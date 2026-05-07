/**
 * Per-thread session creation — used by the dashboard's Slack-style
 * threaded conversations. A session is keyed on
 * (agent_group_id, messaging_group_id, thread_id); two distinct thread_ids
 * on the same channel must produce two distinct sessions, while repeated
 * posts to the same thread_id must reuse the same session.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-per-thread' };
});

const TEST_DIR = '/tmp/nanoclaw-test-per-thread';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession } from './session-manager.js';

function now(): string {
  return new Date().toISOString();
}

function seed(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'dashboard',
    platform_id: 'dashboard:test-agent',
    name: 'Dashboard',
    is_group: 0,
    admin_user_id: null,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('resolveSession — per-thread mode (dashboard threads)', () => {
  it('creates a new session keyed on thread_id when threadId is non-null', () => {
    seed();
    const { session, created } = resolveSession('ag-1', 'mg-1', 'parent-a', 'per-thread');
    expect(created).toBe(true);
    expect(session.thread_id).toBe('parent-a');
    expect(session.agent_group_id).toBe('ag-1');
    expect(session.messaging_group_id).toBe('mg-1');
  });

  it('reuses an existing session when called again with the same thread_id', () => {
    seed();
    const first = resolveSession('ag-1', 'mg-1', 'parent-a', 'per-thread');
    const second = resolveSession('ag-1', 'mg-1', 'parent-a', 'per-thread');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
  });

  it('creates a DIFFERENT session for a different thread_id on the same channel', () => {
    seed();
    const t1 = resolveSession('ag-1', 'mg-1', 'parent-a', 'per-thread');
    const t2 = resolveSession('ag-1', 'mg-1', 'parent-b', 'per-thread');
    expect(t1.session.id).not.toBe(t2.session.id);
    expect(t1.session.thread_id).toBe('parent-a');
    expect(t2.session.thread_id).toBe('parent-b');
  });

  it('threadId=null in per-thread mode resolves (or creates) a root session (thread_id IS NULL)', () => {
    seed();
    const root = resolveSession('ag-1', 'mg-1', null, 'per-thread');
    expect(root.session.thread_id).toBeNull();
    // Posting with a thread_id afterward must NOT reuse the root session.
    const threaded = resolveSession('ag-1', 'mg-1', 'parent-a', 'per-thread');
    expect(threaded.session.id).not.toBe(root.session.id);
  });

  it('does not cross-contaminate a shared-mode session with a per-thread session', () => {
    seed();
    // A shared-mode call (simulating a non-threaded channel) creates a
    // root session. A per-thread call with the same threadId must start
    // a new session, not reuse the shared one, because shared sessions
    // collapse to thread_id IS NULL.
    const shared = resolveSession('ag-1', 'mg-1', null, 'shared');
    const threaded = resolveSession('ag-1', 'mg-1', 'parent-a', 'per-thread');
    expect(shared.session.thread_id).toBeNull();
    expect(threaded.session.thread_id).toBe('parent-a');
    expect(threaded.session.id).not.toBe(shared.session.id);
  });
});
