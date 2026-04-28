/**
 * Step: register — Create v2 entities (agent group, messaging group, wiring).
 *
 * Writes to the v2 central DB (data/v2.db) — NOT the v1 store/messages.db.
 * Creates: agent_group, messaging_group, messaging_group_agents.
 */
import fs from 'fs';
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup, getAdminAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from '../src/db/messaging-groups.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { log } from '../src/log.js';
import { namespacedPlatformId } from '../src/platform-id.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';
import {
  allocateDestinationName,
  createDestination,
  getDestinationByName,
  normalizeName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { emitStatus } from './status.js';

interface RegisterArgs {
  /** Platform-specific channel/group ID (Discord channel ID, Slack channel, etc.) */
  platformId: string;
  /** Human-readable name for the messaging group */
  name: string;
  /** Trigger pattern (regex or keyword) */
  trigger: string;
  /** Agent group folder name */
  folder: string;
  /** Channel type (discord, slack, telegram, etc.) */
  channel: string;
  /** Whether messages require the trigger pattern to activate */
  requiresTrigger: boolean;
  /** Display name for the assistant */
  assistantName: string;
  /** Session mode: 'shared' (one session per channel) or 'per-thread' */
  sessionMode: string;
  /** Whether this agent group is an admin/orchestrator group */
  isAdmin: boolean;
  /** Coworker type from the lego registry (e.g. slang-triage, slang-fix) */
  coworkerType: string | null;
  /** Agent provider: 'claude' (default) or 'codex' */
  agentProvider: string | null;
  /** Routing mode: 'direct' (own channel) or 'internal' (via orchestrator only) */
  routing: 'direct' | 'internal';
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    platformId: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'discord',
    requiresTrigger: false,
    assistantName: 'Andy',
    sessionMode: 'shared',
    isAdmin: false,
    coworkerType: null,
    agentProvider: null,
    routing: 'direct',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--platform-id':
        result.platformId = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
      case '--session-mode':
        result.sessionMode = args[++i] || 'shared';
        break;
      case '--is-admin':
        result.isAdmin = true;
        break;
      case '--coworker-type':
        result.coworkerType = args[++i] || null;
        break;
      case '--agent-provider':
        result.agentProvider = args[++i] || null;
        break;
      case '--routing':
        result.routing = args[++i] === 'internal' ? 'internal' : 'direct';
        break;
    }
  }

  // Default coworker_type for admin groups to 'main' if not explicitly set
  if (result.isAdmin && !result.coworkerType) {
    result.coworkerType = 'main';
  }

  return result;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.platformId || !parsed.name || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Normalize platform_id to the same shape the adapter will emit at runtime,
  // so the router's (channel_type, platform_id) lookup matches what we store.
  // Chat SDK adapters prefix, native adapters (WhatsApp/iMessage/Signal) don't.
  parsed.platformId = namespacedPlatformId(parsed.channel, parsed.platformId);

  log.info('Registering channel', parsed);

  // Init v2 central DB
  const dataDir = path.join(projectRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);

  // 1. Create or find agent group
  let agentGroup = getAgentGroupByFolder(parsed.folder);
  if (!agentGroup) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: parsed.assistantName,
      folder: parsed.folder,
      is_admin: parsed.isAdmin ? 1 : 0,
      coworker_type: parsed.coworkerType,
      routing: parsed.routing,
      agent_provider: parsed.agentProvider,
      created_at: new Date().toISOString(),
    });
    agentGroup = getAgentGroupByFolder(parsed.folder)!;
    log.info('Created agent group', { id: agId, folder: parsed.folder });
  }
  initGroupFilesystem(agentGroup);

  // 1b. Grant the channel's default user the owner role so approval flows work
  if (parsed.isAdmin && parsed.channel === 'dashboard') {
    try {
      const now = new Date().toISOString();
      const dashUserId = 'dashboard:dashboard-admin';
      db.prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES ('system', 'system', 'System', ?)").run(now);
      db.prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', 'Dashboard Admin', ?)").run(dashUserId, now);
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, 'system', ?)").run(dashUserId, now);
      log.info('Granted dashboard-admin owner role');
    } catch {
      // permissions module tables may not exist
    }
  }

  const shouldCreateDirectChannel = parsed.routing === 'direct';

  // 2. Create or find messaging group (direct-routing only)
  let messagingGroup = null;
  if (shouldCreateDirectChannel) {
    messagingGroup = getMessagingGroupByPlatform(parsed.channel, parsed.platformId);
    if (!messagingGroup) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: parsed.channel,
      platform_id: parsed.platformId,
      name: parsed.name,
      is_group: 1,
      unknown_sender_policy: parsed.channel === 'dashboard' ? 'public' : 'strict',
      created_at: new Date().toISOString(),
    });
    messagingGroup = getMessagingGroupByPlatform(parsed.channel, parsed.platformId)!;
    log.info('Created messaging group', { id: mgId, channel: parsed.channel, platformId: parsed.platformId });
    }
  }

  // 3. Wire agent to messaging group — createMessagingGroupAgent auto-creates
  // the companion agent_destinations row so delivery's ACL admits this target.
  let newlyWired = false;
  if (shouldCreateDirectChannel && messagingGroup) {
    const existing = getMessagingGroupAgentByPair(messagingGroup.id, agentGroup.id);
    if (!existing) {
    newlyWired = true;
    const mgaId = generateId('mga');
    // Mirrors scripts/init-first-agent.ts:wireIfMissing so both setup paths
    // create rows with the same shape. Groups default to 'mention' (bot only
    // responds when addressed); DMs default to 'pattern'/'.' (respond to
    // every message). An explicit --trigger overrides the pattern regex.
    const isGroup = messagingGroup.is_group === 1;
    const engageMode: 'always' | 'pattern' | 'mention' = !parsed.requiresTrigger
      ? 'always'
      : isGroup && !parsed.trigger ? 'mention' : 'pattern';
    const engagePattern: string | null = engageMode === 'pattern' ? parsed.trigger || '.' : (engageMode === 'always' ? parsed.trigger || null : null);
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: messagingGroup.id,
      agent_group_id: agentGroup.id,
      engage_mode: engageMode,
      engage_pattern: engagePattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: parsed.sessionMode as 'shared' | 'per-thread' | 'agent-shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    log.info('Wired agent to messaging group', {
      mgaId,
      agentGroup: agentGroup.id,
      messagingGroup: messagingGroup.id,
    });
    }
  }

  // 3b. Bidirectional destinations: admin ↔ new agent
  if (!parsed.isAdmin) {
    const admin = getAdminAgentGroup();
    if (admin && admin.id !== agentGroup.id) {
      const now = new Date().toISOString();
      const childName = allocateDestinationName(admin.id, agentGroup.name);
      if (!getDestinationByName(admin.id, childName)) {
        createDestination({ agent_group_id: admin.id, local_name: childName, target_type: 'agent', target_id: agentGroup.id, created_at: now });
        log.info('Added admin → agent destination', { admin: admin.id, localName: childName, agent: agentGroup.id });
      }
      const adminName = allocateDestinationName(agentGroup.id, admin.name);
      if (!getDestinationByName(agentGroup.id, adminName)) {
        createDestination({ agent_group_id: agentGroup.id, local_name: adminName, target_type: 'agent', target_id: admin.id, created_at: now });
        log.info('Added agent → admin destination', { agent: agentGroup.id, localName: adminName, admin: admin.id });
      }
    }
  }

  // 3b. Bidirectional destinations: admin ↔ new agent
  if (!parsed.isAdmin) {
    const admin = getAdminAgentGroup();
    if (admin && admin.id !== agentGroup.id) {
      const now = new Date().toISOString();
      const childName = allocateDestinationName(admin.id, agentGroup.name);
      if (!getDestinationByName(admin.id, childName)) {
        createDestination({ agent_group_id: admin.id, local_name: childName, target_type: 'agent', target_id: agentGroup.id, created_at: now });
        log.info('Added admin → agent destination', { admin: admin.id, localName: childName, agent: agentGroup.id });
      }
      const adminName = allocateDestinationName(agentGroup.id, admin.name);
      if (!getDestinationByName(agentGroup.id, adminName)) {
        createDestination({ agent_group_id: agentGroup.id, local_name: adminName, target_type: 'agent', target_id: admin.id, created_at: now });
        log.info('Added agent → admin destination', { agent: agentGroup.id, localName: adminName, admin: admin.id });
      }
    }
  }

  // 4. Send onboarding message — only on first wiring, not re-registration
  if (shouldCreateDirectChannel && newlyWired && messagingGroup) {
    const { session } = resolveSession(agentGroup.id, messagingGroup.id, null, parsed.sessionMode as 'shared' | 'per-thread' | 'agent-shared');
    writeSessionMessage(agentGroup.id, session.id, {
      id: generateId('onboard'),
      kind: 'task',
      timestamp: new Date().toISOString(),
      platformId: parsed.platformId,
      channelType: parsed.channel,
      content: JSON.stringify({
        prompt: `A new ${parsed.channel} channel has been connected. Run /welcome to introduce yourself to the user.`,
      }),
    });
    log.info('Onboarding message written', { sessionId: session.id, channel: parsed.channel });
  }

  // 5. Update assistant name in CLAUDE.md files if different from default
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    log.info('Updating assistant name', { from: 'Andy', to: parsed.assistantName });

    const groupsDir = path.join(projectRoot, 'groups');
    const mdFiles = fs
      .readdirSync(groupsDir)
      .map((d) => path.join(groupsDir, d, 'CLAUDE.md'))
      .filter((f) => fs.existsSync(f));

    for (const mdFile of mdFiles) {
      let content = fs.readFileSync(mdFile, 'utf-8');
      content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
      content = content.replace(/You are Andy/g, `You are ${parsed.assistantName}`);
      fs.writeFileSync(mdFile, content);
      log.info('Updated CLAUDE.md', { file: mdFile });
    }

    // Update .env
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(/^ASSISTANT_NAME=.*$/m, `ASSISTANT_NAME="${parsed.assistantName}"`);
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    log.info('Set ASSISTANT_NAME in .env');
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    PLATFORM_ID: parsed.platformId,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    SESSION_MODE: parsed.sessionMode,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
