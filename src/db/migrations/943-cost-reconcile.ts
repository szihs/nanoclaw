import type { Migration } from './index.js';

/**
 * `cost_reconcile` — extend the `cost_ceiling_adjustments` ledger (migration 942)
 * to carry a SECOND runner operation alongside `set_ceiling`: reconciling a
 * session's live enforcement spend (`costSpentUsd`) to its real, transcript-priced
 * cost (issue #1327).
 *
 * WHY REUSE THIS TABLE (not a new sibling). Reconcile is the same shape of
 * operation as set-ceiling — an operator-authorized, per-session, exact-value
 * mutation of a live runner budget number, submitted through the session DB,
 * confirmed by a runner receipt, epoch-fenced by the SAME
 * `UNIQUE(session_id, expected_epoch_key)` compare-and-set. Every money-safety
 * property the 942 ledger already provides (idempotent create, episode-card
 * superseding for the epoch, first-write-wins on the epoch, the reconciler's
 * capped-backoff re-drive, the receipt CAS) applies unchanged; a separate table
 * would duplicate all of it and, worse, let a reconcile and a set-ceiling both
 * claim the same epoch on the host (they can only be fenced against each other by
 * the runner's epoch rotation, which is a weaker guarantee than the shared
 * table's UNIQUE). The 942 header's warning was about overloading the ESCALATION
 * EPISODE table (939) — a runner-INITIATED table — with an operator operation;
 * this adjustments ledger is the operator-operation ledger, and reconcile is a
 * second operator operation, so it belongs here.
 *
 * THREE ADDITIVE COLUMNS (no table rebuild — this table holds live prod rows):
 *  - `operation` — discriminates the two operations. Defaults to `'set_ceiling'`
 *    so every existing row is correctly back-labelled with zero data movement.
 *  - `target_spent_cents` — the reconcile target (the transcript oracle, integer
 *    cents, >= 0). NULL for `set_ceiling` rows.
 *  - `expected_spent_cents` — the live enforcement spend the host read when it
 *    stamped the request (integer cents). It is the THIRD leg of the reconcile
 *    compare-and-set (epoch + ceiling + spend): the runner refuses the reconcile
 *    unless its live spend still equals this, so spend that accrued between the
 *    host's read and the runner's apply is never silently erased by the absolute
 *    set (the operator must re-read the transcript oracle and retry). NULL for
 *    `set_ceiling` rows, which apply against current spend by design.
 *
 * `target_ceiling_cents` is REUSED as-is for a reconcile row: it records the live
 * ceiling at submission, which a reconcile leaves UNCHANGED — so
 * `target_ceiling_cents == expected_ceiling_cents` on a reconcile row, a coherent
 * "ceiling untouched" statement that also keeps the existing NOT NULL + CHECK
 * (`BETWEEN 1 AND 100000`) satisfied without a rebuild. The host submit path
 * therefore requires a live ceiling in [1, $1000] for a reconcile, mirroring the
 * set-ceiling maximum; a session whose ceiling exceeds that is out of scope for
 * this control (none exist in practice — set-ceiling itself caps at $1000).
 *
 * The reconcile TARGET (spend) is carried only in `target_spent_cents`; the
 * receipt CAS (`recordCostCeilingAdjustmentResult`) validates it, not
 * `target_ceiling_cents`, for a reconcile row.
 */
export const migration943: Migration = {
  version: 943,
  name: 'cost-reconcile',
  async up(db) {
    await db.exec(
      `ALTER TABLE cost_ceiling_adjustments
         ADD COLUMN operation TEXT NOT NULL DEFAULT 'set_ceiling'
         CHECK (operation IN ('set_ceiling','reconcile'))`,
    );
    await db.exec(
      `ALTER TABLE cost_ceiling_adjustments
         ADD COLUMN target_spent_cents INTEGER
         CHECK (target_spent_cents IS NULL OR target_spent_cents BETWEEN 0 AND 100000000)`,
    );
    await db.exec(
      `ALTER TABLE cost_ceiling_adjustments
         ADD COLUMN expected_spent_cents INTEGER
         CHECK (expected_spent_cents IS NULL OR expected_spent_cents BETWEEN 0 AND 100000000)`,
    );
  },
};
