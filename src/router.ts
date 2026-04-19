/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { getChannelAdapter } from './channels/channel-registry.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import { getMessagingGroupByPlatform, createMessagingGroup, getMessagingGroupAgents } from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { startTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface InboundEvent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk';
    content: string; // JSON blob
    timestamp: string;
  };
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  // 1. Resolve messaging group
  let mg = getMessagingGroupByPlatform(event.channelType, event.platformId);

  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // 3. Resolve agent groups wired to this messaging group. Structural
  //    drops record to dropped_messages for audit.
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) {
    log.warn('MESSAGE DROPPED — no agent groups wired to this channel. Run setup register step to configure.', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
    return;
  }

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  let engagedCount = 0;
  let accumulatedCount = 0;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    const engages = evaluateEngage(agent, agentGroup, messageText, mg, event.threadId);

    const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, true);
      engagedCount++;
    } else if (agent.ignored_message_policy === 'accumulate') {
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false);
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be @-mentioned by its agent-group name
 *   'mention-sticky' — @mention OR an active per-thread session already
 *                      exists for this (agent, mg, thread). The session
 *                      existence IS our subscription state; once a thread
 *                      has engaged us once, follow-ups arrive with no
 *                      mention and should still fire.
 */
function evaluateEngage(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  text: string,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return hasMention(text, agentGroup.name);
    case 'mention-sticky': {
      if (hasMention(text, agentGroup.name)) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

function hasMention(text: string, agentName: string): boolean {
  if (!agentName) return false;
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}\\b`, 'i').test(text);
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
): Promise<void> {
  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: event.platformId,
    channelType: event.channelType,
    threadId: event.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
    const freshSession = getSession(session.id);
    if (freshSession) {
      await wakeContainer(freshSession);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
