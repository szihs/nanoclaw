/**
 * cost-per-coworker — per-coworker inference cost, read HOST-SIDE from the
 * OneCLI gateway's `request_logs` and priced from the TOKEN USAGE the patched
 * gateway records for every response body (`usage_*` keys — see
 * scripts/onecli-cost-capture/README.md §v2) × NanoClaw's rate table
 * (`inference-pricing.ts`, a tested mirror of the dashboard/runner tables).
 *
 * Why tokens and not litellm's cost header: `x-litellm-response-cost-original`
 * is emitted BEFORE a streamed completion exists, so it reads 0.0 for ~all
 * coworker traffic (proven on prod 2026-09-03). The header is still captured and
 * reported as `headerCostUsd` — exact for non-streamed calls, informational
 * otherwise — so the two can be reconciled per model.
 *
 * UNKNOWN, never $0: rows without usable body usage — everything logged before
 * the body-tap gateway went live (`BODY_USAGE_SINCE`), calls whose model the
 * table can't price, and any capture gap — are counted in `unknownCalls` and
 * EXCLUDED from `costUsd`. That history is deliberately not backfilled.
 * `/v1/messages/count_tokens` calls are free and excluded entirely.
 *
 * Security (unchanged): `cost-cap` is elevated-only (host operator or a
 * cli_scope=global orchestrator). Even when a container issues
 * `ncl cost-cap coworkers`, the psql runs on the HOST via the mailbox transport
 * and only the numbers travel back — the container never touches the OneCLI DB.
 *
 * Env: ONECLI_PG_CONTAINER (OneCLI Postgres container; UNSET ⇒ `configured:false`,
 * a no-op not an error), ONECLI_PG_RUNTIME (default docker), ONECLI_PG_USER /
 * ONECLI_PG_DB (default onecli).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getAllAgentGroups } from '../db/agent-groups.js';

import { priceUsageBucket } from './inference-pricing.js';

const execFileAsync = promisify(execFile);

/** The captured litellm response-cost header — exact for NON-streamed calls only. */
export const HEADER_COST_KEY = 'x-litellm-response-cost-original';
/** When the body-usage (v2) gateway went live; rows logged before it can only be UNKNOWN. */
export const BODY_USAGE_SINCE = '2026-09-03 13:11 UTC (prod)';

/** An `ag-…` id shape guard — the only value we interpolate into SQL besides a digit-derived interval. */
const GROUP_ID_RE = /^ag-[a-z0-9-]+$/i;

export interface CoworkerTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface CoworkerCostRow {
  groupId: string;
  folder: string | null;
  name: string;
  /** Successful inference calls in the window (count_tokens excluded). */
  calls: number;
  /** Calls priced from body usage (`usage_source` sse|json, priced model). */
  pricedCalls: number;
  /** Calls with NO usable usage — before the v2 gateway, or an unpriced model. UNKNOWN cost, never $0. */
  unknownCalls: number;
  /** USD priced from body usage × NanoClaw rates — the cost of record for `pricedCalls`. */
  costUsd: number;
  /** Σ litellm header cost: exact only for non-streamed calls, informational otherwise. */
  headerCostUsd: number;
  tokens: CoworkerTokenTotals;
  /** Models seen WITH usage that the rate table cannot price (their calls count as unknown). */
  unpricedModels: string[];
}

export interface CostPerCoworkerResult {
  source: 'onecli-request-logs';
  basis: 'body-usage-tokens-x-nanoclaw-rates';
  /** false when ONECLI_PG_CONTAINER is unset — the cost source isn't wired here. */
  configured: boolean;
  /** false when the gateway has captured no rows yet (flags off, or no traffic). */
  captured: boolean;
  /** 'all', or the echoed --period (e.g. '30d'). */
  period: string;
  coworkers: CoworkerCostRow[];
  totalUsd: number;
  unknownCalls: number;
  headerTotalUsd: number;
  note?: string;
}

/**
 * Validate `--period` ("30d", "24h", …) → a safe Postgres interval literal built
 * from digits + a fixed unit word only (never interpolates user text).
 */
