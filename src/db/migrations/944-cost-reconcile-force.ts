import type { Migration } from './index.js';

/**
 * `forced` — audit flag on `cost_ceiling_adjustments` (migration 942/943) recording
 * that a `cost_reconcile` (issue #1327) was applied with `--force`, overriding an
 * already-decided escalation card on its epoch.
 *
 * WHY. The normal `card_already_decided` fence (see `createCostCeilingAdjustment`)
 * refuses BOTH set-ceiling and reconcile on an epoch that already has a resolved
 * (`continued`/`stopped`) card — correct in general, but it deadlocks the exact
 * #1327 recovery case: a session a human `continue`d on the INFLATED spend is now
 * falsely cost-stopped and cannot be corrected — the epoch is card-locked, and it
 * cannot self-advance because it is stopped. `--force` relaxes ONLY that one fence
 * for a reconcile; every other guard stays (still lower-only, still the three-leg
 * epoch+ceiling+spend CAS, still idempotent, and the runner still PRESERVES an
 * explicit human `stop`). A forced reconcile is DOWNWARD only, so it is strictly
 * MORE permissive than the human's `continue` intent (they wanted more budget; the
 * real cost is less) — it removes phantom spend, never violates the decision.
 *
 * This column is the durable audit trail: `forced = 1` iff the reconcile actually
 * bypassed a decided card. Set-ceiling rows and non-forced reconciles are `0`.
 * ADDITIVE (DEFAULT 0) — no rebuild; this table holds live prod rows.
 */
export const migration944: Migration = {
  version: 944,
  name: 'cost-reconcile-force',
  async up(db) {
    await db.exec(
      `ALTER TABLE cost_ceiling_adjustments
         ADD COLUMN forced INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0, 1))`,
    );
  },
};
