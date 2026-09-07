/**
 * Backing module for `ncl cost-cap history` — per-coworker cost over ARBITRARY
 * date ranges, bucketed by day / week / total.
 *
 * This is the one cost surface the live tools can't provide. `status` is a
 * point-in-time per-session read; `sessions` / `stopped` / `coworkers` read the
 * dashboard's `GET /api/sessions`, which only offers the fixed 1d/7d/30d/all
 * windows and no time axis. Neither can answer "what did each coworker spend the
 * week of Aug 14?". This does, by reading the durable #65 cost ledger.
 *
 * SOURCE — the #65 `cost_events` ledger (per-session `outbound.db`,
 * `container/agent-runner/src/cost-events.ts`): one append-only row per billable
 * unit (a deduped Claude assistant message; a codex rollout call), each carrying
 * its OWN UTC `ts`, a token breakdown, and `priced_usd`. The runner writes it
 * dual-run for every turn. Because the whole ledger is `rate_version = 1`,
 * `priced_usd` (which already folds in `adjustment_usd`) is exactly what
 * `sumWindow` would recompute by re-pricing tokens — so this sums `priced_usd`
 * over the `ts` window rather than vendoring a fourth copy of the rate table on
 * the host (the Node host cannot import the Bun runner's pricing). If a future
 * `rate_version > 1` ever lands, this stays correct-as-billed (each row's dollar
 * is its own write-time price) but would need a token re-price to reflect a
 * retroactive rate change; the verb flags any non-v1 rows so that's visible.
 *
 * `window_gen` is an ENFORCEMENT-window concept (the active budget epoch), NOT a
 * dedup key — a billable unit is deduped by its identity PK within a session. So
 * a total-spend report sums EVERY generation. This was validated against real
 * prod data (2026-09-03): a cross-gen scan found 0 Claude messages recorded
 * under more than one generation, i.e. no `/clear`-rotation double counting.
 *
 * Read-only. Enumerates `outbound.db` files under DATA_DIR/v2-sessions on disk
 * (not the central `sessions` table) so it still reports a session whose central
 * row was pruned but whose ledger survives.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getAllAgentGroups } from '../db/agent-groups.js';

export type HistoryBy = 'day' | 'week' | 'total';
export const HISTORY_BY = ['day', 'week', 'total'] as const;

export interface CostHistoryBucket {
  /** 'YYYY-MM-DD' (day), 'YYYY-Www' ISO week (week), or 'all' (total). */
  bucket: string;
  usd: number;
  claudeUsd: number;
  codexUsd: number;
}

export interface CostHistoryGroup {
  /** Agent group id. */
  group: string;
  /** Display name (falls back to folder, then id). */
  group_name: string;
  total_usd: number;
  claudeUsd: number;
  codexUsd: number;
  buckets: CostHistoryBucket[];
}

export interface CostHistoryResult {
  /** Inclusive lower bound (YYYY-MM-DD) or null for unbounded. */
  from: string | null;
  /** Inclusive upper bound (YYYY-MM-DD) or null for unbounded. */
  to: string | null;
  by: HistoryBy;
  /** Filter that was applied (id/name/folder as typed), or null. */
  group: string | null;
  groups: CostHistoryGroup[];
  /** Total of the time/provider-attributed (non-baseline) events. */
  grand_total_usd: number;
  /** Pre-ledger migration-baseline lumps, summed separately: non-timestamped,
   *  provider-ambiguous, likely #1327-inflated, and overlapping recovered codex.
   *  Deliberately NOT part of grand_total_usd or any bucket. */
  legacy_baseline_usd: number;
  sessions_scanned: number;
  /** Sessions whose outbound.db actually had a cost_events table. */
  sessions_with_ledger: number;
  /** Sessions with an outbound.db but no cost_events table (pre-ledger runner). */
  sessions_no_ledger: number;
  /** Read failures (locked/corrupt/unreadable DB or dir). >0 ⇒ complete=false. */
  read_errors: number;
  /** False when any read failed — totals are then a LOWER BOUND, not authoritative. */
  complete: boolean;
  /** Distinct rate_versions seen; anything other than [1] means priced_usd is a
   *  mix of rate epochs (report-as-billed, not a single-rate re-price). */
  rate_versions: number[];
}

export interface ReadCostHistoryOpts {
  from?: string;
  to?: string;
  /** Match against agent group id, folder, or display name (case-insensitive). */
  group?: string;
  by?: HistoryBy;
  /** Override the sessions root (default DATA_DIR); for tests. */
  dataDir?: string;
}

/** ISO 8601 week key, Monday-anchored: 'YYYY-Www'. */
function isoWeekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '????-W??';
  // Shift to the Thursday of this week, then week 1 is the week with Jan 4th.
  const target = new Date(d);
  const dayNr = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function bucketKey(day: string, by: HistoryBy): string {
  if (by === 'total') return 'all';
  if (by === 'week') return isoWeekKey(day);
  return day;
}