export function periodToInterval(period: string | undefined): string | null {
  if (!period) return null;
  const m = /^(\d{1,5})\s*([dh])$/i.exec(period.trim());
  if (!m) throw new Error(`--period must look like 30d or 24h (got: ${period})`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase() === 'd' ? 'days' : 'hours';
  return `${n} ${unit}`;
}

/**
 * One aggregated bucket per (coworker, usage_api, usage_model) — the raw SQL
 * output before pricing. Rows logged without body usage land in the bucket with
 * empty `usageApi`/`model` and `usageCalls = 0`.
 */
export interface UsageAggRow {
  groupId: string;
  name: string;
  usageApi: string;
  model: string;
  calls: number;
  usageCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  /** cache_creation_input_tokens from calls WITHOUT a 5m/1h split (priced at the 5m rate). */
  cacheCreateFlat: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  headerUsd: number;
}

/**
 * Build the per-coworker usage aggregation. Only `intervalSql` (from
 * {@link periodToInterval}) and a shape-checked `ag-…` id are ever interpolated.
 */
export function buildCoworkerCostSql(opts: { intervalSql: string | null; groupId: string | null }): string {
  const filters = [
    `(r.extra_data ? '${HEADER_COST_KEY}' OR r.extra_data ? 'usage_source')`,
    `a.identifier LIKE 'ag-%'`,
    `r.status BETWEEN 200 AND 299`,
    `r.path NOT LIKE '%/count_tokens%'`,
  ];
  if (opts.intervalSql) filters.push(`r.created_at > now() - interval '${opts.intervalSql}'`);
  if (opts.groupId) filters.push(`a.identifier = '${opts.groupId}'`);
  const tok = (k: string) => `coalesce(sum((r.extra_data->>'${k}')::bigint),0)`;
  return (
    `SELECT a.identifier, coalesce(a.name,''), ` +
    `coalesce(r.extra_data->>'usage_api',''), coalesce(r.extra_data->>'usage_model',''), ` +
    `count(*), count(*) FILTER (WHERE r.extra_data ? 'usage_input_tokens'), ` +
    `${tok('usage_input_tokens')}, ${tok('usage_output_tokens')}, ${tok('usage_cache_read_input_tokens')}, ` +
    `coalesce(sum((r.extra_data->>'usage_cache_creation_input_tokens')::bigint) ` +
    `FILTER (WHERE NOT (r.extra_data ? 'usage_cache_creation_5m_input_tokens')),0), ` +
    `${tok('usage_cache_creation_5m_input_tokens')}, ${tok('usage_cache_creation_1h_input_tokens')}, ` +
    `coalesce(round(sum((r.extra_data->>'${HEADER_COST_KEY}')::numeric),6),0) ` +
    `FROM request_logs r JOIN agents a ON a.id = r.agent_id ` +
    `WHERE ${filters.join(' AND ')} ` +
    `GROUP BY a.identifier, a.name, r.extra_data->>'usage_api', r.extra_data->>'usage_model' ` +
    `ORDER BY a.identifier, 3, 4`
  );
}

/** Parse `psql -tAc` pipe-separated output of {@link buildCoworkerCostSql}. Malformed lines are skipped. */
export function parseCoworkerRows(raw: string): UsageAggRow[] {
  const rows: UsageAggRow[] = [];
  const num = (s: string | undefined): number => {
    const n = Number.parseFloat(s ?? '');
    return Number.isFinite(n) ? n : 0;
  };
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split('|');
    if (p.length < 13) continue;
    const groupId = p[0].trim();
    if (!GROUP_ID_RE.test(groupId)) continue;
    const calls = Number.parseInt(p[4], 10);
    if (!Number.isFinite(calls)) continue;
    rows.push({
      groupId,
      name: p[1],
      usageApi: p[2],
      model: p[3],
      calls,
      usageCalls: Math.trunc(num(p[5])),
      input: num(p[6]),
      output: num(p[7]),
      cacheRead: num(p[8]),
      cacheCreateFlat: num(p[9]),
      cacheCreate5m: num(p[10]),
      cacheCreate1h: num(p[11]),
      headerUsd: num(p[12]),
    });
  }
  return rows;
}

const round6 = (n: number): number => Number(n.toFixed(6));

/**
 * Price the aggregated buckets and roll them up per coworker. Buckets without
 * usage, and buckets whose model/API the table can't price, become
 * `unknownCalls` (excluded from `costUsd`) — never $0.
 */
export function aggregateCoworkerCosts(rows: UsageAggRow[], folderById?: Map<string, string>): CoworkerCostRow[] {
  const byGroup = new Map<string, CoworkerCostRow>();
  for (const r of rows) {
    let g = byGroup.get(r.groupId);
    if (!g) {
      g = {
        groupId: r.groupId,
        folder: folderById?.get(r.groupId) ?? null,
        name: r.name,
        calls: 0,
        pricedCalls: 0,
        unknownCalls: 0,
        costUsd: 0,
        headerCostUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        unpricedModels: [],
      };
      byGroup.set(r.groupId, g);
    }
    if (!g.name && r.name) g.name = r.name;
    g.calls += r.calls;
    g.headerCostUsd += r.headerUsd;
    // Calls in this bucket that carried no usage (header-only, pre-v2) are UNKNOWN.
    g.unknownCalls += Math.max(0, r.calls - r.usageCalls);
    if (r.usageCalls <= 0) continue;
    g.tokens.input += r.input;
    g.tokens.output += r.output;
    g.tokens.cacheRead += r.cacheRead;
    g.tokens.cacheCreate += r.cacheCreateFlat + r.cacheCreate5m + r.cacheCreate1h;
    const usd = priceUsageBucket(r.usageApi, r.model, {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheCreateFlat: r.cacheCreateFlat,
      cacheCreate5m: r.cacheCreate5m,
      cacheCreate1h: r.cacheCreate1h,
    });
    if (usd === null) {
      g.unknownCalls += r.usageCalls;
      const label = r.model || r.usageApi || '(unknown)';
      if (!g.unpricedModels.includes(label)) g.unpricedModels.push(label);
    } else {
      g.pricedCalls += r.usageCalls;
      g.costUsd += usd;
    }
  }
  const out = [...byGroup.values()].map((g) => ({
    ...g,
    costUsd: round6(g.costUsd),
    headerCostUsd: round6(g.headerCostUsd),
  }));
  out.sort((a, b) => b.costUsd - a.costUsd || b.unknownCalls - a.unknownCalls || a.groupId.localeCompare(b.groupId));
  return out;
}

