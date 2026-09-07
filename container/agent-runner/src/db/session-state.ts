/**
 * Persistent key/value state owned by the registered mailbox.
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getAgentMailbox } from '../mailbox/index.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  return getAgentMailbox().operations.getState(key)?.value;
}

function setValue(key: string, value: string): void {
  getAgentMailbox().operations.setState(key, value);
}

function deleteValue(key: string): void {
  getAgentMailbox().operations.deleteState(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

/**
 * Milliseconds since this continuation was last written, or null if unset or
 * unparseable.
 *
 * `setContinuation` runs on every turn, so this measures IDLE time — how long
 * since the thread was last used — not how old the thread is. That is the
 * signal that matters for a provider whose history lives server-side: a thread
 * used daily is fine however old, while one untouched for weeks is the risk.
 */
export function getContinuationAgeMs(providerName: string): number | null {
  const row = getAgentMailbox().operations.getState(continuationKey(providerName));
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  return Number.isFinite(age) ? age : null;
}

/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in mailbox state because the MCP server runs as a separate stdio
 * subprocess; module state set by the poll loop is invisible to it.
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getAgentMailbox().operations.getState(IN_REPLY_TO_KEY);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}

/**
 * Live per-session cost-cap state (NanoClaw #1 — the LEAN cost cap).
 *
 * Written by the runner as cost accrues, READ by the dashboard's Sessions tab
 * (which opens outbound.db readonly and JSON.parses this single key). Kept as
 * ONE JSON row so the dashboard read is atomic and `session_state.updated_at`
 * gives the escalation freshness. The shape here is the SHARED CONTRACT — the
 * dashboard read side must match it field-for-field.
 *
 *  - status: 'ok'      spent < 0.8 * cap
 *            'warn'     0.8 * cap <= spent < cap
 *            'escalated' spent >= cap AND the one-shot escalation has fired
 *            'stopped'  a human 'stop' override was applied (never for immortal)
 *  - immortal groups (orchestrator / admin) never reach 'stopped'; their status
 *    caps at 'escalated' (visibility only).
 *
 * TWO-WINDOW MODEL (v2):
 *  - window 'lifetime' (non-immortal): spend accrues across turns AND container
 *    respawns; reset only on a new_session batch or /clear. Escalates once per run.
 *  - window 'daily' (immortal): spend accrues per UTC day; `dayKey` ("YYYY-MM-DD")
 *    rolls the counter and re-arms escalation on a new day. Escalates once per day.
 *    `dayKey` is present ONLY when window === 'daily'.
 */
export type CostCapStatus = 'ok' | 'warn' | 'escalated' | 'stopped';

export type CostCapWindow = 'lifetime' | 'daily';

