/**
 * NanoClaw Dashboard Server
 *
 * Four-tab dashboard:
 *   Tab 1: Pixel Art Office — real-time interactive coworker visualization
 *   Tab 2: Coworkers — manage coworker agents, containers, files
 *   Tab 3: Timeline — all-time metrics, task history, analytics
 *   Tab 4: Admin — config, debug, infrastructure, logs, skills, chat
 *
 * Reads NanoClaw state from SQLite/session DBs and forwards browser chat to the
 * NanoClaw host over a localhost-only ingress.
 * Receives real-time hook events via POST /api/hook-event.
 */

import { createServer } from 'http';
import { createHash } from 'crypto';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { exec, execSync } from 'child_process';
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  lstatSync,
  symlinkSync,
  cpSync,
  watch,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  createWriteStream,
} from 'fs';
import { join, resolve, relative, normalize, isAbsolute, extname, basename, dirname } from 'path';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

/**
 * Check if `target` is inside (or equal to) `baseDir`.
 * Uses path.relative to avoid the startsWith('/foo/bar') vs '/foo/bar-evil' bug.
 * Mirrors ensureWithinBase() from src/group-folder.ts.
 */
/** Safe decodeURIComponent — returns null on malformed input instead of throwing. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function isInsideDir(baseDir: string, target: string): boolean {
  const rel = relative(resolve(baseDir), resolve(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function getProjectRoot(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_PROJECT_ROOT || resolve(import.meta.dirname, '..'));
}
function getPublicDir(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_PUBLIC_DIR || resolve(import.meta.dirname, 'public'));
}
function getDataDir(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_DATA_DIR || join(getProjectRoot(), 'data'));
}
function getDbPath(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_DB_PATH || join(getDataDir(), 'v2.db'));
}
function getGroupsDir(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_GROUPS_DIR || join(getProjectRoot(), 'groups'));
}
function toSqliteDatetime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}
function getMcpManagementTokenPath(): string {
  return join(getDataDir(), '.mcp-management-token');
}
function getSkillsDir(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_SKILLS_DIR || join(getProjectRoot(), 'container', 'skills'));
}
function getChannelsDir(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_CHANNELS_DIR || join(getProjectRoot(), 'src', 'channels'));
}
function getLogsDir(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_LOGS_DIR || join(getProjectRoot(), 'logs'));
}
function getCoworkerTypesPath(): string {
  return join(getGroupsDir(), 'coworker-types.json');
}
/**
 * Post-import group filesystem init. Mirrors the critical steps from
 * src/group-init.ts so that imported groups are immediately ready —
 * global symlink, settings.json, container skills, agent-runner-src.
 * Idempotent: each step is gated on target not existing.
 */
