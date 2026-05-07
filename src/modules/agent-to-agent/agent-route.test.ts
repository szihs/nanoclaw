import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let _tempDir = '';
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return path.join(_tempDir, 'groups');
  },
  get DATA_DIR() {
    return path.join(_tempDir, 'data');
  },
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(async () => {}),
}));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isSafeAttachmentName, ensureA2aWiring, routeAgentMessage } from './agent-route.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { migration019 } from '../../db/migrations/019-a2a-session-mode-per-thread.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { createDestination } from './db/agent-destinations.js';
import type { Session } from '../../types.js';

/**
 * `forwardAttachedFiles` has a filesystem side that's awkward to unit-test
 * without mocking DATA_DIR. The guarantee worth pinning is that the
 * filename validator rejects everything that could escape the inbox dir —
 * `forwardAttachedFiles` runs this guard before any I/O, so traversal is
 * impossible as long as this matrix holds.
 */
describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('baby-duck.png')).toBe(true);
    expect(isSafeAttachmentName('file with spaces.pdf')).toBe(true);
    expect(isSafeAttachmentName('report.v2.docx')).toBe(true);
    expect(isSafeAttachmentName('.hidden')).toBe(true); // leading dot is fine, just not `.` / `..`
  });

  it('rejects empty / sentinel values', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeAttachmentName('../evil.png')).toBe(false);
    expect(isSafeAttachmentName('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('nested/file.txt')).toBe(false);
    expect(isSafeAttachmentName('windows\\path.exe')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeAttachmentName('clean\0.png')).toBe(false);
  });

  it('rejects anything path.basename would strip', () => {
    expect(isSafeAttachmentName('a/b')).toBe(false);
    expect(isSafeAttachmentName('./thing')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
  });
});

// =============================================================
// Thread-aware a2a delegation — tests for the per-thread routing
// that supersedes the old agent-shared-only behaviour. Covers
// Changes 2+3 from the thread-aware-a2a-delegation plan.
// =============================================================

const realCwd = process.cwd();
const now = () => new Date().toISOString();

function setupTempDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-route-test-'));
  _tempDir = tempDir;
  fs.mkdirSync(path.join(tempDir, 'groups'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'data', 'v2-sessions'), { recursive: true });
  process.chdir(tempDir);
  const db = initTestDb();
  runMigrations(db);
  return tempDir;
}

function seedPair(): { senderSession: Session } {
  createAgentGroup({
    id: 'ag-sender',
    name: 'Sender',
    folder: 'sender',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    created_at: now(),
  });
  createAgentGroup({
    id: 'ag-recipient',
    name: 'Recipient',
    folder: 'recipient',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    created_at: now(),
  });
  createDestination({
    agent_group_id: 'ag-sender',
    local_name: 'recipient',
    target_type: 'agent',
    target_id: 'ag-recipient',
    created_at: now(),
  });
  const senderSession: Session = {
    id: 'sess-sender',
    agent_group_id: 'ag-sender',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  return { senderSession };
}

describe('ensureA2aWiring', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = setupTempDb();
  });
  afterEach(() => {
    closeDb();
    process.chdir(realCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lazy-creates agent messaging_group and mga with session_mode=per-thread', () => {
    seedPair();
    const mgId = ensureA2aWiring('ag-recipient');
    expect(mgId).toMatch(/^mg-a2a-/);
    const mg = getMessagingGroupByPlatform('agent', 'agent:ag-recipient');
    expect(mg).toBeDefined();
    expect(mg!.channel_type).toBe('agent');
    const mgas = getMessagingGroupAgents(mg!.id);
    expect(mgas).toHaveLength(1);
    expect(mgas[0].agent_group_id).toBe('ag-recipient');
    expect(mgas[0].session_mode).toBe('per-thread');
  });

  it('is idempotent — second call returns the same mg id, no duplicate mga', () => {
    seedPair();
    const first = ensureA2aWiring('ag-recipient');
    const second = ensureA2aWiring('ag-recipient');
    expect(second).toBe(first);
    const mg = getMessagingGroupByPlatform('agent', 'agent:ag-recipient')!;
    expect(getMessagingGroupAgents(mg.id)).toHaveLength(1);
  });
});