export interface CostCapState {
  capUsd: number;
  spentUsd: number;
  status: CostCapStatus;
  immortal: boolean;
  window: CostCapWindow;
  /**
   * Live Tier-2 hard ceiling (base + any approved raises). Adopted on respawn
   * so an approved raise survives a container restart, mirroring capUsd.
   *
   * ALWAYS published, including `0` (disabled/unconfigured) — this is the
   * "set ceiling v2" contract (NanoClaw #1): the dashboard's live per-session
   * ceiling control needs to distinguish "no cost_cap row at all" (pre-cost-cap
   * runner, cost tracking off) from "cost tracking is on but no ceiling is
   * configured," and an omitted field can't tell those apart. Previously this
   * was omitted whenever `costCeilingUsd <= 0`; every reader of this field
   * already treats `undefined` and `0` identically (`> 0` / `<= 0` checks), so
   * this widening is behavior-preserving for existing readers.
   */
  ceilingUsd: number;
  /**
   * Set-ceiling control protocol version this runner build speaks, published on
   * EVERY cost_cap write (NanoClaw #1, "set ceiling v2"). This is the capability
   * signal the dashboard's live per-session ceiling control gates on: it reads
   * this field out of the cost_cap blob and only renders the +/-/Apply stepper
   * once it sees `>= 2` — an absent/`< 2` value renders "ceiling control: not yet
   * available (runner not upgraded)" instead (see dashboard `deriveControlVersion`
   * / `renderCostCeilingControl`). Kept in lockstep with the separate
   * `cost_control_protocol` readiness handshake's `version` (both stamp
   * `COST_CONTROL_PROTOCOL_VERSION`). Absent on pre-set-ceiling runners.
   */
  protocolVersion?: number;
  /** UTC day ("YYYY-MM-DD") the daily spend belongs to. Present only when window === 'daily'. */
  dayKey?: string;
  escalatedAt?: string;
  decision?: 'continue' | 'stop';
  decidedAt?: string;
  /**
   * Monotonic BUDGET GENERATION (cost-approval card). Rotated on every event that
   * changes the budget epoch — /clear, new_session, daily rollover, and each
   * Continue (re-arm). An escalation episode is stamped with the generation live
   * at escalation; a `cost_override` carries that generation as `epochKey`, and
   * the runner refuses one whose `epochKey` ≠ the current generation. Because a
   * Continue rotates the generation, a re-enqueued Continue (host crash + retry)
   * is auto-stale — this is the exactly-once GRANT fence, and it also refuses a
   * decision that arrives after a `/clear` reset (the one money-unsafe path v8
   * had). Absent on legacy/pre-card overrides (they apply as before).
   */
  budgetGen?: number;
  /** The current escalation episode's stable id (`esc-<sid>-<reason>-<gen>`), for
   *  host state-ingest. Present only while status is escalated/stopped. */
  episodeId?: string;
  /**
   * Cost-accounting schema generation (issue #1327).
   *
   * Absent / < 2 means `spentUsd` was accumulated by the pre-fix basis, which
   * summed the provider's end-of-turn usage once per `query()` call. That basis
   * double- to triple-counted (the stream emits one assistant message per
   * content block, each repeating the same message-level usage), measured
   * 1.7x–2.8x on real transcripts. Version 2 accumulates per assistant message,
   * deduplicated by wire message id, and additionally folds codex MCP-tool spend
   * from `codexLedger`.
   *
   * The pre-v2 figure is RETAINED rather than rescaled: the inflation factor is
   * per-session and unknowable, and silently lowering recorded spend is the
   * money-unsafe direction. It clears itself at the next window reset — a UTC
   * rollover for the immortal/daily window, a `/clear` or `new_session` batch for
   * the lifetime window.
   */
  accountingVersion?: number;
  /**
   * Absolute codex (MCP tool) spend already folded into `spentUsd`, for
   * observability and for the dashboard's `codexUsd` column. Derived from
   * `codexLedger`; never the enforcement source of truth.
   */
  codexUsd?: number;
  /**
   * Per-(rollout file, UTC day) codex USD already charged — the delta watermark
   * for `$CODEX_HOME/sessions/**` (see `codex-cost.ts`).
   *
   * Keyed per FILE, not as one global total, deliberately: a single absolute
   * high-water mark goes blind if the scanned total ever DROPS (a rotated or
   * deleted rollout), because subsequent real spend has to climb back past the
   * old mark before anything is charged. Per-file entries survive a deletion
   * (so a reappearing file cannot re-charge) while a NEW file starts at 0 and
   * charges from its first token.
   *
   * Keyed per DAY as well so the immortal daily window cannot be charged for
   * spend that happened on a previous UTC day — the runner deliberately
   * discards prior-day spend, and a late scan must not smuggle it into today.
   *
   * See `codexBaselinePending` for the one-time migration marker.
   */
  codexLedger?: Record<string, number>;
  /**
   * Permanent (codexEventKey -> owning rollout-file key) assignment. Ownership
   * by "whichever file sorts first among the files readable this scan" moves
   * when a file's readability flips — the true owner going unreadable lets a
   * later-sorted file claim and charge a call, then the true owner becoming
   * readable again re-claims it with no watermark of its own and charges it a
   * second time. Persisted (not just in-memory) so a container restart can't
   * reopen this window by forgetting who already owns what.
   */
  codexEventOwners?: Record<string, string>;
  /**
   * True while this session still owes a one-time codex BASELINE: its existing
   * rollout history is absorbed into `codexLedger` without being charged, so
   * deploying #1327 cannot retroactively bill a live session for spend it
   * already made (which would hard-stop much of the fleet on the deploy tick).
   *
   * An EXPLICIT flag rather than "is `codexLedger` absent?", because the two
   * diverge across a crash: initialization persists the cost row — and with it
   * an empty ledger — before the first fold runs, so a container that died in
   * that window would look already-baselined to its successor and charge the
   * whole history. The flag is written by the same persist and only cleared once
   * a COMPLETE scan has been absorbed. Absent on pre-#1327 rows, where the
   * ledger's absence is the correct fallback signal.
   */
  codexBaselinePending?: boolean;
  /**
   * #65 durable cost ledger (DUAL-RUN) — persisted so a respawn keeps the same
   * reconciliation identity. NOT enforcement state; the live counter above is
   * still the sole basis. See the module vars in `poll-loop.ts`.
   *
   * `ledgerGen`: the active WINDOW GENERATION stamped into every `cost_events`
   * row the reconcile sums. Rotated forward on `/clear`/`new_session` (where the
   * live counter resets to $0), so a reset starts a fresh, empty generation
   * instead of the lifetime reconcile summing every historical row forever.
   *
   * `ledgerAdjSeq`: monotonic sequence for synthetic ADJUSTMENT rows (the
   * counter's non-token-derivable fallback/residual charges and the migration
   * baseline). Persisted so a respawn never reuses an id — `INSERT OR IGNORE`
   * would silently drop a reused id and strand that charge's ledger row.
   *
   * `ledgerBaselinePending`: the current generation still owes a one-time LEDGER
   * baseline — the next codex fold stamps pre-existing rollout history OUT of the
   * generation (its dollars are already captured by a migration adjustment row).
   * Persisted so a crash between the baseline write and the first fold still
   * excludes that history on the successor.
   */
  ledgerGen?: number;
  ledgerAdjSeq?: number;
  ledgerBaselinePending?: boolean;
  /**
   * #65 durable ledger MIGRATION-BASELINE completion marker (schema version). Its
   * ABSENCE is the sole trigger for the one-time migration baseline in
   * `initCostTracking`; once set it is never re-run. Recorded atomically with the
   * seed row + rotated generation in a single outbound-DB transaction, so a crash
   * can neither double-seed (marker without seed) nor strand a permanent
   * `ledger < counter` (seed without marker). Absent on a pre-#65 row.
   */
  ledgerBaselineVersion?: number;
}