/** Add one day to a 'YYYY-MM-DD' string, returning the next day's string. Used to
 *  make `--to` inclusive of its whole UTC day (ledger `ts` are full ISO). */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** True only for a real calendar date whose canonical form round-trips (so
 *  2026-02-29 / 2026-13-01 are rejected, not silently normalized by Date). */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Migration/reset baseline lumps carry the id `adj:<session>:base:<seq>`
 * (poll-loop.ts). They are a NON-timestamped snapshot of the session's prior
 * `costSpentUsd` at ledger-migration time — which was itself the pre-#1327-fix,
 * per-content-block-inflated enforcement counter — stamped `provider='claude'`
 * at the migration instant, and they OVERLAP the pre-existing codex calls the
 * ledger separately recovers at generation -1. Summing them into per-day /
 * per-provider buckets both double-counts and misattributes. So this surface
 * EXCLUDES them from the buckets and reports their total separately as
 * `legacy_baseline_usd`: unattributable, likely-inflated, pre-ledger spend.
 */
const BASELINE_ID_GLOB = "id LIKE 'adj:%:base:%'";

interface PerFileRow {
  provider: string;
  day: string;
  usd: number;
  rate_version: number;
}

type LedgerOutcome =
  | { kind: 'ok'; rows: PerFileRow[]; baselineUsd: number }
  | { kind: 'no_table' }
  | { kind: 'error'; detail: string };

/** Read + pre-aggregate one session's ledger, excluding baseline lumps from the
 *  buckets and totalling them separately. Distinguishes "no ledger table" from a
 *  genuine read error so the caller never presents a swallowed failure as $0. */
function scanLedger(dbPath: string, startInclusive: string | null, endExclusive: string | null): LedgerOutcome {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cost_events'").get();
    if (!has) return { kind: 'no_table' };
    // Half-open ts range pushed into SQL so the cost_events_ts index selects.
    // Sums ALL window generations (validated: no cross-gen dup — see header).
    // Positional `?` params — the host runs better-sqlite3, whose named-param
    // binding differs from the container's bun:sqlite; positional sidesteps that.
    const clauses: string[] = [];
    const params: string[] = [];
    if (startInclusive) {
      clauses.push('ts >= ?');
      params.push(startInclusive);
    }
    if (endExclusive) {
      clauses.push('ts < ?');
      params.push(endExclusive);
    }
    const windowWhere = clauses.length ? clauses.join(' AND ') : '1=1';
    const rows = db
      .prepare(
        `SELECT provider, substr(ts,1,10) AS day, rate_version, SUM(priced_usd) AS usd
         FROM cost_events
         WHERE ${windowWhere} AND NOT (${BASELINE_ID_GLOB})
         GROUP BY provider, day, rate_version`,
      )
      .all(...params) as Array<{ provider: string; day: string; rate_version: number; usd: number }>;
    const baselineRow = db
      .prepare(`SELECT SUM(priced_usd) AS usd FROM cost_events WHERE ${windowWhere} AND ${BASELINE_ID_GLOB}`)
      .get(...params) as { usd: number | null } | undefined;
    return {
      kind: 'ok',
      baselineUsd: Number(baselineRow?.usd) || 0,
      rows: rows.map((r) => ({
        provider: String(r.provider),
        day: String(r.day),
        usd: Number(r.usd) || 0,
        rate_version: Number(r.rate_version) || 0,
      })),
    };
  } catch (e) {
    return { kind: 'error', detail: String((e as Error)?.message || e).slice(0, 160) };
  } finally {
    db?.close();
  }
}

/** Enumerate `<dataDir>/v2-sessions/<groupId>/<sessionId>/outbound.db`. A group
 *  dir that can't be listed is a read error (counted), not a silent skip. An
 *  absent sessions root is NOT an error (a fresh box legitimately has none). */
function enumerateOutboundDbs(sessionsRoot: string): {
  entries: Array<{ group: string; dbPath: string }>;
  dirErrors: number;
} {
  const entries: Array<{ group: string; dbPath: string }> = [];
  let dirErrors = 0;
  let groups: string[];
  try {
    groups = fs.readdirSync(sessionsRoot);
  } catch (e) {
    // ENOENT = a box with no sessions yet (fine); anything else = a real error.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { entries, dirErrors };
    return { entries, dirErrors: 1 };
  }
  for (const group of groups) {
    const groupDir = path.join(sessionsRoot, group);
    let sessions: string[];
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
      sessions = fs.readdirSync(groupDir);
    } catch {
      dirErrors++;
      continue;
    }
    for (const session of sessions) {
      const dbPath = path.join(groupDir, session, 'outbound.db');
      if (fs.existsSync(dbPath)) entries.push({ group, dbPath });
    }
  }
  return { entries, dirErrors };
}

