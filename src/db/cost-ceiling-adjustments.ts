/**
 * Accessor for `cost_ceiling_adjustments` (migration 942) — the durable ledger and
 * concurrency control behind the live, per-session, exact-value cost-ceiling
 * control (NanoClaw #1, "set ceiling v2"). See the migration file for the full
 * design rationale (why a dedicated table, integer cents, the state machine).
 *
 * Like `cost-escalation-episodes.ts`, this module is PURE DATA plus the one
 * multi-table transaction the creation path genuinely needs (checking/superseding
 * a competing card and reaping its dashboard row are money-safety, not optional
 * cleanup — see `createCostCeilingAdjustment`). It never enqueues the runner
 * control message or wakes a container — that is
 * `src/modules/cost-ceiling-adjustment/index.ts`'s job, driven by what these
 * functions return.
 *
 * READS are fail-soft (empty/undefined when the DB is uninitialized or the table
 * is missing), matching `cost-escalation-episodes.ts`, so hermetic callers never
 * have to special-case an unmigrated DB. WRITES require an initialized DB
 * (host-side only).
 */
import { getDb, hasTable } from './connection.js';
import {
  COST_DECISION_ACTION,
  getEpisodesForSessionEpoch,
  supersedePendingEpisodesForEpoch,
  type CostEpisodeRow,
} from './cost-escalation-episodes.js';
import type { DbDriver } from './driver.js';
import { deletePendingApproval, getPendingApprovalsByAction } from './sessions.js';

export type CostCeilingAdjustmentState = 'pending' | 'enqueued' | 'applied' | 'conflict' | 'rejected';

/** Which runner operation a ledger row carries — set the ceiling to an exact value
 *  (migration 942) or reconcile live enforcement spend to the transcript oracle
 *  (migration 943, issue #1327). See `cost_reconcile` in `src/modules/cost-ceiling-adjustment`. */
export type CostAdjustmentOperation = 'set_ceiling' | 'reconcile';

const TERMINAL_STATES = new Set<CostCeilingAdjustmentState>(['applied', 'conflict', 'rejected']);

