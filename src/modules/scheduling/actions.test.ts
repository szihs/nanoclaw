/**
 * Tests for the scheduling action handlers — focused on the new_session
 * field wiring. PR #58 added reader support in the agent-runner poll-loop;
 * this test pins that handleScheduleTask (the host-side writer) persists
 * the flag into the stored task content so the reader has something to
 * read. Without this wiring, new_session is silently dropped between the
 * MCP tool call and the stored row.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { handleScheduleTask } from './actions.js';

const TEST_DIR = '/tmp/nanoclaw-scheduling-actions-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

const FAKE_SESSION: Session = {
  id: 'sess-test',
  agent_group_id: 'ag-test',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleScheduleTask — new_session wiring (default-on)', () => {
  // Post-default-on: fresh-session is the default; only explicit booleans
  // are persisted. Omission stores nothing — reader applies the default.
  it('writes new_session:true when the MCP payload explicitly sets true', async () => {
    const db = freshDb();
    await handleScheduleTask(
      {
        taskId: 'task-a',
        prompt: 'heartbeat check',
        script: null,
        processAfter: new Date().toISOString(),
        recurrence: '*/5 * * * *',
        new_session: true,
      },
      FAKE_SESSION,
      db,
    );
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-a') as { content: string };
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    expect(parsed.prompt).toBe('heartbeat check');
    expect(parsed.new_session).toBe(true);
    db.close();
  });

  it('writes new_session:false when the MCP payload explicitly sets false (opt-out)', async () => {
    const db = freshDb();
    await handleScheduleTask(
      {
        taskId: 'task-b',
        prompt: 'stateful multi-fire workflow',
        script: null,
        processAfter: new Date().toISOString(),
        recurrence: '0 */6 * * *',
        new_session: false,
      },
      FAKE_SESSION,
      db,
    );
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-b') as { content: string };
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    expect(parsed.new_session).toBe(false);
    db.close();
  });

  it('omits new_session from stored content when the MCP payload did not set it (reader applies default)', async () => {
    const db = freshDb();
    await handleScheduleTask(
      {
        taskId: 'task-c',
        prompt: 'one-shot reminder',
        script: null,
        processAfter: new Date().toISOString(),
        recurrence: null,
      },
      FAKE_SESSION,
      db,
    );
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-c') as { content: string };
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    expect(parsed.prompt).toBe('one-shot reminder');
    expect('new_session' in parsed).toBe(false);
    db.close();
  });

  it('does not persist a non-boolean new_session (no accidental promotion)', async () => {
    const db = freshDb();
    await handleScheduleTask(
      {
        taskId: 'task-d',
        prompt: 'x',
        script: null,
        processAfter: new Date().toISOString(),
        recurrence: '*/5 * * * *',
        new_session: 'true' as unknown as boolean, // string slipped through
      },
      FAKE_SESSION,
      db,
    );
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-d') as { content: string };
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    expect('new_session' in parsed).toBe(false);
    db.close();
  });
});