describe('routeAgentMessage — thread_id routing', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = setupTempDb();
  });
  afterEach(() => {
    closeDb();
    process.chdir(realCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('thread_id=null routes to agent-shared session (back-compat)', async () => {
    const { senderSession } = seedPair();
    await routeAgentMessage(
      { id: 'out-1', platform_id: 'ag-recipient', thread_id: null, content: JSON.stringify({ text: 'hi' }) },
      senderSession,
    );
    const rows = getDb()
      .prepare('SELECT id, thread_id, messaging_group_id FROM sessions WHERE agent_group_id = ?')
      .all('ag-recipient') as Array<{ id: string; thread_id: string | null; messaging_group_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBeNull();
    expect(rows[0].messaging_group_id).toBeNull();
  });

  it('two different thread_ids create two distinct recipient sessions', async () => {
    const { senderSession } = seedPair();
    await routeAgentMessage(
      { id: 'out-a', platform_id: 'ag-recipient', thread_id: 'review-PR-A', content: JSON.stringify({ text: 'A' }) },
      senderSession,
    );
    await routeAgentMessage(
      { id: 'out-b', platform_id: 'ag-recipient', thread_id: 'review-PR-B', content: JSON.stringify({ text: 'B' }) },
      senderSession,
    );
    const rows = getDb()
      .prepare('SELECT id, thread_id FROM sessions WHERE agent_group_id = ? ORDER BY created_at')
      .all('ag-recipient') as Array<{ id: string; thread_id: string | null }>;
    const threaded = rows.filter((r) => r.thread_id !== null);
    expect(threaded).toHaveLength(2);
    expect(new Set(threaded.map((r) => r.thread_id))).toEqual(new Set(['review-PR-A', 'review-PR-B']));
    expect(new Set(threaded.map((r) => r.id)).size).toBe(2);
  });

  it('reusing a thread_id routes to the existing per-thread session', async () => {
    const { senderSession } = seedPair();
    await routeAgentMessage(
      { id: 'out-1', platform_id: 'ag-recipient', thread_id: 'PR-A', content: JSON.stringify({ text: 'first' }) },
      senderSession,
    );
    await routeAgentMessage(
      { id: 'out-2', platform_id: 'ag-recipient', thread_id: 'PR-A', content: JSON.stringify({ text: 'follow-up' }) },
      senderSession,
    );
    const threaded = getDb()
      .prepare('SELECT id FROM sessions WHERE agent_group_id = ? AND thread_id = ?')
      .all('ag-recipient', 'PR-A') as Array<{ id: string }>;
    expect(threaded).toHaveLength(1);
  });

  it('empty-string thread_id is treated as null (root routing)', async () => {
    const { senderSession } = seedPair();
    await routeAgentMessage(
      { id: 'out-1', platform_id: 'ag-recipient', thread_id: '', content: JSON.stringify({ text: 'x' }) },
      senderSession,
    );
    const rows = getDb()
      .prepare('SELECT thread_id, messaging_group_id FROM sessions WHERE agent_group_id = ?')
      .all('ag-recipient') as Array<{ thread_id: string | null; messaging_group_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBeNull();
    expect(rows[0].messaging_group_id).toBeNull();
  });

  it('unthreaded + threaded deliveries to the same recipient live in two different sessions', async () => {
    const { senderSession } = seedPair();
    await routeAgentMessage(
      { id: 'out-root', platform_id: 'ag-recipient', thread_id: null, content: JSON.stringify({ text: 'root' }) },
      senderSession,
    );
    await routeAgentMessage(
      { id: 'out-thread', platform_id: 'ag-recipient', thread_id: 'T1', content: JSON.stringify({ text: 'threaded' }) },
      senderSession,
    );
    const rows = getDb()
      .prepare('SELECT thread_id FROM sessions WHERE agent_group_id = ? ORDER BY created_at')
      .all('ag-recipient') as Array<{ thread_id: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.thread_id).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([null, 'T1']);
  });
});

describe('migration 019', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = setupTempDb();
  });
  afterEach(() => {
    closeDb();
    process.chdir(realCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('upgrades pre-existing channel_type=agent wirings with session_mode=shared to per-thread', () => {
    const db = getDb();
    createAgentGroup({
      id: 'ag-r',
      name: 'R',
      folder: 'r',
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      coworker_type: null,
      allowed_mcp_tools: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-agent-old',
      channel_type: 'agent',
      platform_id: 'agent:ag-r',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      admin_user_id: null,
      created_at: now(),
    });
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-old', 'mg-agent-old', 'ag-r', 'always', NULL, 'all', 'drop', 'shared', 0, ?)`,
    ).run(now());

    migration019.up(db);
    const row = db.prepare("SELECT session_mode FROM messaging_group_agents WHERE id = 'mga-old'").get() as {
      session_mode: string;
    };
    expect(row.session_mode).toBe('per-thread');
  });

  it('does not touch dashboard/slack/telegram wirings', () => {
    const db = getDb();
    createAgentGroup({
      id: 'ag-1',
      name: 'A',
      folder: 'a',
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      coworker_type: null,
      allowed_mcp_tools: null,
      created_at: now(),
    });
    for (const channel of ['slack', 'telegram', 'whatsapp'] as const) {
      const mgId = `mg-${channel}`;
      createMessagingGroup({
        id: mgId,
        channel_type: channel,
        platform_id: `${channel}:x`,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'public',
        admin_user_id: null,
        created_at: now(),
      });
      db.prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, 'ag-1', 'always', NULL, 'all', 'drop', 'shared', 0, ?)`,
      ).run(`mga-${channel}`, mgId, now());
    }

    migration019.up(db);
    const rows = db
      .prepare("SELECT id, session_mode FROM messaging_group_agents WHERE id LIKE 'mga-%'")
      .all() as Array<{ id: string; session_mode: string }>;
    for (const r of rows) {
      expect(r.session_mode, `row ${r.id} should still be 'shared'`).toBe('shared');
    }
  });

  it('is idempotent', () => {
    const db = getDb();
    createAgentGroup({
      id: 'ag-1',
      name: 'A',
      folder: 'a',
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      coworker_type: null,
      allowed_mcp_tools: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-agent',
      channel_type: 'agent',
      platform_id: 'agent:foo',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      admin_user_id: null,
      created_at: now(),
    });
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', 'mg-agent', 'ag-1', 'always', NULL, 'all', 'drop', 'per-thread', 0, ?)`,
    ).run(now());

    expect(() => migration019.up(db)).not.toThrow();
    expect(() => migration019.up(db)).not.toThrow();
    const row = db.prepare("SELECT session_mode FROM messaging_group_agents WHERE id = 'mga-1'").get() as {
      session_mode: string;
    };
    expect(row.session_mode).toBe('per-thread');
  });
});
