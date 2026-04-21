/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR, MCP_PROXY_PORT, PROXY_BIND_HOST } from './config.js';
import { initDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getMessagingGroupsByChannel, getMessagingGroupAgents } from './db/messaging-groups.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { startMcpServers, getRunningServerNames, getServerUpstreamPort } from './mcp-registry.js';
import { startMcpAuthProxy, setUpstreamPortResolver, discoverTools } from './mcp-auth-proxy.js';
// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  getChannelAdapter,
  getActiveAdapters,
} from './channels/channel-registry.js';

/**
 * Per-wiring configuration pushed to adapters so they can pre-filter
 * messages client-side (engage_mode / engage_pattern). Adapters that
 * implement the optional `updateConversations` method receive these when
 * wiring changes (e.g., create_agent).
 */
export interface ConversationConfig {
  platformId: string;
  agentGroupId: string;
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern?: string | null;
  ignoredMessagePolicy?: 'drop' | 'accumulate';
  sessionMode: 'shared' | 'per-thread' | 'agent-shared';
}

// Module-level so shutdown() can access
let mcpStackHandle: { stop: () => void } | null = null;
let mcpProxyHandle: { stop: () => void } | null = null;

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  // Reset stale container_status from previous host runs
  getDb().prepare("UPDATE sessions SET container_status = 'stopped' WHERE container_status = 'running'").run();

  // 2b. MCP server stack (registry + auth proxy)
  const mcpStack = await startMcpServers(MCP_PROXY_PORT + 100);
  mcpStackHandle = mcpStack;
  setUpstreamPortResolver((serverName) => {
    if (serverName) return mcpStack.getUpstreamPort(serverName);
    const names = getRunningServerNames();
    return names.length > 0 ? getServerUpstreamPort(names[0]) : null;
  });
  mcpProxyHandle = startMcpAuthProxy(PROXY_BIND_HOST, MCP_PROXY_PORT);

  // Discover tools from all running MCP servers
  for (const name of getRunningServerNames()) {
    const port = mcpStack.getUpstreamPort(name);
    if (port) {
      await discoverTools(name, port).catch((err) => {
        log.warn('MCP tool discovery failed', { server: name, err });
      });
    }
  }

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  log.info('NanoClaw running');
}

/**
 * Refresh all active adapters with updated conversation configs from the DB.
 * Called when messaging_group_agents wiring changes (e.g., create_agent).
 */
export function refreshAdapterConversations(): void {
  for (const adapter of getActiveAdapters()) {
    const a = adapter as ChannelAdapter & { updateConversations?(configs: ConversationConfig[]): void };
    if (a.updateConversations) {
      const configs = buildConversationConfigs(a.channelType);
      a.updateConversations(configs);
      log.debug('Adapter conversations refreshed', { channel: a.channelType, count: configs.length });
    }
  }
}

/** Build ConversationConfig[] for a channel type from the central DB. */
function buildConversationConfigs(channelType: string): ConversationConfig[] {
  const groups = getMessagingGroupsByChannel(channelType);
  const configs: ConversationConfig[] = [];

  for (const mg of groups) {
    const agents = getMessagingGroupAgents(mg.id);
    for (const agent of agents) {
      configs.push({
        platformId: mg.platform_id,
        agentGroupId: agent.agent_group_id,
        engageMode: agent.engage_mode === 'always' || agent.engage_mode === 'never' ? 'pattern' : agent.engage_mode,
        engagePattern: agent.engage_pattern,
        ignoredMessagePolicy: agent.ignored_message_policy ?? undefined,
        sessionMode: agent.session_mode,
      });
    }
  }

  return configs;
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  mcpProxyHandle?.stop();
  mcpStackHandle?.stop();
  await teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