export interface CostCeilingAdjustmentRow {
  adjustment_id: string;
  protocol_version: number;
  /** `set_ceiling` (default; migration 942) or `reconcile` (migration 943). */
  operation: CostAdjustmentOperation;
  session_id: string;
  agent_group_id: string;
  expected_epoch_key: string;
  expected_ceiling_cents: number;
  target_ceiling_cents: number;
  /** The reconcile target (transcript-oracle spend, integer cents). NULL for `set_ceiling`. */
  target_spent_cents: number | null;
  /** The live spend the host read when stamping a reconcile — the third CAS leg
   *  (epoch + ceiling + spend). NULL for `set_ceiling`. */
  expected_spent_cents: number | null;
  /** 1 iff this reconcile was `--force`d past an already-decided card on its epoch
   *  (migration 944, the #1327 recovery deadlock). 0 otherwise. Audit only. */
  forced: number;
  state: CostCeilingAdjustmentState;
  inbound_message_id: string;
  requested_at: string;
  requested_by: string;
  enqueued_at: string | null;
  completed_at: string | null;
  result_epoch_key: string | null;
  result_ceiling_cents: number | null;
  result_spent_usd: number | null;
  result_cost_status: string | null;
  result_reason: string | null;
  enqueue_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

/** The fields a caller supplies to create a new adjustment request. */
export interface CostCeilingAdjustmentInsert {
  adjustment_id: string;
  protocol_version: number;
  /** Defaults to `'set_ceiling'` when omitted (the pre-943 shape). */
  operation?: CostAdjustmentOperation;
  session_id: string;
  agent_group_id: string;
  expected_epoch_key: string;
  expected_ceiling_cents: number;
  target_ceiling_cents: number;
  /** Required for `operation: 'reconcile'`; NULL/omitted for `set_ceiling`. */
  target_spent_cents?: number | null;
  /** The live spend at stamp time (reconcile CAS third leg); NULL/omitted for `set_ceiling`. */
  expected_spent_cents?: number | null;
  /** Reconcile only (issue #1327): relax the `card_already_decided` fence so the
   *  reconcile may apply on an epoch that already has a resolved decision card.
   *  Relaxes ONLY that check — every other guard (lower-only, the three-leg CAS,
   *  idempotency, the runner's preserve-human-stop) is unaffected. When this
   *  request actually bypasses a decided card, the persisted `forced` column is set. */
  force?: boolean;
  inbound_message_id: string;
  requested_at: string;
  requested_by: string;
}

/** Fail-soft handle: null when there is no initialized DB with the table. */
async function db(): Promise<DbDriver | null> {
  const d = getDb();
  if (!d) return null;
  return (await hasTable(d, 'cost_ceiling_adjustments')) ? d : null;
}

/** Whether two creation requests are the "same" request (byte-identical body) for idempotency. */
function sameRequest(row: CostCeilingAdjustmentRow, input: CostCeilingAdjustmentInsert): boolean {
  return (
    row.operation === (input.operation ?? 'set_ceiling') &&
    row.session_id === input.session_id &&
    row.agent_group_id === input.agent_group_id &&
    row.expected_epoch_key === input.expected_epoch_key &&
    row.expected_ceiling_cents === input.expected_ceiling_cents &&
    row.target_ceiling_cents === input.target_ceiling_cents &&
    (row.target_spent_cents ?? null) === (input.target_spent_cents ?? null) &&
    (row.expected_spent_cents ?? null) === (input.expected_spent_cents ?? null) &&
    row.inbound_message_id === input.inbound_message_id
  );
}

export type CreateCostCeilingAdjustmentResult =
  /** First-ever insert of this adjustment_id — proceed to enqueue. */
  | { outcome: 'created'; row: CostCeilingAdjustmentRow }
  /** Same adjustment_id, byte-identical body — idempotent retry, safe to re-drive the same response. */
  | { outcome: 'idempotent-existing'; row: CostCeilingAdjustmentRow }
  /** Same adjustment_id, DIFFERENT body — a request-id collision with a different payload. Refuse. */
  | { outcome: 'id-conflict'; row: CostCeilingAdjustmentRow }
  /** A card already resolved (continue/stop) this EXACT (session, epoch) — a decision beat this request. */
  | { outcome: 'episode-already-won'; episode: CostEpisodeRow }
  /** The DB's own UNIQUE(session_id, expected_epoch_key) refused a second row for this epoch —
   *  another adjustment_id won the race. `row` is the winner. */
  | { outcome: 'epoch-conflict'; row: CostCeilingAdjustmentRow };

/**
 * Create a new cost-ceiling-adjustment ledger row, or return the existing
 * outcome for a retried/racing request. Runs the full creation sequence in ONE
 * transaction:
 *
 *   1. `adjustment_id` already on file with an IDENTICAL body → return it
 *      (idempotent retry — a dashboard timeout-and-resend must not double-submit).
 *   2. `adjustment_id` already on file with a DIFFERENT body → refuse
 *      (id-conflict — never silently accept a mismatched replay of someone else's id).
 *   3. A `continued`/`stopped` escalation episode already owns this EXACT
 *      (session, epoch) → refuse (a card decision beat this request — the
 *      episode's `cost_override` may already be durably enqueued for the runner).
 *      EXCEPTION: a RECONCILE with `input.force` (issue #1327) applies past a
 *      `continued` card (only) and records `forced = 1` — the deadlock escape for a
 *      session `continue`d on inflated spend. A `stopped` card is NEVER forceable
 *      (that would defeat a human stop). This relaxes ONLY this step; the
 *      downward-only + three-leg CAS guards downstream are untouched.
 *   4. Any still-`pending` episode for this (session, epoch) is superseded (so a
 *      delayed card click can never apply once this request has claimed the epoch).
 *   5. Each superseded episode's dashboard `pending_approvals` row is deleted in
 *      the SAME transaction (a human must never see a card that can no longer do
 *      anything).
 *   6. The row is inserted. If a DIFFERENT adjustment_id already won this exact
 *      (session, epoch) — the true concurrent-race case, since two different
 *      ids can both pass steps 1-4 — the `UNIQUE(session_id, expected_epoch_key)`
 *      constraint refuses the insert; the whole transaction (including step 4's
 *      supersede) rolls back, and the caller gets `epoch-conflict` with the
 *      actual winning row.
 */
export async function createCostCeilingAdjustment(
  input: CostCeilingAdjustmentInsert,
): Promise<CreateCostCeilingAdjustmentResult> {
  const d = getDb();

  try {
    return await d.transaction(async (): Promise<CreateCostCeilingAdjustmentResult> => {
      const existingById = await getCostCeilingAdjustment(input.adjustment_id);
      if (existingById) {
        return sameRequest(existingById, input)
          ? { outcome: 'idempotent-existing', row: existingById }
          : { outcome: 'id-conflict', row: existingById };
      }

      const episodesForEpoch = await getEpisodesForSessionEpoch(input.session_id, input.expected_epoch_key);
      // A `stopped` card is NEVER forceable: `--force` corrects a session a human
      // meant to keep running (a `continue` on inflated spend), and its rationale is
      // "strictly more permissive than the human's CONTINUE intent." Forcing past a
      // `stopped` card would instead DEFEAT the human's stop — and racily so: the
      // stop's `cost_override` may not have reached the runner yet, so a forced
      // reconcile that rotates the epoch first would make that stop go stale. So a
      // stopped card always wins.
      const stoppedWinner = episodesForEpoch.find((e) => e.decision_state === 'stopped');
      if (stoppedWinner) return { outcome: 'episode-already-won', episode: stoppedWinner };

      // `--force` (RECONCILE only, issue #1327) relaxes ONLY this fence for a
      // `continued` card: it lets a downward reconcile apply on an epoch whose
      // card was continued on inflated spend. Everything downstream still holds —
      // it does NOT bypass the lower-only rule or the runner's three-leg CAS. The
      // operation scope is defense-in-depth: `force` on a set-ceiling row (which
      // its own submit path never sets) can never bypass this. When a continued
      // card IS overridden, `forced` is persisted for the audit trail.
      const continuedWinner = episodesForEpoch.find((e) => e.decision_state === 'continued');
      const forcedOverride =
        (input.operation ?? 'set_ceiling') === 'reconcile' && input.force === true && !!continuedWinner;
      if (continuedWinner && !forcedOverride) return { outcome: 'episode-already-won', episode: continuedWinner };

      const superseded = await supersedePendingEpisodesForEpoch(
        input.session_id,
        input.expected_epoch_key,
        `adjustment:${input.adjustment_id}`,
        input.requested_at,
      );
      for (const ep of superseded) await reapPendingApprovalCardForEpisode(ep.episode_id);

      await d.run(
        `INSERT INTO cost_ceiling_adjustments
           (adjustment_id, protocol_version, operation, session_id, agent_group_id, expected_epoch_key,
            expected_ceiling_cents, target_ceiling_cents, target_spent_cents, expected_spent_cents, forced, state,
            inbound_message_id, requested_at, requested_by, enqueue_attempts)
         VALUES
           ($adjustment_id, $protocol_version, $operation, $session_id, $agent_group_id, $expected_epoch_key,
            $expected_ceiling_cents, $target_ceiling_cents, $target_spent_cents, $expected_spent_cents, $forced,
            'pending', $inbound_message_id, $requested_at, $requested_by, 0)`,
        {
          // better-sqlite3's named-parameter binding requires the OBJECT key to be
          // the BARE name (no $/@/: sigil) even though the SQL text uses $-prefixed
          // placeholders — unlike bun:sqlite on the runner side, which accepts the
          // sigil in the object key too. Bare keys here, always.
          adjustment_id: input.adjustment_id,
          protocol_version: input.protocol_version,
          operation: input.operation ?? 'set_ceiling',
          session_id: input.session_id,
          agent_group_id: input.agent_group_id,
          expected_epoch_key: input.expected_epoch_key,
          expected_ceiling_cents: input.expected_ceiling_cents,
          target_ceiling_cents: input.target_ceiling_cents,
          target_spent_cents: input.target_spent_cents ?? null,
          expected_spent_cents: input.expected_spent_cents ?? null,
          forced: forcedOverride ? 1 : 0,
          inbound_message_id: input.inbound_message_id,
          requested_at: input.requested_at,
          requested_by: input.requested_by,
        },
      );

      return { outcome: 'created', row: (await getCostCeilingAdjustment(input.adjustment_id))! };
    });
  } catch (err) {
    // A DIFFERENT adjustment_id already claimed this (session, epoch) between our
    // pre-checks and the insert — the true concurrent-race case. SQLite's own
    // constraint is the arbiter; re-read the winner outside the now-rolled-back
    // transaction and report it cleanly instead of propagating a raw SQL error.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('expected_epoch_key')) {
      const winner = await getCostCeilingAdjustmentBySessionEpoch(input.session_id, input.expected_epoch_key);
      if (winner) return { outcome: 'epoch-conflict', row: winner };
    }
    throw err;
  }
}

