/**
 * Read-only reader for a session's LIVE cost-cap STATE — not the ceiling/cap
 * POLICY (see `src/cli/resources/cost-cap.ts`'s `get`/`set`/`clear` for that;
 * this is the `status` verb's backing module).
 *
 * The runner (`container/agent-runner/src/db/session-state.ts`) persists its
 * `CostCapState` as a single JSON row under the `cost_cap` key of the
 * session's outbound.db `session_state` table on every turn:
 *   { capUsd, spentUsd, status: 'ok'|'warn'|'escalated'|'stopped', immortal,
 *     window: 'lifetime'|'daily', dayKey?, escalatedAt?, decision?, decidedAt? }
 *
 * Two other readers already exist for this same row, each lifting only what
 * their caller needs:
 *   - the dashboard's `readSessionCapState()` (nv-dashboard, not this tree) —
 *     the whole shape, for the Sessions tab / cost-approval card.
 *   - `src/modules/runaway/detect.ts`'s `readRunawayCost()` — spentUsd/capUsd
 *     only, for the runaway card's human-facing numbers. It takes an
 *     ALREADY-OPEN db handle (the sweep has one open already) and
 *     deliberately rejects a non-positive cap, which is right for ITS caller
 *     but wrong for this one — a `stopped` session with a weird cap must
 *     still report `stopped`.
 *
 * This is the HOST-SIDE, `ncl`-scriptable reader: given just a session id (as
 * `ncl cost-cap status --session <id>` receives it), it resolves the
 * session's outbound.db itself and lifts `status`, so a caller — chiefly the
 * /supervise-issues scan, via pull-universe.sh — can tell a session that is
 * merely idle apart from one that is deliberately `stopped` pending a human
 * cost decision, without guessing from container liveness alone.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { getSession } from '../db/sessions.js';
import { outboundDbPath } from '../mailbox/sqlite/paths.js';

export type CostCapStatus = 'ok' | 'warn' | 'escalated' | 'stopped';

const VALID_STATUS = new Set<string>(['ok', 'warn', 'escalated', 'stopped']);

export interface SessionCostCapView {
  session_id: string;
  agent_group_id: string;
  /**
   * 'unknown' means no usable cost-cap row: a pre-cost-cap runner, cost
   * tracking off for the group (non-Claude provider or no cap configured —
   * the runner never writes a row), or the container has never spawned or
   * spent anything yet. Callers should treat 'unknown' exactly like 'ok'
   * (i.e. NOT stopped) — it carries no information either way.
   */
  status: CostCapStatus | 'unknown';
  cap_usd?: number;
  spent_usd?: number;
  immortal?: boolean;
  window?: 'lifetime' | 'daily';
  day_key?: string;
  escalated_at?: string;
  decision?: 'continue' | 'stop';
  decided_at?: string;
  /**
   * Live Tier-2 hard ceiling in USD (NanoClaw #1, "set ceiling v2"). Present
   * whenever the runner has ever written a `cost_cap` row (the runner always
   * publishes this field now, including `0` for "no ceiling configured") —
   * absent only under `status: 'unknown'`, matching every other field here.
   */
  ceiling_usd?: number;
  /** The live budget generation — the epoch-fence value a live-control request
   *  must echo back as `expectedEpochKey`. */
  budget_gen?: number;
  /** The current escalation episode id, present only while status is
   *  escalated/stopped. */
  episode_id?: string;
}

/** The stored shape under the `cost_cap` key — field-for-field mirror of
 *  `CostCapState` in container/agent-runner/src/db/session-state.ts. */
interface StoredCostCap {
  capUsd?: unknown;
  spentUsd?: unknown;
  status?: unknown;
  immortal?: unknown;
  window?: unknown;
  dayKey?: unknown;
  escalatedAt?: unknown;
  decision?: unknown;
  decidedAt?: unknown;
  ceilingUsd?: unknown;
  budgetGen?: unknown;
  episodeId?: unknown;
}

/**
 * Read a session's live cost-cap status by id.
 *
 * Throws only when the session id itself doesn't resolve (a caller error —
 * mirrors `readSessionMessages`'s `session not found` contract). Every other
 * failure mode — missing outbound.db, missing table, missing/unparseable row
 * — degrades to `status: 'unknown'` rather than throwing, so a scriptable
 * caller (pull-universe.sh) never has to special-case "session predates
 * cost-cap" vs. a real error.
 */