const COST_CAP_KEY = 'cost_cap';

export function getCostCap(): CostCapState | undefined {
  const raw = getValue(COST_CAP_KEY);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as CostCapState;
  } catch {
    return undefined;
  }
}

export function setCostCap(state: CostCapState): void {
  setValue(COST_CAP_KEY, JSON.stringify(state));
}

/**
 * Runner-instance readiness handshake (NanoClaw #1, "set ceiling v2"). Published
 * once at poll-loop startup, unconditionally (independent of whether cost
 * tracking itself is enabled for this session) — the host needs to know
 * definitively "this runner build understands the set-ceiling wire protocol"
 * before it ever writes a control message, closing a TOCTOU gap: a stale
 * live-state read from a PRIOR container instance of this same session must not
 * be able to target a NEW instance that happens to share the session id.
 *
 * `runnerInstanceId` is the random nonce the host generated for THIS spawn
 * (env `NANOCLAW_RUNNER_INSTANCE_ID`, see src/container-runner.ts) — the host
 * compares it against the nonce it recorded for the currently-active container
 * before accepting an adjustment, so a handshake left over from a prior spawn of
 * the same session (the container died and respawned between the host's read
 * and its check) is provably stale rather than silently accepted.
 */
export interface CostControlProtocolState {
  version: number;
  runnerInstanceId: string;
  readyAt: string;
  /**
   * Live-control operations this runner build can handle. `set_ceiling` (NanoClaw
   * #1) rides the `version` gate; `reconcile` (issue #1327) ships on the SAME
   * version 2, so it cannot be told apart by version alone — the host requires
   * this list to include `'reconcile'` before enqueueing one, so a set-ceiling-only
   * runner is refused rather than silently consuming-and-dropping the control
   * message (which would strand the host ledger row). Absent on a runner that
   * predates the capability list.
   */
  operations?: string[];
}