/**
 * Delete the dashboard/chat card for an episode, if one was ever created. Mirrors
 * `reapPendingApprovalCard` in `src/modules/cost-approval/index.ts` exactly (same
 * scan-by-payload approach — `requestApproval` returns void, so there is no
 * direct `episode -> approval_id` link to index on). Duplicated rather than
 * imported: importing from the modules layer here would invert the dependency
 * direction (cost-approval/index.ts already imports FROM this file) and risk a
 * circular import.
 */
async function reapPendingApprovalCardForEpisode(episodeId: string): Promise<void> {
  for (const approval of await getPendingApprovalsByAction(COST_DECISION_ACTION)) {
    if (approval.status !== 'pending') continue;
    let payloadEpisodeId: unknown;
    try {
      payloadEpisodeId = (JSON.parse(approval.payload) as { episodeId?: unknown }).episodeId;
    } catch {
      continue;
    }
    if (payloadEpisodeId === episodeId) await deletePendingApproval(approval.approval_id);
  }
}

export async function getCostCeilingAdjustment(adjustmentId: string): Promise<CostCeilingAdjustmentRow | undefined> {
  const d = await db();
  if (!d) return undefined;
  return d.get<CostCeilingAdjustmentRow>(
    `SELECT * FROM cost_ceiling_adjustments WHERE adjustment_id = ?`,
    adjustmentId,
  );
}

