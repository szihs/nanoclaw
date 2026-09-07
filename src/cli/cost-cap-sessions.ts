/**
 * Backing module for `ncl cost-cap sessions` — the per-session cost
 * DISTRIBUTION surface (per-group aggregates + percentiles), the missing
 * counterpart to the tripped-tail `escalations` verb. A container coworker (the
 * cli_scope=global Orchestrator) can already see the sessions that hit a cap
 * (`escalations`) and one session's live state (`status`), but has no way to
 * reach the FULL cost distribution — so it can't compute a per-group p95 to set
 * a sane ceiling. This closes that gap.
 *
 * The authoritative per-session cost is priced from transcripts by the DASHBOARD
 * process (`dashboard/server.ts` `refreshSessionCostCache` / `session-costs.ts`,
 * installed via `/add-dashboard`), NOT the host — the same source
 * `ops/metrics/nanoclaw-metrics.py collect_cost()` reads. So this reads the
 * dashboard's own `GET /api/sessions?period=<Nd>` over loopback and does the
 * percentile math here. Pure aggregation is split out (`aggregateSessionCosts`,
 * `rankSessionCosts`, `percentileNearestRank`) so it is unit-testable without a
 * live dashboard, and the verb handler is a thin fetch-then-aggregate delegate.
 */
import { DASHBOARD_PORT, DASHBOARD_SECRET } from '../config.js';

/** The dashboard's day-window buckets (`ContextPeriod` in dashboard/server.ts). */
export const COST_PERIODS = ['1d', '7d', '30d', 'all'] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

/** One session row from the dashboard `/api/sessions` payload — only the fields
 *  this surface reads. `cost` is the authoritative total (claudeUsd + codexUsd).
 *  The `cost*` fields are the LIVE cost-cap state the dashboard joins onto EVERY
 *  session (ungated on cost) via `buildSessionCostFields` — see the `stopped`
 *  view below; `costStatus` is the exact `costStatus` the dashboard renders. */
export interface SessionCostRow {
  session_id: string;
  agent_group_id: string;
  group_name: string;
  group_folder: string;
  status?: string;
  container_status?: string;
  cost: number;
  claudeUsd?: number;
  codexUsd?: number;
  /** Live cost-cap status — 'ok' | 'warn' | 'escalated' | 'stopped' (the dashboard's `costStatus`). */
  costStatus?: string;
  /** Runner's windowed enforcement spend (USD). */
  costSpent?: number;
  /** True lifetime spend (USD), period-independent — the pill's "spent" number. */
  costLifetime?: number;
  /** Live per-session soft cap (USD). */
  costCap?: number;
  /** Live Tier-2 hard ceiling (USD). */
  costCeiling?: number;
  /** Immortal (orchestrator/admin) session — never actually stopped. */
  costImmortal?: boolean;
}