function postImportGroupInit(
  agentGroupId: string,
  folder: string,
  warnings: string[],
): void {
  const projectRoot = getProjectRoot();
  const groupDir = join(getGroupsDir(), folder);
  const claudeSharedDir = join(getDataDir(), 'v2-sessions', agentGroupId, '.claude-shared');

  // 1. .claude-global.md symlink (dangling on host — resolves inside container)
  //    Skip for typed coworkers — they use composed spines instead.
  const isTyped = (() => { try {
    const wdb = new Database(getDbPath(), { readonly: true });
    const row = wdb.prepare('SELECT coworker_type FROM agent_groups WHERE id = ?').get(agentGroupId) as any;
    wdb.close();
    return !!row?.coworker_type;
  } catch { return false; } })();
  if (!isTyped) {
    const globalLinkPath = join(groupDir, '.claude-global.md');
    let linkExists = false;
    try { lstatSync(globalLinkPath); linkExists = true; } catch { /* missing */ }
    if (!linkExists) {
      try {
        symlinkSync('/workspace/global/CLAUDE.md', globalLinkPath);
      } catch (e: any) {
        warnings.push(`Global symlink failed: ${e.message}`);
      }
    }
  }

  // 2. settings.json
  mkdirSync(claudeSharedDir, { recursive: true });
  const settingsFile = join(claudeSharedDir, 'settings.json');
  if (!existsSync(settingsFile)) {
    writeFileSync(settingsFile, JSON.stringify({
      preferences: { reasoningEffort: 'max' },
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // 3. Container skills — merge individual skill dirs (import may have
  //    already created the parent with a subset of skills from V1 data)
  const skillsDst = join(claudeSharedDir, 'skills');
  const skillsSrc = join(projectRoot, 'container', 'skills');
  if (existsSync(skillsSrc)) {
    mkdirSync(skillsDst, { recursive: true });
    for (const skill of readdirSync(skillsSrc)) {
      const dst = join(skillsDst, skill);
      if (!existsSync(dst)) {
        try { cpSync(join(skillsSrc, skill), dst, { recursive: true }); } catch (e: any) {
          warnings.push(`Skill copy '${skill}' failed: ${e.message}`);
        }
      }
    }
  }

  // 4. Agent-runner source
  const runnerDst = join(getDataDir(), 'v2-sessions', agentGroupId, 'agent-runner-src');
  if (!existsSync(runnerDst)) {
    const runnerSrc = join(projectRoot, 'container', 'agent-runner', 'src');
    if (existsSync(runnerSrc)) {
      try { cpSync(runnerSrc, runnerDst, { recursive: true }); } catch (e: any) {
        warnings.push(`Agent-runner copy failed: ${e.message}`);
      }
    }
  }
}

const DASHBOARD_PORT_DEFAULT = '3737';
const DASHBOARD_HOST_DEFAULT = '127.0.0.1'; // localhost-only; set to 0.0.0.0 to expose on all interfaces
const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);
const DASHBOARD_INGRESS_PORT_DEFAULT = '3738';
const DASHBOARD_AUTH_COOKIE = 'nanoclaw_dashboard_auth';

// --- SQLite (read-only) ---

function openDb(): Database.Database | null {
  try {
    return new Database(getDbPath(), { readonly: true, fileMustExist: true });
  } catch {
    console.warn(`[dashboard] Cannot open DB at ${getDbPath()} — running without DB`);
    return null;
  }
}

let db: Database.Database | null = null;

// Persistent write connection (lazy-opened, reused across requests)
let writeDb: Database.Database | null = null;

function getWriteDb(): Database.Database | null {
  if (writeDb) return writeDb;
  try {
    writeDb = new Database(getDbPath(), { fileMustExist: true });
    return writeDb;
  } catch {
    return null;
  }
}

function parseJsonObject(value: unknown): Record<string, any> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

const MESSAGE_ATTACHMENT_MIME_TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  slang: 'text/plain',
  cpp: 'text/plain',
  h: 'text/plain',
  py: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

function getMessageAttachmentMimeType(filename: string): string {
  const ext = extname(filename).replace(/^\./, '').toLowerCase();
  return MESSAGE_ATTACHMENT_MIME_TYPES[ext] || 'application/octet-stream';
}

function compareMessagesAscending(a: any, b: any): number {
  const at = a.timestamp ? Date.parse(a.timestamp) : 0;
  const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
  if (at !== bt) return at - bt;
  const aid = String(a.id ?? '');
  const bid = String(b.id ?? '');
  return aid.localeCompare(bid);
}

function compareMessagesDescending(a: any, b: any): number {
  return compareMessagesAscending(b, a);
}

function buildMessageAttachments(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  fileNames: string[],
): Array<{ name: string; url: string; mime: string; isImage: boolean }> {
  const attachmentDir = join(getDataDir(), 'v2-sessions', agentGroupId, sessionId, 'outbox', messageId);
  if (!existsSync(attachmentDir)) return [];

  return fileNames
    .filter((fileName) => typeof fileName === 'string' && fileName)
    .filter((fileName) => {
      const fullPath = join(attachmentDir, fileName);
      return isInsideDir(attachmentDir, fullPath) && existsSync(fullPath) && !statSync(fullPath).isDirectory();
    })
    .map((fileName) => {
      const mime = getMessageAttachmentMimeType(fileName);
      return {
        name: fileName,
        url:
          `/api/messages/attachment?agentGroupId=${encodeURIComponent(agentGroupId)}` +
          `&sessionId=${encodeURIComponent(sessionId)}` +
          `&messageId=${encodeURIComponent(messageId)}` +
          `&name=${encodeURIComponent(fileName)}`,
        mime,
        isImage: mime.startsWith('image/'),
      };
    });
}

function applyMessageOperations(messages: any[]): any[] {
  const ordered = [...messages].sort(compareMessagesAscending);
  const byPlatformMessageId = new Map<string, any>();
  const visible: any[] = [];

  for (const message of ordered) {
    if (message.direction === 'outgoing' && message.operationType === 'edit' && message.targetPlatformMessageId) {
      const target = byPlatformMessageId.get(message.targetPlatformMessageId);
      if (target) {
        target.displayContent = message.operationText || target.displayContent;
        target.edited = true;
        if (target.cardType === 'credential_request') {
          target.question = target.displayContent;
        }
        continue;
      }
    }

    if (message.direction === 'outgoing' && message.operationType === 'reaction' && message.targetPlatformMessageId) {
      const target = byPlatformMessageId.get(message.targetPlatformMessageId);
      if (target && message.emoji) {
        if (!Array.isArray(target.reactions)) target.reactions = [];
        target.reactions.push(message.emoji);
        continue;
      }
    }

    if (message.direction === 'outgoing' && message.platformMessageId) {
      byPlatformMessageId.set(message.platformMessageId, message);
    }

    visible.push(message);
  }

  return visible;
}

function normalizeMessageForDisplay(message: any): any {
  message.rawContent = message.content;
  const parsed = parseJsonObject(message.content);
  if (!parsed) {
    message.displayContent = message.content;
    return message;
  }
  message.parsedContent = parsed;
  message.displayContent = parsed.text || parsed.markdown || parsed.prompt || parsed.question || '';

  const fileNames = Array.isArray(parsed.files) ? parsed.files.filter((file: any) => typeof file === 'string') : [];
  if (fileNames.length > 0) {
    message.fileNames = fileNames;
  }

  if (parsed.operation === 'edit') {
    message.operationType = 'edit';
    message.targetPlatformMessageId = typeof parsed.messageId === 'string' ? parsed.messageId : null;
    message.operationText =
      (typeof parsed.text === 'string' && parsed.text) || (typeof parsed.markdown === 'string' && parsed.markdown) || '';
    message.displayContent = message.operationText || 'Edited a previous message';
  } else if (parsed.operation === 'reaction') {
    message.operationType = 'reaction';
    message.targetPlatformMessageId = typeof parsed.messageId === 'string' ? parsed.messageId : null;
    message.emoji = typeof parsed.emoji === 'string' ? parsed.emoji : null;
    message.displayContent = message.emoji ? `Reacted with ${message.emoji}` : 'Reacted to a previous message';
  } else if (!message.displayContent && fileNames.length === 0) {
    message.displayContent = message.content;
  }

  if (parsed.type === 'ask_question') {
    message.cardType = 'ask_question';
    message.questionId = typeof parsed.questionId === 'string' ? parsed.questionId : null;
    message.options = Array.isArray(parsed.options) ? parsed.options.filter((opt: any) => typeof opt === 'string') : [];
  } else if (parsed.type === 'credential_request') {
    message.cardType = 'credential_request';
    message.credentialId = typeof parsed.credentialId === 'string' ? parsed.credentialId : null;
    message.question = typeof parsed.question === 'string' ? parsed.question : message.displayContent;
  }

  return message;
}

function getPendingQuestionRow(questionId: string): any | null {
  if (!db || !questionId) return null;
  try {
    return db.prepare('SELECT * FROM pending_questions WHERE question_id = ?').get(questionId) as any;
  } catch {
    return null;
  }
}

function getPendingCredentialRow(credentialId: string): any | null {
  if (!db || !credentialId) return null;
  try {
    return db.prepare('SELECT * FROM pending_credentials WHERE id = ?').get(credentialId) as any;
  } catch {
    return null;
  }
}

function normalizeDestinationName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

function allocateDestinationNameDb(wdb: Database.Database, agentGroupId: string, preferredName: string): string {
  const baseLocalName = normalizeDestinationName(preferredName);
  let localName = baseLocalName;
  let suffix = 2;
  while (
    wdb
      .prepare('SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND local_name = ? LIMIT 1')
      .get(agentGroupId, localName)
  ) {
    localName = `${baseLocalName}-${suffix}`;
    suffix++;
  }
  return localName;
}

function getDestinationByLocalNameDb(
  wdb: Database.Database,
  agentGroupId: string,
  localName: string,
): { target_type: string; target_id: string } | undefined {
  return wdb
    .prepare(
      'SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ? LIMIT 1',
    )
    .get(agentGroupId, localName) as { target_type: string; target_id: string } | undefined;
}

interface CoworkerTypeMetadata {
  description: string;
  allowedMcpTools: string[];
  known: boolean;
}

export function resolveCoworkerTypeMetadata(
  coworkerType: string | null,
  types: Record<string, any>,
): CoworkerTypeMetadata {
  if (!coworkerType) {
    return { description: '', allowedMcpTools: [], known: false };
  }

  const exact = types[coworkerType];
  if (exact) {
    return {
      description: exact.description || '',
      allowedMcpTools: Array.isArray(exact.allowedMcpTools) ? exact.allowedMcpTools : [],
      known: true,
    };
  }

  const roles = coworkerType
    .split('+')
    .map((role) => role.trim())
    .filter(Boolean);
  if (roles.length === 0) {
    return { description: '', allowedMcpTools: [], known: false };
  }

  const descriptions: string[] = [];
  const allowed = new Set<string>();
  let known = true;
  for (const role of roles) {
    const entry = types[role];
    if (!entry) {
      known = false;
      descriptions.push(role);
      continue;
    }
    descriptions.push(entry.description || role);
    if (Array.isArray(entry.allowedMcpTools)) {
      for (const tool of entry.allowedMcpTools) allowed.add(tool);
    }
  }

  return {
    description: descriptions.join(' + '),
    allowedMcpTools: [...allowed],
    known,
  };
}

/**
 * Ensure a trigger pattern is unique across all messaging_group_agents.
 * If the candidate already exists (for a different agent), appends a numeric suffix.
 */
export function getUniqueTrigger(
  db: Database.Database,
  candidate: string,
  excludeAgentGroupId?: string,
): string {
  const existing = db
    .prepare('SELECT mga.agent_group_id, mga.engage_mode, mga.engage_pattern FROM messaging_group_agents mga')
    .all() as { agent_group_id: string; engage_mode: string | null; engage_pattern: string | null }[];

  const usedPatterns = new Set<string>();
  for (const row of existing) {
    if (excludeAgentGroupId && row.agent_group_id === excludeAgentGroupId) continue;
    if (!row.engage_pattern) continue;
    if (row.engage_mode === 'pattern' && row.engage_pattern) usedPatterns.add(row.engage_pattern);
  }

  if (!usedPatterns.has(candidate)) return candidate;

  // Also check prefix collisions: @Slang would collide with @SlangBuild
  // and @SlangBuild would collide with @Slang (either direction)
  const candidateLower = candidate.toLowerCase();
  for (const used of usedPatterns) {
    const usedLower = used.toLowerCase();
    if (candidateLower.startsWith(usedLower) || usedLower.startsWith(candidateLower)) {
      // Prefix collision — need a different trigger
      let suffix = 2;
      let attempt = `${candidate}${suffix}`;
      while (usedPatterns.has(attempt)) {
        suffix++;
        attempt = `${candidate}${suffix}`;
      }
      return attempt;
    }
  }

  return candidate;
}

export function ensureDashboardChatWiring(
  wdb: Database.Database,
  group: { id: string; folder: string; name: string },
  triggerPattern: string,
  now = new Date().toISOString(),
): { messagingGroupId: string } {
  const platformId = `dashboard:${group.folder}`;
  let mg = wdb
    .prepare(
      "SELECT id, name, channel_type, platform_id FROM messaging_groups WHERE channel_type = 'dashboard' AND platform_id = ?",
    )
    .get(platformId) as { id: string; name: string | null; channel_type: string; platform_id: string } | undefined;

  if (!mg) {
    mg = {
      id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: group.name,
      channel_type: 'dashboard',
      platform_id: platformId,
    };
    wdb
      .prepare(
        "INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, 'dashboard', ?, ?, 0, 'public', ?)",
      )
      .run(mg.id, platformId, group.name, now);
  }

  const existingMga = wdb
    .prepare('SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ? LIMIT 1')
    .get(mg.id, group.id);
  if (!existingMga) {
    wdb
      .prepare(
        "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, session_mode, priority, created_at) VALUES (?, ?, ?, 'always', ?, 'all', 'shared', 0, ?)",
      )
      .run(
        `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mg.id,
        group.id,
        triggerPattern,
        now,
      );
  }

  const existingDestination = wdb
    .prepare(
      "SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ? LIMIT 1",
    )
    .get(group.id, mg.id);
  if (!existingDestination) {
    const preferredName = mg.name ? `${mg.name}-${mg.channel_type}` : `${mg.channel_type}-${mg.platform_id.slice(-8)}`;
    const localName = allocateDestinationNameDb(wdb, group.id, preferredName);
    wdb
      .prepare(
        "INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, 'channel', ?, ?)",
      )
      .run(group.id, localName, mg.id, now);
  }

  return { messagingGroupId: mg.id };
}

function bootstrapEagerSession(
  wdb: Database.Database,
  agentGroupId: string,
  messagingGroupId: string,
  now = new Date().toISOString(),
): void {
  const sessId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    wdb
      .prepare(
        "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at) VALUES (?, ?, ?, NULL, 'active', 'stopped', ?)",
      )
      .run(sessId, agentGroupId, messagingGroupId, now);
  } catch {
    return;
  }
  const dataDir = join(getProjectRoot(), 'data');
  const sessDir = join(dataDir, 'v2-sessions', agentGroupId, sessId);
  mkdirSync(sessDir, { recursive: true });
  for (const [file, schema] of [
    ['inbound.db', 'inbound'],
    ['outbound.db', 'outbound'],
  ] as const) {
    const dbPath = join(sessDir, file);
    const sdb = new Database(dbPath);
    sdb.pragma('journal_mode = DELETE');
    sdb.exec(
      schema === 'inbound'
        ? `CREATE TABLE IF NOT EXISTS messages_in (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT, tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL);
           CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);
           CREATE TABLE IF NOT EXISTS delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS destinations (name TEXT PRIMARY KEY, display_name TEXT, type TEXT NOT NULL, channel_type TEXT, platform_id TEXT, agent_group_id TEXT);
           CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT);`
        : `CREATE TABLE IF NOT EXISTS messages_out (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT, timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT, kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS processing_ack (message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL);`,
    );
    sdb.close();
  }
}

function readProjectEnvValue(key: string): string | null {
  try {
    const envContent = readFileSync(join(getProjectRoot(), '.env'), 'utf-8');
    const match = envContent.match(new RegExp(`^${key}=([^\\n]+)$`, 'm'));
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
  } catch {
    return null;
  }
}

function getDashboardIngressBaseUrl(): string {
  const explicitPort =
    process.env.DASHBOARD_INGRESS_PORT ||
    readProjectEnvValue('DASHBOARD_INGRESS_PORT') ||
    DASHBOARD_INGRESS_PORT_DEFAULT;
  return `http://127.0.0.1:${explicitPort}`;
}

function getDashboardPort(): number {
  return parseInt(process.env.DASHBOARD_PORT || readProjectEnvValue('DASHBOARD_PORT') || DASHBOARD_PORT_DEFAULT, 10);
}

function getDashboardHost(): string {
  return process.env.DASHBOARD_HOST || DASHBOARD_HOST_DEFAULT;
}

function getDashboardSecret(): string {
  return process.env.DASHBOARD_SECRET || readProjectEnvValue('DASHBOARD_SECRET') || '';
}

function getAllowedV1ImportRoot(): string {
  return resolve(process.env.NANOCLAW_DASHBOARD_V1_IMPORT_ROOT || '/home');
}

function parseCookies(req: import('http').IncomingMessage): Record<string, string> {
  const header = req.headers.cookie || '';
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function buildAuthCookie(secret: string, clear = false): string {
  const parts = [
    `${DASHBOARD_AUTH_COOKIE}=${clear ? '' : encodeURIComponent(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push('Max-Age=43200');
  }
  return parts.join('; ');
}

function isDashboardAuthenticated(req: import('http').IncomingMessage, secret = getDashboardSecret()): boolean {
  if (!secret) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${secret}`) return true;
  const cookies = parseCookies(req);
  return cookies[DASHBOARD_AUTH_COOKIE] === secret;
}

// --- State snapshot ---

interface CoworkerState {
  folder: string;
  name: string;
  type: string;
  description: string;
  status: 'idle' | 'active' | 'working' | 'error' | 'thinking';
  currentTask: string | null;
  lastActivity: string | null;
  taskCount: number;
  color: string;
  // live hook data
  lastToolUse: string | null;
  lastNotification: string | null;
  hookTimestamp: number | null;
  subagents: SubagentState[];
  isAutoUpdate: boolean;
  allowedMcpTools: string[];
  disallowedMcpTools: string[];
  lastMessageTs: string | null;
}

interface SubagentState {
  agentId: string;
  agentType: string | null;
  phase: 'active' | 'leaving';
  status: 'idle' | 'active' | 'working' | 'error' | 'thinking';
  lastToolUse: string | null;
  lastNotification: string | null;
  startedAt: number;
  lastActivity: number;
  sessionId: string | null;
  exitAt: number | null;
}

interface DashboardState {
  coworkers: CoworkerState[];
  tasks: any[];
  taskRunLogs: any[];
  registeredGroups: any[];
  hookEvents: HookEvent[];
  timestamp: number;
}

interface HookEvent {
  group: string;
  event: string;
  tool?: string;
  message?: string;
  tool_input?: string;
  tool_response?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_use_id?: string;
  transcript_path?: string;
  cwd?: string;
  extra?: Record<string, any>;
  timestamp: number;
}

// Ring buffer for recent hook events (live state)
const hookEvents: HookEvent[] = [];
const MAX_HOOK_EVENTS = 200;

// Hook events DB (write connection, lazy-opened)
let hookEventsDb: Database.Database | null = null;

function getHookEventsDb(): Database.Database | null {
  if (hookEventsDb) return hookEventsDb;
  try {
    hookEventsDb = new Database(getDbPath(), { fileMustExist: true });
    hookEventsDb.pragma('journal_mode = WAL');
    // hook_events table is created by migration 007 in the v2 central DB.
    return hookEventsDb;
  } catch {
    return null;
  }
}

// Bootstrap ring buffer from DB so timeline has history after restart
function bootstrapHookEvents(): void {
  const db = getHookEventsDb();
  if (!db) return;
  try {
    const rows = db
      .prepare(
        'SELECT group_folder, event, tool, tool_use_id, message, tool_input, tool_response, session_id, agent_id, agent_type, transcript_path, cwd, extra, timestamp FROM hook_events ORDER BY timestamp DESC LIMIT ?',
      )
      .all(MAX_HOOK_EVENTS) as any[];
    for (const row of rows.reverse()) {
      const extra = row.extra
        ? (() => {
            try {
              return JSON.parse(row.extra);
            } catch {
              return undefined;
            }
          })()
        : undefined;
      hookEvents.push({
        group: row.group_folder,
        event: row.event,
        tool: row.tool || undefined,
        tool_use_id: row.tool_use_id || undefined,
        message: row.message || undefined,
        tool_input: row.tool_input || undefined,
        tool_response: row.tool_response || undefined,
        session_id: row.session_id || undefined,
        agent_id: row.agent_id || undefined,
        agent_type: row.agent_type || undefined,
        transcript_path: row.transcript_path || undefined,
        cwd: row.cwd || undefined,
        extra,
        timestamp: row.timestamp,
      });
    }
  } catch {
    /* DB not ready yet — buffer stays empty, events will arrive live */
  }
}
bootstrapHookEvents();

// Last message timestamp cache (group_folder -> ISO timestamp)
const lastMessageTsCache = new Map<string, string>();

function pickLatestMessageTs(current: string | null, dbPath: string, table: 'messages_in' | 'messages_out'): string | null {
  if (!existsSync(dbPath)) return current;
  try {
    const sdb = new Database(dbPath, { readonly: true });
    const row = sdb.prepare(`SELECT timestamp FROM ${table} ORDER BY timestamp DESC LIMIT 1`).get() as any;
    sdb.close();
    const ts = row?.timestamp as string | undefined;
    if (!ts) return current;
    if (!current) return ts;
    return Date.parse(ts) > Date.parse(current) ? ts : current;
  } catch {
    return current;
  }
}

function refreshMessageTimestamps(): void {
  if (!db) return;
  const next = new Map<string, string>();
  try {
    const groups = db.prepare('SELECT id, folder FROM agent_groups').all() as { id: string; folder: string }[];
    for (const group of groups) {
      let maxTs: string | null = null;
      const sessions = db
        .prepare('SELECT id FROM sessions WHERE agent_group_id = ?')
        .all(group.id) as { id: string }[];
      const sessionsDir = join(getDataDir(), 'v2-sessions', group.id);
      for (const sess of sessions) {
        maxTs = pickLatestMessageTs(maxTs, join(sessionsDir, sess.id, 'inbound.db'), 'messages_in');
        maxTs = pickLatestMessageTs(maxTs, join(sessionsDir, sess.id, 'outbound.db'), 'messages_out');
      }
      if (maxTs) next.set(group.folder, maxTs);
    }
    lastMessageTsCache.clear();
    for (const [folder, ts] of next.entries()) lastMessageTsCache.set(folder, ts);
  } catch {
    /* DB not ready */
  }
}
refreshMessageTimestamps();
const msgTsTimer = setInterval(refreshMessageTimestamps, 30000);
msgTsTimer.unref?.();

// Live status from hooks (group_folder -> latest state)
const liveHookState = new Map<
  string,
  {
    tool?: string;
    notification?: string;
    status: CoworkerState['status'];
    ts: number;
    agentActive: boolean;
  }
>();
const liveSubagentState = new Map<string, Map<string, SubagentState>>();
const SUBAGENT_STALE_MS = 5 * 60 * 1000;
const SUBAGENT_EXIT_MS = 12 * 1000;
// Groups that have ever sent a hook event — prevents "container running + no hookState" from
// being treated as "working" after hook state expires following a Stop event.
const hookEverSeen = new Set<string>();
// Seed hookEverSeen from DB so dashboard restarts don't reset status
try {
  if (db) {
    const rows = db.prepare('SELECT DISTINCT group_folder FROM hook_events').all() as { group_folder: string }[];
    for (const r of rows) hookEverSeen.add(r.group_folder);
  }
} catch { /* hook_events table may not exist yet */ }

// Cached set of running container name prefixes (refreshed async every 5s)
const runningContainers = new Set<string>();

function refreshContainerStatus(): void {
  exec('docker ps --format "{{.Names}}" 2>/dev/null', { timeout: 3000 }, (_err, stdout) => {
    runningContainers.clear();
    if (stdout) {
      for (const name of stdout.trim().split('\n')) {
        if (name) runningContainers.add(name);
      }
    }
  });
}

// Initial refresh + periodic update
refreshContainerStatus();
setInterval(refreshContainerStatus, 5000);

/** Check if a group folder has a running container (from cache). */
function hasRunningContainer(folder: string): boolean {
  return findRunningContainer(folder) !== null;
}

let cachedTypes: { data: Record<string, any>; mtimeMs: number } | null = null;
function getCoworkerTypes(): Record<string, any> {
  let jsonTypes: Record<string, any> = {};
  try {
    const st = statSync(getCoworkerTypesPath());
    if (cachedTypes && cachedTypes.mtimeMs === st.mtimeMs) {
      jsonTypes = cachedTypes.data;
    } else {
      jsonTypes = JSON.parse(readFileSync(getCoworkerTypesPath(), 'utf-8'));
      cachedTypes = { data: jsonTypes, mtimeMs: st.mtimeMs };
    }
  } catch { /* no JSON file */ }
  const legoTypes = readLegoCoworkerTypes();
  return { ...legoTypes, ...jsonTypes };
}

// Shallow merge of the lego coworker-type registry: every
// container/skills/<skill>/coworker-types.yaml is read and merged. Duplicate type
// names have their extends left-wins-ish (first skill's extends retained
// unless a later one sets it explicitly). Only fields the dashboard needs are
// preserved: extends, description. Full merge semantics live in the
// composer (src/claude-composer.ts); this helper exists because the dashboard
// only needs the extends chain for requires.coworkerTypes walks.
function readLegoCoworkerTypes(): Record<string, { extends?: string | string[]; description?: string; project?: string; flat?: boolean }> {
  const registry: Record<string, { extends?: string | string[]; description?: string; project?: string; flat?: boolean }> = {};
  const skillsDir = getSkillsDir();
  let dirents: string[];
  try {
    dirents = readdirSync(skillsDir);
  } catch {
    return registry;
  }
  // Deterministic order so duplicate handling is stable
  dirents.sort();
  // Load js-yaml synchronously via createRequire — dynamic imports return a Promise
  let yamlLoad: (input: string) => any;
  try {
    yamlLoad = createRequire(import.meta.url)('js-yaml').load;
  } catch {
    return registry;
  }
  for (const entry of dirents) {
    const filePath = join(skillsDir, entry, 'coworker-types.yaml');
    if (!existsSync(filePath)) continue;
    try {
      const doc = yamlLoad(readFileSync(filePath, 'utf-8'));
      if (!doc || typeof doc !== 'object') continue;
      for (const [name, rawEntry] of Object.entries(doc) as [string, any][]) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        const existing = registry[name];
        registry[name] = {
          extends: rawEntry.extends ?? existing?.extends,
          description: rawEntry.description ?? existing?.description,
          project: rawEntry.project ?? existing?.project,
          flat: rawEntry.flat ?? existing?.flat,
        };
      }
    } catch {
      /* skip malformed file */
    }
  }
  return registry;
}

function findRunningContainer(folder: string): string | null {
  const prefix = process.env.CONTAINER_PREFIX || 'nanoclaw';
  const containerName = folder.replace(/_/g, '-');
  for (const name of runningContainers) {
    if (name.startsWith(`${prefix}-${containerName}`)) return name;
  }
  return null;
}

/** Load coworker type colors from coworker-types.json. Cached. */
let _typeColors: Record<string, string> | null = null;
function getTypeColors(): Record<string, string> {
  if (_typeColors) return _typeColors;
  _typeColors = {};
  try {
    const types = JSON.parse(readFileSync(getCoworkerTypesPath(), 'utf-8'));
    for (const [name, entry] of Object.entries(types) as [string, any][]) {
      if (entry.color) _typeColors[name] = entry.color;
    }
  } catch {
    /* file missing — no colors */
  }
  return _typeColors;
}

/** Full MCP tool inventory — loaded from proxy at startup, refreshed on demand. */
let _mcpAllTools: string[] = [];

/** Read the MCP management token from the runtime file written by the auth proxy. */
function getMcpManagementToken(): string | null {
  try {
    return readFileSync(getMcpManagementTokenPath(), 'utf-8').trim();
  } catch {
    return null;
  }
}

function watchMcpManagementToken(onChange: () => void): (() => void) | null {
  try {
    const watcher = watch(getDataDir(), (_eventType, filename) => {
      if (filename === '.mcp-management-token') onChange();
    });
    return () => watcher.close();
  } catch {
    return null;
  }
}

async function refreshMcpTools(): Promise<void> {
  try {
    const proxyPort = process.env.MCP_PROXY_PORT || '3100';
    const token = getMcpManagementToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${proxyPort}/tools`, { headers });
    const data = (await res.json()) as Record<string, string[]>;
    _mcpAllTools = Object.values(data).flat();
  } catch {
    /* proxy not ready — will retry later */
  }
}

// Default MCP tools for base-tier coworkers when no type-specific tools are configured.
// Empty by default — project-specific defaults come from coworker-types.json.
const BASE_TIER_TOOLS: string[] = [];

function resolveAllowedMcpTools(
  dbAllowed: string[] | null,
  coworkerType: string | null,
  isMain: boolean,
  types: Record<string, any>,
): string[] {
  if (dbAllowed && dbAllowed.length > 0) return dbAllowed;
  if (coworkerType) {
    const metadata = resolveCoworkerTypeMetadata(coworkerType, types);
    if (metadata.allowedMcpTools.length > 0) return metadata.allowedMcpTools;
  }
  if (isMain) return _mcpAllTools.length > 0 ? [..._mcpAllTools] : ['mcp__deepwiki__ask_question'];
  return BASE_TIER_TOOLS;
}

function computeDisallowed(allowed: string[]): string[] {
  const set = new Set(allowed);
  return _mcpAllTools.filter((t) => !set.has(t));
}

const READISH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoRead', 'NotebookRead']);
const WRITEISH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit', 'TodoWrite']);

function classifyToolStatus(
  tool: string | undefined,
  fallback: CoworkerState['status'] = 'working',
): CoworkerState['status'] {
  if (!tool) return fallback;
  if (READISH_TOOLS.has(tool)) return 'thinking';
  if (WRITEISH_TOOLS.has(tool)) return 'working';
  return fallback;
}

function classifyEventStatus(
  event: Pick<HookEvent, 'event' | 'tool' | 'message'>,
  previous: CoworkerState['status'] = 'working',
): CoworkerState['status'] {
  if (event.event === 'PostToolUseFailure') return 'error';
  if (event.event === 'PreToolUse' || event.event === 'PostToolUse') {
    return classifyToolStatus(event.tool, previous);
  }
  if (event.event === 'Notification') {
    const msg = (event.message || '').toLowerCase();
    if (/(waiting|approval|permission|confirm|blocked|input required)/.test(msg)) return 'thinking';
  }
  if (event.event === 'SessionEnd' || event.event === 'Stop') return 'idle';
  return previous;
}

function getOrCreateGroupSubagents(group: string): Map<string, SubagentState> {
  let groupMap = liveSubagentState.get(group);
  if (!groupMap) {
    groupMap = new Map<string, SubagentState>();
    liveSubagentState.set(group, groupMap);
  }
  return groupMap;
}

function updateLiveSubagentState(event: HookEvent): void {
  if (!event.group || !event.agent_id) return;

  if (event.event === 'SubagentStart') {
    const groupMap = getOrCreateGroupSubagents(event.group);
    const previous = groupMap.get(event.agent_id);
    groupMap.set(event.agent_id, {
      agentId: event.agent_id,
      agentType: event.agent_type || previous?.agentType || null,
      phase: 'active',
      status: classifyEventStatus(event, previous?.status || 'working'),
      lastToolUse: previous?.lastToolUse || null,
      lastNotification: event.message || previous?.lastNotification || null,
      startedAt: previous?.startedAt || event.timestamp,
      lastActivity: event.timestamp,
      sessionId: event.session_id || previous?.sessionId || null,
      exitAt: null,
    });
    return;
  }

  const groupMap = liveSubagentState.get(event.group);
  if (!groupMap || !groupMap.has(event.agent_id)) return;

  if (event.event === 'SubagentStop') {
    const previous = groupMap.get(event.agent_id)!;
    groupMap.set(event.agent_id, {
      ...previous,
      phase: 'leaving',
      status: 'idle',
      lastNotification: event.message || previous.lastNotification || 'Leaving desk',
      lastActivity: event.timestamp,
      exitAt: event.timestamp + SUBAGENT_EXIT_MS,
    });
    return;
  }

  const previous = groupMap.get(event.agent_id)!;
  groupMap.set(event.agent_id, {
    agentId: event.agent_id,
    agentType: event.agent_type || previous.agentType,
    phase: 'active',
    status: classifyEventStatus(event, previous.status),
    lastToolUse: event.tool || previous.lastToolUse,
    lastNotification: event.message || previous.lastNotification,
    startedAt: previous.startedAt,
    lastActivity: event.timestamp,
    sessionId: event.session_id || previous.sessionId,
    exitAt: null,
  });
}

function getState(): DashboardState {
  const types = getCoworkerTypes();
  const coworkers: CoworkerState[] = [];

  // Scan groups/ for spawned instances (slang_* folders)
  try {
    const folders = readdirSync(getGroupsDir()).filter(
      (f) => statSync(join(getGroupsDir(), f)).isDirectory() && !f.startsWith('.'),
    );

    // Collect registered group folders for filtering
    const registeredFolders = new Set<string>();
    if (db) {
      try {
        const rows = db.prepare('SELECT folder FROM agent_groups').all() as { folder: string }[];
        for (const r of rows) registeredFolders.add(r.folder);
      } catch {
        /* ignore */
      }
    }

    for (const folder of folders) {
      // Skip non-instance folders: global (shared memory)
      if (folder === 'global') continue;
      // Skip folders not registered in the DB (deleted coworkers leave stale folders)
      if (!registeredFolders.has(folder)) continue;

      // Determine coworker type
      let type = 'unknown';
      let description = '';
      let name = folder;
      let isAutoUpdate = false;

      // Check if this is a template folder (matches a type key)
      // but allow it if it's registered as a coworker in the DB
      if (types[folder] && !registeredFolders.has(folder)) {
        continue;
      }

      // Match spawned instances by coworker type prefix (e.g., type "slang-ir" matches folder "slang_ir-generics")
      for (const [typeName, typeInfo] of Object.entries(types) as [string, any][]) {
        const normalizedType = typeName.replace(/-/g, '_');
        if (folder.startsWith(normalizedType + '_') || folder.startsWith(typeName + '_')) {
          type = typeName;
          description = typeInfo.description || '';
          name = folder.replace(new RegExp(`^${normalizedType}_`), '');
          isAutoUpdate = true;
          break;
        }
      }

      // Resolve type, name, and MCP tools from DB
      let dbAllowedMcp: string[] | null = null;
      let isMainGroup = false;
      if (type === 'unknown' && db) {
        try {
          const row = db
            .prepare(
              'SELECT name, folder, coworker_type, allowed_mcp_tools, is_admin FROM agent_groups WHERE folder = ?',
            )
            .get(folder) as any;
          if (row) {
            name = row.name || folder;
            isMainGroup = !!row.is_admin;
            dbAllowedMcp = row.allowed_mcp_tools ? JSON.parse(row.allowed_mcp_tools) : null;
            if (row.coworker_type) {
              type = row.coworker_type;
              const metadata = resolveCoworkerTypeMetadata(row.coworker_type, types);
              description = metadata.description || 'Custom type (no template)';
              isAutoUpdate = metadata.known;
            } else if (row.is_admin) {
              type = 'coordinator';
              description = 'Main coordinator — orchestrates all coworkers';
            }
          }
        } catch {
          /* ignore */
        }
      }

      // Skip non-coworker folders
      if (folder === 'global') continue;

      // Determine status from IPC and task state
      let status: CoworkerState['status'] = 'idle';
      let currentTask: string | null = null;
      let lastActivity: string | null = null;
      let taskCount = 0;

      // v2: check session/container status from central DB
      if (db) {
        try {
          const agRow = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(folder) as any;
          if (agRow) {
            const sessRow = db
              .prepare(
                "SELECT container_status, last_active FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY last_active DESC LIMIT 1",
              )
              .get(agRow.id) as any;
            if (sessRow) {
              lastActivity = sessRow.last_active;
              if (sessRow.container_status === 'running' || sessRow.container_status === 'idle') status = 'active';
            }
          }
        } catch {
          /* ignore query errors */
        }
      }

      // Count scheduled tasks from session DBs
      if (db) {
        try {
          const agRow2 = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(folder) as any;
          if (agRow2) {
            const { sessionIds } = collectSessionDbFiles(agRow2.id);
            taskCount = extractScheduledTasks(agRow2.id, sessionIds).length;
          }
        } catch { /* ignore */ }
      }

      // Use agent hook state for real-time status (preferred over container check)
      const hookState = liveHookState.get(folder);
      const containerRunning = hasRunningContainer(folder);
      if (hookState && hookState.agentActive) {
        // Agent is actively processing — use live hook-derived status.
        // No time limit: long-running tools (builds) can take minutes;
        // agentActive is cleared explicitly by Stop/SessionEnd events.
        status = hookState.status || classifyToolStatus(hookState.tool, 'working');
      } else if ((status === 'idle' || status === 'active') && containerRunning && !hookState) {
        // Container is alive but quiet (e.g. long-running Bash/cmake); show active, not idle.
        status = 'active';
      }

      const subagents = Array.from(liveSubagentState.get(folder)?.values() || [])
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((subagent) => ({ ...subagent }));

      // If subagents are active, parent should show working
      if ((status === 'idle' || status === 'active') && subagents.length > 0) {
        status = 'working';
      }

      coworkers.push({
        folder,
        name,
        type,
        description,
        status,
        currentTask,
        lastActivity,
        taskCount,
        color: getTypeColors()[type] || '#6B7280',
        lastToolUse: hookState?.tool || null,
        lastNotification: hookState?.notification || null,
        hookTimestamp: hookState?.ts || null,
        subagents,
        isAutoUpdate,
        allowedMcpTools: resolveAllowedMcpTools(
          dbAllowedMcp,
          type !== 'unknown' && type !== 'coordinator' ? type : null,
          isMainGroup,
          types,
        ),
        disallowedMcpTools: [],
        lastMessageTs: lastMessageTsCache.get(folder) || null,
      });
      // Compute disallowed after push (needs allowedMcpTools)
      const last = coworkers[coworkers.length - 1];
      last.disallowedMcpTools = computeDisallowed(last.allowedMcpTools);
    }
  } catch {
    /* groups dir may not exist */
  }

  // Add transient entries for groups that have live hook state but no folder yet
  const knownFolders = new Set(coworkers.map((c) => c.folder));
  for (const [folder, hookState] of liveHookState.entries()) {
    if (knownFolders.has(folder)) continue;
    coworkers.push({
      folder,
      name: folder,
      type: 'unknown',
      description: '',
      status: hookState.status || classifyToolStatus(hookState.tool, 'working'),
      currentTask: null,
      lastActivity: new Date(hookState.ts).toISOString(),
      taskCount: 0,
      color: '#6B7280',
      lastToolUse: hookState.tool || null,
      lastNotification: hookState.notification || null,
      isAutoUpdate: false,
      hookTimestamp: hookState.ts || null,
      subagents: Array.from(liveSubagentState.get(folder)?.values() || []),
      allowedMcpTools: BASE_TIER_TOOLS,
      disallowedMcpTools: computeDisallowed(BASE_TIER_TOOLS),
      lastMessageTs: lastMessageTsCache.get(folder) || null,
    });
  }

  // Get registered agent groups enriched with trigger/JID from messaging tables
  let registeredGroups: any[] = [];

  if (db) {
    try {
      registeredGroups = db.prepare('SELECT * FROM agent_groups').all();
      // Enrich with trigger_pattern and jid from messaging_group_agents / messaging_groups
      for (const g of registeredGroups) {
        try {
          const mga = db.prepare(
            `SELECT mga.engage_mode, mga.engage_pattern, mg.platform_id
             FROM messaging_group_agents mga
             JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
             WHERE mga.agent_group_id = ?
             LIMIT 1`,
          ).get(g.id) as any;
          if (mga) {
            g.trigger_pattern = (mga.engage_mode === 'pattern' && mga.engage_pattern) ? mga.engage_pattern : null;
            g.jid = mga.platform_id || null;
          }
        } catch { /* ignore */ }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    coworkers,
    tasks: [],
    taskRunLogs: [],
    registeredGroups,
    hookEvents: hookEvents.slice(-MAX_HOOK_EVENTS),
    timestamp: Date.now(),
    maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
  };
}

// --- WebSocket (manual, no external dep) ---

function computeAcceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC6552AA')
    .digest('base64');
}

const wsClients = new Set<any>();
const sseClients = new Set<import('http').ServerResponse>();

export function resetTransientDashboardStateForTests(): void {
  hookEvents.length = 0;
  liveHookState.clear();
  liveSubagentState.clear();
  hookEverSeen.clear();
  lastMessageTsCache.clear();
  runningContainers.clear();
  _mcpAllTools = [];
  _typeColors = null;
  cachedTypes = null;
  wsClients.clear();
  sseClients.clear();
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  try {
    writeDb?.close();
  } catch {
    /* ignore */
  }
  try {
    hookEventsDb?.close();
  } catch {
    /* ignore */
  }
  db = null;
  writeDb = null;
  hookEventsDb = null;
}

/** Force-open the readonly DB handle for tests (avoids waiting on broadcast timer). */
export function forceOpenDbForTests(): void {
  if (!db) db = openDb();
}

function broadcastState(): void {
  if (wsClients.size === 0 && sseClients.size === 0) return;
  const state = JSON.stringify({ type: 'state', data: getState() });
  for (const ws of wsClients) {
    try {
      const buf = Buffer.from(state);
      const frame = createWsFrame(buf);
      ws.write(frame);
    } catch {
      wsClients.delete(ws);
    }
  }
  const ssePayload = `data: ${state}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(ssePayload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function createWsFrame(data: Buffer, opcode = 0x1): Buffer {
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function parseWsFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    return { opcode, payload, consumed: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { opcode, payload: buf.subarray(offset, offset + payloadLen), consumed: offset + payloadLen };
}

// --- HTTP Server ---

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Check DASHBOARD_SECRET for admin-mutating requests.
 * If DASHBOARD_SECRET is set, requires Authorization: Bearer <secret> header.
 * Hook events from containers are exempt (they use their own auth path).
 */
function requireAuth(req: import('http').IncomingMessage, res: import('http').ServerResponse): boolean {
  const secret = getDashboardSecret();
  if (!secret) return true; // no secret configured → open (localhost-only by default)
  if (isDashboardAuthenticated(req, secret)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end('{"error":"unauthorized"}');
  return false;
}

/** Strict auth — always requires DASHBOARD_SECRET, even when unset.
 *  Used for dangerous operations (exec, config writes) that should
 *  never be open by default regardless of bind address. */
function requireStrictAuth(req: import('http').IncomingMessage, res: import('http').ServerResponse): boolean {
  const secret = getDashboardSecret();
  if (!secret) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"DASHBOARD_SECRET must be set to use this endpoint"}');
    return false;
  }
  return requireAuth(req, res);
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
const MAX_ARCHIVE_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_EXTRACTED_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_SINGLE_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_GROUP_SUBDIR_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB (exports stay on host)
const EXCLUDE_DIR_PATTERNS = /^(node_modules|cmake-.*|conda.*|build|dist|target|__pycache__|\.cache|venv|\.venv|\.tox|\.mypy_cache|\.pytest_cache)$/;

/** Read request body with size limit. Rejects with 413 if exceeded. */
function readBody(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let exceeded = false;
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE && !exceeded) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"error":"Request body too large"}');
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (!exceeded) resolve(body);
    });
    req.on('error', () => {
      if (!exceeded) resolve(null);
    });
  });
}

/** Read request body as raw Buffer for binary uploads (archives). */
function readBodyBinary(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  maxSize = MAX_ARCHIVE_SIZE,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let exceeded = false;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize && !exceeded) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"error":"Archive too large"}');
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!exceeded) resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Full-archive file collection helpers
// ---------------------------------------------------------------------------