export async function readSessionCostCapStatus(sessionId: string): Promise<SessionCostCapView> {
  if (!sessionId) throw new Error('--session is required');
  const session = await getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const base = { session_id: session.id, agent_group_id: session.agent_group_id };
  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(dbPath)) return { ...base, status: 'unknown' };

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const cols = db.prepare('PRAGMA table_info(session_state)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'value')) return { ...base, status: 'unknown' };

    const row = db.prepare("SELECT value FROM session_state WHERE key = 'cost_cap'").get() as
      | { value: string }
      | undefined;
    if (!row?.value) return { ...base, status: 'unknown' };

    const parsed = JSON.parse(row.value) as StoredCostCap;
    if (!parsed || typeof parsed !== 'object' || !VALID_STATUS.has(String(parsed.status))) {
      return { ...base, status: 'unknown' };
    }

    return {
      ...base,
      status: parsed.status as CostCapStatus,
      ...(typeof parsed.capUsd === 'number' ? { cap_usd: parsed.capUsd } : {}),
      ...(typeof parsed.spentUsd === 'number' ? { spent_usd: parsed.spentUsd } : {}),
      ...(typeof parsed.immortal === 'boolean' ? { immortal: parsed.immortal } : {}),
      ...(parsed.window === 'lifetime' || parsed.window === 'daily' ? { window: parsed.window } : {}),
      ...(typeof parsed.dayKey === 'string' ? { day_key: parsed.dayKey } : {}),
      ...(typeof parsed.escalatedAt === 'string' ? { escalated_at: parsed.escalatedAt } : {}),
      ...(parsed.decision === 'continue' || parsed.decision === 'stop' ? { decision: parsed.decision } : {}),
      ...(typeof parsed.decidedAt === 'string' ? { decided_at: parsed.decidedAt } : {}),
      ...(typeof parsed.ceilingUsd === 'number' ? { ceiling_usd: parsed.ceilingUsd } : {}),
      ...(typeof parsed.budgetGen === 'number' ? { budget_gen: parsed.budgetGen } : {}),
      ...(typeof parsed.episodeId === 'string' ? { episode_id: parsed.episodeId } : {}),
    };
  } catch {
    // Corrupt DB / unparseable JSON — no signal, not an error.
    return { ...base, status: 'unknown' };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * The runner-instance readiness handshake (NanoClaw #1, "set ceiling v2") —
 * `session_state.cost_control_protocol`, published unconditionally at runner
 * startup (see `publishRunnerReadiness` in `container/agent-runner/src/poll-
 * loop.ts`). Read by `src/modules/cost-ceiling-adjustment/index.ts` before
 * accepting a live-control request; never trust a stale value across a
 * respawn without comparing `runnerInstanceId` against the CURRENTLY active
 * container's own nonce (`getActiveContainerInstanceId` in
 * `src/container-runner.ts`) — this reader only reports what is on file, it
 * does not itself know which spawn is "current."
 *
 * Fail-soft like `readSessionCostCapStatus`: any missing/corrupt/pre-feature
 * state reads as `undefined`, never throws (except for an unresolvable
 * session id, matching that function's contract).
 */
export interface SessionCostControlProtocolView {
  version: number;
  runner_instance_id: string;
  ready_at: string;
  /** Live-control operations this runner build can handle (e.g. `set_ceiling`,
   *  `reconcile`). Absent on a runner that predates the capability list — such a
   *  runner still supports `set_ceiling` (gated on `version`), but a caller must
   *  treat any operation not listed here as unsupported. */
  operations?: string[];
}

interface StoredCostControlProtocol {
  version?: unknown;
  runnerInstanceId?: unknown;
  readyAt?: unknown;
  operations?: unknown;
}

export async function readSessionCostControlProtocol(
  sessionId: string,
): Promise<SessionCostControlProtocolView | undefined> {
  if (!sessionId) throw new Error('sessionId is required');
  const session = await getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(dbPath)) return undefined;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const cols = db.prepare('PRAGMA table_info(session_state)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'value')) return undefined;

    const row = db.prepare("SELECT value FROM session_state WHERE key = 'cost_control_protocol'").get() as
      | { value: string }
      | undefined;
    if (!row?.value) return undefined;

    const parsed = JSON.parse(row.value) as StoredCostControlProtocol;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'number' ||
      typeof parsed.runnerInstanceId !== 'string' ||
      !parsed.runnerInstanceId ||
      typeof parsed.readyAt !== 'string'
    ) {
      return undefined;
    }

    const operations =
      Array.isArray(parsed.operations) && parsed.operations.every((o) => typeof o === 'string')
        ? (parsed.operations as string[])
        : undefined;
    return {
      version: parsed.version,
      runner_instance_id: parsed.runnerInstanceId,
      ready_at: parsed.readyAt,
      ...(operations ? { operations } : {}),
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
