import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from './index.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface TableInfo {
  name: string;
}

interface IndexInfo {
  name: string;
}

beforeEach(() => {
  initTestDb();
});

afterEach(() => {
  closeDb();
});

describe('migration 006 — coworker fields', () => {
  it('adds coworker_type and allowed_mcp_tools columns to agent_groups', () => {
    const db = initTestDb();
    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(agent_groups)').all() as ColumnInfo[];
    const names = columns.map((c) => c.name);

    expect(names).toContain('coworker_type');
    expect(names).toContain('allowed_mcp_tools');

    const coworker = columns.find((c) => c.name === 'coworker_type')!;
    expect(coworker.type.toUpperCase()).toBe('TEXT');
    expect(coworker.notnull).toBe(0); // nullable — old rows predate the column

    const tools = columns.find((c) => c.name === 'allowed_mcp_tools')!;
    expect(tools.type.toUpperCase()).toBe('TEXT');
    expect(tools.notnull).toBe(0);
  });

  it('records version 6 in schema_version', () => {
    const db = initTestDb();
    runMigrations(db);

    const row = db.prepare('SELECT name FROM schema_version WHERE version = 6').get() as { name: string } | undefined;
    expect(row?.name).toBe('coworker-fields');
  });
});

describe('migration 007 — hook_events table', () => {
  it('creates the hook_events table with the documented columns', () => {
    const db = initTestDb();
    runMigrations(db);

    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hook_events'").get() as
      | TableInfo
      | undefined;
    expect(table).toBeDefined();

    const columns = db.prepare('PRAGMA table_info(hook_events)').all() as ColumnInfo[];
    const names = columns.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'agent_id',
        'agent_type',
        'created_at',
        'cwd',
        'event',
        'extra',
        'group_folder',
        'id',
        'message',
        'session_id',
        'timestamp',
        'tool',
        'tool_input',
        'tool_response',
        'tool_use_id',
        'transcript_path',
      ].sort(),
    );

    const id = columns.find((c) => c.name === 'id')!;
    expect(id.pk).toBe(1);

    // NOT NULL invariants for the host-ingest contract (hook-event POST body).
    const groupFolder = columns.find((c) => c.name === 'group_folder')!;
    expect(groupFolder.notnull).toBe(1);
    const event = columns.find((c) => c.name === 'event')!;
    expect(event.notnull).toBe(1);
    const ts = columns.find((c) => c.name === 'timestamp')!;
    expect(ts.notnull).toBe(1);
  });

  it('creates indexes on group_folder, session_id, tool_use_id, and timestamp', () => {
    const db = initTestDb();
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='hook_events'")
      .all() as IndexInfo[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_he_group');
    expect(indexNames).toContain('idx_he_session');
    expect(indexNames).toContain('idx_he_tool_use');
    expect(indexNames).toContain('idx_he_ts');
  });

  it('inserts default timestamps for created_at', () => {
    const db = initTestDb();
    runMigrations(db);

    db.prepare(`INSERT INTO hook_events (group_folder, event, timestamp) VALUES (?, ?, ?)`).run(
      'test-group',
      'PreToolUse',
      Date.now(),
    );

    const row = db.prepare('SELECT created_at FROM hook_events LIMIT 1').get() as { created_at: string };
    expect(typeof row.created_at).toBe('string');
    expect(row.created_at.length).toBeGreaterThan(0);
  });

  it('records hook-events in schema_version', () => {
    const db = initTestDb();
    runMigrations(db);

    const row = db.prepare("SELECT name FROM schema_version WHERE name = 'hook-events'").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('hook-events');
  });
});

describe('runMigrations', () => {
  it('applies migrations in order and is idempotent', () => {
    const db = initTestDb();
    runMigrations(db);
    const firstCount = (db.prepare('SELECT COUNT(*) as c FROM schema_version').get() as { c: number }).c;

    runMigrations(db);
    const secondCount = (db.prepare('SELECT COUNT(*) as c FROM schema_version').get() as { c: number }).c;

    expect(firstCount).toBe(secondCount);
    expect(firstCount).toBeGreaterThanOrEqual(7);
  });
});