/** Check if a relative path (or directory name) should be excluded from archive. */
function shouldExcludeFromArchive(relativePath: string, isDir: boolean): boolean {
  const name = basename(relativePath);
  // Always exclude system-composed files (recomposed every container wake)
  if (name === 'CLAUDE.md' || name === '.claude-global.md') return true;
  if (isDir && EXCLUDE_DIR_PATTERNS.test(name)) return true;
  return false;
}

/** Walk a directory recursively, collecting { relativePath → absolutePath } entries.
 *  Skips excluded dirs/files. Enforces per-file and per-subdir size limits. */
function walkDir(
  baseDir: string,
  opts?: { maxFileSize?: number; maxSubdirSize?: number },
): Map<string, string> {
  const maxFile = opts?.maxFileSize ?? MAX_SINGLE_FILE_SIZE;
  const maxSubdir = opts?.maxSubdirSize ?? Infinity;
  const result = new Map<string, string>();

  function recurse(dir: string, relPrefix: string, budgetLeft: number): number {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return 0; }
    let consumed = 0;
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (shouldExcludeFromArchive(rel, true)) continue;
        consumed += recurse(abs, rel, budgetLeft - consumed);
      } else if (st.isFile()) {
        if (shouldExcludeFromArchive(rel, false)) continue;
        if (st.size > maxFile) continue;
        if (consumed + st.size > budgetLeft) continue;
        consumed += st.size;
        result.set(rel, abs);
      }
    }
    return consumed;
  }

  if (maxSubdir < Infinity) {
    // Apply per-top-level-subdir budget
    let entries: string[];
    try { entries = readdirSync(baseDir); } catch { return result; }
    for (const entry of entries) {
      const abs = join(baseDir, entry);
      const rel = entry;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (shouldExcludeFromArchive(rel, true)) continue;
        recurse(abs, rel, maxSubdir);
      } else if (st.isFile()) {
        if (shouldExcludeFromArchive(rel, false)) continue;
        if (st.size <= maxFile) result.set(rel, abs);
      }
    }
  } else {
    recurse(baseDir, '', Infinity);
  }
  return result;
}

/** Collect files from groups/{folder}/ with size exclusions. */
function collectGroupFiles(groupDir: string): Map<string, string> {
  if (!existsSync(groupDir)) return new Map();
  return walkDir(groupDir, {
    maxFileSize: MAX_SINGLE_FILE_SIZE,
    maxSubdirSize: MAX_GROUP_SUBDIR_SIZE,
  });
}

/** Collect FULL .claude-shared/ directory (Docker-like — copy everything). */
function collectClaudeShared(agentGroupId: string): Map<string, string> {
  const claudeDir = join(getDataDir(), 'v2-sessions', agentGroupId, '.claude-shared');
  if (!existsSync(claudeDir)) return new Map();
  return walkDir(claudeDir, { maxFileSize: MAX_SINGLE_FILE_SIZE });
}

/** Collect inbound.db + outbound.db per session. Returns { relPath → absPath }. */
function collectSessionDbFiles(agentGroupId: string): { files: Map<string, string>; sessionIds: string[] } {
  const files = new Map<string, string>();
  const sessionIds: string[] = [];
  const agDir = join(getDataDir(), 'v2-sessions', agentGroupId);
  let entries: string[];
  try { entries = readdirSync(agDir); } catch { return { files, sessionIds }; }
  for (const entry of entries) {
    if (!entry.startsWith('sess-')) continue;
    const sessDir = join(agDir, entry);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(sessDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    sessionIds.push(entry);
    for (const dbFile of ['inbound.db', 'outbound.db']) {
      const dbPath = join(sessDir, dbFile);
      if (existsSync(dbPath)) {
        files.set(`sessions/${entry}/${dbFile}`, dbPath);
      }
    }
  }
  return { files, sessionIds };
}

/** Extract scheduled tasks from inbound.db for the manifest. */
function extractScheduledTasks(
  agentGroupId: string,
  sessionIds: string[],
): { origId: string; sessionId: string; recurrence: string | null; processAfter: string | null; content: string; status: string }[] {
  const tasks: { origId: string; sessionId: string; recurrence: string | null; processAfter: string | null; content: string; status: string }[] = [];
  for (const sessId of sessionIds) {
    const dbPath = join(getDataDir(), 'v2-sessions', agentGroupId, sessId, 'inbound.db');
    if (!existsSync(dbPath)) continue;
    let sdb: Database | null = null;
    try {
      sdb = new Database(dbPath, { readonly: true });
      sdb.pragma('busy_timeout = 3000');
      const rows = sdb.prepare(
        "SELECT id, recurrence, process_after, content, status FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')"
      ).all() as any[];
      for (const r of rows) {
        tasks.push({
          origId: r.id,
          sessionId: sessId,
          recurrence: r.recurrence || null,
          processAfter: r.process_after || null,
          content: r.content,
          status: r.status,
        });
      }
    } catch { /* DB may be corrupt or locked */ }
    finally { try { sdb?.close(); } catch { /* */ } }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// V1 → V2 migration: package a v1 NanoClaw instance's agent data into a
// v4-compatible archive buffer. Generic — works for any v1 instance path.
// ---------------------------------------------------------------------------

/** Inbound DB schema (duplicated from src/db/schema.ts to keep dashboard self-contained). */
const V2_INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL,
  timestamp TEXT NOT NULL, status TEXT DEFAULT 'pending', process_after TEXT,
  recurrence TEXT, tries INTEGER DEFAULT 0, platform_id TEXT,
  channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id TEXT PRIMARY KEY, platform_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS destinations (
  name TEXT PRIMARY KEY, display_name TEXT, type TEXT NOT NULL,
  channel_type TEXT, platform_id TEXT, agent_group_id TEXT
);
CREATE TABLE IF NOT EXISTS session_routing (
  id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT
);`;

/** Outbound DB schema. */
const V2_OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT,
  timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT,
  kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT,
  thread_id TEXT, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);`;

/** V1 directories to skip entirely when collecting group files. */
const V1_SKIP_GROUP_DIRS = /^(node_modules|build|cmake-.*|conda.*|dist|target|__pycache__|\.cache|venv|\.venv)$/;

/**
 * Parse v1 conversation markdown files into inbound/outbound message pairs.
 * V1 format: alternating `**User**:` and `**AgentName**:` blocks.
 * User blocks contain `<message ... time="Apr 10, 2026, 1:10 PM">text</message>` XML.
 * Returns arrays ready for DB insertion.
 */
/**
 * Compose the v1 base CLAUDE.md from a v1 instance's own template files.
 * Mirrors v1's composeClaudeMd() logic: global base + \n\n---\n\n + each section.
 * Returns null if the template files aren't found (e.g. very old v1 instance).
 */
function composeV1Base(v1Root: string): string | null {
  const globalPath = join(v1Root, 'groups', 'global', 'CLAUDE.md');
  if (!existsSync(globalPath)) return null;

  let composed = readFileSync(globalPath, 'utf-8');

  // Read manifest to discover section order (default: dashboard-formatting, coworker-extensions)
  const manifestPath = join(v1Root, 'groups', 'templates', 'manifests', 'coworker.yaml');
  let sections = ['dashboard-formatting', 'coworker-extensions']; // v1 default
  if (existsSync(manifestPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require('js-yaml');
      const manifest = yaml.load(readFileSync(manifestPath, 'utf-8')) as any;
      if (Array.isArray(manifest?.sections)) sections = manifest.sections;
    } catch { /* use defaults */ }
  }

  const sectionsDir = join(v1Root, 'groups', 'templates', 'sections');
  for (const section of sections) {
    const sectionPath = join(sectionsDir, `${section}.md`);
    if (existsSync(sectionPath)) {
      composed += `\n\n---\n\n${readFileSync(sectionPath, 'utf-8')}`;
    }
  }

  // Project overlays (sorted alphabetically)
  const projectsDir = join(v1Root, 'groups', 'templates', 'projects');
  if (existsSync(projectsDir)) {
    try {
      const projects = readdirSync(projectsDir).sort();
      for (const proj of projects) {
        const overlayPath = join(projectsDir, proj, 'coworker-base.md');
        if (existsSync(overlayPath)) {
          composed += `\n\n---\n\n${readFileSync(overlayPath, 'utf-8')}`;
        }
      }
    } catch { /* no overlays */ }
  }

  return composed;
}

/**
 * Strip lego spine content from a CLAUDE.md so only user-authored lines remain.
 * Used during V1 import of typed coworkers to extract the custom delta.
 */
function stripLegoSpineContent(instructions: string, coworkerType: string): string {
  let spine: string;
  try {
    const req = createRequire(import.meta.url);
    const { composeCoworkerSpine } = req(join(getProjectRoot(), 'dist', 'claude-composer.js'));
    spine = composeCoworkerSpine({ coworkerType });
  } catch { return instructions; }
  const spineLines = new Set(spine.split('\n').map(l => l.trim()).filter(l => l.length > 0));
  const legoHeaders = new Set([
    '## Identity', '## Invariants', '## Context', '## Workflows Available',
    '## Skills Available', '## Trait Bindings', '## Workflow Customizations',
    '### Safety invariants', '### Truthfulness invariants', '### Scope invariants',
  ]);
  const filtered = instructions.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    if (legoHeaders.has(trimmed)) return false;
    if (spineLines.has(trimmed)) return false;
    return true;
  });
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const line of filtered) {
    const blank = line.trim().length === 0;
    if (blank && prevBlank) continue;
    collapsed.push(line);
    prevBlank = blank;
  }
  const result = collapsed.join('\n').trim();
  const meaningful = result.split('\n').filter(l => l.trim().length > 0);
  return meaningful.length < 5 ? '' : result;
}

/**
 * Package a v1 NanoClaw agent into a v4-format archive buffer.
 * Works with any v1 instance — pass the root path and folder name.
 */
async function packageV1Archive(
  v1Root: string,
  folder: string,
): Promise<{ buffer: Buffer; agentName: string; stats: Record<string, number> }> {
  const tarStream = await import('tar-stream');
  const { Readable } = await import('stream');

  const v1GroupDir = join(v1Root, 'groups', folder);
  const v1SessionDir = join(v1Root, 'data', 'sessions', folder);
  const v1StoreDb = join(v1Root, 'store', 'messages.db');

  if (!existsSync(v1GroupDir)) throw new Error(`V1 group dir not found: ${v1GroupDir}`);

  const stats = { groupFiles: 0, claudeFiles: 0, tasks: 0 };

  // 1. Read agent metadata from v1 store/messages.db
  let agentName = folder.replace(/^dashboard_/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  let triggerPattern = `@${agentName.replace(/\s+/g, '')}`;
  let v1SessionId: string | null = null;
  let coworkerType: string | null = null;
  let allowedMcpTools: string | null = null;
  let containerConfig: string | null = null;
  const v1Tasks: any[] = [];
  const v1Messages: any[] = [];

  if (existsSync(v1StoreDb)) {
    let sdb: Database | null = null;
    try {
      sdb = new Database(v1StoreDb, { readonly: true });
      sdb.pragma('busy_timeout = 3000');

      // registered_groups
      const reg = sdb.prepare('SELECT * FROM registered_groups WHERE folder = ?').get(folder) as any;
      if (reg) {
        agentName = reg.name || agentName;
        triggerPattern = reg.trigger_pattern || triggerPattern;
        coworkerType = reg.coworker_type || null;
        allowedMcpTools = reg.allowed_mcp_tools || null;
        containerConfig = reg.container_config || null;
      }

      // sessions
      const sess = sdb.prepare('SELECT session_id FROM sessions WHERE group_folder = ?').get(folder) as any;
      if (sess) v1SessionId = sess.session_id;

      // scheduled_tasks
      const tasks = sdb.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ?').all(folder) as any[];
      for (const t of tasks) v1Tasks.push(t);

      // messages — v1 stores chat history in the central messages table
      // keyed by chat_jid = 'dashboard:{short_name}' where short_name = folder minus 'dashboard_'
      try {
        const shortName = folder.replace(/^dashboard_/, '');
        const chatJid = `dashboard:${shortName}`;
        const msgs = sdb.prepare(
          'SELECT id, content, timestamp, is_from_me, is_bot_message, sender, sender_name FROM messages WHERE chat_jid = ? ORDER BY timestamp'
        ).all(chatJid) as any[];
        for (const m of msgs) v1Messages.push(m);
      } catch { /* messages table may not exist in older v1 instances */ }
    } catch { /* v1 DB may not exist or have different schema */ }
    finally { try { sdb?.close(); } catch { /* */ } }
  }

  // Fallback: if V1 DB didn't have coworkerType, look up from coworkers/*.yaml
  if (!coworkerType) {
    try {
      const jsYamlLookup = await import('js-yaml');
      const coworkersDir = join(dirname(dirname(import.meta.url.replace('file://', ''))), 'coworkers');
      const yamlCandidates = [
        join(coworkersDir, `${folder}.yaml`),
        join(coworkersDir, `${folder.replace(/^dashboard_/, '')}.yaml`),
      ];
      for (const yp of yamlCandidates) {
        if (existsSync(yp)) {
          const parsed = jsYamlLookup.load(readFileSync(yp, 'utf-8')) as any;
          if (parsed?.agent?.coworkerType) {
            coworkerType = parsed.agent.coworkerType;
            if (parsed.agent.allowedMcpTools && !allowedMcpTools) {
              allowedMcpTools = JSON.stringify(parsed.agent.allowedMcpTools);
            }
            break;
          }
        }
      }
    } catch { /* YAML lookup is best-effort */ }
  }

  // 2. Extract custom instructions from CLAUDE.md.
  // V1 composed CLAUDE.md = base (groups/global/CLAUDE.md) + sections
  // (templates/sections/*.md) + optional role templates (typed coworkers).
  // V2 recomposes from its own base + sections + .instructions.md, so we
  // must extract only the custom delta — not the shared boilerplate.
  //
  // Algorithm:
  //   a) Compose the v1 base from the v1 instance's own template files.
  //   b) If the agent's CLAUDE.md starts with that base → delta is everything
  //      after the base (the claudeMdAppend content, or role template for typed).
  //   c) If it doesn't match → fully rewritten static coworker; entire file
  //      is the instructions.
  //   d) For typed coworkers whose delta matches role templates, v2 will
  //      recompose from coworker-types.json, so we store coworkerType in the
  //      manifest and the instructions can be empty. BUT we still extract the
  //      delta in case v2 doesn't have the same role templates.
  let instructions = '';
  const claudeMdPath = join(v1GroupDir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const fullClaudeMd = readFileSync(claudeMdPath, 'utf-8');
    const v1Base = composeV1Base(v1Root);
    if (v1Base && fullClaudeMd.startsWith(v1Base)) {
      // Base matches — extract only the delta
      instructions = fullClaudeMd.slice(v1Base.length).replace(/^\n*---\n*/, '\n').trimStart();
    } else {
      // Fully rewritten — use entire file
      instructions = fullClaudeMd;
    }
  }

  // 3. Collect group files (skip repo clones and heavy dirs)
  const groupFiles = new Map<string, string>();
  function collectV1GroupFiles(dir: string, relPrefix: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (V1_SKIP_GROUP_DIRS.test(entry)) continue;
        collectV1GroupFiles(abs, rel);
      } else if (st.isFile()) {
        if (entry === 'CLAUDE.md' || entry === '.claude-global.md') continue;
        if (st.size > MAX_SINGLE_FILE_SIZE) continue;
        groupFiles.set(rel, abs);
      }
    }
  }
  collectV1GroupFiles(v1GroupDir, '');
  stats.groupFiles = groupFiles.size;

  // 4. Collect .claude/ session state → remap to .claude-shared/ with -workspace-agent
  const claudeFiles = new Map<string, string>();
  const v1ClaudeDir = join(v1SessionDir, '.claude');
  if (existsSync(v1ClaudeDir)) {
    function collectClaudeV1(dir: string, relPrefix: string): void {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const abs = join(dir, entry);
        let rel = relPrefix ? `${relPrefix}/${entry}` : entry;
        let st: ReturnType<typeof statSync>;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) {
          if (entry === 'agent-runner-src') continue; // Reinitialised at session start
          collectClaudeV1(abs, rel);
        } else if (st.isFile()) {
          if (st.size > MAX_SINGLE_FILE_SIZE) continue;
          // Path rename: -workspace-group → -workspace-agent
          rel = rel.replace(/-workspace-group/g, '-workspace-agent');
          claudeFiles.set(rel, abs);
        }
      }
    }
    collectClaudeV1(v1ClaudeDir, '');
  }
  stats.claudeFiles = claudeFiles.size;
  stats.tasks = v1Tasks.filter(t => t.status === 'active').length;

  // 5. Build v4 manifest
  const jsYaml = await import('js-yaml');
  const manifest: Record<string, unknown> = {
    version: 4,
    archiveFormat: 'full',
    sourceFormat: 'v1',
    exportedAt: new Date().toISOString(),
    sourceInstance: v1Root,
    requires: null,
    agent: {
      name: agentName,
      folder,
      coworkerType: coworkerType || null,
      allowedMcpTools: allowedMcpTools ? JSON.parse(allowedMcpTools) : null,
      agentProvider: null,
      containerConfig: containerConfig ? JSON.parse(containerConfig) : null,
    },
    instructions: instructions || null,
    instructionTemplate: null,
    trigger: triggerPattern,
    destinations: null,
    sessions: v1SessionId ? [{ origId: `v1-${folder}`, status: 'active', v1SessionId }] : [],
    scheduledTasks: v1Tasks.filter(t => t.status === 'active' || t.status === 'paused').map(t => ({
      origId: t.id,
      recurrence: t.schedule_type === 'cron' ? t.schedule_value : null,
      processAfter: toSqliteDatetime(t.next_run),
      content: JSON.stringify({ prompt: t.prompt, script: t.script || null }),
      importStatus: 'paused',
      v1ScheduleType: t.schedule_type,
      v1ScheduleValue: t.schedule_value,
    })),
    memory: null,
    // V1 chat messages from the central messages table — backfilled into
    // session DBs during import so the dashboard chat shows history.
    chatMessages: v1Messages.map(m => ({
      id: m.id,
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: m.is_from_me,
      isBotMessage: m.is_bot_message,
      sender: m.sender,
      senderName: m.sender_name,
    })),
  };

  // 6. Pack tar.gz
  const pack = tarStream.pack();
  const manifestYaml = jsYaml.dump(manifest, { lineWidth: 120, noRefs: true });
  pack.entry({ name: 'manifest.yaml' }, manifestYaml);

  // Instructions as .instructions.md in group-files
  if (instructions) {
    const instrBuf = Buffer.from(instructions, 'utf-8');
    pack.entry({ name: 'group-files/.instructions.md', size: instrBuf.length }, instrBuf);
  }

  for (const [rel, abs] of groupFiles) {
    const data = readFileSync(abs);
    pack.entry({ name: `group-files/${rel}`, size: data.length }, data);
  }

  for (const [rel, abs] of claudeFiles) {
    const data = readFileSync(abs);
    pack.entry({ name: `claude-shared/${rel}`, size: data.length }, data);
  }

  pack.finalize();

  // Collect into buffer
  const { createGzip: gz } = await import('zlib');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gzip = gz();
    pack.pipe(gzip);
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.on('end', () => resolve({ buffer: Buffer.concat(chunks), agentName, stats }));
    gzip.on('error', (err: Error) => reject(err));
  });
}

/** Extract archive from gzipped tarball buffer. Validates security constraints.
 *  Returns manifest + files as Buffers keyed by archive-relative path. */
async function extractArchiveBuffer(
  buffer: Buffer,
): Promise<{ manifest: any; files: Map<string, Buffer> }> {
  const tarStream = await import('tar-stream');
  const { Readable, PassThrough } = await import('stream');
  const { createGunzip: gunzip } = await import('zlib');

  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    const files = new Map<string, Buffer>();
    let manifest: any = null;
    let totalSize = 0;
    let entryCount = 0;

    extract.on('entry', (header: any, stream: any, next: () => void) => {
      entryCount++;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        stream.resume();
        return reject(new Error(`Archive exceeds ${MAX_ARCHIVE_ENTRIES} entries`));
      }

      const name = header.name;
      // Security: reject path traversal, absolute paths, null bytes
      if (name.includes('..') || name.startsWith('/') || name.includes('\0')) {
        stream.resume();
        return reject(new Error(`Unsafe path in archive: ${name}`));
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_EXTRACTED_SIZE) {
          return reject(new Error(`Archive exceeds ${MAX_EXTRACTED_SIZE} bytes when extracted`));
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        if (header.type === 'file') {
          // Normalize: strip leading ./ if present
          const normalized = name.replace(/^\.\//, '');
          if (normalized === 'manifest.yaml' || normalized === 'manifest.yml') {
            try {
              manifest = JSON.parse(data.toString('utf-8'));
            } catch {
              // Try YAML parse at the end
              manifest = data;
            }
          }
          files.set(normalized, data);
        }
        next();
      });
      stream.on('error', (err: Error) => reject(err));
    });

    extract.on('finish', async () => {
      // Parse manifest if it was YAML
      if (manifest instanceof Buffer) {
        try {
          const jsYaml = await import('js-yaml');
          manifest = jsYaml.load(manifest.toString('utf-8'));
        } catch {
          try { manifest = JSON.parse(manifest.toString('utf-8')); } catch {
            return reject(new Error('Failed to parse manifest'));
          }
        }
      }
      if (!manifest) return reject(new Error('Archive missing manifest.yaml'));
      resolve({ manifest, files });
    });

    extract.on('error', (err: Error) => reject(err));

    // Pipe: buffer → gunzip → tar extract
    const readable = Readable.from(buffer);
    const gunzipStream = gunzip();
    gunzipStream.on('error', (err: Error) => reject(new Error(`Gunzip failed: ${err.message}`)));
    readable.pipe(gunzipStream).pipe(extract);
  });
}