const COST_CONTROL_PROTOCOL_KEY = 'cost_control_protocol';

export function getCostControlProtocol(): CostControlProtocolState | undefined {
  const raw = getValue(COST_CONTROL_PROTOCOL_KEY);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as CostControlProtocolState;
  } catch {
    return undefined;
  }
}

export function setCostControlProtocol(state: CostControlProtocolState): void {
  setValue(COST_CONTROL_PROTOCOL_KEY, JSON.stringify(state));
}

/** The shape of the `cost_ceiling_adjustment_result` receipt row (outbound
 *  `kind:'system'`), the runner's confirmation of a set-ceiling control message.
 *  Field-for-field mirror of the host's expectations — see
 *  `src/modules/cost-ceiling-adjustment/index.ts` on the host side. */
export interface CostCeilingAdjustmentReceipt {
  action: 'cost_ceiling_adjustment_result';
  protocolVersion: 2;
  adjustmentId: string;
  sessionId: string;
  outcome: 'applied' | 'conflict' | 'rejected';
  expectedEpochKey: string;
  previousEpochKey?: string;
  resultEpochKey?: string;
  expectedCeilingCents: number;
  previousCeilingCents?: number;
  targetCeilingCents: number;
  resultCeilingCents?: number;
  spentUsd?: number;
  status?: string;
  reason?: string;
}

/**
 * Commit a cost-ceiling-adjustment outcome ATOMICALLY: the new `cost_cap` state
 * (only for `outcome:'applied'`, which is the only outcome that mutates live
 * state), the receipt row the host reads back, and the inbound control
 * message's `processing_ack` → 'completed' transition — ALL IN ONE outbound-DB
 * transaction, all-or-nothing.
 *
 * This is the money-safety boundary for the whole feature: if the state upsert
 * landed but the receipt didn't, the host would never learn the ceiling changed
 * and might apply a second, redundant/conflicting adjustment. If the receipt
 * landed but the processing_ack didn't, a restart would re-process the SAME
 * inbound control message and could double-apply it. Committing all three
 * together means a crash mid-write leaves ALL THREE absent — the inbound
 * message stays (or reverts to, after `clearStaleProcessingAcks()`) unclaimed,
 * so the exact same apply-or-reject logic runs again on the next attempt
 * against then-current live state, rather than silently dropping the request
 * or double-applying a partial write.
 *
 * Deliberately does NOT catch/swallow: on a thrown error the caller (poll-loop's
 * set-ceiling handler) must NOT mark the inbound message complete by any other
 * path — let it propagate so the message is retried/recovered on restart.
 *
 * IMPLEMENTATION NOTE: the atomicity requirement is why this is ONE
 * `commitCostCeilingAdjustment` mailbox operation rather than three composed
 * calls (`setState` + `writeMessageOut` + `markMessages`). `MailboxOperations`
 * has no cross-operation transaction primitive — deliberately, since a
 * non-SQLite backend might not have one — so the all-or-nothing boundary has to
 * live inside the driver, where the odd-seq computation already does.
 */
