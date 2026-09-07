/**
 * `cost-cap` — runtime configuration of the Tier-2 cost cap (NanoClaw #1 cost cap).
 *
 * The Tier-2 hard ceiling and per-group per-session caps used to be settable only
 * via `NANOCLAW_COST_T2_CEILING_USD` (a static `.env` value) and
 * `data/cost-thresholds.json` (auto-sourced p90). This resource lets an elevated
 * operator change them at runtime, DB-backed (`cost_cap_policy`), read fresh at
 * every container spawn. The env var stays a back-compat fallback.
 *
 * ELEVATED-ONLY. `cost-cap` is deliberately NOT in `GROUP_SCOPE_RESOURCES`
 * (src/cli/registry.ts), so the shared CLI guard (src/cli/guard.ts) denies it for
 * any container under `cli_scope: 'group'` or `'disabled'`. It is reachable only
 * from the trusted host socket (operator) and from a `cli_scope: 'global'`
 * container (the orchestrator / admin group). A fleet-wide cost knob is not
 * something an ordinary coworker gets to turn.
 *
 * Effect timing: `set` / `clear` write the DB immediately. The host materializes
 * the values into a group's container.json at its NEXT spawn, so a change reaches
 * a running session on its next restart. To apply immediately, restart the group
 * (`ncl groups restart --id <group-id>`).
 */
import { randomUUID } from 'crypto';

import { registerResource } from '../crud.js';
import {
  clearCostCapPolicy,
  getCostCapPolicy,
  listCostCapPolicies,
  setCostCapPolicy,
  type CostCapPolicyRow,
} from '../../db/cost-cap-policy.js';
import { resolveCostCapT2Usd, resolveCostCeilingT2Usd } from '../../container-config.js';
import { readSessionCostCapStatus, type SessionCostCapView } from '../session-cost-cap.js';
import {
  listEscalationEpisodes,
  type CostDecisionState,
  type EscalationListRow,
} from '../../db/cost-escalation-episodes.js';
import {
  aggregateSessionCosts,
  fetchSessionCosts,
  listStoppedSessions,
  rankSessionCosts,
  COST_PERIODS,
  type CostPeriod,
  type GroupCostAggregate,
  type SessionCostListEntry,
  type StoppedSessionView,
} from '../cost-cap-sessions.js';
import { readCostPerCoworker, type CostPerCoworkerResult } from '../cost-per-coworker.js';
import { readCostHistory, isValidDate, HISTORY_BY, type HistoryBy, type CostHistoryResult } from '../cost-history.js';

/**
 * Cost sources, by verb — the transcript engine (`sessions`) is the COST OF
 * RECORD (matched the Anthropic bill to ~103%). `coworkers` (OneCLI gateway
 * body-usage) and `history` (the #65 per-turn ledger) are ALTERNATE sources with
 * caveats (litellm undercounts streamed today; the ledger is partial pre-2026-08-31)
 * — callers select them explicitly; they are not the default and not hidden.
 */