/**
 * The adjustment claiming one exact (session, epoch) pair, if any — the natural
 * lookup the `UNIQUE(session_id, expected_epoch_key)` constraint backs. Used by
 * the epoch-conflict path above and by escalation-ingest (`ingestCostEscalation`
 * in `src/modules/cost-approval/index.ts`) to detect a delayed `cost_escalation`
 * for an epoch an adjustment already owns.
 */
export async function getCostCeilingAdjustmentBySessionEpoch(
  sessionId: string,
  epochKey: string,
): Promise<CostCeilingAdjustmentRow | undefined> {
  const d = await db();
  if (!d) return undefined;
  return d.get<CostCeilingAdjustmentRow>(
    `SELECT * FROM cost_ceiling_adjustments WHERE session_id = ? AND expected_epoch_key = ?`,
    sessionId,
    epochKey,
  );
}

/** The newest adjustment for a session, in ANY state — for dashboard/CLI status views. */
export async function getLatestCostCeilingAdjustmentBySession(
  sessionId: string,
): Promise<CostCeilingAdjustmentRow | undefined> {
  const d = await db();
  if (!d) return undefined;
  return d.get<CostCeilingAdjustmentRow>(
    `SELECT * FROM cost_ceiling_adjustments WHERE session_id = ? ORDER BY requested_at DESC LIMIT 1`,
    sessionId,
  );
}

