/**
 * Init the first (or Nth) NanoClaw v2 agent for a DM channel.
 *
 * Creates/reuses: user, owner grant (if none), agent group + filesystem,
 * DM messaging group, wiring, session. Stages a system welcome message so
 * the host sweep wakes the container and the agent DMs the operator via
 * the normal delivery path.
 *
 * Runs alongside the service (WAL-mode sqlite) — does NOT initialize
 * channel adapters, so there's no Gateway conflict.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-first-agent.ts \
 *     --channel discord \
 *     --user-id discord:1470183333427675709 \
 *     --platform-id discord:@me:1491573333382523708 \
 *     --display-name "Gavriel" \
 *     [--agent-name "Andy"] \
 *     [--welcome "System instruction: ..."]
 *
 * For direct-addressable channels (telegram, whatsapp, etc.), --platform-id
 * is typically the same as the handle in --user-id, with the channel prefix.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';
import type { AgentGroup } from '../src/types.js';

interface Args {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  welcome: string;
}

const DEFAULT_WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new channel.';

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--channel':
        out.channel = (val ?? '').toLowerCase();
        i++;
        break;
      case '--user-id':
        out.userId = val;
        i++;
        break;
      case '--platform-id':
        out.platformId = val;
        i++;
        break;
      case '--display-name':
        out.displayName = val;
        i++;
        break;
      case '--agent-name':
        out.agentName = val;
        i++;
        break;
      case '--welcome':
        out.welcome = val;
        i++;
        break;
    }
  }

  const required: (keyof Args)[] = ['channel', 'userId', 'platformId', 'displayName'];
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    console.error(`Missing required args: ${missing.map((k) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ')}`);
    console.error('See scripts/init-first-agent.ts header for usage.');
    process.exit(2);
  }

  return {
    channel: out.channel!,
    userId: out.userId!,
    platformId: out.platformId!,
    displayName: out.displayName!,
    agentName: out.agentName?.trim() || out.displayName!,
    welcome: out.welcome?.trim() || DEFAULT_WELCOME,
  };
}

function namespacedUserId(channel: string, raw: string): string {
  return raw.includes(':') ? raw : `${channel}:${raw}`;
}

function namespacedPlatformId(channel: string, raw: string): string {
  return raw.startsWith(`${channel}:`) ? raw : `${channel}:${raw}`;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const now = new Date().toISOString();

  // 1. User + (conditional) owner grant
  const userId = namespacedUserId(args.channel, args.userId);
  upsertUser({
    id: userId,
    kind: args.channel,
    display_name: args.displayName,
    created_at: now,
  });

  let promotedToOwner = false;
  if (!hasAnyOwner()) {
    grantRole({
      user_id: userId,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    promotedToOwner = true;
  }

  // 2. Agent group + filesystem
  const folder = `dm-with-${normalizeName(args.displayName)}`;
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a personal NanoClaw agent for ${args.displayName}. ` +
      'When you receive a system welcome prompt, introduce yourself briefly and invite them to chat. Keep replies concise.',
  });

  // 3. DM messaging group
  const platformId = namespacedPlatformId(args.channel, args.platformId);
  let mg = getMessagingGroupByPlatform(args.channel, platformId);
  if (!mg) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: args.channel,
      platform_id: platformId,
      name: args.displayName,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(args.channel, platformId)!;
    console.log(`Created messaging group: ${mg.id} (${platformId})`);
  } else {
    console.log(`Reusing messaging group: ${mg.id} (${platformId})`);
  }

  // 4. Wire (auto-creates the companion agent_destinations row)
  const existingMga = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existingMga) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      // DM (is_group=0) defaults to "respond to everything" via the '.' pattern.
      // Group chats default to mention-only; admins can upgrade to
      // mention-sticky via /manage-channels once the agent is in use.
      engage_mode: mg.is_group === 0 ? 'pattern' : 'mention',
      engage_pattern: mg.is_group === 0 ? '.' : null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired ${mg.id} -> ${ag.id}`);
  } else {
    console.log(`Wiring already exists: ${existingMga.id}`);
  }

  // 5. Session + staged welcome message
  const { session, created } = resolveSession(ag.id, mg.id, null, 'shared');
  console.log(`${created ? 'Created' : 'Reusing'} session: ${session.id}`);

  writeSessionMessage(ag.id, session.id, {
    id: generateId('sys-welcome'),
    kind: 'chat',
    timestamp: now,
    platformId: mg.platform_id,
    channelType: args.channel,
    threadId: null,
    content: JSON.stringify({
      text: args.welcome,
      sender: 'system',
      senderId: 'system',
    }),
  });

  // 6. Wire the CLI channel to the same agent so the user can `pnpm run chat`
  // immediately. CLI ships with main and is always available — separate
  // messaging_group from the DM channel, so the two don't share a session.
  const CLI_PLATFORM_ID = 'local';
  let cliMg = getMessagingGroupByPlatform('cli', CLI_PLATFORM_ID);
  if (!cliMg) {
    cliMg = {
      id: generateId('mg'),
      channel_type: 'cli',
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(cliMg);
    console.log(`Created CLI messaging group: ${cliMg.id}`);
  }
  const existingCliMga = getMessagingGroupAgentByPair(cliMg.id, ag.id);
  if (!existingCliMga) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: cliMg.id,
      agent_group_id: ag.id,
      // CLI is a local single-user DM — always respond.
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired cli/${CLI_PLATFORM_ID} -> ${ag.id}`);
  }

  console.log('');
  console.log('Init complete.');
  console.log(`  owner:   ${userId}${promotedToOwner ? ' (promoted on first owner)' : ''}`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  console.log(`  channel: ${args.channel} ${platformId}`);
  console.log(`  session: ${session.id}`);
  console.log(`  cli:     cli/${CLI_PLATFORM_ID} wired — try \`pnpm run chat hi\``);
  console.log('');
  console.log('Host sweep (<=60s) will wake the container and the agent will send the welcome DM.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