/** Who is making the change, for the row's audit column. */
function actorLabel(ctx: { caller: string; agentGroupId?: string } | undefined): string {
  return ctx?.caller === 'agent' ? (ctx.agentGroupId ?? 'agent') : 'host';
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Observed-cost formatter — keeps enough precision that sub-cent spend doesn't render as $0.00. */
function money(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

/** A DB override row rendered for JSON output (nulls kept explicit). */
function policyView(row: CostCapPolicyRow) {
  return {
    scope: row.group_folder === '' ? 'fleet' : row.group_folder,
    group_folder: row.group_folder,
    ceiling_usd: row.ceiling_usd,
    cap_usd: row.cap_usd,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

/** An escalation episode rendered for JSON/human output (the `escalations` verb). */
function escalationView(r: EscalationListRow) {
  return {
    session_id: r.session_id,
    short_id: r.short_id,
    coworker: r.group_folder,
    reason: r.reason,
    window: r.window,
    spent_usd: r.spent_usd,
    cap_usd: r.cap_usd,
    ceiling_usd: r.ceiling_usd,
    immortal: r.immortal === 1,
    decision_state: r.decision_state,
    gh_author: r.gh_author,
    gh: r.gh_repo && r.gh_number != null ? `${r.gh_repo}#${r.gh_number}` : null,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    resolved_by: r.resolved_by,
  };
}

registerResource({
  name: 'cost-cap',
  plural: 'cost-cap',
  // No generic CRUD — cost_cap_policy is a small policy table, not a row-per-id
  // resource. `table`/`idColumn`/`columns` are declared for help introspection.
  table: 'cost_cap_policy',
  description:
    'Runtime Tier-2 cost-cap policy. Fleet-wide hard ceiling + optional per-group cap/ceiling overrides, ' +
    'DB-backed and read at each container spawn (env NANOCLAW_COST_T2_CEILING_USD / cost-thresholds.json ' +
    'stay as fallbacks). Elevated-only: reachable from the host operator or a cli_scope=global orchestrator.',
  idColumn: 'group_folder',
  columns: [
    {
      name: 'group_folder',
      type: 'string',
      description: "'' = fleet-wide row; otherwise the group's workspace folder.",
    },
    { name: 'ceiling_usd', type: 'number', description: 'Tier-2 hard ceiling (USD). 0 = explicitly no ceiling.' },
    { name: 'cap_usd', type: 'number', description: 'Per-session soft cap (USD). Per-group only.' },
    { name: 'updated_at', type: 'string', description: 'When the row was last written (ISO-8601 UTC).' },
    { name: 'updated_by', type: 'string', description: 'host, or the agent group id that set it.' },
  ],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description:
        'Show the effective cost-cap policy. Without --group: the fleet ceiling (effective + sources) and every ' +
        "DB override. With --group <folder>: that group's effective per-session cap and ceiling.",
      args: [
        { name: 'group', type: 'string', description: 'Group workspace folder to report the effective values for.' },
      ],
      examples: ['ncl cost-cap get', 'ncl cost-cap get --group slang-fixer'],
      handler: async (args) => {
        const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : undefined;
        const fleetRow = await getCostCapPolicy();
        const envCeiling = Number(process.env.NANOCLAW_COST_T2_CEILING_USD);
        const envCeilingValue = Number.isFinite(envCeiling) && envCeiling > 0 ? envCeiling : null;

        const effectiveFleetCeiling = await resolveCostCeilingT2Usd();
        const fleetSource =
          fleetRow && typeof fleetRow.ceiling_usd === 'number' ? 'db' : envCeilingValue !== null ? 'env' : 'none';

        const base = {
          fleet: {
            effectiveCeilingUsd: effectiveFleetCeiling,
            source: fleetSource,
            dbCeilingUsd: fleetRow?.ceiling_usd ?? null,
            envCeilingUsd: envCeilingValue,
          },
          overrides: (await listCostCapPolicies()).map(policyView),
        };

        if (!group) return base;

        const row = await getCostCapPolicy(group);
        return {
          ...base,
          group: {
            group_folder: group,
            effectiveCapUsd: await resolveCostCapT2Usd(group),
            effectiveCeilingUsd: await resolveCostCeilingT2Usd(group),
            dbCapUsd: row?.cap_usd ?? null,
            dbCeilingUsd: row?.ceiling_usd ?? null,
          },
        };
      },
      formatHuman: (data) => {
        const d = data as {
          fleet: {
            effectiveCeilingUsd: number;
            source: string;
            dbCeilingUsd: number | null;
            envCeilingUsd: number | null;
          };
          overrides: ReturnType<typeof policyView>[];
          group?: {
            group_folder: string;
            effectiveCapUsd: number;
            effectiveCeilingUsd: number;
            dbCapUsd: number | null;
            dbCeilingUsd: number | null;
          };
        };
        const lines: string[] = [];
        const fc = d.fleet.effectiveCeilingUsd;
        lines.push(`Fleet ceiling: ${fc > 0 ? usd(fc) : 'none'} (source: ${d.fleet.source})`);
        if (d.overrides.length === 0) {
          lines.push('Overrides: none');
        } else {
          lines.push('Overrides:');
          for (const o of d.overrides) {
            const parts: string[] = [];
            if (o.ceiling_usd !== null) parts.push(`ceiling=${usd(o.ceiling_usd)}`);
            if (o.cap_usd !== null) parts.push(`cap=${usd(o.cap_usd)}`);
            lines.push(
              `  ${o.scope}: ${parts.join(' ') || '(none set)'} — by ${o.updated_by ?? '?'} at ${o.updated_at}`,
            );
          }
        }
        if (d.group) {
          lines.push(
            `Group ${d.group.group_folder}: effective cap ${usd(d.group.effectiveCapUsd)}, ` +
              `effective ceiling ${d.group.effectiveCeilingUsd > 0 ? usd(d.group.effectiveCeilingUsd) : 'none'}`,
          );
        }
        return lines.join('\n');
      },
    },
    set: {
      access: 'open',
      description:
        'Set the fleet ceiling and/or a per-group override. Provide at least one of --ceiling / --cap. Without ' +
        '--group the ceiling is fleet-wide; with --group <folder> the values override just that group. --cap is ' +
        'per-group only (fleet caps come from p90) so it requires --group. Effect: next container spawn.',
      args: [
        { name: 'ceiling', type: 'number', description: 'Tier-2 hard ceiling (USD), >= 0. 0 = disable the ceiling.' },
        { name: 'cap', type: 'number', description: 'Per-session soft cap (USD), > 0. Requires --group.' },
        { name: 'group', type: 'string', description: 'Group workspace folder. Omit for the fleet-wide ceiling.' },
      ],
      examples: [
        'ncl cost-cap set --ceiling 150',
        'ncl cost-cap set --ceiling 300 --group slang-fixer',
        'ncl cost-cap set --cap 60 --group slang-fixer',
        'ncl cost-cap set --ceiling 0   # disable the fleet ceiling (overrides the env var)',
      ],
      handler: async (args, ctx) => {
        const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : undefined;
        const hasCeiling = args.ceiling !== undefined;
        const hasCap = args.cap !== undefined;
        if (!hasCeiling && !hasCap) throw new Error('provide at least one of --ceiling or --cap');

        let ceilingUsd: number | undefined;
        if (hasCeiling) {
          ceilingUsd = Number(args.ceiling);
          if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) throw new Error('--ceiling must be a number >= 0');
        }

        let capUsd: number | undefined;
        if (hasCap) {
          capUsd = Number(args.cap);
          if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('--cap must be a number > 0');
          if (!group) {
            throw new Error(
              '--cap is a per-group override and requires --group <folder>. A fleet-wide cap is auto-sourced ' +
                'from cost-thresholds.json (p90); use --ceiling for a fleet-wide limit.',
            );
          }
        }

        const row = await setCostCapPolicy({ groupFolder: group, ceilingUsd, capUsd, updatedBy: actorLabel(ctx) });
        return {
          updated: policyView(row),
          note:
            'Written to the DB. It materializes into container.json at the next container spawn; ' +
            'run `ncl groups restart --id <group-id>` to apply it to a running session immediately.',
        };
      },
      formatHuman: (data) => {
        const d = data as { updated: ReturnType<typeof policyView>; note: string };
        const o = d.updated;
        const parts: string[] = [];
        if (o.ceiling_usd !== null) parts.push(`ceiling=${usd(o.ceiling_usd)}`);
        if (o.cap_usd !== null) parts.push(`cap=${usd(o.cap_usd)}`);
        return `Set ${o.scope}: ${parts.join(' ') || '(nothing)'}\n${d.note}`;
      },
    },
    reconcile: {
      access: 'open',
      description:
        "Set a session's LIVE enforcement spend (costSpentUsd) to its real, transcript-priced cost — the " +
        'correction for issue #1327, where the pre-fix accounting over-charged spend (per content block, ' +
        '1.7x-17x) and left sessions falsely cost-stopped. --to is USD (the transcript oracle from the ' +
        'dashboard / #68 litellm capture, NOT a guess); the value is converted to integer cents and applied ' +
        'THROUGH the runner (the container is the sole writer of its own spend), epoch-fenced by the same ' +
        'compare-and-set as set-ceiling. Elevated-only. Fails loudly on a stale epoch, an un-upgraded runner, ' +
        'or an immortal/untracked session. --force relaxes ONLY the card_already_decided fence — the escape ' +
        'for a session card-decided on inflated (#1327) spend that is now falsely-stopped; it stays ' +
        'downward-only, keeps the epoch+ceiling+spend CAS, and never overrides a human stop.',
      args: [
        { name: 'session', type: 'string', description: 'Session ID to reconcile.', required: true },
        { name: 'to', type: 'number', description: 'Real transcript-priced spend to set (USD, >= 0).', required: true },
        {
          name: 'force',
          type: 'boolean',
          description: 'Apply even on an epoch with an already-decided card (relaxes ONLY that fence; downward-only).',
        },
      ],
      examples: [
        'ncl cost-cap reconcile --session <session-id> --to 42.17',
        'ncl cost-cap reconcile --session <session-id> --to 116 --force',
      ],
      handler: async (args, ctx) => {
        const sessionId = typeof args.session === 'string' ? args.session.trim() : '';
        if (!sessionId) throw new Error('--session is required');
        if (args.to === undefined) throw new Error('--to is required (USD)');
        const targetSpentUsd = Number(args.to);
        if (!Number.isFinite(targetSpentUsd) || targetSpentUsd < 0) {
          throw new Error('--to must be a number >= 0 (USD)');
        }
        const force = args.force === true;

        const { submitCostReconcile } = await import('../../modules/cost-ceiling-adjustment/index.js');
        const res = await submitCostReconcile(sessionId, targetSpentUsd, `ncl:${actorLabel(ctx)}`, force);
        if (res.status >= 300) {
          const b = res.body as { error?: string; message?: string };
          throw new Error(`cost reconcile failed (${res.status} ${b.error ?? 'error'}): ${b.message ?? ''}`.trim());
        }
        return { status: res.status, targetSpentUsd, ...res.body };
      },
      formatHuman: (data) => {
        const d = data as {
          status: number;
          targetSpentUsd: number;
          noop?: boolean;
          adjustmentId?: string;
          state?: string;
          message?: string;
          forced?: boolean;
        };
        if (d.noop) return d.message ?? 'Nothing to reconcile.';
        const target = usd(d.targetSpentUsd);
        const forced = d.forced ? ' [FORCED past a decided card]' : '';
        if (d.status === 200) {
          return `Reconcile to ${target}: already terminal (${d.state ?? 'done'}, id ${d.adjustmentId ?? '?'}).${forced}`;
        }
        return (
          `Reconcile to ${target} submitted (id ${d.adjustmentId ?? '?'}, state ${d.state ?? 'enqueued'}).${forced} ` +
          'The runner applies it on its next poll and confirms via receipt; re-check with ' +
          '`ncl cost-cap status --session <id>`.'
        );
      },
    },
    clear: {
      access: 'open',
      description:
        'Remove a DB cost-cap override, restoring the env / thresholds fallback. Without --group clears the ' +
        'fleet ceiling row; with --group <folder> clears that group override. Effect: next container spawn.',
      args: [{ name: 'group', type: 'string', description: 'Group workspace folder. Omit to clear the fleet row.' }],
      examples: ['ncl cost-cap clear', 'ncl cost-cap clear --group slang-fixer'],
      handler: async (args) => {
        const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : undefined;
        const removed = await clearCostCapPolicy(group);
        const scope = group ?? 'fleet';
        return {
          cleared: removed,
          scope,
          note: removed
            ? `Removed the ${scope} override. The env / thresholds fallback applies at the next spawn.`
            : `No ${scope} override was set.`,
        };
      },
      formatHuman: (data) => {
        const d = data as { cleared: boolean; scope: string; note: string };
        return d.note;
      },
    },
    status: {
      access: 'open',
      description:
        "Report a session's LIVE cost-cap runtime status — read directly from that session's outbound.db " +
        '(`session_state` table, key `cost_cap`), the row the runner writes as spend accrues. Distinct from ' +
        '`get` (the CONFIGURED policy ceiling/cap): this is the OBSERVED state for one specific session — ' +
        "'ok' | 'warn' | 'escalated' | 'stopped' (hard-blocked pending a human Continue/Stop decision on the " +
        "dashboard), or 'unknown' when no cost-cap row exists yet (pre-cost-cap runner, or the session has " +
        'not spawned / spent anything). Intended for scriptable callers (e.g. /supervise-issues) that need to ' +
        "tell a session that's merely idle apart from one that's deliberately stopped.",
      args: [{ name: 'session', type: 'string', description: 'Session ID.', required: true }],
      examples: ['ncl cost-cap status --session <session-id>'],
      handler: async (args) => readSessionCostCapStatus(String(args.session ?? '')),
      formatHuman: (data) => {
        const d = data as SessionCostCapView;
        if (d.status === 'unknown') {
          return `Session ${d.session_id}: cost-cap status unknown (no cost_cap row yet).`;
        }
        const parts: string[] = [`status=${d.status}`];
        if (typeof d.spent_usd === 'number') parts.push(`spent=${usd(d.spent_usd)}`);
        if (typeof d.cap_usd === 'number') parts.push(`cap=${usd(d.cap_usd)}`);
        if (typeof d.ceiling_usd === 'number' && d.ceiling_usd > 0) parts.push(`ceiling=${usd(d.ceiling_usd)}`);
        if (d.decision) parts.push(`decision=${d.decision}${d.decided_at ? ` at ${d.decided_at}` : ''}`);
        return `Session ${d.session_id} (${d.agent_group_id}): ${parts.join(' ')}`;
      },
    },
    stopped: {
      access: 'open',
      description:
        'List the sessions that are CURRENTLY cost-stopped — LIVE `costStatus === stopped` right now (hard-blocked ' +
        "pending a human Continue/Stop). Reads the dashboard's own `GET /api/sessions` — the SAME source, session " +
        "universe, and `costStatus` the dashboard's stopped count/filter use — and applies the same predicate, so " +
        'the dashboard, this verb, and the coworker MCP report the IDENTICAL set, deduped per session. This is the ' +
        '"which sessions are blocked on cost right this instant" view — deliberately distinct from `escalations`, ' +
        'the append-only HISTORY ledger of every ceiling-trip ever (a resumed or exited session keeps its episode ' +
        "rows but is no longer `stopped`). Use it before reconcile/continue so you don't act on a session that is " +
        'merely idle. Needs the dashboard installed/running (like `sessions`); fails loudly if unreachable, never a ' +
        'false-empty. Filter: --group <folder>.',
      args: [{ name: 'group', type: 'string', description: 'Filter to one coworker workspace folder.' }],
      examples: ['ncl cost-cap stopped', 'ncl cost-cap stopped --group slang-fixer --json'],
      handler: async (args) => {
        const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : undefined;
        return listStoppedSessions({ group });
      },
      formatHuman: (data) => {
        const d = data as {
          count: number;
          group: string | null;
          costUnavailable?: string | null;
          stopped: StoppedSessionView[];
        };
        const warn = d.costUnavailable ? `⚠ cost data may be unavailable: ${d.costUnavailable}\n` : '';
        if (d.count === 0) {
          return d.group
            ? `${warn}No sessions in ${d.group} are currently cost-stopped (live status).`
            : `${warn}No sessions are currently cost-stopped (live status).`;
        }
        const lines = [
          `${warn}${d.count} session${d.count === 1 ? '' : 's'} currently STOPPED (live cost-cap status):`,
        ];
        for (const s of d.stopped) {
          const parts: string[] = [];
          if (typeof s.spent_usd === 'number') parts.push(`spent=${usd(s.spent_usd)}`);
          if (typeof s.cap_usd === 'number') parts.push(`cap=${usd(s.cap_usd)}`);
          if (typeof s.ceiling_usd === 'number' && s.ceiling_usd > 0) parts.push(`ceiling=${usd(s.ceiling_usd)}`);
          if (s.immortal) parts.push('immortal');
          const who = s.group_folder ?? s.agent_group_id;
          lines.push(`  ${s.session_id} · ${who}${parts.length ? ` · ${parts.join(' ')}` : ''}`);
        }
        return lines.join('\n');
      },
    },
    escalations: {
      access: 'open',
      description:
        'The append-only HISTORY ledger of cost-escalation episodes — every ceiling/cap trip ever, per session: ' +
        "spent/cap/ceiling, decision_state ('pending' | 'continued' | 'stopped' | 'expired' | 'superseded' | " +
        "'observed'), reason (cap|ceiling), immortal, the coworker, and — when the session sits on a GitHub " +
        'thread — the issue/PR author. NOTE: decision_state is the recorded outcome of an episode, NOT the ' +
        "session's live status — a row here (even decision_state='stopped') does NOT mean the session is blocked " +
        'RIGHT NOW. For "which sessions are CURRENTLY blocked", use `cost-cap stopped` (the live view); pair this ' +
        'with `cost-cap status --session` (one session, LIVE) and the dashboard Continue/Stop. Filters: --state, ' +
        '--session, --group (coworker folder), --author (GitHub login), --limit.',
      args: [
        { name: 'state', type: 'string', description: 'pending|continued|stopped|expired|superseded|observed' },
        { name: 'session', type: 'string', description: 'filter to one session id' },
        { name: 'group', type: 'string', description: 'filter by coworker workspace folder' },
        { name: 'author', type: 'string', description: 'filter by GitHub author (via gh_thread_origin)' },
        { name: 'limit', type: 'number', description: 'max rows (default 50, max 500)' },
      ],
      examples: [
        'ncl cost-cap escalations --state stopped',
        'ncl cost-cap escalations --group slang-fixer',
        'ncl cost-cap escalations --author tangent-vector --json',
      ],
      handler: async (args) => {
        const STATES: CostDecisionState[] = ['pending', 'continued', 'stopped', 'expired', 'superseded', 'observed'];
        const trim = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
        const stateRaw = trim(args.state);
        if (stateRaw && !STATES.includes(stateRaw as CostDecisionState)) {
          throw new Error(`--state must be one of: ${STATES.join(', ')}`);
        }
        const rows = await listEscalationEpisodes({
          state: stateRaw as CostDecisionState | undefined,
          sessionId: trim(args.session),
          groupFolder: trim(args.group),
          ghAuthor: trim(args.author),
          limit: args.limit !== undefined ? Number(args.limit) : undefined,
        });
        return { count: rows.length, escalations: rows.map(escalationView) };
      },
      formatHuman: (data) => {
        const d = data as { count: number; escalations: ReturnType<typeof escalationView>[] };
        if (d.count === 0) return 'No cost escalations match.';
        const lines = [
          `${d.count} escalation ${d.count === 1 ? 'episode' : 'episodes'} (history ledger — a listed ` +
            'row is NOT necessarily blocked now; see `cost-cap stopped` for the LIVE set):',
        ];
        for (const e of d.escalations) {
          const parts: string[] = [`spent=${e.spent_usd != null ? usd(e.spent_usd) : '?'}`];
          if (e.cap_usd != null) parts.push(`cap=${usd(e.cap_usd)}`);
          if (e.ceiling_usd != null && e.ceiling_usd > 0) parts.push(`ceiling=${usd(e.ceiling_usd)}`);
          if (e.immortal) parts.push('immortal');
          const who = e.gh_author ? ` by ${e.gh_author}${e.gh ? ` (${e.gh})` : ''}` : '';
          lines.push(
            `  [${e.decision_state}] ${e.session_id} · ${e.coworker ?? '?'} · ${e.reason}/${e.window} · ${parts.join(' ')}${who}`,
          );
        }
        return lines.join('\n');
      },
    },
    sessions: {
      access: 'open',
      description:
        'Per-session cost DISTRIBUTION + percentiles — the surface a coworker needs to compute a per-group ' +
        'p95 and set a sane ceiling (escalations only shows the tripped tail). Reads the authoritative ' +
        'transcript-priced per-session cost from the local dashboard `GET /api/sessions` (the same source ' +
        'ops/metrics collect_cost() reads; requires /add-dashboard installed + running). Default output: ' +
        "per-group aggregates {group, sessions, total_usd, p50, p90, p95, max} over each group's cost>0 " +
        'sessions, sorted by total spend. Percentiles use the NEAREST-RANK method (sort asc, index ' +
        'floor(p*(n-1))) — the same method the host uses for cost-thresholds.json p90, so every value is a ' +
        'real observed session cost. Filters: --group <folder>, --period (1d|7d|30d|all, default 30d); ' +
        '--sessions emits the raw per-session list instead of aggregates.',
      args: [
        { name: 'group', type: 'string', description: 'Filter to one group workspace folder.' },
        { name: 'period', type: 'string', description: 'Day-window: 1d|7d|30d|all (default 30d).', default: '30d' },
        {
          name: 'sessions',
          type: 'boolean',
          description: 'Emit the raw per-session cost list (ranked desc) instead of per-group aggregates.',
        },
      ],
      examples: [
        'ncl cost-cap sessions',
        'ncl cost-cap sessions --group slang-fixer --period 7d',
        'ncl cost-cap sessions --group slang-fixer --sessions --json',
      ],
      handler: async (args) => {
        const period = String(args.period ?? '30d').trim() as CostPeriod;
        if (!COST_PERIODS.includes(period)) {
          throw new Error(`--period must be one of: ${COST_PERIODS.join(', ')}`);
        }
        const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : undefined;
        const { sessions, costUnavailable } = await fetchSessionCosts(period);
        if (args.sessions === true) {
          const list = rankSessionCosts(sessions, { group });
          return { period, group: group ?? null, costUnavailable, count: list.length, sessions: list };
        }
        const groups = aggregateSessionCosts(sessions, { group });
        return {
          period,
          group: group ?? null,
          costUnavailable,
          method: 'nearest-rank (sort asc, index floor(p*(n-1)))',
          groups,
        };
      },
      formatHuman: (data) => {
        const d = data as {
          period: string;
          group: string | null;
          costUnavailable?: string | null;
          method?: string;
          groups?: GroupCostAggregate[];
          count?: number;
          sessions?: SessionCostListEntry[];
        };
        // Surface the dashboard's "pricing absent" reason so a $0/empty result is
        // never mistaken for "no spend" when it actually means "no cost data".
        const warn = d.costUnavailable ? `⚠ cost data may be unavailable: ${d.costUnavailable}\n` : '';
        if (d.sessions) {
          if (d.sessions.length === 0) return `${warn}No priced sessions in the last ${d.period}.`;
          const lines = [`${warn}${d.count} priced session${d.count === 1 ? '' : 's'} (${d.period}):`];
          for (const s of d.sessions) {
            lines.push(`  ${usd(s.cost)}  ${s.session_id} · ${s.group}${s.status ? ` · ${s.status}` : ''}`);
          }
          return lines.join('\n');
        }
        const groups = d.groups ?? [];
        if (groups.length === 0) return `${warn}No priced sessions in the last ${d.period}.`;
        const lines = [`${warn}Per-group cost over ${d.period} (percentiles: nearest-rank):`];
        for (const g of groups) {
          lines.push(
            `  ${g.group}: ${g.sessions} sessions, total ${usd(g.total_usd)} — ` +
              `p50 ${usd(g.p50)} · p90 ${usd(g.p90)} · p95 ${usd(g.p95)} · max ${usd(g.max)}`,
          );
        }
        return lines.join('\n');
      },
    },
    continue: {
      access: 'open',
      description:
        "Resolve a cost escalation by CONTINUING a session — the elevated ncl equivalent of the dashboard's " +
        'Continue. Routes through the SAME money-safe decision path as the pill (`applyCostOverrideDecision`): ' +
        'a live pending episode resolves via its at-most-once CAS + epoch fence; otherwise the override is ' +
        "fenced by the session's latest episode epoch so a duplicate/stale press can never double-grant. On a " +
        'session that is actually stopped at its ceiling this resumes it (the runner raises the cap by one ' +
        'allotment); to set an EXACT ceiling instead, use `set-ceiling`.',
      args: [{ name: 'session', type: 'string', description: 'Session ID.', required: true }],
      examples: ['ncl cost-cap continue --session <session-id>'],
      handler: async (args, ctx) => {
        const sessionId = String(args.session ?? '').trim();
        if (!sessionId) throw new Error('--session is required');
        const { applyCostOverrideDecision } = await import('../../modules/cost-approval/index.js');
        await applyCostOverrideDecision(sessionId, 'continue', `ncl:${actorLabel(ctx)}`);
        return { session_id: sessionId, decision: 'continue', ok: true };
      },
      formatHuman: (data) => {
        const d = data as { session_id: string };
        return `Continue routed to session ${d.session_id}.`;
      },
    },
    stop: {
      access: 'open',
      description:
        "Resolve a cost escalation by STOPPING a session — the elevated ncl equivalent of the dashboard's Stop. " +
        'Routes through the SAME money-safe decision path as the pill (see `continue`): a genuine manual kill ' +
        'switch that quiesces a running, non-immortal session (recorded-only for immortal sessions, which never ' +
        'quiesce). Money-safe under duplicate/stale presses via the same episode epoch fence.',
      args: [{ name: 'session', type: 'string', description: 'Session ID.', required: true }],
      examples: ['ncl cost-cap stop --session <session-id>'],
      handler: async (args, ctx) => {
        const sessionId = String(args.session ?? '').trim();
        if (!sessionId) throw new Error('--session is required');
        const { applyCostOverrideDecision } = await import('../../modules/cost-approval/index.js');
        await applyCostOverrideDecision(sessionId, 'stop', `ncl:${actorLabel(ctx)}`);
        return { session_id: sessionId, decision: 'stop', ok: true };
      },
      formatHuman: (data) => {
        const d = data as { session_id: string };
        return `Stop routed to session ${d.session_id}.`;
      },
    },
    'set-ceiling': {
      access: 'open',
      description:
        "Set a session's LIVE Tier-2 hard ceiling to an EXACT USD value (NanoClaw #1, set-ceiling v2) — the " +
        'elevated ncl equivalent of the dashboard +/- control. Reads the live epoch + current ceiling itself, ' +
        'then submits through the existing `submitCostCeilingAdjustment` flow, whose ' +
        'UNIQUE(session_id, expected_epoch_key) ledger CAS is the concurrency control: MONEY-SAFE, never a ' +
        'double-grant. If the session moved since the read (stale epoch), or a card/another request already ' +
        'claimed the epoch, or the runner is too old / not ready, this FAILS LOUDLY (non-2xx) rather than ' +
        'over-raising. Works on a stopped session (raise + resume) or a healthy one (proactive raise/lower). ' +
        'Max $1000.00; immortal (admin/main) sessions are refused.',
      args: [
        { name: 'session', type: 'string', description: 'Session ID.', required: true },
        {
          name: 'ceiling',
          type: 'number',
          description: 'Exact target Tier-2 ceiling in USD (> 0, <= 1000). Converted to integer cents.',
          required: true,
        },
      ],
      examples: [
        'ncl cost-cap set-ceiling --session <session-id> --ceiling 300',
        'ncl cost-cap set-ceiling --session <session-id> --ceiling 42.50 --json',
      ],
      handler: async (args, ctx) => {
        const sessionId = String(args.session ?? '').trim();
        if (!sessionId) throw new Error('--session is required');
        const ceilingUsd = Number(args.ceiling);
        if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) throw new Error('--ceiling must be a number > 0');
        const targetCeilingCents = Math.round(ceilingUsd * 100);
        if (targetCeilingCents < 1 || targetCeilingCents > 100_000) {
          throw new Error('--ceiling must be between $0.01 and $1000.00');
        }

        // Read LIVE epoch + ceiling to build the optimistic CAS precondition —
        // the same values the dashboard browser reads from /api/sessions.
        // submitCostCeilingAdjustment RE-READS and RE-VALIDATES these
        // authoritatively (409 'stale' if they moved between now and the ledger
        // insert), so this is the precondition, not a trusted bypass of it.
        const live = await readSessionCostCapStatus(sessionId);
        if (live.status === 'unknown') {
          throw new Error(
            `session ${sessionId} has no live cost-cap state (not spawned, non-Claude provider, or pre-cost-cap runner)`,
          );
        }
        if (live.immortal === true) {
          throw new Error('immortal (admin/main) sessions cannot be quiesced/adjusted by this control');
        }
        if (typeof live.ceiling_usd !== 'number' || live.ceiling_usd <= 0) {
          throw new Error('this session has no live Tier-2 ceiling configured');
        }
        if (typeof live.budget_gen !== 'number') {
          throw new Error('no live budget generation reported for this session');
        }
        const expectedEpochKey = String(live.budget_gen);
        const expectedCeilingCents = Math.round(live.ceiling_usd * 100);
        if (targetCeilingCents === expectedCeilingCents) {
          throw new Error(`--ceiling ${usd(ceilingUsd)} equals the current live ceiling — nothing to change`);
        }

        const requestId = `cca-${randomUUID()}`;
        const { submitCostCeilingAdjustment } = await import('../../modules/cost-ceiling-adjustment/index.js');
        const result = await submitCostCeilingAdjustment(
          { protocolVersion: 2, requestId, sessionId, targetCeilingCents, expectedEpochKey, expectedCeilingCents },
          `ncl:${actorLabel(ctx)}`,
        );

        // MONEY-SAFE: surface any non-accept status as a thrown error instead of
        // pretending success. 200 = idempotent-terminal, 202 = accepted/enqueued.
        if (result.status !== 200 && result.status !== 202) {
          const err = typeof result.body.error === 'string' ? result.body.error : `http_${result.status}`;
          const msg = typeof result.body.message === 'string' ? result.body.message : '';
          throw new Error(`set-ceiling refused (${result.status} ${err})${msg ? `: ${msg}` : ''}`);
        }
        return {
          session_id: sessionId,
          requestId,
          targetCeilingUsd: ceilingUsd,
          targetCeilingCents,
          status: result.status,
          result: result.body,
        };
      },
      formatHuman: (data) => {
        const d = data as { session_id: string; targetCeilingUsd: number; status: number };
        const verb = d.status === 200 ? 'already recorded' : 'submitted';
        return `Set-ceiling ${verb}: session ${d.session_id} → ${usd(d.targetCeilingUsd)} ceiling.`;
      },
    },
    coworkers: {
      access: 'open',
      description:
        '[ALTERNATE source — NOT the default cost of record (that is `cost-cap sessions`, transcript-priced). ' +
        'Currently UNDERCOUNTS: the gateway records $0 for streamed responses (≈all coworker traffic); accurate ' +
        'only once the body-usage tap ships. Use for cross-check.] ' +
        "Cost per coworker (agent group) from the inference gateway's own per-request records: the OneCLI " +
        "gateway captures each response body's token usage (usage_* keys) and this verb prices those tokens " +
        "with NanoClaw's rate table — the same table the dashboard uses — so Claude and Codex are covered and " +
        "reconcilable per model against litellm's cost header (reported separately as headerCostUsd; exact " +
        'only for non-streamed calls). Calls without body usage (logged before the body-usage gateway went ' +
        'live, or an unpriced model) are reported as UNKNOWN, never $0 — no backfill. Read HOST-SIDE only: a ' +
        'cli_scope=global caller gets back just the numbers, never OneCLI DB access. Needs the gateway flags ' +
        '(ONECLI_CAPTURE_RESPONSE_HEADERS + ONECLI_CAPTURE_BODY_USAGE_HOSTS) + ONECLI_PG_CONTAINER; reports ' +
        'configured:false when unset. Filters: --group (coworker folder), --period (e.g. 30d, 24h; default all-time).',
      args: [
        { name: 'group', type: 'string', description: 'filter to one coworker workspace folder' },
        {
          name: 'period',
          type: 'string',
          description: 'lookback window: <n>d or <n>h (e.g. 30d, 24h). Default: all-time.',
        },
      ],
      examples: [
        'ncl cost-cap coworkers',
        'ncl cost-cap coworkers --period 7d',
        'ncl cost-cap coworkers --group slang-fixer --json',
      ],
      handler: async (args) => {
        const trim = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
        return readCostPerCoworker({ period: trim(args.period), groupFolder: trim(args.group) });
      },
      formatHuman: (data) => {
        const d = data as CostPerCoworkerResult;
        if (!d.configured) return d.note ?? 'Cost source not configured.';
        if (d.coworkers.length === 0) return d.note ?? 'No captured cost rows.';
        const unknown = d.unknownCalls > 0 ? ` + ${d.unknownCalls} call${d.unknownCalls === 1 ? '' : 's'} UNKNOWN` : '';
        const lines = [
          `Cost per coworker (${d.period}; gateway body usage × NanoClaw rates) — total ${money(d.totalUsd)}${unknown}:`,
        ];
        for (const c of d.coworkers) {
          const who = c.folder ?? (c.name || c.groupId);
          let line = `  ${who}: ${money(c.costUsd)} · ${c.pricedCalls} priced call${c.pricedCalls === 1 ? '' : 's'}`;
          if (c.unknownCalls > 0) line += ` · ${c.unknownCalls} UNKNOWN`;
          if (c.unpricedModels.length > 0) line += ` (unpriced: ${c.unpricedModels.join(', ')})`;
          lines.push(line);
        }
        if (d.note) lines.push(d.note);
        return lines.join('\n');
      },
    },

    history: {
      access: 'open',
      description:
        'Per-coworker cost over an ARBITRARY date range, bucketed by day / week / total — the one cost view ' +
        'the live tools cannot give (status is point-in-time; sessions/stopped/coworkers only offer fixed ' +
        '1d/7d/30d/all windows with no time axis). Reads the durable #65 cost ledger (`cost_events`, per-' +
        'session outbound.db): one deduped, timestamped, token-priced row per billable unit, written dual-run ' +
        "for every Claude message + Codex call. Sums each row's stored priced_usd (the ledger is " +
        'rate_version=1, so that equals a token re-price) across ALL window generations — validated to carry ' +
        'no /clear-rotation double counting. Covers Claude + Codex, split out per provider. Bounded only by ' +
        "ledger retention (old sessions' outbound.db rotate out). Filters: --group (id/folder/name), --from " +
        'and --to (YYYY-MM-DD, both inclusive), --by (day|week|total, default week).',
      args: [
        { name: 'group', type: 'string', description: 'Filter to one coworker (agent group id, folder, or name).' },
        { name: 'from', type: 'string', description: 'Inclusive start date, YYYY-MM-DD.' },
        { name: 'to', type: 'string', description: 'Inclusive end date, YYYY-MM-DD.' },
        {
          name: 'by',
          type: 'string',
          description: 'Bucket granularity: day|week|total (default week).',
          default: 'week',
        },
      ],
      examples: [
        'ncl cost-cap history',
        'ncl cost-cap history --from 2026-08-01 --to 2026-08-31 --by week',
        'ncl cost-cap history --group slang-fixer --from 2026-08-25 --by day --json',
      ],
      handler: async (args) => {
        const trim = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
        const by = String(args.by ?? 'week').trim() as HistoryBy;
        if (!HISTORY_BY.includes(by)) {
          throw new Error(`--by must be one of: ${HISTORY_BY.join(', ')}`);
        }
        for (const [flag, val] of [
          ['from', args.from],
          ['to', args.to],
        ] as const) {
          const s = trim(val);
          if (s && !isValidDate(s)) throw new Error(`--${flag} must be a real YYYY-MM-DD date`);
        }
        return readCostHistory({ group: trim(args.group), from: trim(args.from), to: trim(args.to), by });
      },
      formatHuman: (data) => {
        const d = data as CostHistoryResult;
        const range = d.from || d.to ? `${d.from ?? '…'} → ${d.to ?? 'now'}` : 'all ledger history';
        const mixed =
          d.rate_versions.length && (d.rate_versions.length > 1 || d.rate_versions[0] !== 1)
            ? ` [rate_versions ${d.rate_versions.join(',')}: report-as-billed]`
            : '';
        // Never present a total as authoritative when a read failed (finding 2).
        const incomplete = d.complete
          ? ''
          : `⚠ INCOMPLETE: ${d.read_errors} session read(s) failed — totals are a LOWER BOUND.\n`;
        // Pre-ledger baseline lumps are excluded from the buckets (finding 1);
        // surface them so their absence from the per-period total is explicit.
        const legacy =
          d.legacy_baseline_usd > 0
            ? `\n(excluded: ${usd(d.legacy_baseline_usd)} pre-ledger migration baseline — non-timestamped, ` +
              `provider-ambiguous, likely #1327-inflated; not in the totals above)`
            : '';
        if (d.groups.length === 0) {
          return `${incomplete}No attributable ledger spend for ${range} (${d.sessions_with_ledger}/${d.sessions_scanned} sessions carry a ledger; ${d.sessions_no_ledger} pre-ledger).${mixed}${legacy}`;
        }
        const lines = [
          `${incomplete}Per-coworker cost — ${range}, by ${d.by} — total ${usd(d.grand_total_usd)}${mixed}`,
          `  (${d.sessions_with_ledger}/${d.sessions_scanned} sessions carry ledger rows)`,
        ];
        for (const g of d.groups) {
          lines.push(`\n${g.group_name}  ${usd(g.total_usd)}  (claude ${usd(g.claudeUsd)} · codex ${usd(g.codexUsd)})`);
          if (d.by !== 'total') {
            for (const b of g.buckets) {
              lines.push(`    ${b.bucket}  ${usd(b.usd)}`);
            }
          }
        }
        if (legacy) lines.push(legacy);
        return lines.join('\n');
      },
    },
  },
});