export function commitCostCeilingAdjustmentOutcome(params: {
  inboundMessageId: string;
  receipt: CostCeilingAdjustmentReceipt;
  /** Present only for `outcome:'applied'` — conflict/rejected mutate no live state. */
  newCostCap?: CostCapState;
}): void {
  // One mailbox op, not three: cap + receipt + ack must land atomically, and the
  // driver owns the transaction boundary and the odd-seq computation so a caller
  // cannot nest one incorrectly. Direct SQLite here would also violate the
  // SQL-containment ratchet in mailbox/registry.test.ts.
  getAgentMailbox().operations.commitCostCeilingAdjustment({
    inboundMessageId: params.inboundMessageId,
    receiptId: `cost-ceiling-adjustment-result:${params.receipt.adjustmentId}`,
    receiptContent: JSON.stringify(params.receipt),
    ...(params.newCostCap ? { costCapKey: COST_CAP_KEY, costCapValue: JSON.stringify(params.newCostCap) } : {}),
  });
}

/** The shape of the `cost_reconcile_result` receipt row (outbound `kind:'system'`),
 *  the runner's confirmation of a `cost_reconcile` control message (issue #1327 —
 *  set live enforcement spend to the transcript oracle). Field-for-field mirror of
 *  the host's expectations — see `ingestCostReconcileReceipt` in
 *  `src/modules/cost-ceiling-adjustment/index.ts`. */
export interface CostReconcileReceipt {
  action: 'cost_reconcile_result';
  protocolVersion: 2;
  adjustmentId: string;
  sessionId: string;
  outcome: 'applied' | 'conflict' | 'rejected';
  expectedEpochKey: string;
  previousEpochKey?: string;
  resultEpochKey?: string;
  /** The live ceiling at submission — UNCHANGED by a reconcile. Echoed as both
   *  `expectedCeilingCents` (the CAS basis) and `resultCeilingCents`. */
  expectedCeilingCents: number;
  resultCeilingCents?: number;
  /** The spend the host expected (CAS third leg); echoed for observability. */
  expectedSpentCents?: number;
  /** The reconcile target (integer cents) — the field the host CAS validates. */
  targetSpentCents: number;
  previousSpentCents?: number;
  resultSpentCents?: number;
  /** Result spend in USD (== resultSpentCents/100), for parity with the
   *  set-ceiling receipt's `spentUsd` and the ledger's `result_spent_usd`. */
  spentUsd?: number;
  status?: string;
  reason?: string;
  /** Echoed from the control message (issue #1327): this reconcile was `--force`d
   *  past an already-decided card. Audit only — the runner applies no card logic. */
  forced?: boolean;
}

/**
 * Commit a `cost_reconcile` outcome ATOMICALLY — identical money-safety boundary
 * to `commitCostCeilingAdjustmentOutcome` (cap state on `applied` only + receipt +
 * inbound `processing_ack` → 'completed', all-or-nothing in one outbound-DB
 * transaction). Reuses the SAME generic mailbox operation; only the receipt id
 * namespace (`cost-reconcile-result:`) and content differ. Deliberately does NOT
 * catch/swallow — a thrown error must leave the inbound message unclaimed so it is
 * retried/recovered rather than silently dropped or double-applied.
 */
export function commitCostReconcileOutcome(params: {
  inboundMessageId: string;
  receipt: CostReconcileReceipt;
  /** Present only for `outcome:'applied'`. */
  newCostCap?: CostCapState;
}): void {
  getAgentMailbox().operations.commitCostCeilingAdjustment({
    inboundMessageId: params.inboundMessageId,
    receiptId: `cost-reconcile-result:${params.receipt.adjustmentId}`,
    receiptContent: JSON.stringify(params.receipt),
    ...(params.newCostCap ? { costCapKey: COST_CAP_KEY, costCapValue: JSON.stringify(params.newCostCap) } : {}),
  });
}