export type PsqlRunner = (sql: string) => Promise<string>;

export interface ReadCostPerCoworkerOpts {
  period?: string;
  groupFolder?: string;
}

export interface ReadCostPerCoworkerDeps {
  /** Override the psql runner (tests). Default = docker exec against ONECLI_PG_CONTAINER. */
  runPsql?: PsqlRunner;
  /** Pre-seeded id→folder map (tests); otherwise loaded from the central DB. */
  folderById?: Map<string, string>;
}

export async function readCostPerCoworker(
  opts: ReadCostPerCoworkerOpts,
  deps: ReadCostPerCoworkerDeps = {},
): Promise<CostPerCoworkerResult> {
  const container = process.env.ONECLI_PG_CONTAINER?.trim();
  const period = opts.period?.trim() || undefined;
  const intervalSql = periodToInterval(period);
  const periodLabel = period ?? 'all';

  // Resolve id→folder (for display) and --group folder→id (for the filter).
  let folderById = deps.folderById;
  let groupId: string | null = null;
  if (!folderById || opts.groupFolder) {
    const groups = await getAllAgentGroups();
    if (!folderById) folderById = new Map(groups.map((g) => [g.id, g.folder]));
    if (opts.groupFolder) {
      const match = groups.find((g) => g.folder === opts.groupFolder);
      if (!match) throw new Error(`unknown group folder: ${opts.groupFolder}`);
      groupId = match.id;
    }
  }
  if (groupId && !GROUP_ID_RE.test(groupId)) throw new Error(`unexpected group id shape: ${groupId}`);

  const base = {
    source: 'onecli-request-logs' as const,
    basis: 'body-usage-tokens-x-nanoclaw-rates' as const,
    period: periodLabel,
  };
  if (!container) {
    return {
      ...base,
      configured: false,
      captured: false,
      coworkers: [],
      totalUsd: 0,
      unknownCalls: 0,
      headerTotalUsd: 0,
      note:
        'Cost source not configured. Set ONECLI_PG_CONTAINER to the OneCLI Postgres container name ' +
        '(see scripts/onecli-cost-capture/README.md).',
    };
  }

  const sql = buildCoworkerCostSql({ intervalSql, groupId });
  const runPsql = deps.runPsql ?? defaultRunPsql(container);
  const coworkers = aggregateCoworkerCosts(parseCoworkerRows(await runPsql(sql)), folderById);
  const totalUsd = round6(coworkers.reduce((s, c) => s + c.costUsd, 0));
  const headerTotalUsd = round6(coworkers.reduce((s, c) => s + c.headerCostUsd, 0));
  const unknownCalls = coworkers.reduce((s, c) => s + c.unknownCalls, 0);

  let note: string | undefined;
  if (coworkers.length === 0) {
    note =
      'No captured rows. Is the OneCLI gateway running the cost-capture image with ' +
      `ONECLI_CAPTURE_RESPONSE_HEADERS (incl. '${HEADER_COST_KEY}') and ONECLI_CAPTURE_BODY_USAGE_HOSTS set?`;
  } else if (unknownCalls > 0) {
    note =
      `${unknownCalls} call${unknownCalls === 1 ? '' : 's'} have UNKNOWN cost (no body usage: logged before the ` +
      `body-usage gateway went live — ${BODY_USAGE_SINCE} — or an unpriced model). They are NOT $0 and are ` +
      'excluded from costUsd; that history is deliberately not backfilled.';
  }

  return {
    ...base,
    configured: true,
    captured: coworkers.length > 0,
    coworkers,
    totalUsd,
    unknownCalls,
    headerTotalUsd,
    note,
  };
}

function defaultRunPsql(container: string): PsqlRunner {
  const runtime = process.env.ONECLI_PG_RUNTIME?.trim() || 'docker';
  const user = process.env.ONECLI_PG_USER?.trim() || 'onecli';
  const db = process.env.ONECLI_PG_DB?.trim() || 'onecli';
  return async (sql: string) => {
    const { stdout } = await execFileAsync(runtime, ['exec', container, 'psql', '-U', user, '-d', db, '-tAc', sql], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };
}
