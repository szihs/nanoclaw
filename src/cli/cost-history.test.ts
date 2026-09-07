import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the test hermetic: no central DB. Two of the three fixture groups get a
// friendly name so name-mapping is exercised; the third falls back to its id.
vi.mock('../db/agent-groups.js', () => ({
  getAllAgentGroups: async () => [
    { id: 'ag-fixer', name: 'slang-fixer', folder: 'slang-fixer' },
    { id: 'ag-triager', name: 'slang-triager', folder: 'slang-triager' },
  ],
}));

import { readCostHistory } from './cost-history.js';

const COLS = `id, ts, provider, model, input_tokens, cache_read_tokens, cache_write_tokens,
  cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, reasoning_tokens,
  priced_usd, rate_version, adjustment_usd, window_gen, thread_id, gh_ref, created_at`;

interface Row {
  id: string;
  ts: string;
  provider?: 'claude' | 'codex';
  priced: number;
  gen?: number;
  rv?: number;
}

let root: string;

function makeSession(group: string, session: string, rows: Row[] | null): void {
  const dir = path.join(root, 'v2-sessions', group, session);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'outbound.db'));
  if (rows === null) {
    // Session with an outbound.db but NO cost_events table.
    db.exec('CREATE TABLE session_state (k TEXT, v TEXT)');
    db.close();
    return;
  }
  db.exec(`CREATE TABLE cost_events (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, priced_usd REAL NOT NULL, rate_version INTEGER NOT NULL,
    adjustment_usd REAL NOT NULL DEFAULT 0, window_gen INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT, gh_ref TEXT, created_at TEXT NOT NULL)`);
  const ins = db.prepare(
    `INSERT INTO cost_events (${COLS}) VALUES
     (@id,@ts,@provider,'m',0,0,0,0,0,0,0,@priced,@rv,0,@gen,NULL,NULL,@ts)`,
  );
  for (const r of rows) {
    ins.run({ id: r.id, ts: r.ts, provider: r.provider ?? 'claude', priced: r.priced, rv: r.rv ?? 1, gen: r.gen ?? 0 });
  }
  db.close();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-hist-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readCostHistory', () => {
  it('aggregates per coworker, splits provider, buckets by ISO week, sums all gens', async () => {
    // Two sessions in the fixer group across two ISO weeks; codex + claude; a
    // second window generation must still be counted (no gen dedup).
    makeSession('ag-fixer', 's1', [
      { id: 'claude:0:a', ts: '2026-08-11T10:00:00.000Z', priced: 10 }, // 2026-W33
      { id: 'claude:0:b', ts: '2026-08-13T10:00:00.000Z', priced: 5, gen: 0 }, // W33
      { id: 'codex:x#1', ts: '2026-08-13T11:00:00.000Z', provider: 'codex', priced: 2 }, // W33
    ]);
    makeSession('ag-fixer', 's2', [
      { id: 'claude:7:c', ts: '2026-08-18T10:00:00.000Z', priced: 20, gen: 7 }, // 2026-W34, different gen
    ]);
    makeSession('ag-triager', 's3', [
      { id: 'claude:0:d', ts: '2026-08-18T10:00:00.000Z', priced: 3 }, // W34
    ]);

    const r = await readCostHistory({ dataDir: root, by: 'week' });
    expect(r.grand_total_usd).toBeCloseTo(40, 6);
    expect(r.sessions_scanned).toBe(3);
    expect(r.sessions_with_ledger).toBe(3);
    expect(r.groups.map((g) => g.group_name)).toEqual(['slang-fixer', 'slang-triager']); // sorted desc by total

    const fixer = r.groups[0];
    expect(fixer.total_usd).toBeCloseTo(37, 6);
    expect(fixer.claudeUsd).toBeCloseTo(35, 6);
    expect(fixer.codexUsd).toBeCloseTo(2, 6);
    const w33 = fixer.buckets.find((b) => b.bucket === '2026-W33')!;
    expect(w33.usd).toBeCloseTo(17, 6);
    const w34 = fixer.buckets.find((b) => b.bucket === '2026-W34')!;
    expect(w34.usd).toBeCloseTo(20, 6); // gen 7 row counted
  });

  it('honors an inclusive --from/--to date window', async () => {
    makeSession('ag-fixer', 's1', [
      { id: 'a', ts: '2026-08-09T23:00:00.000Z', priced: 100 }, // before window
      { id: 'b', ts: '2026-08-10T00:00:00.000Z', priced: 1 }, // from-day, included
      { id: 'c', ts: '2026-08-15T23:59:59.000Z', priced: 1 }, // to-day, included (whole day)
      { id: 'd', ts: '2026-08-16T00:00:00.000Z', priced: 100 }, // after window
    ]);
    const r = await readCostHistory({ dataDir: root, from: '2026-08-10', to: '2026-08-15', by: 'total' });
    expect(r.grand_total_usd).toBeCloseTo(2, 6);
    expect(r.groups[0].buckets).toEqual([{ bucket: 'all', usd: 2, claudeUsd: 2, codexUsd: 0 }]);
  });

  it('filters to one group by id, folder, or name', async () => {
    makeSession('ag-fixer', 's1', [{ id: 'a', ts: '2026-08-11T10:00:00.000Z', priced: 10 }]);
    makeSession('ag-triager', 's2', [{ id: 'b', ts: '2026-08-11T10:00:00.000Z', priced: 5 }]);

    for (const sel of ['ag-fixer', 'slang-fixer', 'SLANG-FIXER']) {
      const r = await readCostHistory({ dataDir: root, group: sel, by: 'total' });
      expect(r.groups).toHaveLength(1);
      expect(r.groups[0].total_usd).toBeCloseTo(10, 6);
    }
  });

  it('counts a session without a cost_events table as scanned-but-not-ledgered', async () => {
    makeSession('ag-fixer', 's1', [{ id: 'a', ts: '2026-08-11T10:00:00.000Z', priced: 10 }]);
    makeSession('ag-fixer', 's2', null); // outbound.db, no ledger table
    const r = await readCostHistory({ dataDir: root, by: 'total' });
    expect(r.sessions_scanned).toBe(2);
    expect(r.sessions_with_ledger).toBe(1);
    expect(r.grand_total_usd).toBeCloseTo(10, 6);
  });

  it('surfaces non-v1 rate_versions for report-as-billed visibility', async () => {
    makeSession('ag-fixer', 's1', [
      { id: 'a', ts: '2026-08-11T10:00:00.000Z', priced: 10, rv: 1 },
      { id: 'b', ts: '2026-08-11T11:00:00.000Z', priced: 5, rv: 2 },
    ]);
    const r = await readCostHistory({ dataDir: root, by: 'total' });
    expect(r.rate_versions).toEqual([1, 2]);
    expect(r.grand_total_usd).toBeCloseTo(15, 6);
  });

  it('returns empty & COMPLETE (no throw) when the sessions root is absent', async () => {
    const r = await readCostHistory({ dataDir: path.join(root, 'nonexistent'), by: 'week' });
    expect(r.groups).toEqual([]);
    expect(r.grand_total_usd).toBe(0);
    expect(r.sessions_scanned).toBe(0);
    expect(r.complete).toBe(true); // absent root is not an error
  });

  it('EXCLUDES migration-baseline lumps from buckets and reports them separately', async () => {
    makeSession('ag-fixer', 's1', [
      { id: 'adj:sess:base:1', ts: '2026-08-11T10:00:00.000Z', priced: 900 }, // lump — excluded
      { id: 'claude:0:a', ts: '2026-08-11T10:00:00.000Z', priced: 7 }, // real
      { id: 'codex:x#1', ts: '2026-08-11T11:00:00.000Z', provider: 'codex', priced: 3 }, // real
      { id: 'adj:sess:9', ts: '2026-08-11T12:00:00.000Z', priced: 1 }, // residual adj — kept
    ]);
    const r = await readCostHistory({ dataDir: root, by: 'total' });
    expect(r.grand_total_usd).toBeCloseTo(11, 6); // 7 + 3 + 1, NOT 911
    expect(r.legacy_baseline_usd).toBeCloseTo(900, 6);
    expect(r.groups[0].claudeUsd).toBeCloseTo(8, 6); // claude 7 + residual 1
    expect(r.groups[0].codexUsd).toBeCloseTo(3, 6);
  });

  it('flags read failures as incomplete instead of silently undercounting', async () => {
    makeSession('ag-fixer', 's1', [{ id: 'a', ts: '2026-08-11T10:00:00.000Z', priced: 10 }]);
    // A directory named outbound.db that is NOT a valid sqlite file → open error.
    const bad = path.join(root, 'v2-sessions', 'ag-fixer', 's2');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'outbound.db'), 'not a database');
    const r = await readCostHistory({ dataDir: root, by: 'total' });
    expect(r.read_errors).toBeGreaterThanOrEqual(1);
    expect(r.complete).toBe(false);
    expect(r.grand_total_usd).toBeCloseTo(10, 6); // the readable one still counts
  });

  it('rejects nonexistent calendar dates and inverted ranges', async () => {
    makeSession('ag-fixer', 's1', [{ id: 'a', ts: '2026-08-11T10:00:00.000Z', priced: 10 }]);
    await expect(readCostHistory({ dataDir: root, to: '2026-02-29' })).rejects.toThrow(/real date/);
    await expect(readCostHistory({ dataDir: root, from: '2026-13-01' })).rejects.toThrow(/real date/);
    await expect(readCostHistory({ dataDir: root, from: '2026-08-10', to: '2026-08-01' })).rejects.toThrow(/after/);
    // A real leap day is fine.
    await expect(readCostHistory({ dataDir: root, from: '2024-02-29', to: '2024-02-29' })).resolves.toBeDefined();
  });

  it('errors (not $0) when --group matches nothing', async () => {
    makeSession('ag-fixer', 's1', [{ id: 'a', ts: '2026-08-11T10:00:00.000Z', priced: 10 }]);
    await expect(readCostHistory({ dataDir: root, group: 'no-such-coworker' })).rejects.toThrow(/matched no/);
  });
});