/**
 * Advance `pending` → `enqueued` once the deterministic inbound control message
 * is durably written. Idempotent single-column advance (guard: only from
 * `pending`), matching `markEffectEnqueued` in cost-escalation-episodes.ts.
 */
export async function markCostCeilingAdjustmentEnqueued(adjustmentId: string, enqueuedAtIso: string): Promise<void> {
  await getDb().run(
    `UPDATE cost_ceiling_adjustments SET state = 'enqueued', enqueued_at = ?
      WHERE adjustment_id = ? AND state = 'pending'`,
    enqueuedAtIso,
    adjustmentId,
  );
}

export interface CostCeilingAdjustmentResultInput {
  adjustment_id: string;
  outcome: 'applied' | 'conflict' | 'rejected';
  completed_at: string;
  result_epoch_key: string | null;
  result_ceiling_cents: number | null;
  result_spent_usd: number | null;
  result_cost_status: string | null;
  result_reason: string | null;
  /** Echoed request fields from the receipt — validated against our own central
   *  record before being accepted as authoritative (never trust the runner's
   *  echo blindly; see `src/modules/cost-ceiling-adjustment/index.ts`). */
  session_id: string;
  expected_epoch_key: string;
  expected_ceiling_cents: number;
  target_ceiling_cents: number;
  /** Echoed reconcile target (integer cents). Validated in place of
   *  `target_ceiling_cents` when the central row's `operation` is `'reconcile'`. */
  target_spent_cents?: number | null;
}

export type RecordCostCeilingAdjustmentResultOutcome =
  /** First time this terminal result has been recorded. */
  | { outcome: 'recorded'; row: CostCeilingAdjustmentRow }
  /** Already terminal with the SAME outcome — a receipt replay. Idempotent no-op. */
  | { outcome: 'replayed-identical'; row: CostCeilingAdjustmentRow }
  /** The receipt's echoed request fields (or its outcome, if already terminal with a
   *  DIFFERENT one) don't match our central record — forged/corrupted/misdirected
   *  receipt. Never accepted as authoritative. */
  | { outcome: 'mismatch'; row: CostCeilingAdjustmentRow }
  | { outcome: 'not-found' };

/**
 * The central-DB CAS behind the runner receipt (`cost_ceiling_adjustment_result`).
 * This is the ONLY place a row leaves `pending`/`enqueued` for a runner-confirmed
 * reason. Validates every echoed field against the row already on file — the
 * runner's self-report is never trusted blindly — and is idempotent under replay
 * (crash after this CAS commits but before the outbound message is marked
 * delivered on the session side re-delivers the identical receipt; this returns
 * the same terminal row rather than re-applying).
 */