export async function readCostHistory(opts: ReadCostHistoryOpts): Promise<CostHistoryResult> {
  const by: HistoryBy = opts.by ?? 'week';
  const from = opts.from ? opts.from.trim() : '';
  const to = opts.to ? opts.to.trim() : '';
  // Finding 3: reject nonexistent calendar dates and inverted ranges rather than
  // silently normalizing (Date turns 2026-02-29 into March) or returning $0.
  if (from && !isValidDate(from)) throw new Error(`--from is not a real date: ${from}`);
  if (to && !isValidDate(to)) throw new Error(`--to is not a real date: ${to}`);
  if (from && to && from > to) throw new Error(`--from (${from}) is after --to (${to})`);
  const startInclusive = from || null;
  const endExclusive = to ? nextDay(to) : null;

  const dataDir = opts.dataDir ?? DATA_DIR;
  const sessionsRoot = path.join(dataDir, 'v2-sessions');

  // group id -> {name, folder}. Track whether the central DB actually answered,
  // so a metadata failure can't masquerade as "group not found".
  const nameById = new Map<string, { name: string; folder: string }>();
  let metadataOk = true;
  try {
    for (const g of await getAllAgentGroups()) {
      nameById.set(g.id, { name: g.name ?? '', folder: g.folder ?? '' });
    }
  } catch {
    metadataOk = false;
  }

  const { entries, dirErrors } = enumerateOutboundDbs(sessionsRoot);
  const onDiskGroupIds = new Set(entries.map((e) => e.group));

  // Finding 4: resolve --group up front. A selector that matches nothing is an
  // ERROR (not "$0 spend"). When metadata is unavailable, only an exact on-disk
  // group id can match — a folder/name selector then can't be trusted to resolve.
  const wantGroup = opts.group ? opts.group.trim() : '';
  let allowedIds: Set<string> | null = null;
  if (wantGroup) {
    const w = wantGroup.toLowerCase();
    const ids = new Set<string>();
    for (const [gid, meta] of nameById) {
      if (gid.toLowerCase() === w || meta.folder.toLowerCase() === w || meta.name.toLowerCase() === w) {
        ids.add(gid);
      }
    }
    if (onDiskGroupIds.has(wantGroup)) ids.add(wantGroup); // exact id, even w/o metadata
    if (ids.size === 0) {
      if (!metadataOk) {
        throw new Error(
          `--group '${wantGroup}' did not match an on-disk group id, and the group registry ` +
            `was unavailable to resolve it by folder/name.`,
        );
      }
      throw new Error(`--group '${wantGroup}' matched no agent group (by id, folder, or name).`);
    }
    allowedIds = ids;
  }

  interface Acc {
    total: number;
    claude: number;
    codex: number;
    buckets: Map<string, { usd: number; claude: number; codex: number }>;
  }
  const byGroup = new Map<string, Acc>();
  const rateVersions = new Set<number>();
  let scanned = 0;
  let withLedger = 0;
  let noLedger = 0;
  let readErrors = dirErrors;
  let legacyBaseline = 0;

  for (const { group, dbPath } of entries) {
    if (allowedIds && !allowedIds.has(group)) continue;
    scanned++;
    const outcome = scanLedger(dbPath, startInclusive, endExclusive);
    if (outcome.kind === 'error') {
      readErrors++;
      continue;
    }
    if (outcome.kind === 'no_table') {
      noLedger++;
      continue;
    }
    withLedger++;
    legacyBaseline += outcome.baselineUsd;
    if (outcome.rows.length === 0) continue;
    let acc = byGroup.get(group);
    if (!acc) {
      acc = { total: 0, claude: 0, codex: 0, buckets: new Map() };
      byGroup.set(group, acc);
    }
    for (const r of outcome.rows) {
      rateVersions.add(r.rate_version);
      const key = bucketKey(r.day, by);
      let b = acc.buckets.get(key);
      if (!b) {
        b = { usd: 0, claude: 0, codex: 0 };
        acc.buckets.set(key, b);
      }
      b.usd += r.usd;
      acc.total += r.usd;
      if (r.provider === 'codex') {
        b.codex += r.usd;
        acc.codex += r.usd;
      } else {
        b.claude += r.usd;
        acc.claude += r.usd;
      }
    }
  }

  const groups: CostHistoryGroup[] = [...byGroup.entries()]
    .map(([gid, acc]) => {
      const meta = nameById.get(gid);
      const buckets: CostHistoryBucket[] = [...acc.buckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([bucket, v]) => ({ bucket, usd: v.usd, claudeUsd: v.claude, codexUsd: v.codex }));
      return {
        group: gid,
        group_name: meta?.name || meta?.folder || gid,
        total_usd: acc.total,
        claudeUsd: acc.claude,
        codexUsd: acc.codex,
        buckets,
      };
    })
    .sort((a, b) => b.total_usd - a.total_usd);

  const grand = groups.reduce((s, g) => s + g.total_usd, 0);

  return {
    from: startInclusive,
    to: to || null,
    by,
    group: opts.group ? opts.group.trim() : null,
    groups,
    grand_total_usd: grand,
    legacy_baseline_usd: legacyBaseline,
    sessions_scanned: scanned,
    sessions_with_ledger: withLedger,
    sessions_no_ledger: noLedger,
    read_errors: readErrors,
    complete: readErrors === 0,
    rate_versions: [...rateVersions].sort((a, b) => a - b),
  };
}