/** Per-group cost aggregate — the default `sessions` output. */
export interface GroupCostAggregate {
  group: string;
  group_name: string;
  sessions: number;
  total_usd: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

/** What `fetchSessionCosts` returns: the session rows plus the dashboard's own
 *  cost-availability signal (echoed straight through — see below). */
export interface FetchSessionCostsResult {
  sessions: SessionCostRow[];
  /**
   * The dashboard's `costUnavailable` field (`ccusageUnavailable()`): a REASON
   * string when the cost subsystem reports numbers as ABSENT rather than merely
   * zero, else null. We THREAD it through instead of throwing on it: the
   * per-session `cost` on `/api/sessions` is transcript-priced (MODEL_PRICING),
   * independent of the ccusage CLI this flag tracks, so it is usually still
   * valid even when the flag is set — throwing would break `sessions` on every
   * install without ccusage. Surfacing the reason lets a caller distinguish
   * "no spend" from "pricing absent" before turning a p95 into a ceiling.
   */
  costUnavailable: string | null;
}

/** One row of the raw per-session list (`--sessions`). */
export interface SessionCostListEntry {
  session_id: string;
  group: string;
  group_name: string;
  cost: number;
  claudeUsd: number;
  codexUsd: number;
  status: string | null;
  container_status: string | null;
}

/** Round a USD amount to whole cents — the natural granularity for cost and the
 *  unit a ceiling is set in (integer cents), so a reported p95 is directly
 *  usable as `set-ceiling --ceiling`. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Nearest-rank percentile (zero-indexed floor), byte-for-byte the method the
 * host already uses: `dashboard/server.ts`'s `p90Of` (which writes
 * `data/cost-thresholds.json`) and, transitively, `resolveCostCapT2Usd`'s p90
 * read contract. Sort ascending, take the element at
 * `min(n - 1, floor(p * (n - 1)))`. No interpolation, so every value returned is
 * an ACTUALLY-OBSERVED session cost — a p95 a coworker turns into a ceiling is a
 * real session's spend, not a synthesized midpoint. `p` is a fraction in [0, 1].
 */
export function percentileNearestRank(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
  return sortedAsc[idx];
}

/** Only sessions that actually spent money participate in the distribution. */
function pricedRows(sessions: SessionCostRow[], group?: string): SessionCostRow[] {
  return sessions.filter((s) => {
    if (!s.group_folder) return false;
    if (group && s.group_folder !== group) return false;
    return typeof s.cost === 'number' && s.cost > 0;
  });
}

/**
 * Per-group aggregates over each group's own priced (cost > 0) session list.
 * Groups with no priced session in the window are omitted (matching "for each
 * group_folder with cost>0"). Sorted by total spend descending so the fat-tail
 * group — the one worth setting a ceiling on — is first.
 */
export function aggregateSessionCosts(sessions: SessionCostRow[], opts: { group?: string } = {}): GroupCostAggregate[] {
  const byGroup = new Map<string, { name: string; costs: number[] }>();
  for (const s of pricedRows(sessions, opts.group)) {
    const bucket = byGroup.get(s.group_folder) ?? { name: s.group_name || s.group_folder, costs: [] };
    bucket.costs.push(s.cost);
    byGroup.set(s.group_folder, bucket);
  }

  const out: GroupCostAggregate[] = [];
  for (const [group, { name, costs }] of byGroup) {
    const sorted = [...costs].sort((a, b) => a - b);
    out.push({
      group,
      group_name: name,
      sessions: sorted.length,
      total_usd: round2(sorted.reduce((a, b) => a + b, 0)),
      p50: round2(percentileNearestRank(sorted, 0.5)),
      p90: round2(percentileNearestRank(sorted, 0.9)),
      p95: round2(percentileNearestRank(sorted, 0.95)),
      max: round2(sorted[sorted.length - 1]),
    });
  }
  out.sort((a, b) => b.total_usd - a.total_usd);
  return out;
}

/** The raw priced per-session list, ranked by cost desc (the `--sessions` view). */
export function rankSessionCosts(sessions: SessionCostRow[], opts: { group?: string } = {}): SessionCostListEntry[] {
  return pricedRows(sessions, opts.group)
    .map((s) => ({
      session_id: s.session_id,
      group: s.group_folder,
      group_name: s.group_name || s.group_folder,
      cost: round2(s.cost),
      claudeUsd: round2(typeof s.claudeUsd === 'number' ? s.claudeUsd : 0),
      codexUsd: round2(typeof s.codexUsd === 'number' ? s.codexUsd : 0),
      status: s.status ?? null,
      container_status: s.container_status ?? null,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Read the authoritative per-session cost list from the local dashboard's
 * `/api/sessions` endpoint. Requires the dashboard server (`/add-dashboard`) to
 * be installed and running — this is a RUNTIME dependency, not a build one (the
 * host tree carries no dashboard source). Bearer-authenticated only when
 * `DASHBOARD_SECRET` is set (localhost-open otherwise, matching the dashboard's
 * own `requireAuth`). Throws a clear, actionable error on any failure so the
 * caller sees "the dashboard isn't reachable" rather than a silent empty list.
 * The dashboard's `costUnavailable` reason is echoed through (never swallowed)
 * so a caller can tell "pricing absent" apart from "no spend".
 */
export async function fetchSessionCosts(period: CostPeriod): Promise<FetchSessionCostsResult> {
  const url = `http://127.0.0.1:${DASHBOARD_PORT}/api/sessions?period=${encodeURIComponent(period)}`;
  const headers: Record<string, string> = {};
  if (DASHBOARD_SECRET) headers.Authorization = `Bearer ${DASHBOARD_SECRET}`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(
      `could not reach the dashboard cost API at ${url} — is the dashboard server running ` +
        `(/add-dashboard) and DASHBOARD_PORT correct? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error('dashboard cost API returned 401 — DASHBOARD_SECRET is set but the host did not send it');
    }
    throw new Error(`dashboard cost API returned ${resp.status} ${resp.statusText}`);
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(`dashboard cost API returned invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const payload = body as { sessions?: unknown; costUnavailable?: unknown } | null;
  if (!Array.isArray(payload?.sessions)) {
    throw new Error('dashboard cost API returned an unexpected shape (no `sessions` array)');
  }
  return {
    sessions: payload.sessions as SessionCostRow[],
    costUnavailable: typeof payload.costUnavailable === 'string' ? payload.costUnavailable : null,
  };
}

// ── LIVE "currently-stopped" view (ncl cost-cap stopped / MCP list_stopped_sessions) ──

/** One CURRENTLY-stopped session, shaped for JSON/human output. */
export interface StoppedSessionView {
  session_id: string;
  agent_group_id: string;
  group_folder: string | null;
  group_name: string | null;
  /** Always 'stopped' — this list is the live-stopped set, by construction. */
  status: 'stopped';
  /** Lifetime spend (falls back to the windowed enforcement counter). */
  spent_usd?: number;
  cap_usd?: number;
  ceiling_usd?: number;
  immortal?: boolean;
  /** The period-priced cost column, for context. */
  cost_usd?: number;
  container_status: string | null;
}

/** What `listStoppedSessions` returns. */
export interface StoppedSessionsResult {
  count: number;
  group: string | null;
  /** The dashboard's `costUnavailable` reason, threaded through (see `FetchSessionCostsResult`). */
  costUnavailable: string | null;
  stopped: StoppedSessionView[];
}

const finiteNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * PURE: reduce the dashboard `/api/sessions` rows to the LIVE currently-stopped
 * set — every row whose `costStatus === 'stopped'` — deduped per session (one
 * row in, one row out) and shaped. This mirrors, byte-for-byte, the dashboard's
 * own stopped predicate (`s.costStatus === 'stopped'`, ungated on session
 * status) so ncl / the MCP and the dashboard report the identical set. Split
 * out so it is unit-testable without a live dashboard. Ranked by spend desc,
 * then session id, for a stable most-expensive-first listing. `opts.group`
 * filters to one coworker workspace folder.
 */
export function filterStoppedSessions(sessions: SessionCostRow[], opts: { group?: string } = {}): StoppedSessionView[] {
  return sessions
    .filter((s) => s.costStatus === 'stopped' && (!opts.group || s.group_folder === opts.group))
    .map((s) => {
      const spent = finiteNum(s.costLifetime) ?? finiteNum(s.costSpent);
      const cap = finiteNum(s.costCap);
      const ceiling = finiteNum(s.costCeiling);
      const cost = finiteNum(s.cost);
      return {
        session_id: s.session_id,
        agent_group_id: s.agent_group_id,
        group_folder: s.group_folder || null,
        group_name: s.group_name || s.group_folder || null,
        status: 'stopped' as const,
        ...(spent !== undefined ? { spent_usd: round2(spent) } : {}),
        ...(cap !== undefined ? { cap_usd: round2(cap) } : {}),
        ...(ceiling !== undefined ? { ceiling_usd: round2(ceiling) } : {}),
        ...(typeof s.costImmortal === 'boolean' ? { immortal: s.costImmortal } : {}),
        ...(cost !== undefined ? { cost_usd: round2(cost) } : {}),
        container_status: s.container_status ?? null,
      };
    })
    .sort((a, b) => (b.spent_usd ?? 0) - (a.spent_usd ?? 0) || a.session_id.localeCompare(b.session_id));
}

/**
 * The LIVE "currently-stopped" set behind `ncl cost-cap stopped` and the
 * coworker MCP's `list_stopped_sessions` — the sessions that are hard-blocked on
 * a cost decision RIGHT NOW.
 *
 * Consistency by construction: it reads the DASHBOARD's own `GET /api/sessions`
 * (the same source, universe, and `costStatus` the dashboard's stopped count and
 * filter use) and applies the same `costStatus === 'stopped'` predicate — so the
 * dashboard, this verb, and the MCP report the identical set, with no host-side
 * per-session SQLite scan (the dashboard already mirrors each session's live
 * cost-cap state into an in-memory map, refreshed in the background). This is the
 * live counterpart to the append-only `cost_escalation_episodes` HISTORY ledger
 * (`ncl cost-cap escalations`): an old/unresolved episode is NOT the same as a
 * session blocked this instant.
 *
 * `costStatus` is period-independent (the dashboard joins it onto every session
 * ungated on spend), so the period passed to `/api/sessions` only affects the
 * contextual `cost_usd` column — we request `'all'` so that column is a lifetime
 * total. Fails LOUDLY (via `fetchSessionCosts`) when the dashboard is
 * unreachable, never a false-empty. `opts.group` filters to one coworker
 * workspace folder, validated against the payload so a typo cannot masquerade as
 * "nothing is stopped".
 */
export async function listStoppedSessions(opts: { group?: string } = {}): Promise<StoppedSessionsResult> {
  const { sessions, costUnavailable } = await fetchSessionCosts('all');
  const group = opts.group;
  if (group && !sessions.some((s) => s.group_folder === group)) {
    // A folder that matches NO session in the whole fleet is far more likely a
    // typo than a real group that happens to have zero sessions — and for a
    // safety query ("is anything blocked?") a confident empty result is the
    // dangerous failure. Fail loudly instead. (A genuinely session-less group
    // has nothing that could be stopped anyway.)
    throw new Error(`no sessions found for group folder '${group}' — check the folder name with \`ncl groups list\``);
  }
  const stopped = filterStoppedSessions(sessions, { group });
  return { count: stopped.length, group: group ?? null, costUnavailable, stopped };
}