export async function recordCostCeilingAdjustmentResult(
  input: CostCeilingAdjustmentResultInput,
): Promise<RecordCostCeilingAdjustmentResultOutcome> {
  const d = getDb();

  return d.transaction(async (): Promise<RecordCostCeilingAdjustmentResultOutcome> => {
    const existing = await getCostCeilingAdjustment(input.adjustment_id);
    if (!existing) return { outcome: 'not-found' };

    // The TARGET echo validated depends on the operation: a reconcile row's
    // target is `target_spent_cents`, a set-ceiling row's is `target_ceiling_cents`.
    // The central row's own `operation` is authoritative (never the receipt's claim).
    const targetMatches =
      existing.operation === 'reconcile'
        ? (existing.target_spent_cents ?? null) === (input.target_spent_cents ?? null)
        : existing.target_ceiling_cents === input.target_ceiling_cents;
    const echoMatches =
      existing.session_id === input.session_id &&
      existing.expected_epoch_key === input.expected_epoch_key &&
      existing.expected_ceiling_cents === input.expected_ceiling_cents &&
      targetMatches;
    if (!echoMatches) return { outcome: 'mismatch', row: existing };

    if (TERMINAL_STATES.has(existing.state)) {
      return existing.state === input.outcome
        ? { outcome: 'replayed-identical', row: existing }
        : { outcome: 'mismatch', row: existing };
    }

    const info = await d.run(
      `UPDATE cost_ceiling_adjustments
          SET state = $outcome, completed_at = $completed_at, result_epoch_key = $result_epoch_key,
              result_ceiling_cents = $result_ceiling_cents, result_spent_usd = $result_spent_usd,
              result_cost_status = $result_cost_status, result_reason = $result_reason
        WHERE adjustment_id = $adjustment_id AND state IN ('pending','enqueued')`,
      {
        // Bare keys — see the same note in createCostCeilingAdjustment above.
        outcome: input.outcome,
        completed_at: input.completed_at,
        result_epoch_key: input.result_epoch_key,
        result_ceiling_cents: input.result_ceiling_cents,
        result_spent_usd: input.result_spent_usd,
        result_cost_status: input.result_cost_status,
        result_reason: input.result_reason,
        adjustment_id: input.adjustment_id,
      },
    );

    if (info.changes === 0) {
      // Lost a race with another writer that terminalized this row between our
      // read above and this UPDATE (e.g. the reconciler). Re-read and resolve
      // the same way a plain replay would.
      const now = (await getCostCeilingAdjustment(input.adjustment_id))!;
      return now.state === input.outcome
        ? { outcome: 'replayed-identical', row: now }
        : { outcome: 'mismatch', row: now };
    }

    return { outcome: 'recorded', row: (await getCostCeilingAdjustment(input.adjustment_id))! };
  });
}

/**
 * Unfinished rows (`pending`/`enqueued`) due for reconciler attention — either
 * never attempted (`next_attempt_at IS NULL`) or past their backoff deadline.
 * Oldest-first so a stuck early row doesn't starve behind a stream of fresh ones.
 */
export async function listUnfinishedCostCeilingAdjustments(
  nowIso: string = new Date().toISOString(),
  limit = 50,
): Promise<CostCeilingAdjustmentRow[]> {
  const d = await db();
  if (!d) return [];
  return d.all<CostCeilingAdjustmentRow>(
    `SELECT * FROM cost_ceiling_adjustments
      WHERE state IN ('pending','enqueued') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY requested_at
      LIMIT ?`,
    nowIso,
    limit,
  );
}

/**
 * Record a failed enqueue attempt (control-message write or container wake) with
 * a persisted, capped-exponential-backoff `next_attempt_at` — the reconciler
 * must never silently give up, only slow down. No state change: a row that
 * fails to enqueue stays exactly where it was (`pending` or `enqueued`) so the
 * next sweep tick still finds and retries it.
 */
export async function bumpCostCeilingAdjustmentAttempt(
  adjustmentId: string,
  nextAttemptAtIso: string,
  error?: string,
): Promise<void> {
  await getDb().run(
    `UPDATE cost_ceiling_adjustments
        SET enqueue_attempts = enqueue_attempts + 1, next_attempt_at = ?, last_error = ?
      WHERE adjustment_id = ?`,
    nextAttemptAtIso,
    error ?? null,
    adjustmentId,
  );
}

/**
 * Reconciler-driven terminalization for a row that will provably never receive a
 * runner receipt: the session is closed, its DB is gone, or its runner build is
 * confirmed protocol-incompatible. Distinct from `recordCostCeilingAdjustmentResult`
 * (which is exclusively the runner-receipt CAS) — this is the host declaring the
 * outcome itself, always `rejected` (never `applied`/`conflict`, which mean "the
 * runner told us"). Guarded to only ever leave `pending`/`enqueued`, matching the
 * other terminal transitions.
 */
export async function rejectCostCeilingAdjustment(adjustmentId: string, reason: string, nowIso: string): Promise<void> {
  await getDb().run(
    `UPDATE cost_ceiling_adjustments
        SET state = 'rejected', completed_at = ?, result_reason = ?
      WHERE adjustment_id = ? AND state IN ('pending','enqueued')`,
    nowIso,
    reason,
    adjustmentId,
  );
}
