/**
 * Behavioral test harness.
 *
 * Foundational scaffold for the `/run-test` behavioral matrix. Each group
 * targets a specific test category listed in the run-test skill; together
 * they cover scheduler, approvals, lifecycle invariants, and migration
 * idempotency with minimal dependency on a live agent container.
 *
 * Implemented in this file:
 *   SC02 — scheduled task pause stays paused past fire time
 *   SC04 — scheduled task cancel stays cancelled past fire time
 *   AP05 — approval decision is case-insensitive (lowercase == capitalized)
 *   CL01 — IDLE_TIMEOUT < CONTAINER_TIMEOUT invariant guard
 *   MG01 — migration idempotency (schema_version dedupe survives rerun)
 *
 * Intentionally NOT implemented here (left as TODO recipes for future PRs
 * — each requires either a live agent container or the dashboard stack):
 *
 *   PR* — GitHub PR create/review/merge loop
 *     Recipe: spin up `/add-github` skill against a scratch repo; post a
 *     comment that triggers a review workflow; assert `outbound.db` row +
 *     GitHub API side effect.
 *
 *   CR* — credential redaction
 *     Recipe: configure OneCLI in mock mode; route a prompt referencing a
 *     secret handle; read container stdout+logs, assert the secret value
 *     never appears and the handle did.
 *
 *   AB* — agent-browser click/screenshot flow
 *     Recipe: boot container with agent-browser installed; drive it via
 *     `agent-browser open http://localhost:NNNN`; snapshot; click; assert
 *     last-page URL changed.
 *
 * Style guide: each describe() block mirrors the category code in the
 * /run-test skill so operators can grep and correlate. Keep tests
 * self-contained (fresh DB per test) so parallelism stays safe.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateContainerTimeouts } from './config.js';
import { startDashboardIngress } from './dashboard-ingress.js';
import { runMigrations } from './db/migrations/index.js';
import { countDueMessages, ensureSchema, openInboundDb } from './db/session-db.js';
import { cancelTask, insertTask, pauseTask } from './modules/scheduling/db.js';
import { once } from 'events';

const tempRoots: string[] = [];

afterEach(() => {
  for (const d of tempRoots) fs.rmSync(d, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nanoclaw-${label}-`));
  tempRoots.push(dir);
  return dir;
}

function freshInboundDb(): Database.Database {
  const dir = makeTempDir('sched-inbound');
  const dbPath = path.join(dir, 'inbound.db');
  ensureSchema(dbPath, 'inbound');
  return openInboundDb(dbPath);
}

function insertScheduledTask(
  db: Database.Database,
  id: string,
  processAfter: string,
  opts: { recurrence?: string | null } = {},
): void {
  insertTask(db, {
    id,
    processAfter,
    recurrence: opts.recurrence ?? null,
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: 'noop' }),
  });
}

// -----------------------------------------------------------------------
// SC02: scheduled task pause stays paused past fire time.
// -----------------------------------------------------------------------
// The scheduler's "what's due" query gates on `status='pending' AND
// process_after <= now()`. A paused task must drop out of that query so the
// sweep-driven fire path does NOT pick it up even after the nominal fire
// moment has passed. `sync-past-fire` is simulated by inserting with a
// `processAfter` that is already in the past — equivalent to sleeping T+30s
// without the wall-clock wait.
describe('SC02: scheduled task pause stays paused past fire time', () => {
  it('paused task is not due even after process_after elapses', () => {
    const db = freshInboundDb();
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    insertScheduledTask(db, 'task-sc02', pastIso);

    // Sanity: the task is due before we pause it.
    expect(countDueMessages(db)).toBe(1);

    pauseTask(db, 'task-sc02');

    // Paused → status moves from 'pending' to 'paused' → no longer due.
    expect(countDueMessages(db)).toBe(0);

    // Explicit cross-check: the row still exists (not deleted) and its
    // status is 'paused' — so resume would pick it back up.
    const row = db.prepare('SELECT status FROM messages_in WHERE id = ?').get('task-sc02') as {
      status: string;
    };
    expect(row.status).toBe('paused');
    db.close();
  });
});

// -----------------------------------------------------------------------
// SC04: scheduled task cancel stays cancelled past fire time.
// -----------------------------------------------------------------------
describe('SC04: scheduled task cancel stays cancelled past fire time', () => {
  it('cancelled task is not due even after process_after elapses', () => {
    const db = freshInboundDb();
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    insertScheduledTask(db, 'task-sc04', pastIso);

    expect(countDueMessages(db)).toBe(1);

    cancelTask(db, 'task-sc04');

    // Cancelled → status='completed' → not due.
    expect(countDueMessages(db)).toBe(0);

    const row = db.prepare('SELECT status, recurrence FROM messages_in WHERE id = ?').get('task-sc04') as {
      status: string;
      recurrence: string | null;
    };
    expect(row.status).toBe('completed');
    // Recurrence cleared so the recurrence sweep doesn't spawn a follow-up.
    expect(row.recurrence).toBeNull();
    db.close();
  });

  it('cancelling a recurring task prevents the live follow-up from firing', () => {
    const db = freshInboundDb();
    // Original task completed; follow-up queued via the normal recurrence
    // chain. Simulates the state after one fire.
    insertScheduledTask(db, 'task-sc04r', new Date(Date.now() - 3_600_000).toISOString(), {
      recurrence: '0 9 * * *',
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-sc04r'").run();
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES ('task-sc04r-next', 200, datetime('now'), 'pending', 0, ?, '0 9 * * *', 'task', NULL, NULL, NULL, '{}', 'task-sc04r')`,
    ).run(new Date(Date.now() - 60_000).toISOString());

    // Sanity: live follow-up is due before cancel.
    expect(countDueMessages(db)).toBe(1);

    cancelTask(db, 'task-sc04r');

    expect(countDueMessages(db)).toBe(0);
    const follow = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'task-sc04r-next'").get() as {
      status: string;
      recurrence: string | null;
    };
    expect(follow.status).toBe('completed');
    expect(follow.recurrence).toBeNull();
    db.close();
  });
});

// -----------------------------------------------------------------------
// AP05: approval decision is case-insensitive.
// -----------------------------------------------------------------------
// The dashboard ingress `/api/dashboard/action` endpoint normalizes the
// `decision` field before comparing against the canonical set. Posting
// lowercase `approve` must resolve identically to `Approve`.
describe('AP05: approval action decision is case-insensitive', () => {
  it('lowercase `approve` resolves to canonical `Approve` and invokes onActionFn', async () => {
    const onActionFn = vi.fn().mockResolvedValue(undefined);
    const handle = startDashboardIngress({
      host: '127.0.0.1',
      port: 0,
      isAdapterReady: () => true,
      onActionFn,
    });
    await once(handle.server, 'listening');
    try {
      const address = handle.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected dashboard ingress to bind an ephemeral TCP port');
      }

      const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: 'appr-123', decision: 'approve' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(onActionFn).toHaveBeenCalledTimes(1);
      // Canonicalized decision reaches the handler.
      expect(onActionFn).toHaveBeenCalledWith('appr-123', 'Approve', 'dashboard-admin');
    } finally {
      await handle.stop();
    }
  });

  it('uppercase `REJECT` also canonicalizes to `Reject`', async () => {
    const onActionFn = vi.fn().mockResolvedValue(undefined);
    const handle = startDashboardIngress({
      host: '127.0.0.1',
      port: 0,
      isAdapterReady: () => true,
      onActionFn,
    });
    await once(handle.server, 'listening');
    try {
      const address = handle.server.address();
      if (!address || typeof address === 'string') throw new Error('port');

      const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: 'appr-456', decision: 'REJECT' }),
      });

      expect(res.status).toBe(200);
      expect(onActionFn).toHaveBeenCalledWith('appr-456', 'Reject', 'dashboard-admin');
    } finally {
      await handle.stop();
    }
  });

  it('unrecognized decision still 400s with canonical set listed', async () => {
    const onActionFn = vi.fn().mockResolvedValue(undefined);
    const handle = startDashboardIngress({
      host: '127.0.0.1',
      port: 0,
      isAdapterReady: () => true,
      onActionFn,
    });
    await once(handle.server, 'listening');
    try {
      const address = handle.server.address();
      if (!address || typeof address === 'string') throw new Error('port');

      const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: 'appr-789', decision: 'maybe' }),
      });

      expect(res.status).toBe(400);
      expect(onActionFn).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
    }
  });
});

// -----------------------------------------------------------------------
// CL01: IDLE_TIMEOUT < CONTAINER_TIMEOUT regression guard.
// -----------------------------------------------------------------------
// Issue #2: the idle sweeper must fire before the hard-kill ceiling. If
// IDLE_TIMEOUT >= CONTAINER_TIMEOUT the sweep is effectively disabled.
// `validateContainerTimeouts` surfaces this at startup.
describe('CL01: IDLE_TIMEOUT / CONTAINER_TIMEOUT invariant', () => {
  it('strictly-less-than pairing returns ok', () => {
    const result = validateContainerTimeouts(60_000, 120_000);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('equal timeouts emit a warning (idle never fires before hard kill)', () => {
    const result = validateContainerTimeouts(1_800_000, 1_800_000);
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/IDLE_TIMEOUT.*CONTAINER_TIMEOUT/);
  });

  it('idle > ceiling emits a warning', () => {
    const result = validateContainerTimeouts(3_000_000, 1_800_000);
    expect(result.ok).toBe(false);
    expect(result.warning).toBeDefined();
  });
});

// -----------------------------------------------------------------------
// MG01: migration idempotency.
// -----------------------------------------------------------------------
// Re-running `runMigrations` on an already-migrated DB must be a no-op —
// no duplicate applied rows, no errors, and the schema_version state stays
// the same. Guards against future regressions in the migration loader.
describe('MG01: migrations are idempotent', () => {
  it('runMigrations twice produces identical schema_version state and does not throw', () => {
    const dir = makeTempDir('mg01');
    const dbPath = path.join(dir, 'app.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');

    // Run #1: apply everything.
    runMigrations(db);
    const after1 = db.prepare('SELECT name, version FROM schema_version ORDER BY version').all() as Array<{
      name: string;
      version: number;
    }>;
    expect(after1.length).toBeGreaterThan(0);

    // Run #2: must be a silent no-op.
    expect(() => runMigrations(db)).not.toThrow();

    const after2 = db.prepare('SELECT name, version FROM schema_version ORDER BY version').all() as Array<{
      name: string;
      version: number;
    }>;
    expect(after2).toEqual(after1);

    // Also assert no duplicate names (the UNIQUE index should already
    // enforce this, but a corruption in the loader could still multiply
    // rows if transactions were dropped).
    const names = after2.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);

    db.close();
  });

  it('migration 016 (disable-overlays) survives a rerun cycle with no schema drift', () => {
    const dir = makeTempDir('mg01-016');
    const dbPath = path.join(dir, 'app.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    runMigrations(db);

    const before = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();

    runMigrations(db);

    const after = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(after).toEqual(before);

    // agent_groups.disable_overlays should exist exactly once.
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('agent_groups') WHERE name = 'disable_overlays'")
      .all() as Array<{ name: string }>;
    expect(cols).toHaveLength(1);

    db.close();
  });
});