/** Exported for testing — handles all HTTP requests. */
export async function handleRequest(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${getDashboardPort()}`);

  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    const secret = getDashboardSecret();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        required: Boolean(secret),
        authenticated: isDashboardAuthenticated(req, secret),
      }),
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/session') {
    const configuredSecret = getDashboardSecret();
    if (!configuredSecret) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"required":false}');
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body) as { secret?: unknown };
      const submittedSecret = typeof parsed.secret === 'string' ? parsed.secret : '';
      if (submittedSecret !== configuredSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid dashboard secret"}');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': buildAuthCookie(configuredSecret),
      });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"invalid json"}');
    }
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/auth/session') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': buildAuthCookie('', true),
    });
    res.end('{"ok":true}');
    return;
  }

  // API: receive hook events from containers
  if (req.method === 'POST' && url.pathname === '/api/hook-event') {
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const raw = JSON.parse(body);
      // Normalize Claude Code's native HTTP hook payload into our HookEvent format.
      // HTTP hooks send the raw SDK JSON with different field names than our old
      // bash-script format. We accept both for backwards compatibility.
      const event: HookEvent = {
        group: raw.group || (req.headers['x-group-folder'] as string) || '',
        event: raw.event || raw.hook_event_name || '',
        tool: raw.tool || raw.tool_name || undefined,
        message: raw.message || raw.notification || raw.prompt || undefined,
        tool_input:
          typeof raw.tool_input === 'string'
            ? raw.tool_input
            : raw.tool_input
              ? JSON.stringify(raw.tool_input)
              : undefined,
        tool_response:
          typeof raw.tool_response === 'string'
            ? raw.tool_response
            : typeof raw.tool_result === 'string'
              ? raw.tool_result
              : raw.tool_result
                ? JSON.stringify(raw.tool_result)
                : raw.tool_response
                  ? JSON.stringify(raw.tool_response)
                  : undefined,
        tool_use_id: raw.tool_use_id || undefined,
        session_id: raw.session_id || undefined,
        agent_id: raw.agent_id || undefined,
        agent_type: raw.agent_type || undefined,
        transcript_path: raw.transcript_path || raw.agent_transcript_path || undefined,
        cwd: raw.cwd || undefined,
        timestamp: Date.now(),
      } as HookEvent;

      // Pack additional fields into extra
      const extra: Record<string, any> = {};
      if (typeof raw.extra === 'object' && raw.extra !== null) {
        Object.assign(extra, raw.extra);
      } else if (typeof raw.extra === 'string') {
        try {
          Object.assign(extra, JSON.parse(raw.extra));
        } catch {
          /* ignore */
        }
      }
      // Capture event-specific fields that aren't in our core schema
      for (const key of [
        'source',
        'stop_hook_active',
        'files_modified',
        'error_message',
        'error_code',
        'error',
        'is_interrupt',
        'tool_count',
        'permission_mode',
        'model',
        'last_assistant_message',
        'compact_summary',
        'trigger',
        'custom_instructions',
        'teammate_name',
        'team_name',
        'task_id',
        'task_subject',
        'task_description',
        'file_path',
        'memory_type',
        'load_reason',
        'notification_type',
        'mcp_server_name',
        'permission_suggestions',
      ]) {
        if (raw[key] !== undefined && raw[key] !== null) extra[key] = raw[key];
      }
      event.extra = Object.keys(extra).length > 0 ? extra : undefined;

      // All events go into ring buffer (including PreToolUse for tool-pair correlation)
      hookEvents.push(event);
      if (hookEvents.length > MAX_HOOK_EVENTS) hookEvents.shift();

      // Persist to database
      const heDb = getHookEventsDb();
      if (heDb) {
        try {
          heDb
            .prepare(
              `INSERT INTO hook_events
            (group_folder, event, tool, tool_use_id, message, tool_input, tool_response,
             session_id, agent_id, agent_type, transcript_path, cwd, extra, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              event.group || '',
              event.event || '',
              event.tool || null,
              event.tool_use_id || null,
              event.message || null,
              event.tool_input || null,
              event.tool_response || null,
              event.session_id || null,
              event.agent_id || null,
              event.agent_type || null,
              event.transcript_path || null,
              event.cwd || null,
              event.extra ? JSON.stringify(event.extra) : null,
              event.timestamp,
            );
        } catch {
          /* DB write failure — non-fatal */
        }
      }

      // Update live state
      if (event.group) {
        hookEverSeen.add(event.group);
        const prev = liveHookState.get(event.group);
        const isStopEvent = event.event === 'Stop' || event.event === 'SessionEnd';
        const isActiveEvent = !isStopEvent && event.event !== 'Notification';
        const nextStatus = classifyEventStatus(event, prev?.status || 'working');
        liveHookState.set(event.group, {
          tool: isStopEvent ? undefined : event.tool || prev?.tool,
          notification: event.message || prev?.notification,
          status: nextStatus,
          ts: Date.now(),
          agentActive: isStopEvent ? false : isActiveEvent || prev?.agentActive || false,
        });
      }
      updateLiveSubagentState(event);

      broadcastState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
    }
    return;
  }

  // API: get current state
  if (url.pathname === '/api/state') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getState()));
    return;
  }

  if (url.pathname === '/api/events') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'state', data: getState() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // API: get coworker types
  if (url.pathname === '/api/types') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getCoworkerTypes()));
    return;
  }

  // API: get coworker CLAUDE.md
  // Returns X-Readonly: true header for typed coworkers (CLAUDE.md rebuilt from templates)
  if (req.method === 'GET' && url.pathname.startsWith('/api/memory/')) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/memory/', ''));
    if (folder === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const raw = url.searchParams.get('raw') === '1';
    const groupDir = resolve(getGroupsDir(), folder);
    if (!isInsideDir(getGroupsDir(), groupDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      let content: string;
      if (!raw) {
        // Default: live composed preview — compute on the fly for typed
        // coworkers; untyped coworkers ship .instructions.md verbatim.
        try {
          const { composeCoworkerSpine } = await import('../src/claude-composer.js');
          const rdb = db;
          let coworkerType: string | null = null;
          if (rdb) {
            const row = rdb.prepare('SELECT coworker_type FROM agent_groups WHERE folder = ?').get(folder) as any;
            coworkerType = row?.coworker_type || null;
          }
          let extraInstructions: string | null = null;
          try {
            extraInstructions = readFileSync(join(groupDir, '.instructions.md'), 'utf-8');
          } catch {
            /* none */
          }
          if (coworkerType) {
            content = composeCoworkerSpine({ coworkerType, extraInstructions });
          } else {
            content = readFileSync(join(groupDir, 'CLAUDE.md'), 'utf-8');
          }
        } catch {
          // Fallback to reading the file if compositor not available
          content = readFileSync(join(groupDir, 'CLAUDE.md'), 'utf-8');
        }
        headers['X-Readonly'] = 'true';
        headers['X-Readonly-Reason'] = 'System-composed (edit .instructions.md instead)';
      } else {
        // Return raw .instructions.md for editing
        try {
          content = readFileSync(join(groupDir, '.instructions.md'), 'utf-8');
        } catch {
          content = '';
        }
      }
      res.writeHead(200, headers);
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // API: get hook events filtered by group
  if (url.pathname === '/api/hook-events') {
    if (!requireAuth(req, res)) return;
    const group = url.searchParams.get('group');
    const filtered = group ? hookEvents.filter((e) => e.group === group) : hookEvents;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filtered.slice(-200)));
    return;
  }

  // API: paginated hook event history from DB
  if (url.pathname === '/api/hook-events/history') {
    if (!requireAuth(req, res)) return;
    const heDb = getHookEventsDb();
    if (!heDb) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const group = url.searchParams.get('group');
    const sessionId = url.searchParams.get('session_id');
    const eventFilter = url.searchParams.get('event');
    const since = url.searchParams.get('since');
    const before = url.searchParams.get('before');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

    const conditions: string[] = [];
    const params: any[] = [];
    if (group) {
      conditions.push('group_folder = ?');
      params.push(group);
    }
    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }
    if (eventFilter) {
      conditions.push('event = ?');
      params.push(eventFilter);
    }
    if (since) {
      conditions.push('timestamp >= ?');
      params.push(parseInt(since, 10));
    }
    if (before) {
      conditions.push('timestamp < ?');
      params.push(parseInt(before, 10));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const rows = heDb
        .prepare(`SELECT * FROM hook_events ${where} ORDER BY timestamp DESC LIMIT ?`)
        .all(...params, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: list distinct sessions from hook_events
  if (url.pathname === '/api/hook-events/sessions') {
    if (!requireAuth(req, res)) return;
    const heDb = getHookEventsDb();
    if (!heDb) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const group = url.searchParams.get('group');
    try {
      const query = group
        ? `SELECT session_id, group_folder, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as event_count
           FROM hook_events WHERE session_id IS NOT NULL AND session_id != '' AND group_folder = ?
           GROUP BY session_id ORDER BY last_ts DESC LIMIT 50`
        : `SELECT session_id, group_folder, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as event_count
           FROM hook_events WHERE session_id IS NOT NULL AND session_id != ''
           GROUP BY session_id ORDER BY last_ts DESC LIMIT 50`;
      const rows = group ? heDb.prepare(query).all(group) : heDb.prepare(query).all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: structured session flow — pairs Pre/PostToolUse, nests subagents
  if (url.pathname === '/api/hook-events/session-flow') {
    if (!requireAuth(req, res)) return;
    const heDb = getHookEventsDb();
    const group = url.searchParams.get('group');
    const sessionId = url.searchParams.get('session_id');
    if (!heDb || !sessionId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"entries":[]}');
      return;
    }
    try {
      const conditions = ['session_id = ?'];
      const params: any[] = [sessionId];
      if (group) {
        conditions.push('group_folder = ?');
        params.push(group);
      }
      const rows: any[] = heDb
        .prepare(`SELECT * FROM hook_events WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC`)
        .all(...params);

      // Build structured flow entries
      const entries: any[] = [];
      const preToolMap = new Map<string, any>(); // tool_use_id -> PreToolUse row
      const subagentStack: any[] = []; // nested subagent tracking

      for (const row of rows) {
        const extra = row.extra ? JSON.parse(row.extra) : {};

        if (row.event === 'SessionStart') {
          entries.push({ type: 'session_start', timestamp: row.timestamp, extra });
        } else if (row.event === 'UserPromptSubmit') {
          entries.push({ type: 'user_prompt', timestamp: row.timestamp, message: row.message || '' });
        } else if (row.event === 'PreToolUse') {
          if (row.tool_use_id) preToolMap.set(row.tool_use_id, row);
        } else if (row.event === 'PostToolUse' || row.event === 'PostToolUseFailure') {
          const pre = row.tool_use_id ? preToolMap.get(row.tool_use_id) : null;
          const duration = pre ? row.timestamp - pre.timestamp : null;
          const entry: any = {
            type: 'tool_call',
            tool: row.tool,
            tool_use_id: row.tool_use_id,
            timestamp: row.timestamp,
            duration,
            tool_input: row.tool_input,
            tool_response: row.tool_response,
            failed: row.event === 'PostToolUseFailure',
            agent_id: row.agent_id,
          };
          if (subagentStack.length > 0) {
            subagentStack[subagentStack.length - 1].children.push(entry);
          } else {
            entries.push(entry);
          }
          if (row.tool_use_id) preToolMap.delete(row.tool_use_id);
        } else if (row.event === 'SubagentStart') {
          const block: any = {
            type: 'subagent_block',
            agent_id: row.agent_id,
            agent_type: row.agent_type,
            timestamp: row.timestamp,
            children: [],
          };
          subagentStack.push(block);
        } else if (row.event === 'SubagentStop') {
          const block = subagentStack.pop();
          if (block) {
            block.end_timestamp = row.timestamp;
            block.duration = row.timestamp - block.timestamp;
            if (subagentStack.length > 0) {
              subagentStack[subagentStack.length - 1].children.push(block);
            } else {
              entries.push(block);
            }
          }
        } else if (row.event === 'PreCompact') {
          entries.push({ type: 'compact', timestamp: row.timestamp });
        } else if (row.event === 'Notification') {
          entries.push({ type: 'notification', timestamp: row.timestamp, message: row.message || '' });
        } else if (row.event === 'Stop' || row.event === 'SessionEnd') {
          entries.push({ type: 'session_end', timestamp: row.timestamp, extra });
        }
      }

      // Flush any unclosed subagent blocks
      while (subagentStack.length > 0) {
        const block = subagentStack.pop()!;
        if (subagentStack.length > 0) {
          subagentStack[subagentStack.length - 1].children.push(block);
        } else {
          entries.push(block);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: download an attachment from a delivered dashboard message
  if (req.method === 'GET' && url.pathname === '/api/messages/attachment') {
    if (!requireAuth(req, res)) return;
    const agentGroupId = url.searchParams.get('agentGroupId') || '';
    const sessionId = url.searchParams.get('sessionId') || '';
    const messageId = url.searchParams.get('messageId') || '';
    const fileName = url.searchParams.get('name') || '';
    if (!agentGroupId || !sessionId || !messageId || !fileName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"agentGroupId, sessionId, messageId, and name are required"}');
      return;
    }

    const attachmentDir = join(getDataDir(), 'v2-sessions', agentGroupId, sessionId, 'outbox', messageId);
    const fullPath = join(attachmentDir, fileName);
    if (!isInsideDir(attachmentDir, fullPath)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const mime = getMessageAttachmentMimeType(fileName);
    const isImage = mime.startsWith('image/');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': isImage ? 'inline' : `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`,
    });
    res.end(readFileSync(fullPath));
    return;
  }

  // API: get recent messages — v2 reads from per-session inbound/outbound DBs
  if (url.pathname === '/api/messages') {
    if (!requireAuth(req, res)) return;
    const group = url.searchParams.get('group');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    let messages: any[] = [];
    const hasMore = false;
    if (db) {
      try {
        // When group is specified, load messages for that group only; otherwise load all groups
        const agRows = group
          ? [db.prepare('SELECT id, folder FROM agent_groups WHERE folder = ?').get(group) as any].filter(Boolean)
          : (db.prepare('SELECT id, folder FROM agent_groups').all() as any[]);
        const perGroupLimit = group ? limit : Math.ceil(limit / Math.max(agRows.length, 1));
        for (const agRow of agRows) {
          const sessions = db
            .prepare("SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active'")
            .all(agRow.id) as { id: string }[];
          const sessionsDir = join(getDataDir(), 'v2-sessions', agRow.id);
          for (const sess of sessions) {
            const inDbPath = join(sessionsDir, sess.id, 'inbound.db');
            const outDbPath = join(sessionsDir, sess.id, 'outbound.db');
            try {
              const deliveredByMessageOutId = new Map<string, { platformMessageId: string | null; status: string | null }>();
              if (existsSync(inDbPath)) {
                const sdb = new Database(inDbPath, { readonly: true });
                try {
                  const deliveredRows = sdb
                    .prepare('SELECT message_out_id, platform_message_id, status FROM delivered')
                    .all() as Array<{ message_out_id: string; platform_message_id: string | null; status: string | null }>;
                  for (const row of deliveredRows) {
                    deliveredByMessageOutId.set(row.message_out_id, {
                      platformMessageId: row.platform_message_id ?? null,
                      status: row.status ?? null,
                    });
                  }
                } catch {
                  /* delivered table may not exist in older sessions */
                }
                const rows = sdb
                  .prepare('SELECT id, kind, content, timestamp FROM messages_in ORDER BY timestamp DESC LIMIT ?')
                  .all(perGroupLimit) as any[];
                for (const r of rows) {
                  messages.push({
                    ...r,
                    direction: 'incoming',
                    agent_group_id: agRow.id,
                    group_folder: agRow.folder,
                    session_id: sess.id,
                  });
                }
                sdb.close();
              }
              if (existsSync(outDbPath)) {
                const sdb = new Database(outDbPath, { readonly: true });
                const rows = sdb
                  .prepare('SELECT id, kind, content, timestamp FROM messages_out ORDER BY timestamp DESC LIMIT ?')
                  .all(perGroupLimit) as any[];
                for (const r of rows) {
                  const delivered = deliveredByMessageOutId.get(r.id);
                  messages.push({
                    ...r,
                    direction: 'outgoing',
                    agent_group_id: agRow.id,
                    group_folder: agRow.folder,
                    session_id: sess.id,
                    body: r.content,
                    platformMessageId: delivered?.platformMessageId ?? null,
                    deliveryStatus: delivered?.status ?? null,
                  });
                }
                sdb.close();
              }
            } catch {
              /* session DB may not exist or be locked */
            }
          }
        }
        // Normalize timestamps before sort (outbound uses SQLite datetime, inbound uses ISO)
        for (const m of messages) {
          if (m.timestamp && !m.timestamp.includes('T')) {
            m.timestamp = m.timestamp.replace(' ', 'T') + '.000Z';
          }
        }
        // Normalize content — extracts cardType, questionId, options, credentialId
        for (const m of messages) {
          normalizeMessageForDisplay(m);
          if (m.direction === 'outgoing' && m.agent_group_id && m.session_id && Array.isArray(m.fileNames)) {
            m.attachments = buildMessageAttachments(m.agent_group_id, m.session_id, m.id, m.fileNames);
          }
          // Enrich with pending status so the client knows whether to show buttons
          if (m.cardType === 'ask_question' && m.questionId) {
            m.isPending = !!getPendingQuestionRow(m.questionId);
          } else if (m.cardType === 'credential_request' && m.credentialId) {
            m.isPending = !!getPendingCredentialRow(m.credentialId);
          }
        }
        messages = applyMessageOperations(messages);
        // Sort descending (newest first)
        messages.sort(compareMessagesDescending);
        messages = messages.slice(0, limit);
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages, hasMore }));
    return;
  }

  // API: admin overview stats
  if (url.pathname === '/api/overview') {
    if (!requireAuth(req, res)) return;
    const result: any = {
      uptime: process.uptime(),
      groups: { total: 0 },
      tasks: { active: 0, paused: 0, completed: 0 },
      messages: { total: 0 },
      sessions: 0,
    };
    if (db) {
      try {
        result.groups.total = (db.prepare('SELECT COUNT(*) as c FROM agent_groups').get() as any)?.c || 0;
        result.messages.total = (db.prepare('SELECT COUNT(*) as c FROM hook_events').get() as any)?.c || 0;
        result.sessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any)?.c || 0;
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: tasks — v2 does not have a central scheduled_tasks table
  if (url.pathname === '/api/tasks') {
    if (!requireAuth(req, res)) return;
    const allTasks: any[] = [];
    if (db) {
      try {
        const groups = db.prepare('SELECT id, folder, name FROM agent_groups').all() as any[];
        for (const g of groups) {
          const { sessionIds } = collectSessionDbFiles(g.id);
          const tasks = extractScheduledTasks(g.id, sessionIds);
          for (const t of tasks) {
            // Parse content JSON to extract prompt
            let prompt = '';
            try { prompt = JSON.parse(t.content)?.prompt || ''; } catch { prompt = t.content || ''; }
            // Map v2 status to frontend expected values
            const status = t.status === 'pending' ? 'active' : t.status;
            allTasks.push({
              id: t.origId,
              group_folder: g.folder,
              group_name: g.name,
              prompt,
              schedule_type: t.recurrence ? 'cron' : 'once',
              schedule_value: t.recurrence || t.processAfter || '',
              status,
              last_run: null,
              sessionId: t.sessionId,
              agentGroupId: g.id,
            });
          }
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allTasks));
    return;
  }

  // API: pause/resume task
  if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/(pause|resume)$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const parts = url.pathname.split('/');
    const action = parts.pop()!;
    const taskId = safeDecode(parts.pop()!);
    if (!taskId) { res.writeHead(400); res.end('bad request'); return; }
    const newStatus = action === 'pause' ? 'paused' : 'pending';
    let found = false;
    if (db) {
      try {
        const groups = db.prepare('SELECT id FROM agent_groups').all() as any[];
        for (const g of groups) {
          if (found) break;
          const agDir = join(getDataDir(), 'v2-sessions', g.id);
          let entries: string[];
          try { entries = readdirSync(agDir); } catch { continue; }
          for (const entry of entries) {
            if (!entry.startsWith('sess-')) continue;
            const dbPath = join(agDir, entry, 'inbound.db');
            if (!existsSync(dbPath)) continue;
            let sdb: Database.Database | null = null;
            try {
              sdb = new Database(dbPath);
              sdb.pragma('busy_timeout = 3000');
              const result = sdb.prepare("UPDATE messages_in SET status = ? WHERE id = ? AND kind = 'task'").run(newStatus, taskId);
              if (result.changes > 0) { found = true; break; }
            } catch { /* */ }
            finally { try { sdb?.close(); } catch { /* */ } }
          }
        }
      } catch { /* */ }
    }
    res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(found ? { ok: true, status: newStatus } : { error: 'task not found' }));
    return;
  }

  // API: delete task
  if (req.method === 'DELETE' && /^\/api\/tasks\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const taskId = safeDecode(url.pathname.replace('/api/tasks/', ''));
    if (!taskId) { res.writeHead(400); res.end('bad request'); return; }
    let found = false;
    if (db) {
      try {
        const groups = db.prepare('SELECT id FROM agent_groups').all() as any[];
        for (const g of groups) {
          if (found) break;
          const agDir = join(getDataDir(), 'v2-sessions', g.id);
          let entries: string[];
          try { entries = readdirSync(agDir); } catch { continue; }
          for (const entry of entries) {
            if (!entry.startsWith('sess-')) continue;
            const dbPath = join(agDir, entry, 'inbound.db');
            if (!existsSync(dbPath)) continue;
            let sdb: Database.Database | null = null;
            try {
              sdb = new Database(dbPath);
              sdb.pragma('busy_timeout = 3000');
              const result = sdb.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'task'").run(taskId);
              if (result.changes > 0) { found = true; break; }
            } catch { /* */ }
            finally { try { sdb?.close(); } catch { /* */ } }
          }
        }
      } catch { /* */ }
    }
    res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(found ? { ok: true } : { error: 'task not found' }));
    return;
  }

  // API: list sessions
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    if (!requireAuth(req, res)) return;
    let sessions: any[] = [];
    if (db) {
      try {
        sessions = db
          .prepare(
            'SELECT s.id as session_id, s.agent_group_id, s.status, s.container_status, s.last_active, ag.name as group_name, ag.folder as group_folder FROM sessions s LEFT JOIN agent_groups ag ON s.agent_group_id = ag.id',
          )
          .all();
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // API: delete sessions for a group folder
  if (req.method === 'DELETE' && /^\/api\/sessions\//.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/sessions/', ''));
    if (folder === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const wdb = getWriteDb();
    if (wdb) {
      try {
        wdb.prepare('DELETE FROM sessions WHERE group_folder=?').run(folder);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: list skills
  // API: list available instruction overlay templates
  if (req.method === 'GET' && url.pathname === '/api/instruction-templates') {
    if (!requireAuth(req, res)) return;
    const templatesDir = join(getGroupsDir(), 'templates', 'instructions');
    const templates: { name: string; content: string }[] = [];
    try {
      if (existsSync(templatesDir)) {
        for (const file of readdirSync(templatesDir).sort()) {
          if (!file.endsWith('.md')) continue;
          const name = file.replace(/\.md$/, '');
          try {
            const content = readFileSync(join(templatesDir, file), 'utf-8');
            templates.push({ name, content });
          } catch { /* unreadable */ }
        }
      }
    } catch { /* dir missing */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(templates));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    if (!requireAuth(req, res)) return;
    const skills: any[] = [];
    try {
      if (existsSync(getSkillsDir())) {
        for (const name of readdirSync(getSkillsDir())) {
          const skillDir = join(getSkillsDir(), name);
          if (!statSync(skillDir).isDirectory()) continue;
          const info: any = { name, enabled: !existsSync(join(skillDir, '.disabled')), files: [] };
          const skillMd = join(skillDir, 'SKILL.md');
          if (existsSync(skillMd)) {
            const content = readFileSync(skillMd, 'utf-8');
            const titleMatch = content.match(/^#\s+(.+)/m);
            info.title = titleMatch ? titleMatch[1] : name;
            info.description =
              content
                .split('\n')
                .find((l: string) => l.trim() && !l.startsWith('#'))
                ?.trim() || '';
          }
          info.files = readdirSync(skillDir).filter((f: string) => !f.startsWith('.'));
          skills.push(info);
        }
      }
    } catch {
      /* ignore */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(skills));
    return;
  }

  // API: toggle skill enabled/disabled
  if (req.method === 'POST' && /^\/api\/skills\/[^/]+\/toggle$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.match(/\/api\/skills\/([^/]+)\/toggle/)![1]);
    if (name === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const skillDir = resolve(getSkillsDir(), name);
    if (!isInsideDir(getSkillsDir(), skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const disabledFile = join(skillDir, '.disabled');
    let enabled: boolean;
    try {
      if (existsSync(disabledFile)) {
        unlinkSync(disabledFile);
        enabled = true;
      } else {
        writeFileSync(disabledFile, '');
        enabled = false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: group details
  if (req.method === 'GET' && url.pathname === '/api/groups/detail') {
    if (!requireAuth(req, res)) return;
    let groups: any[] = [];
    if (db) {
      try {
        groups = db.prepare('SELECT * FROM agent_groups').all() as any[];
        for (const g of groups) {
          // Count sessions
          g.sessionCount =
            (db.prepare('SELECT COUNT(*) as c FROM sessions WHERE agent_group_id = ?').get(g.id) as any)?.c || 0;
          // Enrich with trigger_pattern and jid from messaging tables
          try {
            const mga = db.prepare(
              `SELECT mga.engage_mode, mga.engage_pattern, mg.platform_id
               FROM messaging_group_agents mga
               JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
               WHERE mga.agent_group_id = ?
               LIMIT 1`,
            ).get(g.id) as any;
            if (mga) {
              g.trigger_pattern = (mga.engage_mode === 'pattern' && mga.engage_pattern) ? mga.engage_pattern : null;
              g.jid = mga.platform_id || null;
            }
          } catch { /* ignore */ }
          // Read composed CLAUDE.md for preview (typed coworkers only;
          // untyped fall back to the on-disk file).
          try {
            const { composeCoworkerSpine } = await import('../src/claude-composer.js');
            let coworkerType: string | null = null;
            try {
              const row = db.prepare('SELECT coworker_type FROM agent_groups WHERE folder = ?').get(g.folder) as any;
              coworkerType = row?.coworker_type || null;
            } catch {
              /* ignore */
            }
            if (coworkerType) {
              let extraInstructions: string | null = null;
              try {
                extraInstructions = readFileSync(join(getGroupsDir(), g.folder, '.instructions.md'), 'utf-8');
              } catch {
                /* none */
              }
              g.memory = composeCoworkerSpine({ coworkerType, extraInstructions });
            } else {
              g.memory = readFileSync(join(getGroupsDir(), g.folder, 'CLAUDE.md'), 'utf-8');
            }
          } catch {
            const mdPath = join(getGroupsDir(), g.folder, 'CLAUDE.md');
            try {
              g.memory = readFileSync(mdPath, 'utf-8');
            } catch {
              g.memory = null;
            }
          }
          // Read raw .instructions.md for editor
          try {
            g.rawMemory = readFileSync(join(getGroupsDir(), g.folder, '.instructions.md'), 'utf-8');
          } catch {
            g.rawMemory = '';
          }
          // Check for running container (from async cache)
          g.containerRunning = hasRunningContainer(g.folder);
          // Include destinations for peer/channel visibility
          try {
            g.destinations = db
              .prepare('SELECT local_name, target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
              .all(g.id);
          } catch {
            g.destinations = [];
          }
        }
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(groups));
    return;
  }

  // API: create coworker
  if (req.method === 'POST' && url.pathname === '/api/coworkers') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { name, folder, types, type, trigger, instructions, instructionTemplate, agentProvider } = JSON.parse(body);
      if (!name || !folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"name and folder required"}');
        return;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid folder name (alphanumeric, hyphens, underscores, 1-64 chars)"}');
        return;
      }
      {
        const hasAdmin = getWriteDb()?.prepare('SELECT 1 FROM agent_groups WHERE is_admin = 1 LIMIT 1').get();
        if ((folder === 'global' || folder === 'main') && hasAdmin) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"reserved folder name"}');
          return;
        }
      }
      const wdb = getWriteDb();
      if (!wdb) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"db unavailable"}');
        return;
      }
      const existing = wdb.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(folder);
      if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"error":"coworker already exists with this folder or JID"}');
        return;
      }

      // Resolve coworkerType: single type, or composite from multiple
      const selectedTypes: string[] = types || (type ? [type] : []);
      let coworkerType: string | null = null;
      if (selectedTypes.length === 1) {
        coworkerType = selectedTypes[0];
      } else if (selectedTypes.length > 1) {
        // Create composite entry in coworker-types.json
        const allTypes = getCoworkerTypes();
        const compositeKey = selectedTypes.join('+');
        if (!allTypes[compositeKey]) {
          const templates: string[] = [];
          const focusFiles: string[] = [];
          const descriptions: string[] = [];
          const mcpToolsSet = new Set<string>();
          for (const t of selectedTypes) {
            const entry = allTypes[t];
            if (entry) {
              const tpls = Array.isArray(entry.template) ? entry.template : [entry.template];
              templates.push(...tpls);
              if (entry.focusFiles) focusFiles.push(...entry.focusFiles);
              if (entry.allowedMcpTools) entry.allowedMcpTools.forEach((tool: string) => mcpToolsSet.add(tool));
              descriptions.push(entry.description || t);
            }
          }
          allTypes[compositeKey] = {
            description: descriptions.join(' + '),
            template: templates,
            extends: 'slang-build',
            focusFiles,
            allowedMcpTools: [...mcpToolsSet],
          };
          writeFileSync(getCoworkerTypesPath(), JSON.stringify(allTypes, null, 2) + '\n');
          cachedTypes = null; // invalidate cache
        }
        coworkerType = compositeKey;
      }

      const groupDir = join(getGroupsDir(), folder);
      mkdirSync(groupDir, { recursive: true });
      const triggerCandidate = trigger || `@${name.replace(/\s+/g, '')}`;
      const triggerPattern = getUniqueTrigger(wdb, triggerCandidate);
      const now = new Date().toISOString();
      // Resolve MCP tools from coworker type
      const allTypesNow = getCoworkerTypes();
      const resolvedMcpTools =
        coworkerType && allTypesNow[coworkerType]?.allowedMcpTools
          ? JSON.stringify(allTypesNow[coworkerType].allowedMcpTools)
          : null;
      const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const hasAdmin = wdb.prepare('SELECT 1 FROM agent_groups WHERE is_admin = 1 LIMIT 1').get();
      const isAdmin = hasAdmin ? 0 : 1;
      if (!coworkerType) coworkerType = isAdmin ? 'main' : 'global';
      wdb
        .prepare(
          'INSERT INTO agent_groups (id, name, folder, is_admin, agent_provider, container_config, coworker_type, allowed_mcp_tools, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
        )
        .run(agId, name, folder, isAdmin, agentProvider || null, coworkerType, resolvedMcpTools, now);
      const { messagingGroupId } = ensureDashboardChatWiring(wdb, { id: agId, folder, name }, triggerPattern, now);
      bootstrapEagerSession(wdb, agId, messagingGroupId, now);

      // Grant dashboard-admin the owner role so strict sender policy works
      if (isAdmin) {
        const dashUserId = 'dashboard:dashboard-admin';
        try {
          wdb.prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES ('system', 'system', 'System', ?)").run(now);
          wdb.prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', 'Dashboard Admin', ?)").run(dashUserId, now);
          wdb.prepare("INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, 'system', ?)").run(dashUserId, now);
        } catch { /* tables may not exist if permissions module not installed */ }
      }

      // Wire parent↔child agent destinations (same as delivery.ts create_agent)
      const adminGroup = wdb.prepare('SELECT id, name, folder FROM agent_groups WHERE is_admin = 1 LIMIT 1').get() as
        | { id: string; name: string; folder: string }
        | undefined;
      if (adminGroup) {
        const localName = normalizeDestinationName(name);
        const existingAdminDest = wdb
          .prepare("SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'agent' AND target_id = ? LIMIT 1")
          .get(adminGroup.id, agId);
        if (!existingAdminDest) {
          const destName = allocateDestinationNameDb(wdb, adminGroup.id, localName);
          wdb
            .prepare("INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, 'agent', ?, ?)")
            .run(adminGroup.id, destName, agId, now);
        }
        const existingParentDest = wdb
          .prepare("SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'agent' AND target_id = ? LIMIT 1")
          .get(agId, adminGroup.id);
        if (!existingParentDest) {
          const parentName = allocateDestinationNameDb(wdb, agId, 'parent');
          wdb
            .prepare("INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, 'agent', ?, ?)")
            .run(agId, parentName, adminGroup.id, now);
        }
      }

      // Write .instructions.md if provided (CLAUDE.md is system-composed on wake)
      if (instructions && typeof instructions === 'string' && instructions.trim()) {
        mkdirSync(groupDir, { recursive: true });
        writeFileSync(join(groupDir, '.instructions.md'), instructions.trim() + '\n');
      }
      // Preserve which instruction overlay was used (for export portability)
      if (instructionTemplate && typeof instructionTemplate === 'string') {
        mkdirSync(groupDir, { recursive: true });
        writeFileSync(join(groupDir, '.instruction-meta.json'), JSON.stringify({ template: instructionTemplate }));
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: agId, folder, name, trigger: triggerPattern }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: update coworker
  if (req.method === 'PUT' && /^\/api\/coworkers\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', ''));
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const updates = JSON.parse(body);
      const wdb = getWriteDb();
      if (!wdb) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"db unavailable"}');
        return;
      }
      const existing = wdb.prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as any;
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"coworker not found"}');
        return;
      }
      if (updates.name) {
        wdb.prepare('UPDATE agent_groups SET name = ? WHERE folder = ?').run(updates.name, folder);
      }
      // v2: trigger_pattern is in messaging_group_agents.engage_pattern, not agent_groups
      // Updating triggers from dashboard is deferred — use the host's manage-channels flow
      if (updates.container_config !== undefined) {
        wdb
          .prepare('UPDATE agent_groups SET container_config = ? WHERE folder = ?')
          .run(updates.container_config ? JSON.stringify(updates.container_config) : null, folder);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: get container name for shell exec
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/container$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/container', ''));
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }
    const found = findRunningContainer(folder);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        running: !!found,
        container: found,
        execCommand: found ? `docker exec -it ${found} bash` : null,
      }),
    );
    return;
  }

  // API: execute command in container
  if (req.method === 'POST' && /^\/api\/coworkers\/[^/]+\/exec$/.test(url.pathname)) {
    if (!requireStrictAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/exec', ''));
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { command } = JSON.parse(body);
      if (!command || typeof command !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"command required"}');
        return;
      }
      // Find running container
      const found = findRunningContainer(folder);
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"no running container"}');
        return;
      }
      // Execute command (timeout 10s, max 64KB output)
      exec(
        `docker exec ${found} bash -c ${JSON.stringify(command)}`,
        { timeout: 10000, maxBuffer: 65536 },
        (err, stdout, stderr) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              exitCode: err?.code || 0,
              stdout: stdout?.slice(0, 32768) || '',
              stderr: stderr?.slice(0, 8192) || '',
            }),
          );
        },
      );
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: export coworker as YAML bundle
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/export$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/export', ''));
    if (!folder) { res.writeHead(400); res.end('{"error":"invalid folder"}'); return; }
    const rdb = getHookEventsDb();
    if (!rdb) { res.writeHead(500); res.end('{"error":"db unavailable"}'); return; }

    const group = rdb.prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as any;
    if (!group) { res.writeHead(404); res.end('{"error":"coworker not found"}'); return; }

    // Export mode: lightweight | standard | full
    //   lightweight — metadata only (version, agent, requires, trigger, destinations,
    //                 instructionTemplate). New instance rehydrates identity/invariants/
    //                 context/workflows/skills from its coworker type. Smallest bundle.
    //   standard    — lightweight + .instructions.md + memory snapshot. Preserves
    //                 user-specific overlay and agent memory. Default.
    //   full        — standard + full tar.gz archive of group dir, claude-shared, and
    //                 session DBs. Used for cross-instance migration/backup.
    // Backwards-compat: ?full=true maps to mode=full.
    const rawMode = url.searchParams.get('mode');
    const mode: 'lightweight' | 'standard' | 'full' =
      rawMode === 'lightweight' || rawMode === 'standard' || rawMode === 'full'
        ? rawMode
        : url.searchParams.get('full') === 'true'
          ? 'full'
          : 'standard';
    const includeInstructions = mode !== 'lightweight';
    const includeMemory = mode !== 'lightweight';

    // .instructions.md (user-owned instructions) — only read if needed
    let instructions = '';
    if (includeInstructions) {
      try { instructions = readFileSync(join(getGroupsDir(), folder, '.instructions.md'), 'utf-8'); } catch { /* none */ }
    }

    // Resolve trigger from messaging_group_agents
    let trigger = `@${group.name.replace(/\s+/g, '')}`;
    try {
      const mgaRow = rdb.prepare(
        "SELECT mga.engage_mode, mga.engage_pattern FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id = mga.messaging_group_id WHERE mga.agent_group_id = ? LIMIT 1"
      ).get(group.id) as any;
      if (mgaRow?.engage_mode === 'pattern' && mgaRow?.engage_pattern) {
        trigger = mgaRow.engage_pattern;
      }
    } catch { /* use default */ }

    // Destinations
    const destinations: { name: string; type: string; targetFolder?: string; channelType?: string; platformId?: string }[] = [];
    try {
      const destRows = rdb.prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ?').all(group.id) as any[];
      for (const d of destRows) {
        if (d.target_type === 'agent') {
          const targetAg = rdb.prepare('SELECT folder FROM agent_groups WHERE id = ?').get(d.target_id) as any;
          destinations.push({ name: d.local_name, type: 'agent', targetFolder: targetAg?.folder || d.target_id });
        } else if (d.target_type === 'channel') {
          const mg = rdb.prepare('SELECT channel_type, platform_id FROM messaging_groups WHERE id = ?').get(d.target_id) as any;
          destinations.push({ name: d.local_name, type: 'channel', channelType: mg?.channel_type, platformId: mg?.platform_id });
        }
      }
    } catch { /* no destinations */ }

    // Export only config files needed to reconstruct the coworker.
    // Runtime artifacts (cloned repos, compiled binaries, installed tools) are
    // rebuilt by the agent after import — they don't belong in the export.
    const groupDir = join(getGroupsDir(), folder);

    // Collect compatibility requirements so the target instance can validate
    const requires: Record<string, unknown> = {};
    if (group.coworker_type) {
      const rootTypes = group.coworker_type.split('+').map((t: string) => t.trim()).filter(Boolean);
      const typesData = readLegoCoworkerTypes();
      const allRequired = new Set<string>();
      const walk = (name: string | undefined): void => {
        if (!name || allRequired.has(name)) return;
        allRequired.add(name);
        const ext = typesData[name]?.extends;
        if (Array.isArray(ext)) ext.forEach(walk);
        else walk(ext);
      };
      rootTypes.forEach(walk);
      requires.coworkerTypes = allRequired.size > 0 ? [...allRequired] : rootTypes;
    }

    // Agent memory files (from container's ~/.claude project memory) — only read if needed
    const memoryFiles: Record<string, string> = {};
    if (includeMemory) {
      try {
        const memDir = join(getDataDir(), 'v2-sessions', group.id, '.claude-shared', 'projects', '-workspace-agent', 'memory');
        for (const f of readdirSync(memDir)) {
          if (!f.endsWith('.md')) continue;
          memoryFiles[f] = readFileSync(join(memDir, f), 'utf-8');
        }
      } catch { /* no memory dir or files */ }
    }

    // Shared agent metadata for both lightweight and full-archive exports
    const agentMeta = {
      name: group.name,
      folder: group.folder,
      coworkerType: group.coworker_type || null,
      allowedMcpTools: group.allowed_mcp_tools ? JSON.parse(group.allowed_mcp_tools) : null,
      agentProvider: group.agent_provider || null,
      containerConfig: group.container_config ? JSON.parse(group.container_config) : null,
    };
    const instructionTemplate = (() => {
      try {
        const meta = JSON.parse(readFileSync(join(getGroupsDir(), folder, '.instruction-meta.json'), 'utf-8'));
        return meta.template || null;
      } catch { return null; }
    })();

    // ---- Full-archive export (mode=full) ----
    if (mode === 'full') {
      try {
        const tarStream = await import('tar-stream');
        const pack = tarStream.pack();

        // Collect all files
        const groupFiles = collectGroupFiles(groupDir);
        const claudeSharedFiles = collectClaudeShared(group.id);
        const { files: sessionDbFiles, sessionIds } = collectSessionDbFiles(group.id);
        const scheduledTasks = extractScheduledTasks(group.id, sessionIds);

        // Session rows from v2.db
        const sessionRows = rdb.prepare(
          'SELECT * FROM sessions WHERE agent_group_id = ?'
        ).all(group.id) as any[];

        // Build v4 manifest
        const manifest: Record<string, unknown> = {
          version: 4,
          archiveFormat: 'full',
          exportedAt: new Date().toISOString(),
          sourceInstance: process.env.CONTAINER_PREFIX || 'unknown',
          requires: Object.keys(requires).length > 0 ? requires : null,
          agent: agentMeta,
          instructions: instructions || null,
          instructionTemplate,
          trigger,
          destinations: destinations.length > 0 ? destinations : null,
          sessions: sessionRows.map((s: any) => ({
            origId: s.id,
            status: s.status,
            agentProvider: s.agent_provider || null,
          })),
          scheduledTasks: scheduledTasks.map(t => ({
            origId: t.origId,
            sessionId: t.sessionId,
            recurrence: t.recurrence,
            processAfter: t.processAfter,
            content: t.content,
            importStatus: 'paused',
          })),
          memory: Object.keys(memoryFiles).length > 0 ? memoryFiles : null,
        };

        // Write manifest
        const jsYaml = await import('js-yaml');
        const manifestYaml = jsYaml.dump(manifest, { lineWidth: 120, noRefs: true });
        pack.entry({ name: 'manifest.yaml' }, manifestYaml);

        // Write group-files/
        for (const [rel, abs] of groupFiles) {
          const data = readFileSync(abs);
          pack.entry({ name: `group-files/${rel}`, size: data.length }, data);
        }

        // Write claude-shared/
        for (const [rel, abs] of claudeSharedFiles) {
          const data = readFileSync(abs);
          pack.entry({ name: `claude-shared/${rel}`, size: data.length }, data);
        }

        // Write sessions/
        for (const [rel, abs] of sessionDbFiles) {
          const data = readFileSync(abs);
          pack.entry({ name: rel, size: data.length }, data);
        }

        pack.finalize();

        // Collect the gzipped archive into a buffer and write to disk
        const gzip = createGzip();
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          pack.pipe(gzip)
            .on('data', (chunk: Buffer) => chunks.push(chunk))
            .on('end', resolve)
            .on('error', reject);
        });
        const archiveData = Buffer.concat(chunks);

        const exportsDir = join(getDataDir(), 'exports');
        mkdirSync(exportsDir, { recursive: true });
        const filename = `agent-${folder}-${new Date().toISOString().split('T')[0]}-full.tar.gz`;
        const exportPath = join(exportsDir, filename);
        writeFileSync(exportPath, archiveData);

        // Optionally pause source tasks
        let pausedTasks = false;
        if (url.searchParams.get('pauseTasks') === 'true') {
          for (const sessId of sessionIds) {
            const dbPath = join(getDataDir(), 'v2-sessions', group.id, sessId, 'inbound.db');
            if (!existsSync(dbPath)) continue;
            let sdb: Database | null = null;
            try {
              sdb = new Database(dbPath);
              sdb.pragma('journal_mode = DELETE');
              sdb.pragma('busy_timeout = 5000');
              sdb.prepare("UPDATE messages_in SET status = 'paused' WHERE kind = 'task' AND status = 'pending'").run();
              pausedTasks = true;
            } catch { /* best-effort */ }
            finally { try { sdb?.close(); } catch { /* */ } }
          }
        }

        // Also generate YAML bundle pointing at the archive and write to coworkers/
        const yamlBundle: Record<string, unknown> = {
          version: 3,
          exportedAt: new Date().toISOString(),
          requires: Object.keys(requires).length > 0 ? requires : null,
          agent: agentMeta,
          instructions: instructions || null,
          instructionTemplate,
          trigger,
          destinations: destinations.length > 0 ? destinations : null,
          memory: Object.keys(memoryFiles).length > 0 ? memoryFiles : null,
          archive: exportPath,
        };
        let yamlPath: string | undefined;
        try {
          const jsYaml2 = await import('js-yaml');
          const yamlContent = jsYaml2.dump(yamlBundle, { lineWidth: 120, noRefs: true });
          const coworkersDir = join(getProjectRoot(), 'coworkers');
          mkdirSync(coworkersDir, { recursive: true });
          yamlPath = join(coworkersDir, `${folder}.yaml`);
          writeFileSync(yamlPath, yamlContent);
        } catch { /* best-effort */ }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: exportPath, yamlPath, size: archiveData.length, pausedTasks }));
      } catch (archiveErr: any) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Full archive export failed: ${archiveErr.message}` }));
        }
      }
      return;
    }

    // ---- YAML export (lightweight / standard) ----
    // lightweight: metadata only — re-instantiates from the local lego registry.
    // standard:    lightweight + .instructions.md overlay + agent memory snapshot.
    const { sessionIds: lightSessionIds } = collectSessionDbFiles(group.id);
    const lightScheduledTasks = extractScheduledTasks(group.id, lightSessionIds);
    const bundle: Record<string, unknown> = {
      version: 3,
      exportedAt: new Date().toISOString(),
      mode,
      requires: Object.keys(requires).length > 0 ? requires : null,
      agent: agentMeta,
      instructionTemplate,
      trigger,
      destinations: destinations.length > 0 ? destinations : null,
      scheduledTasks: lightScheduledTasks.length > 0 ? lightScheduledTasks.map(t => ({
        recurrence: t.recurrence,
        processAfter: t.processAfter,
        content: t.content,
      })) : null,
    };
    if (includeInstructions) bundle.instructions = instructions || null;
    if (includeMemory) bundle.memory = Object.keys(memoryFiles).length > 0 ? memoryFiles : null;

    // Use js-yaml for YAML output
    let yamlContent: string;
    try {
      const jsYaml = await import('js-yaml');
      yamlContent = jsYaml.dump(bundle, { lineWidth: 120, noRefs: true });
    } catch {
      // Fallback to JSON if js-yaml not available
      yamlContent = JSON.stringify(bundle, null, 2);
    }

    // Write to both data/exports/ and coworkers/
    const exportsDir = join(getDataDir(), 'exports');
    mkdirSync(exportsDir, { recursive: true });
    const filename = `agent-${folder}-${new Date().toISOString().split('T')[0]}.yaml`;
    const exportPath = join(exportsDir, filename);
    writeFileSync(exportPath, yamlContent);

    const coworkersDir = join(getProjectRoot(), 'coworkers');
    mkdirSync(coworkersDir, { recursive: true });
    const coworkerYamlPath = join(coworkersDir, `${folder}.yaml`);
    writeFileSync(coworkerYamlPath, yamlContent);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: exportPath, yamlPath: coworkerYamlPath, size: Buffer.byteLength(yamlContent) }));
    return;
  }

  // API: import coworker from YAML, JSON, or full archive (transactional)
  if (req.method === 'POST' && url.pathname === '/api/coworkers/import') {
    if (!requireAuth(req, res)) return;

    // Detect binary archive by content-type
    const ct = req.headers['content-type'] || '';
    const isBinaryArchive = ct.includes('application/gzip') || ct.includes('application/x-gzip') || ct.includes('application/octet-stream');

    if (isBinaryArchive) {
      // ---- Full-archive import ----
      const archiveBuf = await readBodyBinary(req, res);
      if (!archiveBuf) return;
      try {
        const { manifest, files } = await extractArchiveBuffer(archiveBuf);

        if (manifest.version !== 4 || manifest.archiveFormat !== 'full') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Expected v4 full-archive manifest"}');
          return;
        }

        const agent = manifest.agent;
        if (!agent?.name || !agent?.folder) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"invalid archive — missing agent name/folder"}');
          return;
        }

        const wdb = getWriteDb();
        if (!wdb) { res.writeHead(500); res.end('{"error":"db unavailable"}'); return; }

        const warnings: string[] = [];

        // Compatibility check: warn if required types are missing from the local lego registry
        if (manifest.requires?.coworkerTypes) {
          const localTypes = readLegoCoworkerTypes();
          for (const t of manifest.requires.coworkerTypes) {
            if (!localTypes[t]) warnings.push(`Missing coworker type: "${t}" — install its provider skill before this agent will compose correctly`);
          }
        }

        const triggerCandidate = manifest.trigger || `@${agent.name.replace(/\s+/g, '')}`;
        const trigger = getUniqueTrigger(wdb, triggerCandidate);
        let folder = agent.folder.replace(/[^a-zA-Z0-9_-]/g, '-');
        { // Unique folder allocator
          const baseFolder = folder;
          let suffix = 2;
          while (wdb.prepare('SELECT 1 FROM agent_groups WHERE folder = ?').get(folder)) {
            folder = `${baseFolder}-${suffix}`;
            suffix++;
          }
        }

        const now = new Date().toISOString();
        const newAgId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Build session ID map
        const sessionMap = new Map<string, string>(); // origId → newId
        const manifestSessions: any[] = manifest.sessions || [];
        for (const s of manifestSessions) {
          const newSessId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          sessionMap.set(s.origId, newSessId);
        }

        // 1. Back up target v2.db before merge
        const dbPath = getDbPath();
        const backupPath = `${dbPath}.backup-${Date.now()}`;
        try { copyFileSync(dbPath, backupPath); } catch (e: any) {
          warnings.push(`DB backup failed: ${e.message} — proceeding without backup`);
        }

        // 2. Stage group-files
        const groupDir = join(getGroupsDir(), folder);
        const stagingDir = join(getDataDir(), 'v2-import-staging', newAgId);
        try {
          mkdirSync(stagingDir, { recursive: true });
          for (const [archivePath, buf] of files) {
            if (!archivePath.startsWith('group-files/')) continue;
            const rel = archivePath.slice('group-files/'.length);
            if (!rel || rel.includes('..')) continue;
            const dst = join(stagingDir, rel);
            mkdirSync(dirname(dst), { recursive: true });
            writeFileSync(dst, buf);
          }
        } catch (fsErr: any) {
          try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* */ }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Import staging failed: ${fsErr.message}` }));
          return;
        }

        // 3. Copy claude-shared
        const claudeSharedDir = join(getDataDir(), 'v2-sessions', newAgId, '.claude-shared');
        try {
          for (const [archivePath, buf] of files) {
            if (!archivePath.startsWith('claude-shared/')) continue;
            const rel = archivePath.slice('claude-shared/'.length);
            if (!rel || rel.includes('..')) continue;
            const dst = join(claudeSharedDir, rel);
            mkdirSync(dirname(dst), { recursive: true });
            writeFileSync(dst, buf);
          }
        } catch (csErr: any) {
          warnings.push(`Claude shared restore partial: ${csErr.message}`);
        }

        // 4. Copy session DBs with ID remapping + patch tasks to paused
        const isV1Source = manifest.sourceFormat === 'v1';
        let sessionsRestored = 0;
        let tasksImported = 0;

        if (isV1Source) {
          // V1 → V2: bootstrap session DBs from scratch
          for (const [origId, newId] of sessionMap) {
            const sessDir = join(getDataDir(), 'v2-sessions', newAgId, newId);
            mkdirSync(sessDir, { recursive: true });

            const ms = manifestSessions.find((s: any) => s.origId === origId);
            const v1SessionId = ms?.v1SessionId || null;

            // Create inbound.db with schema
            const inDbPath = join(sessDir, 'inbound.db');
            let inDb: Database | null = null;
            try {
              inDb = new Database(inDbPath);
              inDb.pragma('journal_mode = DELETE');
              inDb.exec(V2_INBOUND_SCHEMA);

              // Insert v1 scheduled tasks as messages_in rows (paused)
              if (Array.isArray(manifest.scheduledTasks)) {
                let seq = 2; // even seq for host-written
                for (const task of manifest.scheduledTasks) {
                  inDb.prepare(
                    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, content)
                     VALUES (?, ?, 'task', ?, 'paused', ?, ?, ?)`
                  ).run(
                    task.origId,
                    seq,
                    now,
                    toSqliteDatetime(task.processAfter),
                    task.recurrence || null,
                    typeof task.content === 'string' ? task.content : JSON.stringify(task.content),
                  );
                  seq += 2;
                  tasksImported++;
                }
              }
            } catch { /* best effort */ }
            finally { try { inDb?.close(); } catch { /* */ } }

            // Create outbound.db with schema + session_state (for session resume)
            const outDbPath = join(sessDir, 'outbound.db');
            let outDb: Database | null = null;
            try {
              outDb = new Database(outDbPath);
              outDb.pragma('journal_mode = DELETE');
              outDb.exec(V2_OUTBOUND_SCHEMA);

              if (v1SessionId) {
                outDb.prepare(
                  "INSERT INTO session_state (key, value, updated_at) VALUES ('claude_sdk_session_id', ?, ?)"
                ).run(v1SessionId, now);
              }
            } catch { /* best effort */ }
            finally { try { outDb?.close(); } catch { /* */ } }

            // Backfill v1 chat messages from the central messages table.
            // This is the canonical source — v1 stores all chat history in
            // store/messages.db, keyed by chat_jid.
            const chatMsgs = Array.isArray(manifest.chatMessages) ? manifest.chatMessages : [];
            if (chatMsgs.length > 0) {
              const chatIn = chatMsgs.filter((m: any) => m.isFromMe === 0 && !m.isBotMessage);
              const chatOut = chatMsgs.filter((m: any) => m.isFromMe === 1 || m.isBotMessage === 1);
              let inDb2: Database | null = null;
              let outDb2: Database | null = null;
              try {
                inDb2 = new Database(inDbPath);
                inDb2.pragma('busy_timeout = 3000');
                const maxSeq = (inDb2.prepare('SELECT MAX(seq) as m FROM messages_in').get() as any)?.m || 0;
                let inSeq = maxSeq + 2;
                const inStmt = inDb2.prepare(
                  `INSERT OR IGNORE INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', ?, 'completed', ?)`
                );
                for (const msg of chatIn) {
                  const content = JSON.stringify({ text: msg.content, sender: msg.sender || 'dashboard', senderId: msg.sender || 'v1-import' });
                  inStmt.run(msg.id, inSeq, msg.timestamp, content);
                  inSeq += 2;
                }
              } catch { /* best effort */ }
              finally { try { inDb2?.close(); } catch { /* */ } }
              try {
                outDb2 = new Database(outDbPath);
                outDb2.pragma('busy_timeout = 3000');
                let outSeq = 1;
                const outStmt = outDb2.prepare(
                  `INSERT OR IGNORE INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', ?, ?)`
                );
                for (const msg of chatOut) {
                  outStmt.run(msg.id, outSeq, msg.timestamp, JSON.stringify({ text: msg.content }));
                  outSeq += 2;
                }
              } catch { /* best effort */ }
              finally { try { outDb2?.close(); } catch { /* */ } }
            }

            sessionsRestored++;
          }
        } else {
          // V2 → V2: copy existing session DBs as-is
          for (const [origId, newId] of sessionMap) {
            const sessDir = join(getDataDir(), 'v2-sessions', newAgId, newId);
            mkdirSync(sessDir, { recursive: true });
            for (const dbFile of ['inbound.db', 'outbound.db']) {
              const archiveKey = `sessions/${origId}/${dbFile}`;
              const buf = files.get(archiveKey);
              if (buf) {
                writeFileSync(join(sessDir, dbFile), buf);
              }
            }
            // Patch tasks to paused in inbound.db
            const inDbPath = join(sessDir, 'inbound.db');
            if (existsSync(inDbPath)) {
              let sdb: Database | null = null;
              try {
                sdb = new Database(inDbPath);
                sdb.pragma('journal_mode = DELETE');
                sdb.pragma('busy_timeout = 5000');
                const taskCount = (sdb.prepare(
                  "SELECT COUNT(*) as c FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')"
                ).get() as any).c;
                tasksImported += taskCount;
                sdb.prepare("UPDATE messages_in SET status = 'paused' WHERE kind = 'task' AND status = 'pending'").run();
              } catch { /* DB may not have schema yet */ }
              finally { try { sdb?.close(); } catch { /* */ } }
            }
            sessionsRestored++;
          }
        }

        // 5. DB transaction — insert agent group + sessions + wiring
        let destsCreated = 0;
        const unresolvedDests: string[] = [];
        const resolvedDests: { name: string; type: string; resolvedTo: string }[] = [];
        try {
          wdb.exec('BEGIN TRANSACTION');
          wdb.prepare(
            'INSERT INTO agent_groups (id, name, folder, is_admin, agent_provider, container_config, coworker_type, allowed_mcp_tools, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)'
          ).run(
            newAgId, agent.name, folder,
            agent.agentProvider || null,
            agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
            agent.coworkerType || null,
            agent.allowedMcpTools ? JSON.stringify(agent.allowedMcpTools) : null,
            now,
          );

          // Insert session rows
          for (const ms of manifestSessions) {
            const newSessId = sessionMap.get(ms.origId)!;
            wdb.prepare(
              'INSERT INTO sessions (id, agent_group_id, status, agent_provider, container_status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(newSessId, newAgId, ms.status || 'active', ms.agentProvider || agent.agentProvider || null, 'stopped', now);
          }

          ensureDashboardChatWiring(wdb, { id: newAgId, folder, name: agent.name }, trigger, now);

          // Destinations — resolve by folder name
          if (Array.isArray(manifest.destinations)) {
            for (const dest of manifest.destinations) {
              if (!dest.name || !dest.type) continue;
              let targetId: string | null = null;
              let resolvedLabel = '';
              if (dest.type === 'agent' && dest.targetFolder) {
                const targetAg = wdb.prepare('SELECT id, name FROM agent_groups WHERE folder = ?').get(dest.targetFolder) as any;
                targetId = targetAg?.id || null;
                if (targetAg) resolvedLabel = `${dest.targetFolder} (${targetAg.id})`;
              } else if (dest.type === 'channel' && dest.channelType && dest.platformId) {
                const mg = wdb.prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?').get(dest.channelType, dest.platformId) as any;
                targetId = mg?.id || null;
                if (mg) resolvedLabel = `${dest.channelType}:${dest.platformId}`;
              }
              if (targetId) {
                const existingByName = getDestinationByLocalNameDb(wdb, newAgId, dest.name);
                if (!existingByName) {
                  wdb.prepare(
                    'INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)'
                  ).run(newAgId, dest.name, dest.type, targetId, now);
                  destsCreated++;
                  resolvedDests.push({ name: dest.name, type: dest.type, resolvedTo: resolvedLabel });
                }
              } else {
                unresolvedDests.push(`${dest.name} (${dest.type}: ${dest.targetFolder || dest.platformId || '?'})`);
              }
            }
          }

          wdb.exec('COMMIT');
        } catch (dbErr: any) {
          try { wdb.exec('ROLLBACK'); } catch { /* */ }
          try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* */ }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Import failed (DB): ${dbErr.message}` }));
          return;
        }

        // 6. Move staged group-files to final location
        try {
          mkdirSync(groupDir, { recursive: true });
          const copyRecursive = (src: string, dst: string) => {
            for (const entry of readdirSync(src)) {
              const srcPath = join(src, entry);
              const dstPath = join(dst, entry);
              if (statSync(srcPath).isDirectory()) {
                mkdirSync(dstPath, { recursive: true });
                copyRecursive(srcPath, dstPath);
              } else {
                writeFileSync(dstPath, readFileSync(srcPath));
              }
            }
          };
          copyRecursive(stagingDir, groupDir);
          rmSync(stagingDir, { recursive: true, force: true });
        } catch (copyErr: any) {
          warnings.push(`File copy partial: ${copyErr.message}`);
        }

        postImportGroupInit(newAgId, folder, warnings);

        for (const u of unresolvedDests) {
          warnings.push(`Unresolved destination: ${u}`);
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          folder,
          name: agent.name,
          id: newAgId,
          backupPath: existsSync(backupPath) ? backupPath : undefined,
          sessionsRestored,
          tasksImported,
          tasksPaused: true,
          destsCreated,
          resolvedDests: resolvedDests.length > 0 ? resolvedDests : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ---- Lightweight YAML/JSON import ----
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      let data: any;
      try {
        const jsYaml = await import('js-yaml');
        data = jsYaml.load(body);
      } catch {
        data = JSON.parse(body);
      }

      const isV3 = data.version === 3 && data.agent;
      const agent = isV3 ? data.agent : data.coworker;
      if (!agent?.name || !agent?.folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid bundle — missing agent name/folder"}');
        return;
      }

      const wdb = getWriteDb();
      if (!wdb) { res.writeHead(500); res.end('{"error":"db unavailable"}'); return; }

      // Compatibility check: warn if required types are missing from the local lego registry
      const warnings: string[] = [];
      if (isV3 && data.requires?.coworkerTypes) {
        const localTypes = readLegoCoworkerTypes();
        for (const t of data.requires.coworkerTypes) {
          if (!localTypes[t]) warnings.push(`Missing coworker type: "${t}" — install its provider skill before this agent will compose correctly`);
        }
      }

      const triggerCandidate = isV3 ? (data.trigger || `@${agent.name.replace(/\s+/g, '')}`) : (agent.trigger || `@${agent.name.replace(/\s+/g, '')}`);
      const trigger = getUniqueTrigger(wdb, triggerCandidate);
      let folder = agent.folder.replace(/[^a-zA-Z0-9_-]/g, '-');
      // Unique folder allocator — suffix with -2, -3, etc. on collision
      {
        const baseFolder = folder;
        let suffix = 2;
        while (wdb.prepare('SELECT 1 FROM agent_groups WHERE folder = ?').get(folder)) {
          folder = `${baseFolder}-${suffix}`;
          suffix++;
        }
      }

      const now = new Date().toISOString();
      const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const groupDir = join(getGroupsDir(), folder);
      let filesWritten = 0;
      let destsCreated = 0;
      const unresolvedDests: string[] = [];
      const resolvedDests: { name: string; type: string; resolvedTo: string }[] = [];

      // 4. Stage filesystem writes to temp dir BEFORE committing DB
      const stagingDir = join(getDataDir(), 'v2-import-staging', agId);
      try {
        mkdirSync(join(stagingDir, 'logs'), { recursive: true });

        // Write .instructions.md
        if (isV3 && data.instructions) {
          writeFileSync(join(stagingDir, '.instructions.md'), data.instructions);
        } else if (!isV3 && data.claudeMd && !agent.coworkerType) {
          writeFileSync(join(stagingDir, '.instructions.md'), data.claudeMd);
        }

        // Fix 2: Save legacy typed claudeMd as artifact for manual review
        if (!isV3 && data.claudeMd && agent.coworkerType) {
          writeFileSync(join(stagingDir, '.legacy-claude.md'), data.claudeMd);
          warnings.push('Legacy typed import: original CLAUDE.md saved as .legacy-claude.md for manual review');
        }

        // Fix 6: Save instruction template metadata if present
        if (isV3 && data.instructionTemplate) {
          writeFileSync(join(stagingDir, '.instruction-meta.json'), JSON.stringify({ template: data.instructionTemplate }));
        }

        // Write files — reject any hidden path component (starts with .)
        const bundleFiles = data.files || {};
        for (const [relPath, content] of Object.entries(bundleFiles)) {
          if (relPath.includes('..') || relPath.startsWith('/')) continue;
          // Reject any path component that starts with . (hidden files/dirs)
          const hasHiddenComponent = relPath.split('/').some(part => part.startsWith('.'));
          if (hasHiddenComponent) {
            warnings.push(`Blocked file: "${relPath}" (hidden path component)`);
            continue;
          }
          const fullPath = join(stagingDir, relPath);
          mkdirSync(join(fullPath, '..'), { recursive: true });
          writeFileSync(fullPath, content as string);
          filesWritten++;
        }
      } catch (fsErr: any) {
        // Staging failed → cleanup temp, return error (no DB changes yet)
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Import failed (filesystem staging): ${fsErr.message}` }));
        return;
      }

      // 5. Staging succeeded → now commit DB transactionally
      try {
        wdb.exec('BEGIN TRANSACTION');
        wdb.prepare(
          'INSERT INTO agent_groups (id, name, folder, is_admin, agent_provider, container_config, coworker_type, allowed_mcp_tools, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)'
        ).run(
          agId, agent.name, folder,
          agent.agentProvider || null,
          agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
          agent.coworkerType || null,
          agent.allowedMcpTools ? JSON.stringify(agent.allowedMcpTools) : null,
          now,
        );
        ensureDashboardChatWiring(wdb, { id: agId, folder, name: agent.name }, trigger, now);

        // Destinations
        if (isV3 && Array.isArray(data.destinations)) {
          for (const dest of data.destinations) {
            if (!dest.name || !dest.type) continue;
            let targetId: string | null = null;
            let resolvedLabel = '';
            if (dest.type === 'agent' && dest.targetFolder) {
              const targetAg = wdb.prepare('SELECT id, name FROM agent_groups WHERE folder = ?').get(dest.targetFolder) as any;
              targetId = targetAg?.id || null;
              if (targetAg) resolvedLabel = `${dest.targetFolder} (${targetAg.id})`;
            } else if (dest.type === 'channel' && dest.channelType && dest.platformId) {
              const mg = wdb.prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?').get(dest.channelType, dest.platformId) as any;
              targetId = mg?.id || null;
              if (mg) resolvedLabel = `${dest.channelType}:${dest.platformId}`;
            }
            if (targetId) {
              const existingByName = getDestinationByLocalNameDb(wdb, agId, dest.name);
              if (existingByName) {
                if (existingByName.target_type === dest.type && existingByName.target_id === targetId) {
                  resolvedDests.push({ name: dest.name, type: dest.type, resolvedTo: resolvedLabel });
                } else {
                  const allocatedName = allocateDestinationNameDb(wdb, agId, dest.name);
                  wdb
                    .prepare(
                      'INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
                    )
                    .run(agId, allocatedName, dest.type, targetId, now);
                  destsCreated++;
                  resolvedDests.push({ name: allocatedName, type: dest.type, resolvedTo: resolvedLabel });
                  warnings.push(`Destination "${dest.name}" renamed to "${allocatedName}" to avoid name collision`);
                }
              } else {
                wdb
                  .prepare(
                    'INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
                  )
                  .run(agId, dest.name, dest.type, targetId, now);
                destsCreated++;
                resolvedDests.push({ name: dest.name, type: dest.type, resolvedTo: resolvedLabel });
              }
            } else {
              unresolvedDests.push(`${dest.name} (${dest.type}: ${dest.targetFolder || dest.platformId || '?'})`);
            }
          }
        }

        wdb.exec('COMMIT');
      } catch (dbErr: any) {
        try { wdb.exec('ROLLBACK'); } catch { /* already rolled back */ }
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* cleanup staged files */ }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Import failed (DB): ${dbErr.message}` }));
        return;
      }

      // 6. DB committed + files staged → copy to final location
      //    If copy fails, rollback DB rows and return error.
      try {
        mkdirSync(groupDir, { recursive: true });
        const copyRecursive = (src: string, dst: string) => {
          for (const entry of readdirSync(src)) {
            const srcPath = join(src, entry);
            const dstPath = join(dst, entry);
            if (statSync(srcPath).isDirectory()) {
              mkdirSync(dstPath, { recursive: true });
              copyRecursive(srcPath, dstPath);
            } else {
              writeFileSync(dstPath, readFileSync(srcPath));
            }
          }
        };
        copyRecursive(stagingDir, groupDir);
        rmSync(stagingDir, { recursive: true, force: true });
      } catch (copyErr: any) {
        // Copy failed → rollback DB rows so we don't leave a broken agent
        try {
          wdb.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(agId);
          wdb.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agId);
          wdb.prepare("DELETE FROM messaging_groups WHERE channel_type = 'dashboard' AND platform_id = ?").run(`dashboard:${folder}`);
          wdb.prepare('DELETE FROM agent_groups WHERE id = ?').run(agId);
        } catch { /* best-effort cleanup */ }
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* cleanup */ }
        try { rmSync(groupDir, { recursive: true, force: true }); } catch { /* cleanup */ }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Import failed (file copy): ${copyErr.message}` }));
        return;
      }

      postImportGroupInit(agId, folder, warnings);

      // 7. Restore agent memory files if present in the bundle
      let memoriesRestored = 0;
      if (isV3 && data.memory && typeof data.memory === 'object') {
        try {
          const memDir = join(getDataDir(), 'v2-sessions', agId, '.claude-shared', 'projects', '-workspace-agent', 'memory');
          mkdirSync(memDir, { recursive: true });
          for (const [filename, content] of Object.entries(data.memory)) {
            if (!filename.endsWith('.md') || filename.includes('..') || filename.includes('/')) continue;
            writeFileSync(join(memDir, filename), content as string);
            memoriesRestored++;
          }
        } catch (memErr: any) {
          warnings.push(`Memory restore partial: ${memErr.message}`);
        }
      }

      // 8. Restore scheduled tasks if present in the bundle
      let tasksImported = 0;
      if (isV3 && Array.isArray(data.scheduledTasks) && data.scheduledTasks.length > 0) {
        try {
          const sessId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const sessDir = join(getDataDir(), 'v2-sessions', agId, sessId);
          mkdirSync(sessDir, { recursive: true });
          const inDbPath = join(sessDir, 'inbound.db');
          const inDb = new Database(inDbPath);
          inDb.pragma('journal_mode = DELETE');
          inDb.pragma('busy_timeout = 5000');
          inDb.exec(V2_INBOUND_SCHEMA);
          const taskNow = new Date().toISOString();
          let seq = 2;
          for (const task of data.scheduledTasks) {
            if (!task.content) continue;
            const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            inDb.prepare(
              `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, content)
               VALUES (?, ?, 'task', ?, 'paused', ?, ?, ?)`
            ).run(
              taskId, seq, taskNow,
              toSqliteDatetime(task.processAfter),
              task.recurrence || null,
              typeof task.content === 'string' ? task.content : JSON.stringify(task.content),
            );
            seq += 2;
            tasksImported++;
          }
          inDb.close();
          // Register session in central DB
          const wdb2 = getWriteDb();
          if (wdb2) {
            wdb2.prepare(
              'INSERT OR IGNORE INTO sessions (id, agent_group_id, status, created_at) VALUES (?, ?, ?, ?)'
            ).run(sessId, agId, 'active', taskNow);
          }
        } catch (taskErr: any) {
          warnings.push(`Scheduled tasks restore partial: ${taskErr.message}`);
        }
      }

      for (const u of unresolvedDests) {
        warnings.push(`Unresolved destination: ${u}`);
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        folder,
        name: agent.name,
        id: agId,
        filesWritten,
        destsCreated,
        memoriesRestored: memoriesRestored > 0 ? memoriesRestored : undefined,
        resolvedDests: resolvedDests.length > 0 ? resolvedDests : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      }));
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: import coworker from a v1 NanoClaw instance (reads v1 data directly)
  if (req.method === 'POST' && url.pathname === '/api/coworkers/import-v1') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { v1Path, folder, coworkerType: requestedType } = JSON.parse(body);
      if (!v1Path || !folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"v1Path and folder are required"}');
        return;
      }
      const resolvedV1Path = resolve(v1Path);
      const allowedV1ImportRoot = getAllowedV1ImportRoot();
      const withinAllowedV1Root =
        resolvedV1Path === allowedV1ImportRoot || isInsideDir(allowedV1ImportRoot, resolvedV1Path);
      // Security: v1Path must be an absolute path within the configured import root.
      if (!isAbsolute(v1Path) || !withinAllowedV1Root || v1Path.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `v1Path must be an absolute path under ${allowedV1ImportRoot}` }));
        return;
      }
      if (!existsSync(join(resolvedV1Path, 'groups', folder))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `V1 group not found: ${join(resolvedV1Path, 'groups', folder)}` }));
        return;
      }

      // Package v1 data into v4 archive
      const { buffer: archiveBuf, agentName, stats } = await packageV1Archive(resolvedV1Path, folder);

      // Feed into existing full-archive import flow
      const { manifest, files } = await extractArchiveBuffer(archiveBuf);

      // Re-use the import logic by simulating an internal request
      // Instead of duplicating, we'll inline the core import here
      const agent = manifest.agent;
      // Allow caller to override coworkerType (e.g. typed import from dashboard)
      if (requestedType) agent.coworkerType = requestedType;
      const wdb = getWriteDb();
      if (!wdb) { res.writeHead(500); res.end('{"error":"db unavailable"}'); return; }

      const warnings: string[] = [];
      const triggerCandidate = manifest.trigger || `@${agent.name.replace(/\s+/g, '')}`;
      const trigger = getUniqueTrigger(wdb, triggerCandidate);
      let importFolder = agent.folder.replace(/[^a-zA-Z0-9_-]/g, '-');
      { // Unique folder allocator
        const baseFolder = importFolder;
        let suffix = 2;
        while (wdb.prepare('SELECT 1 FROM agent_groups WHERE folder = ?').get(importFolder)) {
          importFolder = `${baseFolder}-${suffix}`;
          suffix++;
        }
      }

      const now = new Date().toISOString();
      const newAgId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Session ID map
      const sessionMap = new Map<string, string>();
      const manifestSessions: any[] = manifest.sessions || [];
      for (const s of manifestSessions) {
        const newSessId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        sessionMap.set(s.origId, newSessId);
      }

      // Backup v2.db
      const dbPath = getDbPath();
      const backupPath = `${dbPath}.backup-${Date.now()}`;
      try { copyFileSync(dbPath, backupPath); } catch (e: any) {
        warnings.push(`DB backup failed: ${e.message}`);
      }

      // Stage group-files
      const groupDir = join(getGroupsDir(), importFolder);
      const stagingDir = join(getDataDir(), 'v2-import-staging', newAgId);
      try {
        mkdirSync(stagingDir, { recursive: true });
        for (const [archivePath, buf] of files) {
          if (!archivePath.startsWith('group-files/')) continue;
          const rel = archivePath.slice('group-files/'.length);
          if (!rel || rel.includes('..')) continue;
          const dst = join(stagingDir, rel);
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, buf);
        }
      } catch (fsErr: any) {
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* */ }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Import staging failed: ${fsErr.message}` }));
        return;
      }

      // Strip lego spine content from .instructions.md for typed coworkers
      if (agent.coworkerType) {
        const instrPath = join(stagingDir, '.instructions.md');
        if (existsSync(instrPath)) {
          try {
            const original = readFileSync(instrPath, 'utf-8');
            writeFileSync(join(stagingDir, '.legacy-claude.md'), original);
            const stripped = stripLegoSpineContent(original, agent.coworkerType);
            if (stripped) {
              writeFileSync(instrPath, stripped + '\n');
            } else {
              unlinkSync(instrPath);
            }
          } catch { /* best effort */ }
        }
      }

      // Copy claude-shared
      const claudeSharedDir = join(getDataDir(), 'v2-sessions', newAgId, '.claude-shared');
      try {
        for (const [archivePath, buf] of files) {
          if (!archivePath.startsWith('claude-shared/')) continue;
          const rel = archivePath.slice('claude-shared/'.length);
          if (!rel || rel.includes('..')) continue;
          const dst = join(claudeSharedDir, rel);
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, buf);
        }
      } catch (csErr: any) {
        warnings.push(`Claude shared restore partial: ${csErr.message}`);
      }

      // V1 session bootstrap: create inbound.db + outbound.db from scratch
      let sessionsRestored = 0;
      let tasksImported = 0;
      for (const [origId, newId] of sessionMap) {
        const sessDir = join(getDataDir(), 'v2-sessions', newAgId, newId);
        mkdirSync(sessDir, { recursive: true });

        const ms = manifestSessions.find((s: any) => s.origId === origId);
        const v1SessionId = ms?.v1SessionId || null;

        // Create inbound.db
        const inDbPath = join(sessDir, 'inbound.db');
        let inDb: Database | null = null;
        try {
          inDb = new Database(inDbPath);
          inDb.pragma('journal_mode = DELETE');
          inDb.exec(V2_INBOUND_SCHEMA);
          if (Array.isArray(manifest.scheduledTasks)) {
            let seq = 2;
            for (const task of manifest.scheduledTasks) {
              inDb.prepare(
                `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, content)
                 VALUES (?, ?, 'task', ?, 'paused', ?, ?, ?)`
              ).run(task.origId, seq, now, toSqliteDatetime(task.processAfter), task.recurrence || null,
                typeof task.content === 'string' ? task.content : JSON.stringify(task.content));
              seq += 2;
              tasksImported++;
            }
          }
        } catch { /* best effort */ }
        finally { try { inDb?.close(); } catch { /* */ } }

        // Create outbound.db with session_state
        const outDbPath = join(sessDir, 'outbound.db');
        let outDb: Database | null = null;
        try {
          outDb = new Database(outDbPath);
          outDb.pragma('journal_mode = DELETE');
          outDb.exec(V2_OUTBOUND_SCHEMA);
          if (v1SessionId) {
            outDb.prepare(
              "INSERT INTO session_state (key, value, updated_at) VALUES ('claude_sdk_session_id', ?, ?)"
            ).run(v1SessionId, now);
          }
        } catch { /* best effort */ }
        finally { try { outDb?.close(); } catch { /* */ } }

        // Backfill v1 chat messages into session DBs
        const chatMsgs = Array.isArray(manifest.chatMessages) ? manifest.chatMessages : [];
        if (chatMsgs.length > 0) {
          const chatIn = chatMsgs.filter((m: any) => m.isFromMe === 0 && !m.isBotMessage);
          const chatOut = chatMsgs.filter((m: any) => m.isFromMe === 1 || m.isBotMessage === 1);
          let inDb2: Database | null = null;
          let outDb2: Database | null = null;
          try {
            inDb2 = new Database(inDbPath);
            inDb2.pragma('busy_timeout = 3000');
            const maxSeq = (inDb2.prepare('SELECT MAX(seq) as m FROM messages_in').get() as any)?.m || 0;
            let inSeq = maxSeq + 2;
            const inStmt = inDb2.prepare(
              `INSERT OR IGNORE INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', ?, 'completed', ?)`
            );
            for (const msg of chatIn) {
              const content = JSON.stringify({ text: msg.content, sender: msg.sender || 'dashboard', senderId: msg.sender || 'v1-import' });
              inStmt.run(msg.id, inSeq, msg.timestamp, content);
              inSeq += 2;
            }
          } catch { /* best effort */ }
          finally { try { inDb2?.close(); } catch { /* */ } }
          try {
            outDb2 = new Database(outDbPath);
            outDb2.pragma('busy_timeout = 3000');
            let outSeq = 1;
            const outStmt = outDb2.prepare(
              `INSERT OR IGNORE INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', ?, ?)`
            );
            for (const msg of chatOut) {
              outStmt.run(msg.id, outSeq, msg.timestamp, JSON.stringify({ text: msg.content }));
              outSeq += 2;
            }
          } catch { /* best effort */ }
          finally { try { outDb2?.close(); } catch { /* */ } }
        }

        sessionsRestored++;
      }

      // DB transaction
      let destsCreated = 0;
      try {
        wdb.exec('BEGIN TRANSACTION');
        wdb.prepare(
          'INSERT INTO agent_groups (id, name, folder, is_admin, agent_provider, container_config, coworker_type, allowed_mcp_tools, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)'
        ).run(newAgId, agent.name, importFolder, agent.agentProvider || null,
          agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
          agent.coworkerType || null,
          agent.allowedMcpTools ? JSON.stringify(agent.allowedMcpTools) : null, now);

        for (const ms of manifestSessions) {
          const newSessId = sessionMap.get(ms.origId)!;
          wdb.prepare(
            'INSERT INTO sessions (id, agent_group_id, status, agent_provider, container_status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(newSessId, newAgId, 'active', agent.agentProvider || null, 'stopped', now);
        }

        ensureDashboardChatWiring(wdb, { id: newAgId, folder: importFolder, name: agent.name }, trigger, now);
        wdb.exec('COMMIT');
      } catch (dbErr: any) {
        try { wdb.exec('ROLLBACK'); } catch { /* */ }
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* */ }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Import failed (DB): ${dbErr.message}` }));
        return;
      }

      // Move staged files to final location
      try {
        mkdirSync(groupDir, { recursive: true });
        const copyRecursive = (src: string, dst: string) => {
          for (const entry of readdirSync(src)) {
            const srcPath = join(src, entry);
            const dstPath = join(dst, entry);
            if (statSync(srcPath).isDirectory()) {
              mkdirSync(dstPath, { recursive: true });
              copyRecursive(srcPath, dstPath);
            } else {
              writeFileSync(dstPath, readFileSync(srcPath));
            }
          }
        };
        copyRecursive(stagingDir, groupDir);
        rmSync(stagingDir, { recursive: true, force: true });
      } catch (copyErr: any) {
        warnings.push(`File copy partial: ${copyErr.message}`);
      }

      postImportGroupInit(newAgId, importFolder, warnings);

      // Migrate V1 global learnings → V2 groups/global/learnings/
      try {
        const v1LearningsDir = join(resolvedV1Path, 'groups', 'global', 'learnings');
        if (existsSync(v1LearningsDir)) {
          const v2LearningsDir = join(getGroupsDir(), 'global', 'learnings');
          mkdirSync(v2LearningsDir, { recursive: true });
          let copied = 0;
          for (const f of readdirSync(v1LearningsDir)) {
            if (f === 'INDEX.md') continue; // rebuild below
            const dst = join(v2LearningsDir, f);
            if (!existsSync(dst)) {
              cpSync(join(v1LearningsDir, f), dst);
              copied++;
            }
          }
          // Rebuild INDEX.md from all learning files
          if (copied > 0) {
            const files = readdirSync(v2LearningsDir)
              .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
              .sort();
            const indexLines = ['# Shared Learnings Index\n'];
            for (const f of files) {
              const content = readFileSync(join(v2LearningsDir, f), 'utf-8');
              const title = content.match(/^#\s+(.+)$/m)?.[1] || f.replace(/\.md$/, '');
              indexLines.push(`- [${title}](${f})`);
            }
            writeFileSync(join(v2LearningsDir, 'INDEX.md'), indexLines.join('\n') + '\n');
          }
        }
      } catch (learnErr: any) {
        warnings.push(`Learnings migration: ${learnErr.message}`);
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        folder: importFolder,
        name: agentName,
        id: newAgId,
        sourceFormat: 'v1',
        backupPath: existsSync(backupPath) ? backupPath : undefined,
        sessionsRestored,
        tasksImported,
        tasksPaused: true,
        destsCreated,
        stats,
        warnings: warnings.length > 0 ? warnings : undefined,
      }));
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: spawn interactive container (resume session without sending a message)
  if (req.method === 'POST' && /^\/api\/coworkers\/[^/]+\/spawn-interactive$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/spawn-interactive', ''));
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }

    const found = findRunningContainer(folder);
    if (found) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'container already running', container: found }));
      return;
    }

    const controlDir = join(getDataDir(), 'ipc', folder, 'control');
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      join(controlDir, 'spawn-interactive.json'),
      JSON.stringify({ type: 'spawn_interactive', timestamp: new Date().toISOString() }),
    );

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'interactive spawn requested' }));
    return;
  }

  // API: delete coworker
  if (req.method === 'DELETE' && /^\/api\/coworkers\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', ''));
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }
    const wdb = getWriteDb();
    if (!wdb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
      return;
    }
    const existing = wdb.prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as any;
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"coworker not found"}');
      return;
    }
    // Don't allow deleting the main group
    if (existing.is_admin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"cannot delete the main group"}');
      return;
    }
    const agId = existing.id;
    const deleteData = url.searchParams.has('deleteData');
    // Stop any running container for this group, then clean up
    const folderHyphenated = folder.replace(/_/g, '-');
    const doCleanup = () => {
      // v2 cascade: delete children before parents
      wdb.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agId);
      wdb.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(agId);
      wdb.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(agId);
      wdb
        .prepare("DELETE FROM messaging_groups WHERE channel_type = 'dashboard' AND platform_id = ?")
        .run(`dashboard:${folder}`);
      wdb.prepare('DELETE FROM agent_groups WHERE id = ?').run(agId);
      // Clean session files
      const sessionDir = join(getDataDir(), 'v2-sessions', agId);
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
      // Only delete group folder/artifacts when explicitly requested
      if (deleteData) {
        const groupDir = join(getGroupsDir(), folder);
        try {
          rmSync(groupDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dataDeleted: deleteData }));
    };
    exec(`docker ps --filter name=nanoclaw-${folderHyphenated}- --format '{{.Names}}'`, (_err, stdout) => {
      const containers = (stdout || '').trim().split('\n').filter(Boolean);
      if (containers.length === 0) {
        doCleanup();
        return;
      }
      exec(`docker stop ${containers.join(' ')}`, () => doCleanup());
    });
    return;
  }

  // API: list files in a coworker's group folder (artifacts)
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/files$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/files', ''));
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }
    const groupDir = join(getGroupsDir(), folder);
    if (!isInsideDir(getGroupsDir(), groupDir) && groupDir !== getGroupsDir()) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    try {
      const files: { name: string; size: number; modified: string; isDir: boolean }[] = [];
      const entries = readdirSync(groupDir);
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        try {
          const st = statSync(join(groupDir, name));
          files.push({
            name,
            size: st.size,
            modified: st.mtime.toISOString(),
            isDir: st.isDirectory(),
          });
        } catch {
          /* skip unreadable */
        }
      }
      files.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // API: browse files in subdirectory (recursive navigation)
  // GET /api/coworkers/:folder/browse?path=reports
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/browse$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/browse', ''));
    const subpath = url.searchParams.get('path') || '';
    if (!folder) {
      res.writeHead(400);
      res.end('{"error":"invalid folder"}');
      return;
    }
    const groupDir = join(getGroupsDir(), folder);
    if (!isInsideDir(getGroupsDir(), groupDir) && groupDir !== resolve(getGroupsDir())) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const targetDir = join(groupDir, subpath);
    if (!isInsideDir(groupDir, targetDir) && targetDir !== groupDir) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    try {
      const entries = readdirSync(targetDir);
      const files: { name: string; path: string; size: number; modified: string; isDir: boolean }[] = [];
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        try {
          const st = statSync(join(targetDir, name));
          files.push({
            name,
            path: subpath ? `${subpath}/${name}` : name,
            size: st.size,
            modified: st.mtime.toISOString(),
            isDir: st.isDirectory(),
          });
        } catch {
          /* skip */
        }
      }
      files.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // API: read file content inline (for work view)
  // GET /api/coworkers/:folder/read?path=reports/issue-10695.md
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/read$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/read', ''));
    const filePath = url.searchParams.get('path') || '';
    if (!folder || !filePath) {
      res.writeHead(400);
      res.end('{"error":"missing path"}');
      return;
    }
    const groupDir = join(getGroupsDir(), folder);
    if (!isInsideDir(getGroupsDir(), groupDir) && groupDir !== resolve(getGroupsDir())) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const fullPath = join(groupDir, filePath);
    if (!isInsideDir(groupDir, fullPath)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    try {
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        res.writeHead(400);
        res.end('{"error":"is directory"}');
        return;
      }
      if (st.size > 1048576) {
        res.writeHead(413);
        res.end('{"error":"file too large (>1MB)"}');
        return;
      }
      const content = readFileSync(fullPath, 'utf-8');
      const ext = extname(filePath).slice(1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: filePath, ext, size: st.size, content }));
    } catch {
      res.writeHead(404);
      res.end('{"error":"not found"}');
      return;
    }
    return;
  }

  // API: download a file from coworker's group folder
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/download\//.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const parts = url.pathname.replace('/api/coworkers/', '').split('/download/');
    const folder = safeDecode(parts[0]);
    const filePath = safeDecode(parts.slice(1).join('/download/'));
    if (!folder || !filePath) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const fullPath = join(getGroupsDir(), folder, filePath);
    // Security: must be inside the group dir
    if (!isInsideDir(join(getGroupsDir(), folder), fullPath)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const content = readFileSync(fullPath);
    const ext = filePath.split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
      md: 'text/markdown',
      txt: 'text/plain',
      json: 'application/json',
      slang: 'text/plain',
      cpp: 'text/plain',
      h: 'text/plain',
      py: 'text/plain',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      ico: 'image/x-icon',
      bmp: 'image/bmp',
    };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const isImage = mime.startsWith('image/');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': isImage ? 'inline' : `attachment; filename="${(filePath.split('/').pop() || 'file').replace(/["\r\n]/g, '_')}"`,
    });
    res.end(content);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/debug') {
    if (!requireAuth(req, res)) return;
    const mem = process.memoryUsage();
    const result: any = {
      pid: process.pid,
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      dbPath: getDbPath(),
      dbAvailable: !!db,
      rowCounts: {} as Record<string, number>,
      wsClients: wsClients.size,
      hookEventsBuffered: hookEvents.length,
    };
    if (db) {
      try {
        for (const table of [
          'agent_groups',
          'messaging_groups',
          'messaging_group_agents',
          'sessions',
          'agent_destinations',
          'hook_events',
        ]) {
          result.rowCounts[table] = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any)?.c || 0;
        }
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: infrastructure health — MCP proxy, auth, network, OneCLI
  if (req.method === 'GET' && url.pathname === '/api/infrastructure') {
    if (!requireAuth(req, res)) return;
    const checks: Record<string, any> = {};

    // MCP auth proxy reachable?
    // Read MCP port from .env or process env (dashboard runs as a separate process)
    let mcpPort = process.env.MCP_PROXY_PORT || '8808';
    try {
      const envContent = readFileSync(join(resolve('.'), '.env'), 'utf-8');
      const match = envContent.match(/^MCP_PROXY_PORT=(\d+)/m);
      if (match) mcpPort = match[1];
    } catch {
      /* use default */
    }
    const mcpToken = getMcpManagementToken();
    const mcpHeaders: Record<string, string> = {};
    if (mcpToken) mcpHeaders['Authorization'] = `Bearer ${mcpToken}`;
    fetch(`http://172.17.0.1:${mcpPort}/tools`, { signal: AbortSignal.timeout(3000), headers: mcpHeaders })
      .catch(() =>
        fetch(`http://127.0.0.1:${mcpPort}/tools`, { signal: AbortSignal.timeout(3000), headers: mcpHeaders }),
      )
      .then((r) => r.json())
      .then((tools: Record<string, string[]>) => {
        const serverNames = Object.keys(tools);
        const toolCount = Object.values(tools).reduce((sum, t) => sum + t.length, 0);
        checks.mcpAuthProxy = { status: 'running', servers: serverNames, toolCount };
      })
      .catch(() => {
        checks.mcpAuthProxy = { status: 'unreachable' };
      })
      .finally(() => {
        // OneCLI gateway reachable?
        const onecliUrl = process.env.ONECLI_URL || 'http://127.0.0.1:10254';
        fetch(`${onecliUrl}/api/health`, { signal: AbortSignal.timeout(3000) })
          .then((r) => {
            checks.onecli = { status: r.ok ? 'running' : 'error', statusCode: r.status };
          })
          .catch(() => {
            checks.onecli = { status: 'unreachable' };
          })
          .finally(() => {
            // Docker network
            try {
              const netInfo = execSync('docker network inspect nanoclaw-agents --format "{{.Options}}"', {
                stdio: 'pipe',
                encoding: 'utf-8',
                timeout: 5000,
              }).trim();
              checks.network = { status: 'active', name: 'nanoclaw-agents', options: netInfo };
            } catch {
              checks.network = { status: 'not_found', name: 'nanoclaw-agents' };
            }

            // Running containers
            try {
              const raw = execSync(
                'docker ps --filter name=nanoclaw- --format "{{.Names}}|{{.Status}}|{{.Networks}}"',
                { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 },
              ).trim();
              const containers = raw
                ? raw
                    .split('\n')
                    .filter(Boolean)
                    .map((line: string) => {
                      const [name, status, networks] = line.split('|');
                      return { name, status, networks };
                    })
                : [];
              checks.containers = { count: containers.length, list: containers };
            } catch {
              checks.containers = { count: 0, list: [] };
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(checks, null, 2));
          });
      });
    return;
  }

  // API: write .instructions.md for a group (admin panel)
  // CLAUDE.md is system-composed — all edits go to .instructions.md
  if (req.method === 'PUT' && url.pathname.startsWith('/api/memory/')) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/memory/', ''));
    if (folder === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const instructionsPath = resolve(getGroupsDir(), folder, '.instructions.md');
    if (!isInsideDir(getGroupsDir(), instructionsPath)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      mkdirSync(resolve(getGroupsDir(), folder), { recursive: true });
      writeFileSync(instructionsPath, body, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: delete a task — v2 tasks are in session DBs
  if (req.method === 'DELETE' && /^\/api\/tasks\/(\d+)$/.test(url.pathname)) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Task deletion not yet implemented for v2 session-based tasks' }));
    return;
  }

  // API: get config values
  if (req.method === 'GET' && url.pathname === '/api/config') {
    if (!requireAuth(req, res)) return;
    const configKeys = [
      { key: 'ASSISTANT_NAME', env: 'ASSISTANT_NAME', description: 'Name of the assistant' },
      { key: 'CONTAINER_IMAGE', env: 'CONTAINER_IMAGE', description: 'Docker image for agent containers' },
      { key: 'CONTAINER_TIMEOUT', env: 'CONTAINER_TIMEOUT', description: 'Max container run time (ms)' },
      { key: 'MAX_CONCURRENT_CONTAINERS', env: 'MAX_CONCURRENT_CONTAINERS', description: 'Max parallel containers' },
      { key: 'IDLE_TIMEOUT', env: 'IDLE_TIMEOUT', description: 'Idle shutdown timeout (ms)' },
      { key: 'TIMEZONE', env: 'TZ', description: 'System timezone' },
      { key: 'DASHBOARD_PORT', env: 'DASHBOARD_PORT', description: 'Dashboard server port' },
      { key: 'ANTHROPIC_MODEL', env: 'ANTHROPIC_MODEL', description: 'Claude model identifier' },
      { key: 'LOG_LEVEL', env: 'LOG_LEVEL', description: 'Logging verbosity' },
    ];
    const result = configKeys.map((c) => ({
      ...c,
      value: process.env[c.env] || '',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: read/write root CLAUDE.md
  if (url.pathname === '/api/config/claude-md') {
    if (!requireAuth(req, res)) return;
    const mdPath = join(getProjectRoot(), 'CLAUDE.md');
    if (req.method === 'GET') {
      try {
        const content = readFileSync(mdPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
    if (req.method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req, res);
      if (body === null) return;
      try {
        writeFileSync(mdPath, body, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  // API: list channels
  if (req.method === 'GET' && url.pathname === '/api/channels') {
    if (!requireAuth(req, res)) return;
    const channels: any[] = [];
    try {
      if (existsSync(getChannelsDir())) {
        const exclude = new Set(['index.ts', 'registry.ts', 'registry.test.ts']);
        for (const file of readdirSync(getChannelsDir())) {
          if (!file.endsWith('.ts') || exclude.has(file) || file.includes('.test.')) continue;
          const name = file.replace('.ts', '');
          // Determine prefix for JID matching
          const prefixMap: Record<string, string> = {
            telegram: 'tg:',
            whatsapp: 'wa:',
            discord: 'disc:',
            slack: 'slack:',
          };
          const prefix = prefixMap[name] || `${name}:`;
          const groups: any[] = [];
          if (db) {
            try {
              const rows = db
                .prepare(
                  'SELECT ag.name, ag.folder, ag.id FROM agent_groups ag JOIN messaging_groups mg ON mg.platform_id LIKE ? JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ag.id',
                )
                .all(`${prefix}%`) as any[];
              for (const r of rows) groups.push({ name: r.name, folder: r.folder });
            } catch {
              /* ignore */
            }
          }
          channels.push({ name, type: name, configured: groups.length > 0, groups });
        }
      }
    } catch {
      /* ignore */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(channels));
    return;
  }

  // API: get logs
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    if (!requireAuth(req, res)) return;
    const source = url.searchParams.get('source') || 'app';
    const group = url.searchParams.get('group') || '';
    const search = url.searchParams.get('search') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 2000);

    let logFile = '';
    if (source === 'app') {
      logFile = join(getLogsDir(), 'nanoclaw.log');
    } else if (source === 'error') {
      logFile = join(getLogsDir(), 'nanoclaw.error.log');
    } else if (source === 'dashboard') {
      logFile = join(getLogsDir(), 'nanoclaw-dashboard.log');
    } else if (source === 'dashboard-error') {
      logFile = join(getLogsDir(), 'nanoclaw-dashboard.error.log');
    } else if (source === 'container' && group) {
      // Find most recent container log for this group
      const groupLogDir = join(getGroupsDir(), group, 'logs');
      // Prevent path traversal (e.g. group = "../../etc")
      if (!groupLogDir.startsWith(getGroupsDir() + '/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid group name' }));
        return;
      }
      if (existsSync(groupLogDir)) {
        const logFiles = readdirSync(groupLogDir)
          .filter((f) => f.startsWith('container-') && f.endsWith('.log'))
          .sort()
          .reverse();
        if (logFiles.length > 0) logFile = join(groupLogDir, logFiles[0]);
      }
    }

    if (!logFile || !existsSync(logFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: [], file: logFile || 'none' }));
      return;
    }

    try {
      let content = readFileSync(logFile, 'utf-8');
      // Strip ANSI codes
      content = content.replace(/\x1b\[[0-9;]*m/g, '');
      let lines = content.split('\n').filter((l) => l.trim());
      if (search) {
        const lowerSearch = search.toLowerCase();
        lines = lines.filter((l) => l.toLowerCase().includes(lowerSearch));
      }
      // Return last N lines
      lines = lines.slice(-limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines, file: logFile }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: [], file: logFile }));
    }
    return;
  }

  // API: get single skill content
  if (req.method === 'GET' && /^\/api\/skills\/[^/]+$/.test(url.pathname) && url.pathname !== '/api/skills') {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.replace('/api/skills/', ''));
    if (name === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const skillDir = resolve(getSkillsDir(), name);
    if (!isInsideDir(getSkillsDir(), skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const skillMd = join(skillDir, 'SKILL.md');
    try {
      const content = readFileSync(skillMd, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // API: create skill
  if (
    req.method === 'POST' &&
    url.pathname === '/api/skills' &&
    req.headers['content-type']?.includes('application/json')
  ) {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { name, content } = JSON.parse(body);
      if (!name || !/^[a-z0-9-]+$/.test(name)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid skill name (use lowercase alphanumeric and hyphens)"}');
        return;
      }
      const skillDir = resolve(getSkillsDir(), name);
      if (!isInsideDir(getSkillsDir(), skillDir)) {
        res.writeHead(403);
        res.end('{"error":"forbidden"}');
        return;
      }
      if (existsSync(skillDir)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"error":"Skill already exists"}');
        return;
      }
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), content || `# ${name}\n\nNew skill.\n`, 'utf-8');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: update skill
  if (req.method === 'PUT' && /^\/api\/skills\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.replace('/api/skills/', ''));
    if (name === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const skillDir = resolve(getSkillsDir(), name);
    if (!isInsideDir(getSkillsDir(), skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: delete skill
  if (req.method === 'DELETE' && /^\/api\/skills\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.replace('/api/skills/', ''));
    if (name === null) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (url.searchParams.get('confirm') !== 'true') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Add ?confirm=true to delete"}');
      return;
    }
    const skillDir = resolve(getSkillsDir(), name);
    if (!isInsideDir(getSkillsDir(), skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    try {
      rmSync(skillDir, { recursive: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: send chat message
  if (req.method === 'POST' && url.pathname === '/api/chat/send') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { group, content } = JSON.parse(body);
      if (!group || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"group and content required"}');
        return;
      }

      const wdb = getWriteDb();
      if (!wdb) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"db unavailable"}');
        return;
      }
      const groupRow = wdb.prepare('SELECT id, name, folder FROM agent_groups WHERE folder = ?').get(group) as
        | { id: string; name: string; folder: string }
        | undefined;
      if (!groupRow) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"coworker not found"}');
        return;
      }
      ensureDashboardChatWiring(wdb, groupRow, `@${groupRow.name.replace(/\s+/g, '')}`);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = getDashboardSecret();
      if (secret) headers.Authorization = `Bearer ${secret}`;

      try {
        const upstream = await fetch(`${getDashboardIngressBaseUrl()}/api/dashboard/inbound`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ group, content }),
          signal: AbortSignal.timeout(5000),
        });
        const upstreamText = await upstream.text();
        if (!upstream.ok) {
          let error = upstreamText || 'Dashboard host bridge request failed';
          try {
            const parsed = JSON.parse(upstreamText);
            error = parsed.error || error;
          } catch {
            /* text body */
          }
          res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error }));
          return;
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Dashboard host bridge unreachable. Ensure NanoClaw host is running.';
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
        return;
      }

      lastMessageTsCache.set(group, new Date().toISOString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: list pending approvals for a specific admin group folder.
  // Returns normalized DTOs: { approvalId, action, reason, packages, createdAt, status }
  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    if (!requireAuth(req, res)) return;
    const group = url.searchParams.get('group') || '';
    let approvals: any[] = [];
    if (db && group) {
      try {
        const agRow = db.prepare('SELECT id, is_admin FROM agent_groups WHERE folder = ?').get(group) as any;
        if (agRow?.is_admin) {
          const rows = db
            .prepare(
              `SELECT pa.* FROM pending_approvals pa
               WHERE pa.status = 'pending' AND pa.platform_id = ?
               ORDER BY pa.created_at DESC
               LIMIT 50`,
            )
            .all(`dashboard:${group}`) as any[];
          approvals = rows.map((row: any) => {
            let payload: any = {};
            try { payload = JSON.parse(row.payload || '{}'); } catch {}
            const packages = ((payload.apt || []).concat(payload.npm || [])).filter(Boolean);
            return {
              approvalId: row.approval_id,
              action: row.action,
              reason: payload.reason || null,
              packages,
              createdAt: row.created_at,
              status: row.status,
            };
          });
        }
      } catch {
        /* table may not exist */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(approvals));
    return;
  }

  // API: handle approval action (approve/reject buttons)
  if (req.method === 'POST' && (url.pathname === '/api/approvals/action' || url.pathname === '/api/chat/action')) {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body);
      const approvalId = parsed.approvalId;
      const actionDecision = parsed.decision || parsed.response;
      if (!approvalId || !actionDecision) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"approvalId and decision required"}');
        return;
      }
      const VALID_DECISIONS = ['Approve', 'Reject'];
      if (!VALID_DECISIONS.includes(actionDecision)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid decision "${actionDecision}". Must be one of: ${VALID_DECISIONS.join(', ')}` }));
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = getDashboardSecret();
      if (secret) headers.Authorization = `Bearer ${secret}`;

      const upstream = await fetch(`${getDashboardIngressBaseUrl()}/api/dashboard/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ approvalId, decision: actionDecision }),
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) {
        const errText = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(errText);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: respond to ask_user_question card (arbitrary options, no VALID_DECISIONS gate)
  if (req.method === 'POST' && url.pathname === '/api/questions/respond') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body);
      const questionId = typeof parsed.questionId === 'string' ? parsed.questionId.trim() : '';
      const selectedOption = typeof parsed.selectedOption === 'string' ? parsed.selectedOption.trim() : '';
      if (!questionId || !selectedOption) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"questionId and selectedOption required"}');
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = getDashboardSecret();
      if (secret) headers.Authorization = `Bearer ${secret}`;
      const upstream = await fetch(`${getDashboardIngressBaseUrl()}/api/dashboard/question-response`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ questionId, selectedOption }),
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) {
        const errText = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(errText);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: list pending credentials for a group
  if (req.method === 'GET' && url.pathname === '/api/credentials') {
    if (!requireAuth(req, res)) return;
    const group = url.searchParams.get('group') || '';
    let credentials: any[] = [];
    if (db && group) {
      try {
        const agRow = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(group) as any;
        if (agRow) {
          const rows = db
            .prepare(
              `SELECT pc.* FROM pending_credentials pc
               JOIN sessions s ON s.id = pc.session_id
               WHERE pc.status = 'pending' AND s.agent_group_id = ?
               ORDER BY pc.created_at DESC
               LIMIT 50`,
            )
            .all(agRow.id) as any[];
          credentials = rows.map((row: any) => ({
            credentialId: row.id,
            name: row.name,
            hostPattern: row.host_pattern,
            headerName: row.header_name || null,
            valueFormat: row.value_format || null,
            description: row.description || null,
            createdAt: row.created_at,
          }));
        }
      } catch {
        /* table may not exist */
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(credentials));
    return;
  }

  // API: submit credential value (same auth as approvals for parity)
  if (req.method === 'POST' && url.pathname === '/api/credentials/submit') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body);
      const credentialId = typeof parsed.credentialId === 'string' ? parsed.credentialId.trim() : '';
      const value = typeof parsed.value === 'string' ? parsed.value : '';
      if (!credentialId || !value) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"credentialId and value required"}');
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = getDashboardSecret();
      if (secret) headers.Authorization = `Bearer ${secret}`;
      const upstream = await fetch(`${getDashboardIngressBaseUrl()}/api/dashboard/credential-submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ credentialId, value }),
        signal: AbortSignal.timeout(15000), // OneCLI secret creation can be slow
      });
      if (!upstream.ok) {
        const errText = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(errText);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: reject credential request
  if (req.method === 'POST' && url.pathname === '/api/credentials/reject') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body);
      const credentialId = typeof parsed.credentialId === 'string' ? parsed.credentialId.trim() : '';
      if (!credentialId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"credentialId required"}');
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = getDashboardSecret();
      if (secret) headers.Authorization = `Bearer ${secret}`;
      const upstream = await fetch(`${getDashboardIngressBaseUrl()}/api/dashboard/credential-reject`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ credentialId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) {
        const errText = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(errText);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── MCP server control (proxy to auth proxy on NanoClaw process) ────────
  if (req.method === 'POST' && url.pathname === '/api/mcp-control') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { action, name } = JSON.parse(body);
      // Read MCP port from env first, then optional project .env fallback.
      let mcpPort = process.env.MCP_PROXY_PORT || '8808';
      try {
        const envContent = readFileSync(join(resolve('.'), '.env'), 'utf-8');
        const match = envContent.match(/^MCP_PROXY_PORT=(\d+)/m);
        if (!process.env.MCP_PROXY_PORT && match) mcpPort = match[1];
      } catch {
        /* use default */
      }

      const endpoint = action === 'stop' ? 'stop' : 'restart';
      const proxyUrl = `http://172.17.0.1:${mcpPort}/servers/${endpoint}?name=${encodeURIComponent(name)}`;

      // Read management token: env var first, then runtime file written by mcp-auth-proxy
      let mcpToken = process.env.MCP_MANAGEMENT_TOKEN || '';
      if (!mcpToken) {
        try {
          mcpToken = getMcpManagementToken() || '';
        } catch {
          /* token file not available */
        }
      }
      const fetchHeaders: Record<string, string> = {};
      if (mcpToken) fetchHeaders['Authorization'] = `Bearer ${mcpToken}`;
      fetch(proxyUrl, { method: 'POST', headers: fetchHeaders, signal: AbortSignal.timeout(10000) })
        .then((r) => r.json())
        .then((j) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(j));
        })
        .catch((e: Error) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'MCP proxy unreachable: ' + e.message }));
        });
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Remote MCP server management ────────────────────────────────────────

  // Static files
  const decodedPath = safeDecode(url.pathname);
  if (decodedPath === null) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  const isMobileUA = /Android|iPhone|iPod|Mobile/i.test(req.headers['user-agent'] || '');
  const forceDesktop = url.searchParams.get('desktop') === '1';
  const forceMobile = url.searchParams.get('mobile') === '1';
  const serveMobile = !forceDesktop && (forceMobile || isMobileUA);
  let filePath = decodedPath === '/' ? (serveMobile ? '/mobile.html' : '/index.html') : decodedPath;
  filePath = resolve(getPublicDir(), '.' + filePath);
  if (!isInsideDir(getPublicDir(), filePath)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    const headers: Record<string, string> = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
    // Prevent proxy caching of mutable assets (JS, HTML) so code updates are picked up immediately
    if (ext === '.js' || ext === '.html' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

/** Start the dashboard server (binds port, sets up WebSocket, timers). */
export function startServer(port = getDashboardPort(), host = getDashboardHost()): import('http').Server {
  // Load MCP tool inventory eagerly and refresh when the auth proxy rotates the token.
  void refreshMcpTools();
  const stopWatchingMcpToken = watchMcpManagementToken(() => {
    void refreshMcpTools();
  });
  const mcpRefreshTimer = setInterval(() => {
    void refreshMcpTools();
  }, 300_000);
  mcpRefreshTimer.unref?.();

  const server = createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n',
    );

    wsClients.add(socket);

    const state = JSON.stringify({ type: 'state', data: getState() });
    socket.write(createWsFrame(Buffer.from(state)));

    let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const frame = parseWsFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          // Close: reply with close and terminate socket.
          try {
            socket.write(createWsFrame(frame.payload, 0x8));
          } finally {
            socket.end();
          }
          return;
        }
        if (frame.opcode === 0x9) {
          // Ping: keep browser connections alive by replying with pong.
          socket.write(createWsFrame(frame.payload, 0xa));
          continue;
        }
      }
    });

    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  // Poll and broadcast state every 500ms
  const broadcastTimer = setInterval(() => {
    if (!db) db = openDb();
    broadcastState();
  }, 500);
  broadcastTimer.unref?.();

  // Expire stale hook state (>30s old)
  const expireTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of liveHookState) {
      if (now - val.ts > 30000) liveHookState.delete(key);
    }
    for (const [group, subagents] of liveSubagentState) {
      for (const [agentId, subagent] of subagents) {
        const isExpiredLeaving = subagent.phase === 'leaving' && subagent.exitAt !== null && now > subagent.exitAt;
        const isExpiredActive = subagent.phase !== 'leaving' && now - subagent.lastActivity > SUBAGENT_STALE_MS;
        if (isExpiredLeaving || isExpiredActive) subagents.delete(agentId);
      }
      if (subagents.size === 0) liveSubagentState.delete(group);
    }
  }, 5000);
  expireTimer.unref?.();

  // Retention cleanup: delete hook_events older than HOOK_RETENTION_DAYS (default 7)
  const retentionDays = parseInt(process.env.HOOK_RETENTION_DAYS || '7', 10);
  const retentionTimer = setInterval(() => {
    const heDb = getHookEventsDb();
    if (heDb) {
      try {
        const cutoff = Date.now() - retentionDays * 86400000;
        heDb.prepare('DELETE FROM hook_events WHERE timestamp < ?').run(cutoff);
      } catch {
        /* non-fatal */
      }
    }
  }, 3600000); // every hour
  retentionTimer.unref?.();

  server.on('close', () => {
    stopWatchingMcpToken?.();
    clearInterval(mcpRefreshTimer);
    clearInterval(broadcastTimer);
    clearInterval(expireTimer);
    clearInterval(retentionTimer);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  });

  server.listen(port, host, () => {
    console.log(`\n  NVIDIA Coworker Dashboard`);
    console.log(`  http://${host}:${port}\n`);
    console.log(`  Tab 1: Pixel Art Office (real-time)`);
    console.log(`  Tab 2: Timeline (all-time metrics)`);
    if (getDashboardSecret()) console.log(`  Auth: dashboard secret required for browser/admin access`);
    console.log();
  });

  return server;
}

// Auto-start when run directly (not imported by tests)
if (!process.env.VITEST) {
  startServer();
}
