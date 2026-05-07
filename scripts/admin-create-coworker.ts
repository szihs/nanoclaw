/**
 * admin-create-coworker — one-off helper to mint a coworker on a running
 * NanoClaw instance when no admin-capable parent agent is available to call
 * the MCP `create_agent` tool.
 *
 * Mirrors the essential subset of `src/modules/agent-to-agent/create-agent.ts`:
 * createAgentGroup + initGroupFilesystem + createMessagingGroupAgent +
 * createDestination (channel). Skips the parent-destination linkage and
 * dashboard channel (we only need CLI smoke).
 *
 * The CLI router re-reads `messaging_group_agents` per inbound message, so
 * no adapter-refresh signal is needed — the next `pnpm run chat` sees it.
 *
 * Usage:
 *   pnpm exec tsx scripts/admin-create-coworker.ts \
 *     --name Claude-main [--provider claude] [--type nanoclaw-writer] \
 *     [--mg-channel cli] [--mg-platform cli:local]
 */
import type { AgentGroup } from '../src/types.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';
import {
  allocateDestinationName,
  createDestination,
  normalizeName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { DATA_DIR } from '../src/config.js';
import path from 'path';

interface Args {
  name: string;
  provider: string | null;
  type: string | null;
  mgChannel: string;
  mgPlatform: string;
}

function parse(argv: string[]): Args {
  let name: string | undefined;
  let provider: string | null = null;
  let type: string | null = null;
  let mgChannel = 'cli';
  let mgPlatform = 'cli:local';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--name') { name = v; i++; }
    else if (k === '--provider') { provider = v; i++; }
    else if (k === '--type') { type = v; i++; }
    else if (k === '--mg-channel') { mgChannel = v; i++; }
    else if (k === '--mg-platform') { mgPlatform = v; i++; }
  }
  if (!name) throw new Error('--name is required');
  return { name, provider, type, mgChannel, mgPlatform };
}

async function main() {
  const args = parse(process.argv.slice(2));

  // Open central DB (same path the orchestrator uses)
  const dbPath = path.join(DATA_DIR, 'v2.db');
  initDb(dbPath);

  const mg = getMessagingGroupByPlatform(args.mgChannel, args.mgPlatform);
  if (!mg) throw new Error(`messaging group not found: ${args.mgChannel}/${args.mgPlatform}`);

  const localName = normalizeName(args.name);
  const folder = localName; // assume no collision for this sandbox
  const id = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const group: AgentGroup = {
    id,
    name: args.name,
    folder,
    is_admin: 0,
    agent_provider: args.provider,
    container_config: null,
    coworker_type: args.type,
    allowed_mcp_tools: null,
    routing: 'direct',
    disable_overlays: 0,
    created_at: now,
  };
  createAgentGroup(group);
  initGroupFilesystem(group, {});

  // Wire to the CLI messaging group with engage_mode=pattern + @<localName>
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: mg.id,
    agent_group_id: id,
    engage_mode: 'pattern',
    engage_pattern: `@${localName}\\b`,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  } as never);

  // Channel destination so outbound messages can route
  const destName = allocateDestinationName(id, `${mg.name || mg.channel_type}-${mg.channel_type}`);
  createDestination({
    agent_group_id: id,
    local_name: destName,
    target_type: 'channel',
    target_id: mg.id,
    created_at: now,
  });

  console.log(JSON.stringify({
    status: 'ok',
    agent_group_id: id,
    name: args.name,
    folder,
    local_name: localName,
    engage_pattern: `@${localName}\\b`,
    messaging_group: `${mg.channel_type}/${mg.platform_id}`,
    destination: destName,
  }, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
