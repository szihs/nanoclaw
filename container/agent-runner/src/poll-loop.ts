import fs from 'fs';
import path from 'path';

import {
  buildSystemPromptAddendum,
  findByName,
  getAllDestinations,
  getDestinationsFingerprint,
  type DestinationEntry,
} from './destinations.js';
import { appendMemorySection } from './memory/context.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  markBounced,
  markFailed,
  markScriptSkipped,
  getMessageInBySeq,
  type MessageInRow,
} from './db/messages-in.js';
import { classifyTurnError } from './transient-error.js';
import { getUndeliveredMessages, hasIdenticalSend, outboundWatermark, writeMessageOut } from './db/messages-out.js';
import { clearStaleProcessingAcks } from './db/container-state.js';
import { touchHeartbeat } from './heartbeat.js';
import { getAgentMailbox } from './mailbox/index.js';
import {
  clearContinuation,
  getContinuationAgeMs,
  clearCurrentInReplyTo,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentInReplyTo,
  getCostCap,
  setCostCap,
  setCostControlProtocol,
  commitCostCeilingAdjustmentOutcome,
  commitCostReconcileOutcome,
  type CostCapState,
  type CostCapStatus,
  type CostCapWindow,
  type CostCeilingAdjustmentReceipt,
  type CostReconcileReceipt,
} from './db/session-state.js';
import { getConfig } from './config.js';
import { priceUsage } from './pricing.js';
import { MISSING_DAY_KEY, ledgerKey, scanCodexRollouts } from './codex-cost.js';
// #65 durable cost ledger — DUAL-RUN (additive; writes cost_events alongside the
// live counter, changes no enforcement).
import { createCostEventsTable, recordCostEvent, sumWindow } from './cost-events.js';
import { claudeMessageToEvent, codexCallToEvent } from './cost-events-integration.js';
import { RATE_TABLE, RATE_VERSION } from './cost-rate-table.js';
import { getOutboundDb } from './mailbox/sqlite/connection.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  isSessionEcho,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { appendExchange } from './conversations.js';
import { classifyAndPrepend } from './intent-router-bridge.js';
import { stripHarnessTagArtifacts } from './harness-tag-strip.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
// End stream after this many ms with no SDK events.
// Set NANOCLAW_IDLE_END_MS in the container env to override per-agent-group.
const IDLE_END_MS = process.env.NANOCLAW_IDLE_END_MS
  ? Math.max(60_000, parseInt(process.env.NANOCLAW_IDLE_END_MS, 10))
  : 1_200_000;

/**
 * Number of consecutive driver-classified read failures after which the
 * follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const MAILBOX_FAILURE_STREAK_EXIT = 10;

// ── Per-session cost cap (NanoClaw #1, v2 two-window) ─────────────────────────
//
// Live per-session cost accounting + a soft escalation when spend crosses the
// cap. TWO WINDOWS, chosen by immortality:
//
//   - NON-IMMORTAL → 'lifetime': spend accrues across turns AND container
//     respawns; reset only on a new_session batch or /clear. Escalates once per
//     run (a new_session re-arms it).
//   - IMMORTAL (orchestrator/admin) → 'daily': spend accrues per UTC day; a new
//     day resets the counter and re-arms escalation. Immortal groups escalate
//     for visibility only and are NEVER quiesced — the DM itself is the bound.
//
// State is persisted to outbound.db `session_state` under the single `cost_cap`
// JSON key (the shared contract the dashboard reads) so spend survives respawns.
//
// Enabled for the Claude AND codex providers (#1333). Claude spend accrues from
// its 'usage' events at the turn boundary; codex never emits 'usage', so its
// spend accrues from foldCodexCost reading the rollout files — folded at the
// poll boundary AND settled again at each `result` (codex's turn boundary) so
// the ceiling hard-stop is turn-granular, not merely poll-granular. A provider
// that does neither accrues nothing and would paint a false-green $0, so the cap
// stays disabled for it (no row → the dashboard shows "—").
//
// Module-level because the accounting happens inside `processQuery`'s event
// loop (a free function) while init/override live in `runPollLoop`; one
// container == one session, so a singleton is correct.
const WARN_FRACTION = 0.8;

let costEnabled = false;
let costImmortal = false;
// 'lifetime' for non-immortal, 'daily' for immortal.
let costWindow: CostCapWindow = 'lifetime';
// UTC day ("YYYY-MM-DD") the daily spend belongs to. Only meaningful for the
// daily window; undefined for lifetime.
let costDayKey: string | undefined;
// One "allotment" — the base cap and the amount a 'continue' override adds.
let costAllotmentUsd = 0;
// Effective cap: allotment plus any raises from 'continue' overrides.
let costCapUsd = 0;
let costSpentUsd = 0;
let costEscalatedAt: string | undefined;
let costDecision: 'continue' | 'stop' | undefined;
let costDecidedAt: string | undefined;
// Quiesce marker: a 'stop' override was applied — take no NEW work. Never set
// for immortal groups.
let costStopRequested = false;
// Tier-2 hard ceiling (USD; 0 = disabled). A NON-immortal session that reaches
// it hard-stops (quiesce, no more work); an immortal one is never blocked — the
// ceiling only re-escalates for visibility. This is the LIVE ceiling — the base
// value plus any raises from an approved ceiling-continue (mirrors costCapUsd).
let costCeilingUsd = 0;
// The base ceiling from config — the fixed amount each ceiling-continue adds.
// Set once in initCostTracking; never mutated (mirrors costAllotmentUsd).
let costCeilingAllotmentUsd = 0;
// One-shot dedup for the immortal ceiling re-escalation (in-memory: a respawn
// re-alerting a still-over-ceiling immortal session is acceptable and rare).
let costCeilingEscalated = false;
// Set true when a non-immortal session crosses the ceiling mid-turn. The event
// loop reads it right after recordTurnCost and ends the IN-FLIGHT stream, so the
// hard stop is "no more tokens" (not merely "no new messages next poll"). Reset
// only on a genuine session reset (resetCostForNewSession) — a 'continue' cannot
// clear it, mirroring the absolute ceiling.
let costCeilingHardStop = false;

// Monotonic BUDGET GENERATION — the exactly-once GRANT fence for the cost-approval
// card. Rotated on EVERY event that changes the budget epoch: /clear or new_session
// (resetCostForNewSession), a daily rollover (recordTurnCost / respawn across a UTC
// day), and each applied Continue (re-arm). An escalation stamps its episode with the
// gen live at escalation; a cost_override carries that gen as `epochKey`, and
// applyCostOverride REFUSES one whose epochKey ≠ the current gen. Because applying a
// Continue rotates the gen, a re-enqueued Continue (host crash + retry) is auto-stale,
// and a decision that lands after a /clear reset is refused — the one money-unsafe
// path v8 had. Loaded from the persisted cost_cap so it survives respawn (never resets
// backward). Legacy/pill overrides without epochKey apply unconditionally (back-compat).
let costBudgetGen = 0;
// The current escalation episode's stable id (`esc-<sid>-<reason>-<gen>`). Set when an
// escalation fires, persisted into cost_cap so the host can ingest the episode from
// durable state (read-only), cleared on reset/rollover/applied-Continue.
let costEpisodeId: string | undefined;

// One-shot cost-sensitivity note queued by a ceiling-continue, consumed as a
// <system> prefix on the NEXT real turn's prompt (not injected immediately —
// cost_override rows are never fed to the agent, so this rides the following
// genuine message instead). Cleared on consumption and on a fresh session.
let pendingCostNudge: string | undefined;

// --- Per-message Claude accounting (issue #1327) -----------------------------
//
// Wire message ids already charged. The provider emits ONE assistant message per
// content block and every block of an API response repeats the same id and the
// same message-level usage, so without this set the same response is charged
// two to three times (measured 1.7x–2.8x on real prod transcripts).
//
// In-memory and EXACT — no eviction. An LRU would re-charge an evicted id, and
// under-enforcement by memory is not a trade worth making at this scale
// (~850 ids for a 17MB, week-long transcript). It is not persisted because a
// resumed stream does not re-emit historical assistant messages: `SDKMessage`
// has a replay variant for USER messages (`SDKUserMessageReplay`) and none for
// assistant ones, and the observed inflation on a 48-resume session was ~2.1x —
// the block-duplication factor — not the ~24x whole-history replay would give.
// Cleared only when the spend window itself resets.
const seenMessageIds = new Set<string>();
// Per-turn accounting state, reset at every aggregate `usage` event. Explicit
// counters rather than "did we charge anything": `recordTurnCost` has to tell a
// provider that emits no per-message usage from one whose messages were all
// priced from one whose messages were partly unpriceable, and a single number
// conflates all three.
let turnSawMessageUsage = false;
let turnMessageCostUsd = 0;
let turnUnpricedCount = 0;
let turnMissingIdCount = 0;
// A genuine assistant message arrived with no `usage` at all (not just no id).
// Forces the end-of-turn aggregate fallback so its spend is settled, not
// silently dropped when it is mixed with usage-bearing messages (issue #1327).
let turnNoUsageCount = 0;

/** Record that an assistant message carried no per-message usage. */
function noteMessageMissingUsage(): void {
  if (!costEnabled) return;
  turnNoUsageCount++;
}

/**
 * Clear the per-turn accounting counters. Called from THREE places, not one:
 * `recordTurnCost` (the happy path — a turn that reached its aggregate
 * `usage` event), `resetCostForNewSession` (an explicit /clear or
 * new_session), and defensively right before a new `query()` is built. The
 * third call site is load-bearing: a turn that throws or gets aborted
 * mid-stream after at least one `recordMessageCost()` call never reaches
 * `recordTurnCost`, so without it the next turn would inherit a dead turn's
 * partial state and mis-settle its own fallback. This state is also
 * persisted/restored (see CostCapState), so an unreset leak survives a
 * container restart too.
 */
function resetTurnAccountingState(): void {
  turnSawMessageUsage = false;
  turnMessageCostUsd = 0;
  turnUnpricedCount = 0;
  turnMissingIdCount = 0;
  turnNoUsageCount = 0;
}

// --- Codex MCP-tool accounting (issue #1327) --------------------------------
//
// "<rollout file> <UTC day>" → USD already charged. See CostCapState.codexLedger
// for why the ledger is per-file and per-day rather than one absolute total.
let codexLedger: Record<string, number> = {};
// Permanent (codexEventKey -> owning rollout file key) assignment, held for
// the container's lifetime AND persisted (see persistCostCap/initCostTracking)
// so a restart can't reopen the window by forgetting who already owns what.
// Without this, ownership is implicitly "whichever file sorts first among the
// files readable THIS scan" — which moves when a file's readability flips, and
// a moved-to file has no ledger watermark, so the same call gets charged again
// under its new owner. See codex-cost.ts priceCodexFiles for the full mechanism.
let codexEventOwners = new Map<string, string>();
// Absolute codex spend folded into costSpentUsd (observability / dashboard).
let codexUsdCharged = 0;
// True until the first fold when the session had NO persisted ledger — that fold
// absorbs existing rollout history without charging (see foldCodexCost).
let codexLedgerBaselinePending = false;
let codexScanFailures = 0;
// One-shot dedup for the unknown-codex-model warning (in-memory: re-reporting
// after a respawn is fine and rare).
const codexUnpricedReported = new Set<string>();

// --- #65 durable cost ledger (DUAL-RUN) state ------------------------------
//
// ADDITIVE and best-effort: these drive ONLY the `cost_events` write path and the
// turn-boundary reconcile log — enforcement still runs entirely off the live
// counter above. See db/session-state.ts CostCapState for the persisted contract.
//
// The active WINDOW GENERATION stamped into every row the reconcile sums. The
// lifetime reconcile has no ts selectivity (it spans all dates), so WITHOUT a gen
// the sum would include every historical row while `costSpentUsd` reflects only
// the post-reset window — `ledger=$X counter=$0` forever after a `/clear`.
// Rotated forward wherever the live counter's lifetime window resets to $0
// (resetCostForNewSession). Restored from the persisted row so a respawn keeps
// the same live gen.
let ledgerGen = 0;
// Monotonic id sequence for synthetic ADJUSTMENT rows (the counter's
// non-token-derivable residual/aggregate fallback charges + the migration
// baseline). Persisted so a respawn never reuses an id (INSERT OR IGNORE would
// silently drop it and strand that charge's ledger row).
let ledgerAdjSeq = 0;
// The current gen still owes a one-time LEDGER baseline: the next codex fold
// stamps pre-existing rollout history at LEDGER_BASELINE_GEN so the current-gen
// reconcile is not inflated by rows whose dollars are already captured by a
// migration adjustment. Set at migration; the `/clear` path is already covered by
// the enforcement `codexLedgerBaselinePending`. Persisted so a crash before the
// first fold still excludes that history.
let ledgerBaselinePending = false;
// Persisted MIGRATION-BASELINE completion marker (schema version). Its ABSENCE on
// init is the ONLY trigger for the one-time migration baseline; presence means
// "already baselined for this schema version" and is never re-run. This replaces
// inferring completion from a row COUNT — a count is neither durable nor atomic
// (a partial current-gen row would wrongly suppress the baseline, and the seed
// insert + state writes could tear across a crash into a double-count). Undefined
// on a pre-#65 row.
let ledgerBaselineVersion: number | undefined;
// Sentinel generation for pre-existing/baselined codex rows: never equals a live
// `ledgerGen` (which starts at 0 and only increments), so a `window_gen = $gen`
// reconcile permanently excludes them, while the rows are still durably captured
// (first-write-wins on the id keeps them out of every later real gen too).
const LEDGER_BASELINE_GEN = -1;
// The migration-baseline schema version stamped by `performLedgerMigrationBaseline`.
// Bump only if the migration itself changes shape (it never re-runs for a version
// already recorded).
const LEDGER_BASELINE_VERSION = 1;

/**
 * Cost-accounting schema generation stamped into the persisted state. Bumped by
 * #1327: v1 summed the provider's end-of-turn aggregate once per query() call
 * (block-duplicated, 1.7x–2.8x over), v2 sums per assistant message deduped by
 * wire id and folds codex tool spend.
 */
const COST_ACCOUNTING_VERSION = 2;

/**
 * Set-ceiling control wire-protocol version this runner build speaks (NanoClaw
 * #1, "set ceiling v2"). Stamped into BOTH the `cost_control_protocol` readiness
 * handshake (`version`) and every persisted `cost_cap` blob (`protocolVersion`),
 * so the two never drift. The dashboard's ceiling control gates on the cost_cap
 * copy: it renders the live stepper only once it reads `>= 2`, otherwise it shows
 * "ceiling control: not yet available (runner not upgraded)".
 */
const COST_CONTROL_PROTOCOL_VERSION = 2;

/**
 * Live-control operations this runner build can apply, published in the readiness
 * handshake so the host can gate each one (NanoClaw #1 set-ceiling + issue #1327
 * reconcile). Reconcile rides the same protocol version 2 as set-ceiling, so the
 * host cannot infer it from `version` alone — a runner that predates reconcile
 * advertises no list, and the host refuses to enqueue a reconcile to it (fail
 * loud, never strand). Keep in sync with the operations `applyCostOverride`
 * dispatches.
 */
const RUNNER_COST_CONTROL_OPERATIONS: string[] = ['set_ceiling', 'reconcile'];

/** Current UTC day as "YYYY-MM-DD" — the daily-window bucket key. */
function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Publish the runner-instance readiness handshake (NanoClaw #1, "set ceiling
 * v2"): `{version, runnerInstanceId, readyAt}` under `session_state.
 * cost_control_protocol`. Called once at loop startup, UNCONDITIONALLY —
 * independent of `costEnabled` (which requires a Claude provider AND a
 * configured cap). The host's readiness check needs to know "this runner build
 * understands the set-ceiling wire protocol" before it ever writes a control
 * message; whether cost tracking happens to be configured for this particular
 * session is a separate question the host answers earlier in its own
 * validation (a session with no live ceiling is rejected there regardless of
 * what this handshake says).
 *
 * `runnerInstanceId` comes from `NANOCLAW_RUNNER_INSTANCE_ID`, the random nonce
 * `src/container-runner.ts` generates fresh for every container spawn. Its
 * whole purpose is to let the host distinguish THIS instance's handshake from
 * one a prior instance of the same session id left behind — without a nonce
 * there is nothing to compare against, so an empty/missing env var is treated
 * as "nothing to publish" rather than publishing a handshake no host check
 * could ever safely match.
 */
function publishRunnerReadiness(): void {
  const runnerInstanceId = process.env.NANOCLAW_RUNNER_INSTANCE_ID || '';
  if (!runnerInstanceId) return;
  setCostControlProtocol({
    version: COST_CONTROL_PROTOCOL_VERSION,
    runnerInstanceId,
    readyAt: new Date().toISOString(),
    // Capability list the host gates live-control operations on. `reconcile`
    // (issue #1327) ships on the SAME version as `set_ceiling`, so the host
    // cannot infer it from the version number — it must be advertised explicitly
    // or the host refuses to enqueue a reconcile to this runner.
    operations: RUNNER_COST_CONTROL_OPERATIONS,
  });
}

/**
 * Load persisted cost state once at loop start so accrued spend (and any raised
 * cap / stop decision) survives a container respawn. Immortality comes from the
 * authoritative host-materialized config field, not the persisted row.
 *
 * Cost tracking is enabled only for a provider with a real accounting source:
 * Claude prices its per-message/`usage` events (plus codex rollout folding), and
 * native codex prices via rollout folding at the poll AND `result` boundaries.
 * A provider with neither leaves costEnabled false so no cost_cap row is written
 * — the dashboard renders "—" rather than a false $0.
 *
 * Window handling:
 *  - lifetime (non-immortal): adopt persisted spend/escalation as-is.
 *  - daily (immortal): adopt persisted spend/escalation ONLY if the persisted
 *    dayKey is today's UTC day; a stale day starts fresh at 0.
 */
function initCostTracking(providerName: string): void {
  // getConfig() throws if loadConfig() was never called — the case in poll-loop
  // integration tests that exercise the loop without scaffolding container.json.
  // Cost accounting is simply off there; production always loads config first.
  let cfg: ReturnType<typeof getConfig>;
  try {
    cfg = getConfig();
  } catch {
    costEnabled = false;
    return;
  }
  costAllotmentUsd = cfg.costCapT2Usd && cfg.costCapT2Usd > 0 ? cfg.costCapT2Usd : 0;
  costCeilingAllotmentUsd = cfg.costCeilingT2Usd && cfg.costCeilingT2Usd > 0 ? cfg.costCeilingT2Usd : 0;
  costImmortal = cfg.immortal === true;
  costWindow = costImmortal ? 'daily' : 'lifetime';
  // Meter both Claude (usage events + codex fold) AND native codex (fold only —
  // the codex provider emits no usage event, so its spend accrues from
  // `foldCodexCost()` at the poll boundary AND at each `result` (codex's turn
  // boundary), where the ceiling hard-stop then ends the stream; the
  // costStopRequested gate keeps subsequent polls quiesced — the honest
  // turn-granular bound). #1333: a codex-primary group previously had NO cap at
  // all. Still gated on a configured cap (`costAllotmentUsd > 0`), so a
  // codex-primary group WITHOUT a cap stays unmetered exactly as before — this
  // only turns enforcement on where a cap is actually set.
  costEnabled = costAllotmentUsd > 0 && (providerName === 'claude' || providerName === 'codex');
  if (!costEnabled) return;

  // #65 dual-run: create the durable ledger table once per session. Best-effort.
  try {
    createCostEventsTable(getOutboundDb());
  } catch {
    /* best-effort — a table-create failure must not block cost tracking */
  }

  const persisted = getCostCap();
  // Budget generation is MONOTONIC across the session lifetime — adopt the persisted
  // value so a respawn keeps the same live gen (a mid-session respawn must NOT re-arm
  // a pending grant). Rotations only ever move it forward (below + on reset/rollover).
  costBudgetGen = persisted?.budgetGen ?? 0;

  if (costWindow === 'daily') {
    costDayKey = utcDayKey();
    const persistedIsToday = persisted?.dayKey === costDayKey;
    // A respawn that crosses a UTC day is a daily rollover — rotate the gen so a
    // yesterday-daily decision that arrives now is refused (mirrors the in-loop
    // rollover in recordTurnCost). Guard on `persisted` so a brand-new session
    // (no prior row) starts at gen 0 rather than spuriously rotating to 1.
    if (!persistedIsToday && persisted) costBudgetGen++;
    // A fresh UTC day starts back at the p90/day allotment so the daily bound
    // holds day-over-day; only a same-day respawn adopts the persisted (possibly
    // 'continue'-raised) cap, spend, and escalation.
    costCapUsd = persistedIsToday && persisted?.capUsd && persisted.capUsd > 0 ? persisted.capUsd : costAllotmentUsd;
    costCeilingUsd =
      persistedIsToday && persisted?.ceilingUsd && persisted.ceilingUsd > 0
        ? persisted.ceilingUsd
        : costCeilingAllotmentUsd;
    costSpentUsd = persistedIsToday && persisted?.spentUsd && persisted.spentUsd > 0 ? persisted.spentUsd : 0;
    costEscalatedAt = persistedIsToday ? persisted?.escalatedAt : undefined;
    costEpisodeId = persistedIsToday ? persisted?.episodeId : undefined;
  } else {
    costCapUsd = persisted?.capUsd && persisted.capUsd > 0 ? persisted.capUsd : costAllotmentUsd;
    costCeilingUsd = persisted?.ceilingUsd && persisted.ceilingUsd > 0 ? persisted.ceilingUsd : costCeilingAllotmentUsd;
    costDayKey = undefined;
    costSpentUsd = persisted?.spentUsd && persisted.spentUsd > 0 ? persisted.spentUsd : 0;
    costEscalatedAt = persisted?.escalatedAt;
    costEpisodeId = persisted?.episodeId;
  }
  // Codex ledger (issue #1327). The baseline marker is an EXPLICIT persisted
  // flag so it survives a crash between this persist and the first fold; the
  // ledger's absence is only the fallback for rows written before #1327. With no
  // persisted row, a Claude-primary session owes no baseline (it has no rollout
  // files); a native-codex session baselines its existing rollout history before
  // charging new deltas — see the branch below.
  codexLedger = persisted?.codexLedger ? { ...persisted.codexLedger } : {};
  codexEventOwners = persisted?.codexEventOwners ? new Map(Object.entries(persisted.codexEventOwners)) : new Map();
  codexLedgerBaselinePending = persisted
    ? (persisted.codexBaselinePending ?? persisted.codexLedger === undefined)
    : // No persisted cost row = first time under cost tracking. A Claude-primary
      // session starts with no rollout files, so it owes no baseline. But a
      // NATIVE-CODEX session (#1333) being metered for the first time has ALREADY
      // accumulated rollout history while it ran uncapped — it MUST baseline that
      // history (absorb without charging) or the first fold would retroactively
      // bill it and hard-stop it on the deploy tick. A brand-new codex session
      // has no rollouts, so it baselines $0 (harmless).
      providerName === 'codex';
  codexUsdCharged = persisted?.codexUsd && persisted.codexUsd > 0 ? persisted.codexUsd : 0;
  // #65 durable ledger (dual-run) — restore the reconciliation identity alongside
  // the codex ledger so a respawn keeps the same generation, adjustment sequence,
  // and pending ledger baseline. A pre-#65 row has none of these → 0/0/false.
  ledgerGen = persisted?.ledgerGen ?? 0;
  ledgerAdjSeq = persisted?.ledgerAdjSeq ?? 0;
  ledgerBaselinePending = persisted?.ledgerBaselinePending ?? false;
  ledgerBaselineVersion = persisted?.ledgerBaselineVersion;
  if (costWindow === 'daily' && !(persisted?.dayKey === costDayKey)) {
    // A stale day's spend is discarded, so the codex figure attributed to it is
    // too — the ledger keeps the per-day watermarks, this is only the display total.
    codexUsdCharged = 0;
  }
  if (persisted && (persisted.accountingVersion ?? 1) < COST_ACCOUNTING_VERSION) {
    log(
      `Cost accounting upgraded to v${COST_ACCOUNTING_VERSION} (issue #1327). The persisted ` +
        `spend of $${costSpentUsd.toFixed(2)} was accumulated by the pre-fix basis, which counted each ` +
        `API response once per content block (measured 1.7x-2.8x over). It is RETAINED, not rescaled — ` +
        `the factor is per-session and unknowable, and lowering recorded spend is the unsafe direction. ` +
        `It clears at the next window reset (UTC rollover for daily, /clear or new_session for lifetime).`,
    );
  }

  costDecision = persisted?.decision;
  costDecidedAt = persisted?.decidedAt;
  costStopRequested = persisted?.status === 'stopped' && !costImmortal;
  // A ceiling that was newly enabled or lowered after this session already
  // accrued past it won't be reflected in the persisted STATUS (that row was
  // written before the ceiling existed / at the old threshold). Deriving the
  // quiesce marker from status alone would hand such a session one free turn on
  // respawn. Also key it off spend-vs-ceiling so an over-ceiling non-immortal
  // session loads already-stopped. Immortal is never hard-stopped.
  if (!costImmortal && costCeilingUsd > 0 && costSpentUsd >= costCeilingUsd) {
    costStopRequested = true;
  }

  // #65 dual-run MIGRATION BASELINE — runs exactly ONCE per session, gated by the
  // ABSENCE of the persisted version marker (never by a row count). An existing
  // session carries persisted spend while the durable ledger is empty, so the
  // lifetime reconcile would read `ledger=$0 counter=$10` forever; the baseline
  // seeds one adjustment = the persisted spend so the active gen starts equal.
  if (persisted?.ledgerBaselineVersion === undefined) performLedgerMigrationBaseline();

  // Publish immediately so the dashboard shows a cap even before the first turn
  // (and so a flipped immortal flag / window is reflected).
  persistCostCap();
}

/**
 * The one-time #65 ledger migration baseline (finding-1 durability fix). Gated by
 * the ABSENCE of the persisted `ledgerBaselineVersion`; `initCostTracking` calls
 * it at most once per session.
 *
 * Everything commits in a SINGLE outbound-DB transaction so a crash can never
 * leave a half-migration (a seed row without its marker → a second respawn would
 * seed AGAIN and double-count; or a marker without its seed → a permanent
 * `ledger < counter`). On any error the transaction rolls back the DB and we
 * restore the in-memory state to its pre-call snapshot, so the marker stays unset
 * and a later respawn retries cleanly.
 *
 * It ROTATES to a fresh generation first, so the seed lands in a provably-empty
 * gen — a stray/partial row in the old gen (which a COUNT-based guard would have
 * mis-read as "already seeded") cannot contaminate it. It arms `ledgerBaselinePending`
 * so the first codex fold stamps pre-existing rollout history OUT of this gen (its
 * dollars are already inside the single adjustment; re-counting the repriced tokens
 * would double it). Best-effort: a failure just leaves the pre-existing `ledger=$0`
 * delta, which the reconcile log surfaces.
 */
function performLedgerMigrationBaseline(): void {
  const snapshot = { ledgerGen, ledgerAdjSeq, ledgerBaselinePending, ledgerBaselineVersion };
  try {
    const db = getOutboundDb();
    db.transaction(() => {
      // Fresh, provably-empty generation for the seed (isolates it from any stray
      // row a partial prior write may have left in the old gen).
      ledgerGen++;
      ledgerBaselineVersion = LEDGER_BASELINE_VERSION;
      // The first codex fold sentinels pre-existing rollout history out of this gen.
      ledgerBaselinePending = true;
      if (costSpentUsd > 0) {
        const seq = ++ledgerAdjSeq;
        recordCostEvent(
          db,
          {
            id: `adj:${process.env.NANOCLAW_SESSION_ID || ''}:base:${seq}`,
            ts: ledgerNow(),
            provider: 'claude',
            model: getConfig().model || '',
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            adjustmentUsd: costSpentUsd,
          },
          RATE_VERSION,
          RATE_TABLE,
          ledgerNow(),
          ledgerGen,
        );
      }
      // Persist the seed + rotated gen + advanced seq + pending flag + marker
      // together, inside the same transaction (persistCostCap writes session_state
      // on this same outbound.db handle) — the atomic completion record.
      persistCostCap();
    })();
  } catch {
    // Roll back the in-memory state to match the rolled-back DB so the marker stays
    // unset and a later respawn retries the whole migration cleanly.
    ledgerGen = snapshot.ledgerGen;
    ledgerAdjSeq = snapshot.ledgerAdjSeq;
    ledgerBaselinePending = snapshot.ledgerBaselinePending;
    ledgerBaselineVersion = snapshot.ledgerBaselineVersion;
  }
}

/**
 * Reset the LIFETIME window to a fresh allotment — called when a non-immortal
 * session genuinely starts over (a new_session task batch or an explicit
 * /clear). No-op for the immortal daily window (that rolls on the UTC day, not
 * on session boundaries) and when the cap is disabled.
 */
function resetCostForNewSession(): void {
  if (!costEnabled || costWindow !== 'lifetime') return;
  costSpentUsd = 0;
  // A fresh window must not re-charge spend the old one already paid for.
  // Per-message ids: the new conversation gets new ids, so the set is only
  // holding memory — drop it. Codex: re-baseline on the next fold so the
  // rollout files that exist right now are absorbed, not billed again.
  seenMessageIds.clear();
  resetTurnAccountingState();
  codexLedgerBaselinePending = true;
  codexUsdCharged = 0;
  costCapUsd = costAllotmentUsd;
  costCeilingUsd = costCeilingAllotmentUsd;
  costEscalatedAt = undefined;
  costStopRequested = false;
  costCeilingEscalated = false;
  costCeilingHardStop = false;
  costDecision = undefined;
  costDecidedAt = undefined;
  // A fresh window makes any queued cost nudge moot — the session is starting
  // over below both thresholds, not resuming from a ceiling raise.
  pendingCostNudge = undefined;
  // /clear or new_session is a budget-epoch change: rotate the gen so a decision
  // stamped for the pre-clear escalation is refused, and drop the resolved episode.
  costBudgetGen++;
  costEpisodeId = undefined;
  // #65 dual-run: the live counter just reset to $0, so rotate the LEDGER
  // generation too — the new gen starts empty and the reconcile (which sums only
  // the current gen) reads ledger==counter==$0. The synchronous foldCodexCost
  // below re-baselines codex (codexLedgerBaselinePending was set above), so the
  // pre-existing rollout history is stamped at LEDGER_BASELINE_GEN, out of this
  // new gen; the first real charge on the next turn lands in it and reconciles.
  ledgerGen++;
  persistCostCap();
  // Absorb the baseline SYNCHRONOUSLY, right now — not on the next natural
  // fold (a turn boundary later). Deferring it left a window: the reset
  // arms `codexLedgerBaselinePending` but the first turn of the fresh
  // session can make real codex calls before that later fold ever runs, and
  // when it finally does, `baselining` is still true so those genuinely-new
  // calls get absorbed as "pre-existing history" and never charged. Folding
  // here, before this function returns and the caller can start that first
  // turn, means only rollout content that existed AT reset time can ever be
  // baselined; anything after is a real, chargeable delta. If the scan is
  // incomplete right now, foldCodexCost leaves the pending flag set and this
  // degrades to the old deferred behavior for this one reset.
  foldCodexCost();
}

/**
 * The per-turn ceiling soft-brake handed to the provider as `maxBudgetUsd`: the spend
 * headroom left before the Tier-2 ceiling, or undefined when no ceiling applies
 * (disabled, no ceiling configured, or an immortal group — which is never hard-stopped).
 * Best-effort: the SDK checks between calls, so a turn may overshoot by ≤ one in-flight
 * call; `recordTurnCost` stays the canonical basis and the sole close decider.
 */
function costCeilingRemainingUsd(): number | undefined {
  if (!costEnabled || costImmortal || costCeilingUsd <= 0) return undefined;
  return Math.max(0.01, costCeilingUsd - costSpentUsd);
}

/** Current status band from spent/cap/escalation/stop state. */
function computeCostStatus(): CostCapStatus {
  // Tier-2 hard ceiling: a non-immortal session past the ceiling reads 'stopped'
  // even without an explicit 'stop' decision, and survives a respawn statelessly
  // (the check is on spend, not a persisted flag). Immortal is never hard-stopped.
  if (!costImmortal && costCeilingUsd > 0 && costSpentUsd >= costCeilingUsd) return 'stopped';
  if (costStopRequested && !costImmortal) return 'stopped';
  if (costSpentUsd >= costCapUsd) return 'escalated';
  if (costSpentUsd >= WARN_FRACTION * costCapUsd) return 'warn';
  return 'ok';
}

/**
 * Build the full, self-consistent `cost_cap` state blob from the current live
 * accumulator. Extracted from `persistCostCap` so the atomic `cost_reconcile`
 * commit can write the SAME complete state (accountingVersion + codex/#65 ledger
 * identity included) inside its single outbound-DB transaction — unlike the
 * set-ceiling apply, which writes a deliberately minimal blob.
 */
function buildCostCapState(): CostCapState {
  const status = computeCostStatus();
  return {
    capUsd: costCapUsd,
    spentUsd: costSpentUsd,
    status,
    immortal: costImmortal,
    window: costWindow,
    // Live ceiling (base + any approved raises). ALWAYS published — including 0
    // (disabled/unconfigured) — so the dashboard's live per-session ceiling
    // control (NanoClaw #1, "set ceiling v2") can distinguish "no cost_cap row
    // at all" from "cost tracking is on but no ceiling is configured." Every
    // existing reader already treats an omitted value and 0 identically.
    ceilingUsd: costCeilingUsd,
    // Set-ceiling capability signal (NanoClaw #1, "set ceiling v2"). ALWAYS
    // published so the dashboard's live ceiling control can tell an upgraded
    // runner (renders the stepper) from a pre-set-ceiling one (renders "not yet
    // available"). Mirrors the cost_control_protocol handshake's version.
    protocolVersion: COST_CONTROL_PROTOCOL_VERSION,
    // Always publish the live budget generation so the host reads the same gen the
    // runner is fencing on (it stamps overrides with it via the escalation episode).
    budgetGen: costBudgetGen,
    // Cost-accounting generation + the codex delta watermark (issue #1327).
    // `codexLedger` is ALWAYS written, including empty: its presence is what
    // tells a later respawn this session has already been baselined.
    accountingVersion: COST_ACCOUNTING_VERSION,
    codexLedger,
    ...(codexEventOwners.size > 0 ? { codexEventOwners: Object.fromEntries(codexEventOwners) } : {}),
    // Written on EVERY persist, including the one initCostTracking does before
    // the first fold — that is the point: a crash between init and the baseline
    // fold must leave the successor knowing the baseline is still owed.
    codexBaselinePending: codexLedgerBaselinePending,
    // #65 durable ledger (dual-run) identity — always written so a respawn keeps
    // the same generation/sequence and any pending ledger baseline. The baseline
    // VERSION marker is written only once set (its absence is the migration trigger).
    ledgerGen,
    ledgerAdjSeq,
    ledgerBaselinePending,
    ...(ledgerBaselineVersion !== undefined ? { ledgerBaselineVersion } : {}),
    ...(codexUsdCharged > 0 ? { codexUsd: codexUsdCharged } : {}),
    // dayKey is present ONLY for the daily window (shared contract #1).
    ...(costWindow === 'daily' && costDayKey ? { dayKey: costDayKey } : {}),
    ...(costEscalatedAt ? { escalatedAt: costEscalatedAt } : {}),
    ...(costDecision ? { decision: costDecision } : {}),
    ...(costDecidedAt ? { decidedAt: costDecidedAt } : {}),
    // episodeId is meaningful only while an escalation is live (escalated/stopped);
    // the host ingests it from this durable state (read-only) to build the card.
    ...(costEpisodeId && (status === 'escalated' || status === 'stopped') ? { episodeId: costEpisodeId } : {}),
  };
}

function persistCostCap(): void {
  if (!costEnabled) return;
  setCostCap(buildCostCapState());
}

/**
 * Roll the immortal daily window if the UTC day changed.
 *
 * Split out of the accrual path so every cost source (per-message Claude usage,
 * the result-derived fallback, the codex fold) rolls the day identically before
 * charging into it.
 *
 * Returns whether a rollover happened, so a caller that would otherwise only
 * persist conditionally on a charge (`foldCodexCost`) still publishes the
 * rescoped dayKey/spentUsd/codexUsd on an idle rollover — without this an idle
 * session's DB row keeps publishing yesterday's figures until some unrelated
 * later mutation happens to persist.
 */
function maybeRollDailyWindow(): boolean {
  // IMMORTAL daily rollover: crossing into a new UTC day zeroes today's spend
  // and re-arms the once-per-day escalation. The lifetime window never rolls —
  // it resets only on a new_session batch or /clear (resetCostForNewSession).
  if (costWindow !== 'daily') return false;
  const today = utcDayKey();
  if (today === costDayKey) return false;
  costDayKey = today;
  costSpentUsd = 0;
  costEscalatedAt = undefined;
  // New UTC day = new budget epoch: rotate the gen so a yesterday-daily decision
  // that arrives now is refused, and drop the resolved episode.
  costBudgetGen++;
  costEpisodeId = undefined;
  // Re-arm the immortal ceiling re-escalation for the new day — otherwise a
  // day-1 crossing latches it forever and every later day's ceiling breach
  // goes silent, killing the only visibility signal for a group class we
  // deliberately never block.
  costCeilingEscalated = false;
  // New day → back to the p90/day allotment; a prior day's 'continue' raise
  // does not carry over (the bound is per-day).
  costCapUsd = costAllotmentUsd;
  // The published codex figure is day-scoped for a daily window, matching what
  // initCostTracking does when it adopts a stale dayKey. Display only — the
  // per-(file, day) ledger is what actually fences double-charging, and it is
  // deliberately NOT reset here.
  codexUsdCharged = 0;
  return true;
}

/**
 * Add one priced delta to spend, persist, and fire the one-shot escalations on
 * first crossing.
 *
 * THE single accrual point. Every cost source funnels through here so the
 * cap/ceiling/escalation semantics cannot diverge between them: per-assistant-
 * message Claude usage (`recordMessageCost`), the end-of-turn fallback
 * (`recordTurnCost`), and codex MCP-tool spend (`foldCodexCost`).
 */
function applyCostDelta(delta: number): void {
  if (!costEnabled || !(delta > 0)) return;
  maybeRollDailyWindow();
  costSpentUsd += delta;

  // One-shot soft escalation on first crossing of the cap. Dedupe via
  // escalatedAt so a warm session that keeps spending only escalates once per
  // allotment (a 'continue' override clears escalatedAt and raises the cap).
  // Tier-2 hard ceiling takes precedence over the Tier-1 escalation for this turn:
  // one large turn can cross both, so fire ONE notification (the ceiling one)
  // rather than two near-identical payloads.
  const crossedCeiling = costCeilingUsd > 0 && costSpentUsd >= costCeilingUsd;
  let firedCeiling = false;
  if (crossedCeiling) {
    if (!costImmortal) {
      // HARD STOP: signal the event loop to end THIS in-flight turn (no more
      // tokens), and set the quiesce marker for subsequent polls.
      costCeilingHardStop = true;
      if (!costStopRequested) {
        costStopRequested = true;
        emitCostEscalation('ceiling');
        firedCeiling = true;
      }
    } else if (!costCeilingEscalated) {
      // Immortal is never blocked — re-escalate once per day for visibility.
      costCeilingEscalated = true;
      emitCostEscalation('ceiling');
      firedCeiling = true;
    }
  }

  // Tier-1 soft escalation on first cap crossing. Mark escalatedAt for dedup even
  // when the ceiling already fired, but skip the second notification.
  if (costSpentUsd >= costCapUsd && !costEscalatedAt) {
    costEscalatedAt = new Date().toISOString();
    if (!firedCeiling) emitCostEscalation('cap');
  }
  persistCostCap();
}

/**
 * Price ONE streamed assistant message and accrue it — the cost cap's primary
 * basis since #1327.
 *
 * WHY PER MESSAGE, AND WHY DEDUPED. The provider stream emits one assistant
 * message per CONTENT BLOCK (thinking / text / tool_use are separate messages),
 * and every block of one API response repeats the same wire `message.id` AND the
 * same message-level `usage`. Summing the end-of-turn aggregate instead
 * double- to triple-counted: measured across 8 real prod transcripts the
 * non-deduped sum ran 1.7x–2.8x the deduped one, and the session that motivated
 * the issue carried a live counter of $166.00 against a true $78.69 — so its
 * ceiling fired at less than half the spend it was configured for. Deduping by
 * `message.id` reproduces, to the cent, the figure the dashboard's transcript
 * scanner already computes (`dashboard/server.ts` `scanFileCost`), which is the
 * number a human sees and the one reconciled against ccusage.
 *
 * A null id is NOT charged here: without an id the event cannot be deduplicated,
 * so charging it risks re-charging the same API response once per block. It is
 * counted instead, and the end-of-turn fallback settles the residual.
 */
function recordMessageCost(event: Extract<ProviderEvent, { type: 'message_usage' }>): void {
  if (!costEnabled) return;
  turnSawMessageUsage = true;

  if (!event.messageId) {
    // Undedupable — see the doc comment. `recordTurnCost` picks up the residual.
    turnMissingIdCount++;
    return;
  }
  if (seenMessageIds.has(event.messageId)) return;
  seenMessageIds.add(event.messageId);

  // Prefer the per-TTL cache-write split (authoritative for this fleet, which
  // runs 1h prompt caching); fall back to the flat cache_creation field only
  // when no split is reported, matching the dashboard's priceUsage semantics.
  const hasSplit = event.ephemeral1hInputTokens > 0 || event.ephemeral5mInputTokens > 0;
  const usage = {
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_input_tokens: event.cacheReadInputTokens,
    cache_creation_input_tokens: event.cacheCreationInputTokens,
    ...(hasSplit
      ? {
          cache_creation: {
            ephemeral_1h_input_tokens: event.ephemeral1hInputTokens,
            ephemeral_5m_input_tokens: event.ephemeral5mInputTokens,
          },
        }
      : {}),
  };
  // Price by the model that actually served THIS message. Two DISTINCT cases,
  // deliberately not collapsed:
  //   - event.model ABSENT: the provider didn't say which model served the
  //     message, so the configured model is the best available guess. This is
  //     the pre-#1327 behavior and a safe fallback.
  //   - event.model PRESENT but unpriced: a real, named model the rate table
  //     doesn't know (e.g. a newly-released, possibly pricier model). Repricing
  //     it at the CONFIGURED model's rate would silently bill a new model at an
  //     old (often cheaper) rate AND mark the turn fully accounted, so the
  //     aggregate residual never corrects it. Instead count it unpriced and let
  //     recordTurnCost settle the residual from the SDK's own totalCostUsd,
  //     which reflects the true rate.
  const reportedModel = event.model?.trim();
  const delta = priceUsage(reportedModel || getConfig().model, usage);
  if (delta <= 0) {
    const tokens = event.inputTokens + event.outputTokens + event.cacheCreationInputTokens + event.cacheReadInputTokens;
    // Zero-token messages price to $0 legitimately; only a message that billed
    // tokens with no known rate is a real accounting hole.
    if (tokens > 0) turnUnpricedCount++;
    return;
  }
  turnMessageCostUsd += delta;
  applyCostDelta(delta);
  recordClaudeLedger(event);
}

// ── #65 durable cost ledger — DUAL-RUN writers ─────────────────────────────
// Additive and BEST-EFFORT: every DB touch is wrapped, because a ledger write
// failing must never break enforcement. Enforcement still runs entirely off the
// existing counter; these only populate `cost_events` so it can be reconciled
// against the counter during a bake, before enforcement is flipped to derive
// from the ledger.
function ledgerNow(): string {
  return new Date().toISOString();
}
function recordClaudeLedger(event: Extract<ProviderEvent, { type: 'message_usage' }>): void {
  if (!costEnabled) return;
  // Same effective model the counter priced (recordMessageCost:
  // `reportedModel || getConfig().model`), so an absent model reprices at the
  // configured model in the ledger too (finding 3).
  const ev = claudeMessageToEvent(event, ledgerNow(), event.model?.trim() || getConfig().model || '', ledgerGen);
  if (!ev) return; // null-id message — the counter skips it too
  try {
    recordCostEvent(getOutboundDb(), ev, RATE_VERSION, RATE_TABLE, ledgerNow(), ledgerGen);
  } catch {
    /* best-effort */
  }
}
/**
 * Persist ONE synthetic ADJUSTMENT row (#65 finding 2): a dollar charge the live
 * counter made that is NOT token-derivable — `recordTurnCost`'s degraded residual
 * and legacy aggregate fallback, both settled from the SDK's `totalCostUsd`.
 * Token fields are all 0; `adjustmentUsd` carries the exact dollars charged, so
 * the reconcile counts it verbatim rather than repricing it. No-op unless the
 * charge is positive. The id draws from the persisted monotonic `ledgerAdjSeq`, so
 * a respawn never reuses one (INSERT OR IGNORE would else silently drop the row).
 *
 * KNOWN-ACCEPTED (dual-run) — the counter charge (`applyCostDelta`, which persists
 * `costSpentUsd`) and this ledger write are TWO separate best-effort writes, not
 * one transaction. The caller charges first, then records here, so a crash in the
 * microsecond window between them loses this one adjustment row → the next
 * reconcile shows a small `ledger < counter` delta for that single turn. That is
 * an INVESTIGABLE delta the dual-run bake surfaces (the reconcile log line), NOT
 * silent corruption or a mischarge — enforcement runs entirely off the counter,
 * which is already durably persisted. Making the pair transactional is deliberate
 * over-engineering for a validation log; the delta is one-time and self-heals at
 * the next window reset (a fresh gen starts both at $0).
 */
function recordLedgerAdjustment(usd: number): void {
  if (!costEnabled || !(usd > 0)) return;
  const seq = ++ledgerAdjSeq;
  try {
    recordCostEvent(
      getOutboundDb(),
      {
        id: `adj:${process.env.NANOCLAW_SESSION_ID || ''}:${seq}`,
        ts: ledgerNow(),
        provider: 'claude',
        model: getConfig().model || '',
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        adjustmentUsd: usd,
      },
      RATE_VERSION,
      RATE_TABLE,
      ledgerNow(),
      ledgerGen,
    );
  } catch {
    /* best-effort */
  }
  // Persist the advanced sequence so the id is never reused after a respawn.
  persistCostCap();
}
function recordCodexLedger(files: ReturnType<typeof scanCodexRollouts>['files'], windowGen: number): void {
  if (!costEnabled) return;
  try {
    const db = getOutboundDb();
    const now = ledgerNow();
    // INSERT OR IGNORE on codexEventKey → re-scans and cross-file fork replays
    // are no-ops, so writing every deduped call every fold is safe. `windowGen`
    // is the live gen for genuinely-new (charged) calls, or LEDGER_BASELINE_GEN
    // for pre-existing history a baseline is absorbing — first-write-wins on the
    // id keeps a call in whichever gen first saw it, so a later fold cannot
    // promote baselined history into the reconciled gen.
    for (const f of files)
      for (const e of f.dedupedEvents)
        recordCostEvent(db, codexCallToEvent(e, now), RATE_VERSION, RATE_TABLE, now, windowGen);
  } catch {
    /* best-effort */
  }
}
/**
 * The UTC day AFTER `day` ("YYYY-MM-DD" → next "YYYY-MM-DD"), via real Date math
 * so month/year rollover is correct. Used as the half-open daily-window END so
 * membership is a plain `ts < nextDay` — no reliance on a sentinel char ('Z')
 * sorting above 'T'/digits, and it composes with the indexed ts-range query.
 */
function nextUtcDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}
function reconcileLedger(): { ledgerUsd: number; counterUsd: number; delta: number } | undefined {
  if (!costEnabled) return undefined;
  try {
    const [ws, we] =
      costWindow === 'daily' && costDayKey ? [costDayKey, nextUtcDay(costDayKey)] : ['0000-00-00', '9999-99-99'];
    // Reconcile only the ACTIVE generation: the counter reflects the post-reset
    // window, so the ledger must sum the same one (else a `/clear` leaves every
    // pre-reset row inflating the lifetime sum forever). #65 finding 1.
    const { usd, unpricedModels } = sumWindow(getOutboundDb(), RATE_TABLE, ws, we, ledgerGen);
    log(
      `[ledger dual-run v${RATE_VERSION}] window=${costWindow} gen=${ledgerGen} ledger=$${usd.toFixed(4)} counter=$${costSpentUsd.toFixed(4)} ` +
        `delta=$${(usd - costSpentUsd).toFixed(4)}` +
        (unpricedModels.length ? ` unpriced:${unpricedModels.join(',')}` : ''),
    );
    return { ledgerUsd: usd, counterUsd: costSpentUsd, delta: usd - costSpentUsd };
  } catch {
    /* best-effort */
    return undefined;
  }
}

/**
 * End-of-turn settlement for the provider's aggregate `usage` event.
 *
 * Since #1327 this is a FALLBACK, not the primary basis (see
 * `recordMessageCost`). Three cases, decided from explicit per-turn state rather
 * than from "did we charge anything", which conflates far too much:
 *
 *  1. No `message_usage` at all — a provider that reports only an end-of-turn
 *     aggregate. Charge exactly as before: reprice the tokens, and fall back to
 *     the SDK's own `totalCostUsd` for a model the rate table doesn't know.
 *  2. Fully accounted per message — charge nothing more.
 *  3. DEGRADED: some message priced, but at least one message was undedupable
 *     (null id), billed tokens at an unknown rate, or arrived with no `usage`
 *     object at all (`noUsage`). Charge the residual `totalCostUsd - <already
 *     charged>` and log it. `totalCostUsd` carries the same block inflation, so
 *     the residual is an over-estimate — deliberately: in a path we cannot
 *     account exactly, erring toward charging more is the money-safe direction,
 *     and silently dropping the unpriced part is not acceptable.
 */
function recordTurnCost(event: Extract<ProviderEvent, { type: 'usage' }>): void {
  if (!costEnabled) return;
  const sawMessages = turnSawMessageUsage;
  const messageCost = turnMessageCostUsd;
  const unpriced = turnUnpricedCount;
  const missingId = turnMissingIdCount;
  const noUsage = turnNoUsageCount;
  // The turn is over either way — reset before any early return so a later turn
  // never inherits this one's state.
  resetTurnAccountingState();

  // A message with no usage at all (noUsage) makes the per-message stream
  // incomplete even if every message that DID carry usage was priced cleanly,
  // so it must NOT take the fully-accounted fast path — its spend lives only in
  // the aggregate. Treat it as a degraded turn (case 3) so the fallback runs.
  if (sawMessages && unpriced === 0 && missingId === 0 && noUsage === 0) return; // case 2

  // The pre-#1327 basis: reprice the turn's aggregate tokens at the configured
  // model. Block-inflated (that is the bug), so it is an OVER-estimate of the
  // turn — which is exactly what a degraded path wants as an upper bound.
  const hasSplit = event.ephemeral1hInputTokens > 0 || event.ephemeral5mInputTokens > 0;
  const aggregateUsd = priceUsage(getConfig().model, {
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_input_tokens: event.cacheReadInputTokens,
    cache_creation_input_tokens: event.cacheCreationInputTokens,
    ...(hasSplit
      ? {
          cache_creation: {
            ephemeral_1h_input_tokens: event.ephemeral1hInputTokens,
            ephemeral_5m_input_tokens: event.ephemeral5mInputTokens,
          },
        }
      : {}),
  });

  if (sawMessages) {
    // case 3 — degraded. Take the LARGER of the two independent turn estimates
    // before subtracting what we already charged. Using `totalCostUsd` alone
    // leaves a hole: a provider that reports it as 0 (or below the priced
    // aggregate) would yield a non-positive residual and the unpriced messages
    // would vanish silently — the failure this branch exists to prevent.
    const residual = Math.max(event.totalCostUsd, aggregateUsd) - messageCost;
    log(
      `Cost accounting DEGRADED this turn: ${unpriced} unpriced message(s), ${missingId} without a ` +
        `message id, ${noUsage} without usage. Charged $${messageCost.toFixed(4)} per-message` +
        (residual > 0 ? ` + $${residual.toFixed(4)} residual from the turn total` : ' (no positive residual)'),
    );
    applyCostDelta(residual);
    // #65 finding 2: this residual is a DOLLAR charge with no per-message tokens
    // behind it (it settles the SDK's totalCostUsd), so mirror it into the ledger
    // as an explicit adjustment — no-op if the residual was not positive.
    recordLedgerAdjustment(residual);
    return;
  }

  // case 1 — legacy aggregate-only path, unchanged
  let delta = aggregateUsd;
  if (delta <= 0 && event.totalCostUsd > 0) delta = event.totalCostUsd; // unpriced model fallback
  applyCostDelta(delta);
  // #65 finding 2: aggregate-only turns charge dollars with no per-message ledger
  // rows behind them; record the exact charge as an adjustment so the reconcile
  // matches. No-op when nothing was charged.
  recordLedgerAdjustment(delta);
}

/**
 * Fold codex (MCP tool) spend into the cap — the second half of #1327.
 *
 * `mcp__codex__codex` runs as a stdio child, so none of its inference reaches
 * the Claude stream; before this the cap had zero visibility into it and a
 * codex-heavy session could spend real, uncapped money (the issue's session:
 * $76.72, next to $78.69 of Claude spend). `$CODEX_HOME` is a per-session mount,
 * so everything under it belongs to this session — no attribution needed.
 *
 * Charges the DELTA against a persisted per-(file, UTC-day) ledger, so it is
 * idempotent, respawn-safe, and cannot be blinded by a rotated file (a new file
 * charges from zero rather than having to climb past a global high-water mark).
 *
 * KNOWN, ACCEPTED EDGE: calls are de-duplicated across files (a forked subagent
 * rollout replays its parent's, see `codexEventKey`), so if the ORIGINAL file is
 * later deleted while its fork survives, the fork stops losing the duplicate and
 * charges those calls a second time. Nothing in nanoclaw or codex deletes a
 * rollout, so this needs an operator with a broom; the alternative — not
 * de-duplicating — is a measured 13.7%–19.2% over-count on every session that
 * forks, which is routine.
 *
 * MIGRATION: a session with no `codexLedger` at all has its existing codex
 * history absorbed once WITHOUT charging. Charging it would bill a live session
 * for spend it already made and hard-stop much of the fleet the moment this
 * deploys. A brand-new session has no rollout files, so it absorbs $0 and
 * charges from its first codex call.
 *
 * Synchronous end to end — see `scanCodexRollouts`. Called at turn boundaries:
 * before a query is built, on Claude's aggregate `usage` event, and on native
 * codex's `result` (codex emits no `usage`, so `result` IS its turn boundary).
 * Enforcement of codex spend is therefore turn-granular: a single turn can
 * overshoot by its own codex calls. That is the honest bound; a timer here would
 * not change it, because ending a turn mid-stream is not something the runner
 * can do safely (the result/ack path owns that).
 */
function foldCodexCost(): void {
  if (!costEnabled) return;
  let scan: ReturnType<typeof scanCodexRollouts>;
  try {
    scan = scanCodexRollouts(undefined, codexEventOwners);
  } catch (err) {
    codexScanFailures++;
    log(
      `Codex cost scan THREW (${codexScanFailures} consecutive): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (scan.errors > 0) {
    codexScanFailures++;
    // Loud, but NOT a quiesce. An unreadable rollout loses nothing permanently:
    // its ledger entries are untouched, so the entire delta is charged the first
    // time the file reads successfully. The only unrecoverable case is a file
    // that is never readable again — an infrastructure fault on a bind mount
    // that, if it were real, would also stop codex from running at all. Stopping
    // the session on it would turn a benign accounting delay into an outage that
    // needs a human to clear.
    log(
      `Codex cost scan INCOMPLETE: ${scan.errors} unreadable/corrupt path(s) ` +
        `(${codexScanFailures} consecutive). Their spend is charged when they become readable.`,
    );
  } else {
    codexScanFailures = 0;
  }
  // Priced at DEFAULT_CODEX_RATE, never $0 — an unrecognized model must not buy
  // unaccounted spend. Reported ONCE per model per container: the fold runs at
  // every turn boundary, and there are genuinely several GPT-5.x ids in the wild
  // the table does not enumerate, so logging every fold is noise that would
  // train the reader to ignore the line.
  const newlyUnpriced = scan.unpricedModels.filter((m) => !codexUnpricedReported.has(m));
  if (newlyUnpriced.length > 0) {
    for (const m of newlyUnpriced) codexUnpricedReported.add(m);
    log(`Codex cost: unknown model id(s) ${newlyUnpriced.join(', ')} priced at the default codex rate`);
  }

  // Roll the day BEFORE deciding what "today" means for the daily window below.
  // Persist even on an idle rollover (no charge this fold) so the DB row stops
  // publishing yesterday's dayKey/spentUsd/codexUsd the moment the day turns,
  // not whenever some later unrelated mutation happens to persist.
  const rolled = maybeRollDailyWindow();

  // NEVER mutate the ledger off an incomplete scan while a baseline is owed:
  // charging only the readable files would both mark some history charged (via
  // their watermark) AND leave the baseline flag pending, so the NEXT complete
  // scan would re-absorb the readable files' totals as if new — but their
  // watermark already reflects them, so nothing double-charges there, except
  // the unreadable files' eventual absorption still races a session that has
  // been paying real charges throughout, contradicting "baseline the WHOLE
  // pre-existing history before charging anything." Stay fully pending instead:
  // no ledger writes, no charges, retry next fold.
  if (codexLedgerBaselinePending && scan.errors > 0) {
    if (rolled) persistCostCap();
    return;
  }
  const baselining = codexLedgerBaselinePending;
  let charged = 0;
  let recorded = 0;
  for (const file of scan.files) {
    for (const [rawDay, usd] of Object.entries(file.byDay)) {
      // Unknown-day usage (unparseable/absent timestamp) must not be
      // permanently free: in a daily window `day` would never equal a real
      // costDayKey on any future date either, so treating it like "prior-day,
      // defer forever" (the branch below) silently drops it for good. Charge
      // it to TODAY instead — the money-safe direction, matching how an
      // unpriced model is charged at a default rate rather than $0.
      const day = rawDay === MISSING_DAY_KEY ? (costDayKey ?? rawDay) : rawDay;
      const k = ledgerKey(file.key, rawDay);
      const prev = codexLedger[k] ?? 0;
      const delta = usd - prev;
      if (delta <= 0) continue;
      codexLedger[k] = usd;
      if (baselining) {
        recorded += delta;
        continue;
      }
      // The immortal daily window deliberately discards prior-day spend
      // (initCostTracking drops a stale dayKey). A late scan must not smuggle
      // yesterday into today, so record it and move on. Unknown-day usage was
      // already rewritten to today's key above, so it never lands here.
      if (costWindow === 'daily' && day !== costDayKey) {
        recorded += delta;
        continue;
      }
      charged += delta;
      codexUsdCharged += delta;
      applyCostDelta(delta);
    }
  }

  // #65 dual-run: durably record every deduped codex call (incl. baselined
  // history and, once #1333 lands, native-codex). Best-effort, no enforcement
  // effect. Deduped by codexEventKey (verified to match ccusage's tokens).
  //
  // GEN CHOICE (finding 1 codex sub-case). Pre-existing history the counter does
  // NOT charge — an enforcement baseline (`baselining`) or a ledger migration/reset
  // baseline (`ledgerBaselinePending`) — is stamped at LEDGER_BASELINE_GEN so the
  // current-gen reconcile excludes it; otherwise it would read `ledger > counter`.
  // Genuinely-new (charged) calls take the live gen and reconcile. First-write-wins
  // on the id means a call stays in whichever gen first saw it, so once the baseline
  // fold has sentinel-stamped today's history, a later fold cannot promote it into
  // the reconciled gen. Prior-day `recorded` deltas in a daily window are already
  // excluded by the ts-window, so they may take the live gen harmlessly.
  const ledgerBaselining = baselining || ledgerBaselinePending;
  recordCodexLedger(scan.files, ledgerBaselining ? LEDGER_BASELINE_GEN : ledgerGen);
  // Clear the ledger baseline ONLY after a COMPLETE scan (errors === 0), mirroring
  // the enforcement baseline's "don't finish off an incomplete scan" discipline —
  // an incomplete first fold leaves it pending so the next complete fold re-stamps
  // the still-unread history rather than promoting it into the reconciled gen.
  //
  // KNOWN-ACCEPTED (dual-run) incomplete-scan edges — each a small INVESTIGABLE
  // reconcile delta, never a mischarge (enforcement is unaffected), and the common
  // COMPLETE-scan path is exact:
  //   - An unreadable rollout during the baseline fold: its history is stamped on a
  //     later fold. If that later fold is still `ledgerBaselinePending`, it lands at
  //     the sentinel gen (ledger slightly under counter until the watermark catches
  //     up); if the flag has since cleared, at the live gen (slightly over). Either
  //     way it is one boundary file, surfaced by the reconcile log.
  //   - A mixed scan where a genuinely-NEW charged call arrives while the baseline
  //     is still pending would stamp that call at the sentinel gen (excluded) → a
  //     transient `ledger < counter` for that call until the next clean fold. Rare:
  //     the migration/reset fold runs before the session's first turn, so there is
  //     normally no new-and-charged call in flight when the flag is set.
  if (scan.errors === 0) ledgerBaselinePending = false;

  // #1361: prune now takes the scan's live event-key set so an owner whose file
  // vanished but whose call still replays in a surviving fork is NOT dropped
  // (dropping it double-charges). Keep this signature — do not revert to the
  // pre-#1361 single-arg form.
  const pruned = scan.errors === 0 ? pruneCodexLedger(new Set(scan.files.map((f) => f.key)), scan.eventKeys) : 0;

  if (baselining) {
    codexLedgerBaselinePending = false;
    if (recorded > 0) {
      log(
        `Codex cost: baselined $${recorded.toFixed(4)} of pre-existing rollout spend without charging ` +
          `(first run under accounting v${COST_ACCOUNTING_VERSION})`,
      );
    }
  }
  if (charged > 0) {
    log(`Codex cost: +$${charged.toFixed(4)} folded into the cap (codex total $${codexUsdCharged.toFixed(4)})`);
  }
  // A baseline, a recorded-not-charged delta, a rollover or a prune all mutate
  // published state, so persist whenever anything moved; applyCostDelta
  // already persisted on charge.
  if (charged === 0 && (recorded > 0 || baselining || pruned > 0 || rolled)) persistCostCap();
}

/**
 * Days a ledger entry is kept after its rollout file disappears from disk.
 *
 * The ledger rides inside the `cost_cap` row, which is rewritten on EVERY cost
 * delta — i.e. once per assistant message — so an unbounded ledger turns into
 * unbounded write amplification on a long-lived immortal session.
 *
 * Both conditions are required before an entry is dropped, and both matter:
 * a file still on disk would re-charge its whole total from zero if its
 * watermark were removed, and a file that vanished only recently is the one case
 * where a restore is plausible (an operator moving data, a mount blip). Past the
 * retention window a rollout is neither present nor plausibly returning.
 */
const CODEX_LEDGER_RETENTION_DAYS = 30;

/**
 * The date a ledger/owner entry ages against. Normally the day bucket itself,
 * but a timestamp-less codex event buckets as `MISSING_DAY_KEY` ('unknown-day'),
 * which never satisfies the `YYYY-MM-DD` cutoff test — so such an entry for a
 * vanished file would live forever. Fall back to the date embedded in the
 * rollout path (`sessions/YYYY/MM/DD/rollout-…`); returns undefined only when
 * neither is a real date, in which case the caller KEEPS the entry (the safe
 * direction — never prune something whose age can't be established).
 */
function retentionDay(day: string, fileKey: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const m = fileKey.match(/(?:^|[/\\])(\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/**
 * Drop watermarks for rollout files that are gone from a COMPLETE scan and whose
 * day bucket is older than the retention window. Returns how many were removed.
 */
function pruneCodexLedger(present: Set<string>, presentEventKeys: ReadonlySet<string>): number {
  const cutoff = new Date(Date.now() - CODEX_LEDGER_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  let removed = 0;
  for (const k of Object.keys(codexLedger)) {
    const sep = k.lastIndexOf(' ');
    if (sep < 0) continue;
    const fileKey = k.slice(0, sep);
    const day = k.slice(sep + 1);
    if (present.has(fileKey)) continue; // still on disk — its watermark is load-bearing
    const ageDay = retentionDay(day, fileKey);
    if (!ageDay || ageDay >= cutoff) continue;
    delete codexLedger[k];
    removed++;
  }
  // Prune the OWNERS map too — it is persisted side-by-side with codexLedger in
  // the same cost-accounting state blob and is the BIGGER of the two (one entry
  // per codex CALL vs one per (file, day)), so leaving it unbounded is the exact
  // persisted-state growth CODEX_LEDGER_RETENTION_DAYS exists to prevent.
  //
  // But an owner is load-bearing beyond its own file: it is what stops a
  // byte-identical REPLAYED call in a SURVIVING rollout (a fork of a since-deleted
  // parent) from being re-claimed and re-charged. So keep it while EITHER its
  // owning file is present OR its event key still appears in a live file this
  // scan — drop it only when the call is gone everywhere AND its day is past the
  // retention window. Key is `codexEventKey` = `model|day|input|cached|output`.
  for (const [k, fileKey] of codexEventOwners) {
    if (present.has(fileKey) || presentEventKeys.has(k)) continue;
    const ageDay = retentionDay(k.split('|')[1] ?? '', fileKey);
    if (!ageDay || ageDay >= cutoff) continue;
    codexEventOwners.delete(k);
    removed++;
  }
  return removed;
}

/**
 * Fire the escalation: a kind:'system' outbound row the host's `cost_escalation`
 * delivery action picks up and routes to a human approver (owner/admin). This
 * is the ONLY signal — the runner cannot block on a reply; the human decision
 * returns asynchronously as a `cost_override` inbound row.
 */
function emitCostEscalation(reason: 'cap' | 'ceiling'): void {
  const sessionId = process.env.NANOCLAW_SESSION_ID || '';
  // Stamp the episode with the budget generation LIVE at escalation. The host echoes
  // this back as the override's `epochKey`; applyCostOverride refuses one whose epoch
  // ≠ the then-current gen (superseded / post-/clear / yesterday-daily). A distinct
  // `reason` in the same gen is a distinct episode (cap → ceiling supersession).
  costEpisodeId = `esc-${sessionId}-${reason}-${costBudgetGen}`;
  // Fire-and-forget: this stays synchronous because `recordTurnCost` (its only
  // runtime caller) runs inside the provider event loop and its signature is
  // pinned by __costCapTestHooks. The escalation is advisory — the row is the
  // ONLY signal and the runner never blocks on it — so a failed write must not
  // take down the turn, but it must not become an unhandled rejection either.
  void writeMessageOut({
    id: generateId(),
    kind: 'system',
    content: JSON.stringify({
      action: 'cost_escalation',
      // 'cap' = Tier-1 soft escalation; 'ceiling' = Tier-2 (hard stop for
      // non-immortal, visibility-only for immortal). Lets the human tell a
      // "please decide" from a "this was hard-stopped / is running away".
      reason,
      sessionId,
      // The card/episode identity + the epoch fence the runner will enforce on the
      // returning cost_override (see applyCostOverride).
      episodeId: costEpisodeId,
      epochKey: String(costBudgetGen),
      spentUsd: Number(costSpentUsd.toFixed(4)),
      capUsd: Number(costCapUsd.toFixed(4)),
      ...(costCeilingUsd > 0 ? { ceilingUsd: Number(costCeilingUsd.toFixed(4)) } : {}),
      // The fixed step a ceiling-continue adds (host uses this to preview the
      // post-approve ceiling in the card text). Absent when no ceiling is set.
      ...(costCeilingAllotmentUsd > 0 ? { ceilingAllotmentUsd: Number(costCeilingAllotmentUsd.toFixed(4)) } : {}),
      immortal: costImmortal,
      window: costWindow,
    }),
  }).catch((err: unknown) => {
    log(`Cost escalation row failed to write: ${err instanceof Error ? err.message : String(err)}`);
  });
  log(
    `Cost cap escalation (${reason}): spent=$${costSpentUsd.toFixed(2)} ` +
      `cap=$${costCapUsd.toFixed(2)}` +
      (costCeilingUsd > 0 ? ` ceiling=$${costCeilingUsd.toFixed(2)}` : '') +
      ` (immortal=${costImmortal}, window=${costWindow})`,
  );
}

/**
 * Server-enforced hard maximum for a `set_ceiling` target (NanoClaw #1, "set
 * ceiling v2") — $1,000.00 in integer cents. Enforced HERE independently of the
 * host's own identical check (`src/modules/cost-ceiling-adjustment/index.ts`):
 * the wire contract is host-authoritative for VALIDATION, but the runner never
 * trusts a control message's value bounds blindly — defense in depth against a
 * bug or a compromised host.
 */
const MAX_CEILING_CENTS = 100_000;

/**
 * Server-enforced sanity maximum for a `cost_reconcile` target — $1,000,000.00 in
 * integer cents (issue #1327). Enforced HERE independently of the host's identical
 * check: not a policy limit (the reconcile target is the transcript oracle, which
 * the runner does not second-guess) but defense in depth against a bug/typo in the
 * control message. No single session's real cost approaches this.
 */
const MAX_SPENT_CENTS = 100_000_000;

/**
 * The union of every field either `cost_override` shape can carry — the legacy
 * `decision:'continue'|'stop'` payload and the "set ceiling v2"
 * `protocolVersion:2, operation:'set_ceiling'` payload. Parsed once as this
 * shape so the dispatcher and both handlers share one type instead of each
 * asserting a narrower, mutually-exclusive one.
 */
interface CostOverrideContent {
  decision?: unknown;
  epochKey?: unknown;
  protocolVersion?: unknown;
  operation?: unknown;
  adjustmentId?: unknown;
  expectedEpochKey?: unknown;
  expectedCeilingCents?: unknown;
  targetCeilingCents?: unknown;
  /** `operation:'reconcile'` only — the transcript-oracle spend target (integer cents). */
  targetSpentCents?: unknown;
  /** `operation:'reconcile'` only — the live spend the host read (CAS third leg, integer cents). */
  expectedSpentCents?: unknown;
  /** `operation:'reconcile'` only — audit flag: this reconcile was `--force`d past an
   *  already-decided card (host-side fence relaxation). Echoed in the receipt; no runner logic. */
  forced?: unknown;
}

/**
 * Apply a human cost-override decision (from a `cost_override` inbound row).
 * The Tier-2 ceiling is the only actionable decision now (Tier-1 'cap' crossings
 * are dashboard-observation only — the host never cards them, so a legitimate
 * 'continue' only ever arrives for a session at/over its ceiling):
 *   - continue: raise the ceiling by one ceiling-allotment (bounded, not
 *     unbounded — a session that burns through the raise re-stops and re-cards)
 *     and resume, queuing a one-shot cost-sensitivity nudge for the next turn.
 *   - stop: quiesce (finish current turn, take no new work). Immortal groups
 *     never stop — the decision is recorded but status stays at 'escalated'.
 *
 * `{protocolVersion:2, operation:'set_ceiling'}` is a DISTINCT, newer operation
 * (NanoClaw #1, "set ceiling v2" — the dashboard's live +/- ceiling control) —
 * handled in its own path (`applySetCeilingOverride`) rather than folded into
 * the legacy `decision:'continue'|'stop'` branch below. An earlier draft that
 * overloaded `continue` for this was flagged in review as money-unsafe: the
 * legacy path can only ADD a fixed allotment, so it structurally cannot express
 * "lower to an exact value below current spend," and conflating the two
 * decisions risked a stale/duplicate legacy override interacting with a live
 * exact-value request in ways neither path was designed to fence against.
 */
function applyCostOverride(msg: MessageInRow): void {
  let parsed: CostOverrideContent;
  try {
    parsed = JSON.parse(msg.content) as CostOverrideContent;
  } catch {
    log(`cost_override with unparseable content — ignoring (id=${msg.id})`);
    return;
  }

  if (parsed.protocolVersion === 2 && parsed.operation === 'set_ceiling') {
    applySetCeilingOverride(msg, parsed);
    return;
  }

  if (parsed.protocolVersion === 2 && parsed.operation === 'reconcile') {
    applyReconcileOverride(msg, parsed);
    return;
  }

  if (!costEnabled) return;
  const decision = parsed.decision;
  const epochKey = parsed.epochKey;
  // EPOCH FENCE — the exactly-once GRANT guarantee. An override carries the budget
  // generation live when its episode escalated. Refuse it if that gen no longer
  // matches: the episode was superseded, the session was /clear-reset, a prior
  // Continue already re-armed (this is a crash re-enqueue of the same click), or a
  // daily window rolled over. A stale Continue must not raise the cap twice, and a
  // stale Stop must not quiesce a fresh session. Overrides WITHOUT an epochKey
  // (legacy S1 rows, dashboard-pill path) apply unconditionally for back-compat.
  if (epochKey != null && String(epochKey) !== String(costBudgetGen)) {
    log(
      `cost_override ${String(decision)} REFUSED — epoch ${String(epochKey)} ≠ live gen ` +
        `${costBudgetGen} (superseded/stale/re-enqueued); ignoring (id=${msg.id})`,
    );
    return;
  }
  const now = new Date().toISOString();
  if (decision === 'continue') {
    // A non-immortal session at/over its ceiling: this IS the actionable ceiling
    // decision (see the doc comment above applyCostOverride) — raise the ceiling
    // by one fixed allotment (bounded: a session that burns through it re-stops
    // and re-cards rather than running unbounded) and resume.
    if (!costImmortal && costCeilingUsd > 0 && costSpentUsd >= costCeilingUsd) {
      const previousCeiling = costCeilingUsd;
      costCeilingUsd += costCeilingAllotmentUsd > 0 ? costCeilingAllotmentUsd : 0;
      costStopRequested = false;
      costCeilingHardStop = false;
      costDecision = 'continue';
      costDecidedAt = now;
      // Re-arm: rotate the gen so a re-enqueue of THIS same Continue (host crash + retry)
      // is auto-stale (its epochKey now ≠ live gen), and drop the resolved episode. The
      // next ceiling crossing escalates a fresh episode stamped with the new gen.
      costBudgetGen++;
      costEpisodeId = undefined;
      // Queued for the NEXT real turn's prompt (cost_override rows are never fed
      // to the agent directly) — tells the agent it's in expensive territory and
      // to actively wind down rather than keep accumulating context.
      pendingCostNudge =
        `Cost checkpoint: this session has spent $${costSpentUsd.toFixed(2)}. A human just approved ` +
        `raising the cost ceiling to $${costCeilingUsd.toFixed(2)} so you can continue — this is not a ` +
        `blank check. You're likely carrying a large accumulated context; be frugal from here: avoid ` +
        `re-reading files or context you already have, summarize progress instead of re-deriving it, and ` +
        `aim to finish or hand off the current task within the next few turns rather than continuing to ` +
        `accumulate more context.`;
      persistCostCap();
      log(
        `cost_override continue — CEILING raised $${previousCeiling.toFixed(2)} -> ` +
          `$${costCeilingUsd.toFixed(2)}, resuming with cost nudge queued`,
      );
      return;
    }
    // Legacy: resolves an in-flight Tier-1 'cap' episode from before this redesign
    // (the host no longer creates new ones, but a stale approval could still land
    // right after deploy). Harmless — raises the now-unused cap number only.
    costStopRequested = false;
    costEscalatedAt = undefined;
    costCapUsd += costAllotmentUsd;
    costDecision = 'continue';
    costDecidedAt = now;
    costBudgetGen++;
    costEpisodeId = undefined;
    log(`cost_override continue — cap raised to $${costCapUsd.toFixed(2)}, resuming`);
  } else if (decision === 'stop') {
    costDecision = 'stop';
    costDecidedAt = now;
    if (!costImmortal) {
      costStopRequested = true;
      log('cost_override stop — quiescing after current turn, taking no new work');
    } else {
      log('cost_override stop on immortal group — recorded, but immortal never quiesces');
    }
  } else {
    log(`cost_override with unknown decision "${String(decision)}" — ignoring`);
    return;
  }
  persistCostCap();
}

/**
 * `{protocolVersion:2, operation:'set_ceiling'}` — the live, per-session, exact-
 * value ceiling control (NanoClaw #1, "set ceiling v2"). Unlike the legacy
 * continue/stop path, this ALWAYS sends a receipt back (`commitCostCeiling
 * AdjustmentOutcome`) — the host's ledger row is stuck `enqueued` until it
 * hears a definitive outcome, so silently dropping an unrecognized/invalid
 * message here (as the legacy path does) would leave that row stranded.
 *
 * Runs regardless of `costEnabled`/`costImmortal` — those become REJECT
 * outcomes (`cost_tracking_disabled` / `immortal`) with a receipt, not silent
 * no-ops, so the host always reaches a terminal ledger state.
 *
 * Money-safety invariants this function must uphold (pinned by
 * `poll-loop.setCeiling.test.ts`):
 *   - Both `expectedEpochKey` AND `expectedCeilingCents` must match live state
 *     exactly, or the request is refused as `conflict` — never partially applied.
 *   - The target is applied VERBATIM against CURRENT live spend — never a
 *     different/higher value, never a stale spend snapshot. A session that
 *     stopped between the browser's read and this request's arrival (the
 *     escalation itself never rotates the epoch) is accepted at the SAME
 *     expected epoch/ceiling and resolved against its now-current spend: raise
 *     above spend → resume; raise still at/below spend → stay stopped at
 *     exactly the requested value.
 *   - Every successful apply rotates `costBudgetGen`, whether it raises or
 *     lowers — this is what makes a stale legacy card override (still carrying
 *     the OLD epoch) refuse itself if it lands after this request already
 *     resolved the epoch, and what makes a duplicate/redelivered copy of THIS
 *     SAME request refuse itself on a second delivery.
 *   - State + receipt + processing_ack are committed in ONE outbound-DB
 *     transaction (`commitCostCeilingAdjustmentOutcome`) — never partially.
 */
function applySetCeilingOverride(msg: MessageInRow, parsed: CostOverrideContent): void {
  const adjustmentId = typeof parsed.adjustmentId === 'string' && parsed.adjustmentId ? parsed.adjustmentId : undefined;
  if (!adjustmentId) {
    log(`set_ceiling control with missing/invalid adjustmentId — cannot address a receipt, ignoring (id=${msg.id})`);
    return;
  }

  const sessionId = process.env.NANOCLAW_SESSION_ID || '';
  const requestExpectedEpochKey =
    typeof parsed.expectedEpochKey === 'string' ? parsed.expectedEpochKey : String(parsed.expectedEpochKey ?? '');
  const requestExpectedCeilingCents = Number(parsed.expectedCeilingCents);
  const requestTargetCeilingCents = Number(parsed.targetCeilingCents);

  const commitOrThrow = (
    receipt: CostCeilingAdjustmentReceipt,
    newCostCap: CostCapState | undefined,
    logMsg: string,
  ): void => {
    try {
      commitCostCeilingAdjustmentOutcome({ inboundMessageId: msg.id, receipt, newCostCap });
      log(logMsg);
    } catch (err) {
      // Do NOT swallow: the caller (applyCostOverride's callers in the poll
      // loop) must not mark this inbound message complete by any other path
      // when the atomic commit itself failed. Propagating lets it be retried
      // on redelivery / recovered by clearStaleProcessingAcks() on restart,
      // rather than silently losing the request.
      log(
        `set_ceiling: atomic commit FAILED for adjustment ${adjustmentId} — NOT acking (id=${msg.id}): ${String(err)}`,
      );
      throw err;
    }
  };

  const reject = (reason: 'immortal' | 'cost_tracking_disabled' | 'invalid_value'): void => {
    const receipt: CostCeilingAdjustmentReceipt = {
      action: 'cost_ceiling_adjustment_result',
      protocolVersion: 2,
      adjustmentId,
      sessionId,
      outcome: 'rejected',
      expectedEpochKey: requestExpectedEpochKey,
      expectedCeilingCents: Number.isFinite(requestExpectedCeilingCents) ? requestExpectedCeilingCents : 0,
      targetCeilingCents: Number.isFinite(requestTargetCeilingCents) ? requestTargetCeilingCents : 0,
      reason,
      ...(costEnabled
        ? {
            resultEpochKey: String(costBudgetGen),
            resultCeilingCents: Math.round(costCeilingUsd * 100),
            spentUsd: Number(costSpentUsd.toFixed(4)),
            status: computeCostStatus(),
          }
        : {}),
    };
    commitOrThrow(receipt, undefined, `set_ceiling REJECTED (${reason}) for adjustment ${adjustmentId} (id=${msg.id})`);
  };

  if (!costEnabled) return reject('cost_tracking_disabled');
  if (costImmortal) return reject('immortal');

  const validEpoch = requestExpectedEpochKey.length > 0;
  const validExpectedCents = Number.isInteger(requestExpectedCeilingCents) && requestExpectedCeilingCents >= 0;
  const validTargetCents =
    Number.isInteger(requestTargetCeilingCents) &&
    requestTargetCeilingCents >= 1 &&
    requestTargetCeilingCents <= MAX_CEILING_CENTS;
  if (!validEpoch || !validExpectedCents || !validTargetCents) return reject('invalid_value');

  const liveCeilingCents = Math.round(costCeilingUsd * 100);
  const epochMatches = requestExpectedEpochKey === String(costBudgetGen);
  const ceilingMatches = requestExpectedCeilingCents === liveCeilingCents;

  if (!epochMatches || !ceilingMatches) {
    const reason = !epochMatches ? 'epoch_mismatch' : 'ceiling_mismatch';
    const receipt: CostCeilingAdjustmentReceipt = {
      action: 'cost_ceiling_adjustment_result',
      protocolVersion: 2,
      adjustmentId,
      sessionId,
      outcome: 'conflict',
      expectedEpochKey: requestExpectedEpochKey,
      expectedCeilingCents: requestExpectedCeilingCents,
      targetCeilingCents: requestTargetCeilingCents,
      reason,
      resultEpochKey: String(costBudgetGen),
      resultCeilingCents: liveCeilingCents,
      spentUsd: Number(costSpentUsd.toFixed(4)),
      status: computeCostStatus(),
    };
    commitOrThrow(
      receipt,
      undefined,
      `set_ceiling CONFLICT (${reason}) for adjustment ${adjustmentId}: expected epoch=${requestExpectedEpochKey}/` +
        `ceiling=${requestExpectedCeilingCents}¢, live epoch=${costBudgetGen}/ceiling=${liveCeilingCents}¢ (id=${msg.id})`,
    );
    return;
  }

  // MATCHED — apply against CURRENT live state. `wasStopped` is read BEFORE any
  // mutation below so the resume-nudge decision reflects the state this request
  // actually found, not the state it's about to create.
  const previousEpochKey = String(costBudgetGen);
  const previousCeilingCents = liveCeilingCents;
  const wasStopped = computeCostStatus() === 'stopped';

  costCeilingUsd = requestTargetCeilingCents / 100;
  // Rotate on EVERY successful apply (raise or lower) — not just raises. This is
  // what fences a still-in-flight legacy card override (stamped with the OLD
  // epoch) and a redelivered copy of THIS SAME request after it already applied.
  costBudgetGen++;
  costEpisodeId = undefined;

  if (costSpentUsd >= costCeilingUsd) {
    // Stay or become stopped immediately — do not wait for the next
    // recordTurnCost tick to notice (mirrors the in-turn hard-stop check).
    costCeilingHardStop = true;
    costStopRequested = true;
  } else {
    costCeilingHardStop = false;
    costStopRequested = false;
    // A bare raise on an already-healthy session must not fabricate a "you were
    // just resumed" nudge — only queue it when this transition actually resumes
    // a session that WAS stopped.
    if (wasStopped) {
      pendingCostNudge =
        `Cost checkpoint: this session has spent $${costSpentUsd.toFixed(2)}. A human just approved ` +
        `raising the cost ceiling to $${costCeilingUsd.toFixed(2)} so you can continue — this is not a ` +
        `blank check. You're likely carrying a large accumulated context; be frugal from here: avoid ` +
        `re-reading files or context you already have, summarize progress instead of re-deriving it, and ` +
        `aim to finish or hand off the current task within the next few turns rather than continuing to ` +
        `accumulate more context.`;
    }
  }

  const status = computeCostStatus();
  const newState: CostCapState = {
    capUsd: costCapUsd,
    spentUsd: costSpentUsd,
    status,
    immortal: costImmortal,
    window: costWindow,
    ceilingUsd: costCeilingUsd,
    // Keep the set-ceiling capability signal present on this write too, so the
    // atomic commit path never drops it (persistCostCap always publishes it).
    protocolVersion: COST_CONTROL_PROTOCOL_VERSION,
    budgetGen: costBudgetGen,
    ...(costWindow === 'daily' && costDayKey ? { dayKey: costDayKey } : {}),
    ...(costEscalatedAt ? { escalatedAt: costEscalatedAt } : {}),
    ...(costDecision ? { decision: costDecision } : {}),
    ...(costDecidedAt ? { decidedAt: costDecidedAt } : {}),
  };

  const receipt: CostCeilingAdjustmentReceipt = {
    action: 'cost_ceiling_adjustment_result',
    protocolVersion: 2,
    adjustmentId,
    sessionId,
    outcome: 'applied',
    expectedEpochKey: requestExpectedEpochKey,
    previousEpochKey,
    resultEpochKey: String(costBudgetGen),
    expectedCeilingCents: requestExpectedCeilingCents,
    previousCeilingCents,
    targetCeilingCents: requestTargetCeilingCents,
    resultCeilingCents: Math.round(costCeilingUsd * 100),
    spentUsd: Number(costSpentUsd.toFixed(4)),
    status,
  };

  commitOrThrow(
    receipt,
    newState,
    `set_ceiling APPLIED for adjustment ${adjustmentId}: ceiling $${(previousCeilingCents / 100).toFixed(2)} -> ` +
      `$${costCeilingUsd.toFixed(2)}, spent=$${costSpentUsd.toFixed(2)}, status=${status} (id=${msg.id})`,
  );
}

/**
 * `{protocolVersion:2, operation:'reconcile'}` — set the live enforcement spend
 * (`costSpentUsd`) to an exact, operator-supplied value: the session's real,
 * transcript-priced cost (issue #1327 remediation). The #1327 pre-fix accounting
 * over-charged spend (once per streamed content block, measured 1.7x–17x), so
 * sessions sit falsely cost-stopped with `costSpentUsd` ≫ ceiling; the fix stopped
 * the over-count going forward but RETAINED the inflated figure. This corrects it
 * to the oracle the host passes in `targetSpentCents`.
 *
 * Structurally a sibling of `applySetCeilingOverride`: it ALWAYS sends a receipt
 * (`cost_reconcile_result`) so the host's ledger row can reach a terminal state,
 * uses the SAME epoch/ceiling compare-and-set, rotates `costBudgetGen` on every
 * successful apply (so a redelivered copy of THIS request, or a stale legacy
 * override, refuses itself), and commits state+receipt+ack in one transaction.
 *
 * Money-safety invariants (pinned by `poll-loop.reconcile.test.ts`):
 *   - THREE-leg compare-and-set: `expectedEpochKey`, `expectedCeilingCents`, AND
 *     `expectedSpentCents` must all match live state, or the request is a
 *     `conflict` — never partially applied. The spend leg is what makes the
 *     absolute set safe: a turn that accrued between the host's read and here
 *     moves live spend, so the reconcile refuses rather than erasing that accrual.
 *   - Lower-only: `targetSpentCents` may not exceed `expectedSpentCents` (the
 *     #1327 basis only ever OVER-counted), so a reconcile can never raise
 *     enforcement or stop a healthy session. Enforced here, independent of the host.
 *   - `costSpentUsd` is set VERBATIM to `targetSpentCents/100` — never clamped.
 *   - Stop state: a correction that leaves spend at/over the ceiling stays stopped
 *     at the exact value; one that drops below clears the CEILING hard-stop but
 *     PRESERVES an explicit human `stop` decision (a reconcile must not resurrect a
 *     session a human deliberately stopped). No "you were resumed" nudge. A drop
 *     below the Tier-1 cap re-arms `escalatedAt` so the next crossing still fires.
 *   - The persisted blob keeps `accountingVersion:2` and the #65 ledger identity
 *     (it is built by `buildCostCapState`, not the minimal set-ceiling blob), so a
 *     later respawn does not spuriously re-log the #1327 upgrade or re-seed the
 *     ledger baseline.
 */
function applyReconcileOverride(msg: MessageInRow, parsed: CostOverrideContent): void {
  const adjustmentId = typeof parsed.adjustmentId === 'string' && parsed.adjustmentId ? parsed.adjustmentId : undefined;
  if (!adjustmentId) {
    log(`reconcile control with missing/invalid adjustmentId — cannot address a receipt, ignoring (id=${msg.id})`);
    return;
  }

  const sessionId = process.env.NANOCLAW_SESSION_ID || '';
  const requestExpectedEpochKey =
    typeof parsed.expectedEpochKey === 'string' ? parsed.expectedEpochKey : String(parsed.expectedEpochKey ?? '');
  const requestExpectedCeilingCents = Number(parsed.expectedCeilingCents);
  const requestExpectedSpentCents = Number(parsed.expectedSpentCents);
  const requestTargetSpentCents = Number(parsed.targetSpentCents);
  // Audit passthrough only — the host relaxed the card fence; the runner applies no
  // card logic. Echoed in every receipt so a forced correction is traceable.
  const requestForced = parsed.forced === true;

  const commitOrThrow = (receipt: CostReconcileReceipt, newCostCap: CostCapState | undefined, logMsg: string): void => {
    try {
      commitCostReconcileOutcome({ inboundMessageId: msg.id, receipt, newCostCap });
      log(logMsg);
    } catch (err) {
      log(`reconcile: atomic commit FAILED for adjustment ${adjustmentId} — NOT acking (id=${msg.id}): ${String(err)}`);
      throw err;
    }
  };

  const reject = (reason: 'immortal' | 'cost_tracking_disabled' | 'invalid_value'): void => {
    const receipt: CostReconcileReceipt = {
      action: 'cost_reconcile_result',
      protocolVersion: 2,
      adjustmentId,
      sessionId,
      outcome: 'rejected',
      expectedEpochKey: requestExpectedEpochKey,
      expectedCeilingCents: Number.isFinite(requestExpectedCeilingCents) ? requestExpectedCeilingCents : 0,
      expectedSpentCents: Number.isFinite(requestExpectedSpentCents) ? requestExpectedSpentCents : 0,
      targetSpentCents: Number.isFinite(requestTargetSpentCents) ? requestTargetSpentCents : 0,
      forced: requestForced,
      reason,
      ...(costEnabled
        ? {
            resultEpochKey: String(costBudgetGen),
            resultCeilingCents: Math.round(costCeilingUsd * 100),
            resultSpentCents: Math.round(costSpentUsd * 100),
            spentUsd: Number(costSpentUsd.toFixed(4)),
            status: computeCostStatus(),
          }
        : {}),
    };
    commitOrThrow(receipt, undefined, `reconcile REJECTED (${reason}) for adjustment ${adjustmentId} (id=${msg.id})`);
  };

  if (!costEnabled) return reject('cost_tracking_disabled');
  if (costImmortal) return reject('immortal');

  const validEpoch = requestExpectedEpochKey.length > 0;
  const validExpectedCeilingCents = Number.isInteger(requestExpectedCeilingCents) && requestExpectedCeilingCents >= 0;
  const validExpectedSpentCents =
    Number.isInteger(requestExpectedSpentCents) &&
    requestExpectedSpentCents >= 0 &&
    requestExpectedSpentCents <= MAX_SPENT_CENTS;
  const validTargetCents =
    Number.isInteger(requestTargetSpentCents) &&
    requestTargetSpentCents >= 0 &&
    requestTargetSpentCents <= MAX_SPENT_CENTS;
  if (!validEpoch || !validExpectedCeilingCents || !validExpectedSpentCents || !validTargetCents) {
    return reject('invalid_value');
  }
  // Lower-only: reconcile corrects the #1327 OVER-count, so the target can never
  // exceed the spend it is correcting. Independent of the host's identical check —
  // the runner never trusts the control message to have already enforced it.
  if (requestTargetSpentCents > requestExpectedSpentCents) return reject('invalid_value');

  const liveCeilingCents = Math.round(costCeilingUsd * 100);
  const liveSpentCents = Math.round(costSpentUsd * 100);
  const epochMatches = requestExpectedEpochKey === String(costBudgetGen);
  const ceilingMatches = requestExpectedCeilingCents === liveCeilingCents;
  // Third CAS leg: the spend the host read must still be live. A reconcile is an
  // ABSOLUTE set, so applying it against a DIFFERENT current spend (a turn accrued
  // between the host read and now) would silently erase that legitimate accrual —
  // refuse instead, and the operator re-reads the oracle and retries.
  const spentMatches = requestExpectedSpentCents === liveSpentCents;

  if (!epochMatches || !ceilingMatches || !spentMatches) {
    const reason = !epochMatches ? 'epoch_mismatch' : !ceilingMatches ? 'ceiling_mismatch' : 'spent_mismatch';
    const receipt: CostReconcileReceipt = {
      action: 'cost_reconcile_result',
      protocolVersion: 2,
      adjustmentId,
      sessionId,
      outcome: 'conflict',
      expectedEpochKey: requestExpectedEpochKey,
      expectedCeilingCents: requestExpectedCeilingCents,
      expectedSpentCents: requestExpectedSpentCents,
      targetSpentCents: requestTargetSpentCents,
      forced: requestForced,
      reason,
      resultEpochKey: String(costBudgetGen),
      resultCeilingCents: liveCeilingCents,
      resultSpentCents: liveSpentCents,
      spentUsd: Number(costSpentUsd.toFixed(4)),
      status: computeCostStatus(),
    };
    commitOrThrow(
      receipt,
      undefined,
      `reconcile CONFLICT (${reason}) for adjustment ${adjustmentId}: expected epoch=${requestExpectedEpochKey}/` +
        `ceiling=${requestExpectedCeilingCents}¢/spent=${requestExpectedSpentCents}¢, live epoch=${costBudgetGen}/` +
        `ceiling=${liveCeilingCents}¢/spent=${liveSpentCents}¢ (id=${msg.id})`,
    );
    return;
  }

  // MATCHED — apply the correction against live state.
  const previousEpochKey = String(costBudgetGen);
  const previousSpentCents = Math.round(costSpentUsd * 100);

  costSpentUsd = requestTargetSpentCents / 100;
  // Rotate on EVERY successful apply — fences a redelivered copy of THIS request
  // and any stale legacy override still carrying the OLD epoch.
  costBudgetGen++;
  costEpisodeId = undefined;

  if (!costImmortal && costCeilingUsd > 0 && costSpentUsd >= costCeilingUsd) {
    // Still at/over the ceiling after the correction — stay (or remain) stopped.
    costCeilingHardStop = true;
    costStopRequested = true;
  } else {
    // The correction brought spend under the ceiling — clear the CEILING-derived
    // hard stop. But do NOT resurrect a session a human explicitly STOPPED: that
    // decision is unrelated to the inflated number, so preserve it. Only an
    // auto/ceiling stop (no human 'stop' decision on file) resumes. No nudge:
    // this is an accounting correction, not a human raising the budget.
    costCeilingHardStop = false;
    if (costDecision !== 'stop') costStopRequested = false;
  }
  // Re-arm the one-shot Tier-1 cap escalation if the correction dropped spend back
  // under the cap — otherwise a latched `escalatedAt` would silence the next
  // genuine cap crossing. (Leave it set when still at/over the cap, so a session
  // that is still escalated does not immediately re-fire.)
  if (costSpentUsd < costCapUsd) costEscalatedAt = undefined;

  const status = computeCostStatus();
  // The FULL state (accountingVersion + #65 ledger identity), not the minimal
  // set-ceiling blob — a reconcile is precisely the #1327 accounting correction,
  // so the persisted row must land on the v2 basis.
  const newState = buildCostCapState();

  const receipt: CostReconcileReceipt = {
    action: 'cost_reconcile_result',
    protocolVersion: 2,
    adjustmentId,
    sessionId,
    outcome: 'applied',
    expectedEpochKey: requestExpectedEpochKey,
    previousEpochKey,
    resultEpochKey: String(costBudgetGen),
    expectedCeilingCents: requestExpectedCeilingCents,
    resultCeilingCents: liveCeilingCents, // unchanged by a reconcile
    expectedSpentCents: requestExpectedSpentCents,
    targetSpentCents: requestTargetSpentCents,
    forced: requestForced,
    previousSpentCents,
    resultSpentCents: Math.round(costSpentUsd * 100),
    spentUsd: Number(costSpentUsd.toFixed(4)),
    status,
  };

  commitOrThrow(
    receipt,
    newState,
    `reconcile APPLIED for adjustment ${adjustmentId}: spent $${(previousSpentCents / 100).toFixed(2)} -> ` +
      `$${costSpentUsd.toFixed(2)} (ceiling $${costCeilingUsd.toFixed(2)} unchanged), status=${status} (id=${msg.id})`,
  );
}

/**
 * Test-only seam for the per-session cost state machine (ADDITIVE — no runtime
 * path references this). The cost functions and their accumulator are
 * module-private singletons because the accounting happens inside processQuery's
 * event loop; that makes them unreachable from a unit test without a hook. This
 * bundle exposes the pure transitions plus a get/set for the module globals so
 * `poll-loop.cost.test.ts` can drive crossings (cap, ceiling, day rollover,
 * overrides, reset) directly. It changes no behavior.
 */
export const __costCapTestHooks = {
  recordTurnCost,
  recordMessageCost,
  noteMessageMissingUsage,
  resetTurnAccountingState,
  foldCodexCost,
  computeCostStatus,
  costCeilingRemainingUsd,
  applyCostOverride,
  resetCostForNewSession,
  initCostTracking,
  emitCostEscalation,
  publishRunnerReadiness,
  persistCostCap,
  reconcileLedger,
  getState: () => ({
    costEnabled,
    costImmortal,
    costWindow,
    costDayKey,
    costAllotmentUsd,
    costCapUsd,
    costSpentUsd,
    costEscalatedAt,
    costDecision,
    costDecidedAt,
    costStopRequested,
    costCeilingUsd,
    costCeilingAllotmentUsd,
    costCeilingEscalated,
    costCeilingHardStop,
    costBudgetGen,
    costEpisodeId,
    pendingCostNudge,
    codexLedger,
    codexUsdCharged,
    codexLedgerBaselinePending,
    ledgerGen,
    ledgerAdjSeq,
    ledgerBaselinePending,
    ledgerBaselineVersion,
    seenMessageIdCount: seenMessageIds.size,
    turnSawMessageUsage,
    turnMessageCostUsd,
    turnUnpricedCount,
    turnMissingIdCount,
    turnNoUsageCount,
    codexEventOwners: Object.fromEntries(codexEventOwners),
  }),
  setState: (p: {
    costEnabled?: boolean;
    costImmortal?: boolean;
    costWindow?: CostCapWindow;
    costDayKey?: string | undefined;
    costAllotmentUsd?: number;
    costCapUsd?: number;
    costSpentUsd?: number;
    costEscalatedAt?: string | undefined;
    costDecision?: 'continue' | 'stop' | undefined;
    costDecidedAt?: string | undefined;
    costStopRequested?: boolean;
    costCeilingUsd?: number;
    costCeilingAllotmentUsd?: number;
    costCeilingEscalated?: boolean;
    costCeilingHardStop?: boolean;
    costBudgetGen?: number;
    costEpisodeId?: string | undefined;
    pendingCostNudge?: string | undefined;
    codexLedger?: Record<string, number>;
    codexUsdCharged?: number;
    codexLedgerBaselinePending?: boolean;
    ledgerGen?: number;
    ledgerAdjSeq?: number;
    ledgerBaselinePending?: boolean;
    ledgerBaselineVersion?: number | undefined;
    seenMessageIds?: string[];
    turnSawMessageUsage?: boolean;
    turnMessageCostUsd?: number;
    turnUnpricedCount?: number;
    turnMissingIdCount?: number;
    turnNoUsageCount?: number;
    codexEventOwners?: Record<string, string>;
  }): void => {
    if ('costEnabled' in p) costEnabled = p.costEnabled!;
    if ('costImmortal' in p) costImmortal = p.costImmortal!;
    if ('costWindow' in p) costWindow = p.costWindow!;
    if ('costDayKey' in p) costDayKey = p.costDayKey;
    if ('costAllotmentUsd' in p) costAllotmentUsd = p.costAllotmentUsd!;
    if ('costCapUsd' in p) costCapUsd = p.costCapUsd!;
    if ('costSpentUsd' in p) costSpentUsd = p.costSpentUsd!;
    if ('costEscalatedAt' in p) costEscalatedAt = p.costEscalatedAt;
    if ('costDecision' in p) costDecision = p.costDecision;
    if ('costDecidedAt' in p) costDecidedAt = p.costDecidedAt;
    if ('costStopRequested' in p) costStopRequested = p.costStopRequested!;
    if ('costCeilingUsd' in p) costCeilingUsd = p.costCeilingUsd!;
    if ('costCeilingAllotmentUsd' in p) costCeilingAllotmentUsd = p.costCeilingAllotmentUsd!;
    if ('costCeilingEscalated' in p) costCeilingEscalated = p.costCeilingEscalated!;
    if ('costCeilingHardStop' in p) costCeilingHardStop = p.costCeilingHardStop!;
    if ('costBudgetGen' in p) costBudgetGen = p.costBudgetGen!;
    if ('costEpisodeId' in p) costEpisodeId = p.costEpisodeId;
    if ('pendingCostNudge' in p) pendingCostNudge = p.pendingCostNudge;
    if ('codexLedger' in p) codexLedger = { ...p.codexLedger! };
    if ('codexUsdCharged' in p) codexUsdCharged = p.codexUsdCharged!;
    if ('codexLedgerBaselinePending' in p) codexLedgerBaselinePending = p.codexLedgerBaselinePending!;
    if ('ledgerGen' in p) ledgerGen = p.ledgerGen!;
    if ('ledgerAdjSeq' in p) ledgerAdjSeq = p.ledgerAdjSeq!;
    if ('ledgerBaselinePending' in p) ledgerBaselinePending = p.ledgerBaselinePending!;
    if ('ledgerBaselineVersion' in p) ledgerBaselineVersion = p.ledgerBaselineVersion;
    if ('seenMessageIds' in p) {
      seenMessageIds.clear();
      for (const id of p.seenMessageIds!) seenMessageIds.add(id);
    }
    if ('turnSawMessageUsage' in p) turnSawMessageUsage = p.turnSawMessageUsage!;
    if ('turnMessageCostUsd' in p) turnMessageCostUsd = p.turnMessageCostUsd!;
    if ('turnUnpricedCount' in p) turnUnpricedCount = p.turnUnpricedCount!;
    if ('turnMissingIdCount' in p) turnMissingIdCount = p.turnMissingIdCount!;
    if ('turnNoUsageCount' in p) turnNoUsageCount = p.turnNoUsageCount!;
    if ('codexEventOwners' in p) codexEventOwners = new Map(Object.entries(p.codexEventOwners!));
  },
};

/**
 * User-facing notice for a turn that produced nothing at all, even after the
 * re-send nudge. Delivered so the thread reports the failure instead of just
 * stopping — the whole point of the silent-turn path.
 */
const SILENT_TURN_NOTICE =
  'The agent finished its turn without producing any output, so there is nothing to deliver. ' +
  'Your message was not answered — please re-send it.';

// Delivered when a native-codex session hard-stops at the Tier-2 ceiling while a
// corrective delivery retry is still queued (#1360 re-review). The retry can't
// run (the hard stop tears the app-server down), so the answer is withheld — but
// the inbound row is marked FAILED, not completed, so it stays reclaimable.
const COST_CEILING_WITHHELD_NOTICE =
  'This session reached its cost ceiling before your answer could be re-sent, so the reply was withheld. ' +
  'It is recorded as unfinished (not silently dropped) — resume the session, or raise the ceiling, to get the answer.';

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 *
 * The LIVE classification the poll loop acts on now belongs to the mailbox
 * driver (`SqliteAgentMailbox.shouldRestartAfter`) — a non-SQLite driver has
 * its own idea of "needs a fresh runner". This predicate is kept as the
 * SQLite-specific statement of the symptom for callers that hold a bare
 * message string rather than a mailbox.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/**
 * Mirror an overlay event to the dashboard's hook-event ingest. Same
 * shape the universal SDK PostToolUse curl uses, with `tool_name="overlay"`
 * and an `event` namespace prefix so the timeline can filter / colorize.
 *
 * Container-runner sets `NANOCLAW_HOOK_URL` when the dashboard is
 * configured; empty value → silent no-op (dashboards don't exist on every
 * install). Errors are swallowed: this is observability, not control flow.
 */
function postOverlayEvent(event: string, extra: Record<string, unknown> = {}): void {
  const url = process.env.NANOCLAW_HOOK_URL;
  if (!url) return;
  const payload = JSON.stringify({
    hook_event_name: event,
    tool_name: 'overlay',
    session_id: process.env.NANOCLAW_SESSION_ID ?? '',
    thread_id: process.env.NANOCLAW_SESSION_THREAD_ID ?? '',
    group: process.env.NANOCLAW_GROUP_FOLDER ?? '',
    ...extra,
  });
  // Fire-and-forget — do not await, do not block dispatch on a slow
  // dashboard. The host curl runs as a child process so we get the same
  // proxy-bypass behavior as the universal hook.
  try {
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn(
      'curl',
      [
        '-sf',
        '--proxy',
        '',
        '-X',
        'POST',
        url,
        '-H',
        'Content-Type: application/json',
        '-H',
        `X-Group-Folder: ${process.env.NANOCLAW_GROUP_FOLDER ?? ''}`,
        '-H',
        `X-NanoClaw-Session-Id: ${process.env.NANOCLAW_SESSION_ID ?? ''}`,
        '-H',
        `X-NanoClaw-Session-Thread-Id: ${process.env.NANOCLAW_SESSION_THREAD_ID ?? ''}`,
        '-d',
        payload,
        '--max-time',
        '3',
      ],
      { stdio: 'ignore', detached: true },
    );
    child.unref();
    child.on('error', () => {});
  } catch {
    // ignore — observability is best-effort
  }
}

/**
 * True iff the message is a scheduled task that explicitly OPTS OUT of the
 * fresh-session default by setting `content.new_session === false`. The
 * default across the system is now fresh-session-on for recurring task
 * batches (see isNewSessionBatch); tasks that genuinely need the stored
 * continuation (chained workflows that carry state in conversation memory,
 * rather than in files) must opt out explicitly.
 *
 * Strict `=== false` matters — an absent key or `true` both participate in
 * the default; only an explicit `false` blocks it. Swallows malformed JSON
 * rather than throwing.
 */
export function taskOptsOutOfNewSession(m: { kind: string; content: string }): boolean {
  if (m.kind !== 'task') return false;
  try {
    return (JSON.parse(m.content) as Record<string, unknown>).new_session === false;
  } catch {
    return false;
  }
}

/**
 * Decide whether a THROWN turn error (outer-catch path) should bounce the a2a
 * trigger for host redrive.
 *
 * The structured-isError bounce in processQuery only fires when the provider
 * YIELDS a result event. A transport death — the SDK's readMessages stream
 * erroring mid-read (e.g. "Connection closed mid-response", ECONNRESET) — is
 * re-raised as a thrown Error instead and lands in runPollLoop's outer catch,
 * bypassing that bounce (the #12108 drop). This re-arms those for host redrive.
 *
 * CRITICAL asymmetry with the result branch: that branch is gated on
 * `event.isError === true`, which PROVES the provider turn itself failed and
 * produced no output — so it can safely bounce even an `unknown` error. The
 * thrown path has NO such proof. A throw reaching this catch can be a genuine
 * provider transport death OR a LOCAL runner exception raised AFTER
 * dispatchResultText already wrote outbound rows (e.g. a downstream throw in
 * the result branch). Bouncing the latter would redrive the trigger and
 * DUPLICATE already-delivered peer messages. So the thrown path only bounces
 * errors we POSITIVELY recognize as transient provider/transport shapes
 * (classifyTurnError === 'transient'); `unknown` and `permanent` both fall
 * through to the unchanged relay+complete path. This is allowlist-driven on
 * purpose — an unrecognized throw is treated as possibly-local, not redriven.
 *
 *   - non-`agent` channel  → null  (never bounce; deliver the notice as today)
 *   - transient error text → 'bounced-transient'  (known provider/transport outage)
 *   - unknown / permanent  → null  (may be a local post-delivery throw — do NOT redrive)
 *
 * Returns 'bounced-transient' to bounce, or null when the turn must NOT bounce.
 */
export function classifyThrownBounce(channelType: string | null, errMsg: string): 'bounced-transient' | null {
  if (channelType !== 'agent') return null;
  return classifyTurnError(errMsg) === 'transient' ? 'bounced-transient' : null;
}

/**
 * Default-on fresh-session policy for recurring task batches:
 *   - Empty batch: false (defensive — no spurious fresh sessions).
 *   - Any chat in the batch: false (mixed batches preserve chat history).
 *   - All-tasks AND at least one opts out via `new_session: false`: false
 *     (safer to preserve continuity than drop it when any task asks).
 *   - All-tasks AND none opts out: true (the common heartbeat/cron case,
 *     now the default without any flag needing to be set).
 *
 * Historical note: PR #58 introduced opt-in (`new_session: true`); PR #106
 * fixed the follow-up-push bypass; empirical prod rollout (slang-discord-
 * support: $0.57 after flip vs $1.00 before, on 11 turns vs 3) confirmed
 * the delta is real enough to make opt-out the sane default.
 */
export function isNewSessionBatch(keep: Array<{ kind: string; content: string }>): boolean {
  return keep.length > 0 && keep.every((m) => m.kind === 'task') && !keep.some(taskOptsOutOfNewSession);
}

/**
 * Idle cap for providers with no transcript of their own to rotate. Mirrors the
 * Claude age knob's default and its disable semantics (non-positive = off).
 */
function continuationMaxIdleMs(): number {
  const raw = process.env.CONTINUATION_MAX_IDLE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  return days > 0 ? days * 86_400_000 : Infinity;
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a per-loop refresher for the destinations section of the system
 * prompt. The host re-projects `inbound.db::destinations` whenever a new
 * coworker is wired up (dashboard/server.ts → refreshRunningSessions),
 * but Claude SDK pins the system prompt at the initial query and never
 * re-reads it for `query.push()` follow-ups. Two-part fix:
 *
 *   1. Always update `systemContext.instructions` so the NEXT fresh query
 *      starts with the current destinations list.
 *   2. Return an inline `[System: destinations updated …]` block that the
 *      caller prepends to the pushed prompt so the agent sees the live
 *      list even while the frozen system prompt is stale.
 *
 * Returns null (no inline note needed) when destinations haven't changed
 * since the last call, or on the very first call (seed observation —
 * otherwise every container's first push carries a redundant note).
 */
function makeDestinationsRefresher(systemContext: PollLoopConfig['systemContext']): () => string | null {
  let last: string | null = null;
  return () => {
    const fp = getDestinationsFingerprint();
    if (fp === last) return null;
    const firstCall = last === null;
    last = fp;
    // Rebuild through the runner's own builder, not a bare
    // buildSystemPromptAddendum(): that loses the assistant name, the task-vs-chat
    // mode, and (for hookless providers) the memory section. This refresher runs
    // once before the very first query, so anything it drops is never sent at all.
    if (systemContext) systemContext.instructions = systemContext.rebuild();
    if (firstCall) return null;
    log('Destinations changed — refreshed system prompt + push-block');
    return buildDestinationsPushNote();
  };
}

/** Inline system note listing current destinations; prepended to pushed prompts. */
function buildDestinationsPushNote(): string {
  const all = getAllDestinations();
  if (all.length === 0) {
    return '\n[System: destinations updated — you currently have no configured destinations.]\n\n';
  }
  const names = all
    .map((d) => (d.displayName && d.displayName !== d.name ? `${d.name} (${d.displayName})` : d.name))
    .map((s) => `  - ${s}`)
    .join('\n');
  return (
    '\n[System: destinations list updated since your previous turn. Current list:\n' +
    names +
    '\nUse THIS list, not any earlier mention. No restart is needed.]\n\n'
  );
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
    /**
     * Recompute `instructions` from scratch. Owned by the runner because only it
     * knows the assistant name, the session mode, and whether this provider needs
     * the memory section — and because memory must be re-read, not cached: the
     * agent edits its own memory mid-session, and a pinned boot-time copy would
     * go stale for the rest of the container's life.
     */
    rebuild(): string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
  /** Test seam: shorten active-query follow-up polling without changing prod. */
  activePollIntervalMs?: number;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll the mailbox for pending messages
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write outbound messages
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    let rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    // Providers whose history lives server-side legitimately omit that hook
    // (providers/types.ts) — there is no local transcript to measure. They were
    // therefore never rotated at all, at any age. Codex resumed a thread last
    // touched seven weeks earlier on 2026-07-17, returned task_complete with
    // last_agent_message null, and the thread went silent.
    //
    // Only applied when the provider has no rotation of its own, so a
    // file-based provider can never be double-rotated by this. Idle age comes
    // from session_state's existing per-write timestamp — no new bookkeeping,
    // and no size cap: bytes are meaningless when the transcript is not local.
    if (!rotateReason && !config.provider.maybeRotateContinuation) {
      const ageMs = getContinuationAgeMs(config.providerName);
      const maxIdleMs = continuationMaxIdleMs();
      if (ageMs !== null && ageMs > maxIdleMs) {
        rotateReason = `continuation idle ${(ageMs / 86_400_000).toFixed(1)}d > ${(maxIdleMs / 86_400_000).toFixed(0)}d cap`;
      }
    }
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  // Runner-instance readiness handshake (NanoClaw #1, "set ceiling v2") —
  // publish before anything else so the host's post-wake readiness poll finds
  // it as soon as possible.
  publishRunnerReadiness();

  // Cost cap (NanoClaw #1): load persisted spend so the cap survives respawns,
  // and publish the current cap state for the dashboard. Provider name gates
  // enablement — Claude (usage events + codex fold) and native codex (rollout
  // fold at the poll and result boundaries) are metered; any other provider has
  // no accounting source and stays disabled.
  initCostTracking(config.providerName);

  const refreshDestinations = makeDestinationsRefresher(config.systemContext);

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Roll the immortal daily window on the poll tick itself, BEFORE the
    // empty-batch and accumulate-only `continue`s below — otherwise a session
    // that goes idle across a UTC midnight keeps publishing yesterday's
    // dayKey/spentUsd/codexUsd in its DB row until the next real message
    // happens to drive an accrual. Independent of codex scan health (unlike
    // the fold-path rollover), so a scan that throws can't strand the day.
    if (maybeRollDailyWindow()) persistCostCap();
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold through countDueMessages().
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Settle codex (MCP tool) spend from the PREVIOUS turn BEFORE the quiesce
    // gate below (issue #1327). Order matters: fold later and a session that
    // blew its ceiling purely on codex would claim this batch and start another
    // turn with $0.01 of headroom before anyone noticed. Folding here means the
    // crossing sets `costStopRequested`, the gate immediately below leaves the
    // rows `pending`, and the ceiling headroom handed to the provider
    // (`maxBudgetUsd`) is computed from a spend figure that includes codex.
    foldCodexCost();

    // Cost-cap quiesce (NanoClaw #1): after a 'stop' override, take no NEW
    // work — but still process any `cost_override` control rows so a later
    // 'continue' can resume. Normal messages are left `pending` (never
    // markProcessing'd) so they run once the session resumes.
    if (costStopRequested) {
      // Recovery out of a cost stop is TWO-WAY: a cost_override 'continue' (the
      // dashboard button) OR an explicit /clear. A /clear clears the stop and
      // falls through to the normal command path below (which resets the window
      // + continuation). Everything else stays pending until the session resumes.
      const hasClear = messages.some((m) => (m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m));
      if (!hasClear) {
        const controls = messages.filter((m) => m.kind === 'cost_override');
        if (controls.length === 0) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const controlIds = controls.map((m) => m.id);
        markProcessing(controlIds);
        for (const c of controls) applyCostOverride(c);
        markCompleted(controlIds);
        continue;
      }
      // /clear present → drop the quiesce and let the normal loop reset us.
      costStopRequested = false;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      // Cost-cap override (NanoClaw #1): a human decision from the dashboard.
      // Applied to the in-memory cost state and acked — never fed to the agent.
      if (msg.kind === 'cost_override') {
        applyCostOverride(msg);
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        // /clear is a genuine restart — zero the lifetime cost window too so the
        // fresh conversation starts on a fresh allotment (no-op for daily).
        resetCostForNewSession();
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      // isSessionEcho guard: a copied "/upload-trace" from another session is
      // ambient context, never a runner command (isClearCommand self-guards).
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && !isSessionEcho(msg) && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: Array<{ id: string; reason: string }> = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markScriptSkipped(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.map((s) => s.id).join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Scheduled tasks with new_session:true run in a fresh context so
    // heartbeat/cron history doesn't accumulate across runs. Only applies
    // when the entire batch is tasks (no chat messages mixed in) — mixed
    // batches default to the stored continuation so chat history is preserved.
    const newSessionBatch = isNewSessionBatch(keep);
    // A fresh-session batch starts the conversation over — reset the lifetime
    // cost window to a new allotment (no-op for the immortal daily window).
    if (newSessionBatch) resetCostForNewSession();

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    let prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    // A ceiling-continue queued a one-shot cost-sensitivity note — this is the
    // first real turn since, so prepend it. cost_override rows are never fed to
    // the agent directly (see applyCostOverride), so it has to ride here instead.
    if (pendingCostNudge) {
      prompt = `<system>${pendingCostNudge}</system>\n\n${prompt}`;
      pendingCostNudge = undefined;
    }

    // Non-native providers: run intent router on the initial prompt too.
    // Claude SDK fires UserPromptSubmit hooks natively; for Codex/OpenCode
    // we call the same bridge so workflow classification applies to every
    // user message regardless of provider.
    if (!config.provider.supportsNativeSlashCommands) {
      prompt = await classifyAndPrepend(prompt);
    }

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);
    if (newSessionBatch) log('new_session flag set — running task in fresh context');

    // Pick up destination changes the host wrote mid-session so the agent
    // sees new coworkers without requiring a container restart.
    refreshDestinations();

    // Defensive reset before a NEW query starts — see resetTurnAccountingState's
    // doc comment for why this call site matters (a thrown/aborted turn never
    // reaches recordTurnCost's own reset).
    resetTurnAccountingState();

    const query = config.provider.query({
      prompt,
      continuation: newSessionBatch ? undefined : continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
      // Tier-2 ceiling soft-brake for THIS turn (undefined when no ceiling applies).
      maxBudgetUsd: costCeilingRemainingUsd(),
    });
    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped.map((s) => s.id));
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    let queryResult: QueryResult | undefined;
    // Trigger ids bounced via the THROWN-error path (outer catch) this turn.
    // Kept separate from queryResult.bouncedIds because a throw means
    // processQuery never returned a result to carry them.
    let thrownBouncedIds: string[] = [];
    // Forward a loop stop to the ACTIVE query. The stream deliberately stays
    // open between turns, so the loop can be parked inside processQuery when
    // config.signal fires; without this, the "stopped" loop's query — and its
    // 500ms follow-up poller — outlives the stop and keeps polling (and
    // claiming) messages from whatever inbound DB the process points at. In
    // tests that leaked one immortal poller per loop-driven test, which could
    // steal a later test's follow-up message into a dead query.
    // Belt-and-braces with the signal processQuery registers internally: only
    // this one covers a signal that is ALREADY aborted at query-start.
    const abortActiveQuery = () => query.abort();
    if (config.signal?.aborted) abortActiveQuery();
    else config.signal?.addEventListener('abort', abortActiveQuery, { once: true });
    try {
      queryResult = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
        config.provider.emitsMidTurnText === true,
        config.signal,
        config.activePollIntervalMs,
        newSessionBatch,
        refreshDestinations,
      );
      // Don't overwrite the stored chat continuation with a task's ephemeral session.
      if (!newSessionBatch && queryResult.continuation && queryResult.continuation !== continuation) {
        continuation = queryResult.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // a2a bounce on the THROWN-error path (#12108). The structured-isError
      // bounce in processQuery only fires when the provider YIELDS a result
      // event. But a transport death — the SDK's readMessages stream erroring
      // mid-read (e.g. "Connection closed mid-response", ECONNRESET) — is
      // re-raised as `Error("Claude Code returned an error result: <text>")`
      // and lands HERE instead, bypassing that bounce. Without this, such a
      // turn relayed the raw error to the peer and was acked completed
      // (tries=0), permanently consuming an un-actioned a2a handoff — the exact
      // #12108 drop. classifyThrownBounce mirrors the result-branch decision:
      // on an `agent` edge a transient/unknown error bounces (trigger left
      // un-acked for the host redrive sweep, blip NOT relayed to the peer);
      // permanent errors and non-a2a channels fall through to the unchanged
      // write-error-and-complete path.
      const thrownBounce = classifyThrownBounce(routing.channelType, errMsg);
      if (thrownBounce) {
        markBounced(processingIds, thrownBounce);
        thrownBouncedIds = processingIds;
        log(
          `a2a thrown-error bounce (${thrownBounce}) — trigger left pending for host redrive: ` + errMsg.slice(0, 80),
        );
      } else {
        // Write error response so the user knows something went wrong
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: `Error: ${errMsg}` }),
        });

        // The batch is still acked completed below (no redelivery). Without
        // this line the only log trace of the errored turn is "Query error"
        // followed by a "Completed" line that reads like success.
        log(`Errored batch will be acked completed — ${processingIds.length} message(s), no redelivery`);
      }
    } finally {
      clearCurrentInReplyTo();
      config.signal?.removeEventListener('abort', abortActiveQuery);
    }

    // A caller-requested stop is not a completed turn. If the query already
    // produced a result, processQuery handled its normal ack; otherwise leave the
    // processing claim for the next container/test loop to reset instead of
    // consuming an unanswered message.
    if (config.signal?.aborted) return;

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly). EXCLUDE any ids marked as a transient
    // a2a bounce — completing them here would clobber the 'bounced-*' marker
    // back to 'completed' and permanently consume the un-actioned handoff. This
    // covers both bounce paths: the structured-result bounce (queryResult.
    // bouncedIds) and the thrown-error bounce (thrownBouncedIds) above.
    // Silent turns (queryResult.undeliveredIds) are excluded for the same
    // reason: they were acked 'failed' after delivering a failure notice, and
    // overwriting that with 'completed' is exactly how the silence used to
    // disappear from the record.
    const skipAck = new Set([
      ...(queryResult?.bouncedIds ?? []),
      ...(queryResult?.undeliveredIds ?? []),
      ...thrownBouncedIds,
    ]);
    const ackedIds = processingIds.filter((id) => !skipAck.has(id));
    markCompleted(ackedIds);
    log(
      skipAck.size > 0
        ? `Completed ${ackedIds.length} message(s); ${skipAck.size} NOT completed (bounced or undelivered)`
        : `Completed ${ids.length} message(s)`,
    );
  }
}

/**
 * For non-native providers, resolve a slash command to its SKILL.md body.
 * Claude Code's SDK loads SKILL.md on demand via its Skill tool; for Codex
 * and other providers we inject the body directly into the prompt so the
 * agent gets the same information without needing to `cat` the file.
 */
function resolveSkillBody(command: string): string | null {
  const skillName = command.replace(/^\//, '').split(/\s/)[0];
  if (!skillName) return null;

  const agentDirs: string[] = [];
  try {
    agentDirs.push(...fs.readdirSync('/workspace/agent'));
  } catch {
    /* /workspace/agent may not exist */
  }

  const candidates = [
    path.join('/home/node/.claude/skills', skillName, 'SKILL.md'),
    // Additional dirs: cloned repos may put skills under the agent workspace
    ...agentDirs.flatMap((dir) => {
      const p = path.join('/workspace/agent', dir, '.claude', 'skills', skillName, 'SKILL.md');
      return fs.existsSync(p) ? [p] : [];
    }),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      let body = fs.readFileSync(candidate, 'utf-8');
      // Strip YAML frontmatter
      body = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
      return body.trim();
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. For non-native providers, skill bodies are resolved and
 * injected so the agent gets the full SKILL.md content on invocation.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (msg.kind === 'chat' || msg.kind === 'chat-sdk') {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        if (nativeSlashCommands) {
          // Flush normal batch first
          if (normalBatch.length > 0) {
            parts.push(formatMessages(normalBatch));
            normalBatch.length = 0;
          }
          // Pass raw command text (no XML wrapping) — SDK handles it natively
          parts.push(cmdInfo.text);
          continue;
        }

        // Non-native provider: resolve SKILL.md body and inject it
        if (cmdInfo.category === 'passthrough') {
          const body = resolveSkillBody(cmdInfo.command);
          if (body) {
            if (normalBatch.length > 0) {
              parts.push(formatMessages(normalBatch));
              normalBatch.length = 0;
            }
            const args = cmdInfo.text.slice(cmdInfo.command.length).trim();
            parts.push(
              `<skill-invocation name="${cmdInfo.command.slice(1)}"${args ? ` args="${args}"` : ''}>\n${body}\n</skill-invocation>`,
            );
            continue;
          }
        }
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
  // Trigger ids that were marked as a transient a2a bounce (markBounced) this
  // turn instead of completed. The outer poll loop must EXCLUDE these from its
  // fallback markCompleted, or it would clobber the bounce marker back to
  // 'completed' and permanently consume the un-actioned handoff.
  bouncedIds?: string[];
  // Ids acked `failed` because the turn delivered nothing at all (see the
  // silent-turn branch in processQuery). Same contract as bouncedIds: the
  // outer loop's fallback markCompleted must skip them, or it would overwrite
  // the failure with 'completed' and the silence would go unrecorded again.
  undeliveredIds?: string[];
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined = undefined,
  initialPrompt = '',
  initialContinuation: string | undefined = undefined,
  /**
   * The provider's declared `emitsMidTurnText` capability (see
   * providers/types.ts). True → mid-turn streaming is the single content
   * door: complete <message> blocks deliver exactly once, at parse time from
   * streamed 'text' events (with cross-segment assembly of split blocks),
   * and the final result never delivers content — it only surfaces error
   * results and decides the wrap-nudge. False → text events are
   * delivery-inert and the final result stays the single delivery door.
   */
  emitsMidTurnText = false,
  signal?: AbortSignal,
  activePollIntervalMs = ACTIVE_POLL_INTERVAL_MS,
  skipPersistContinuation = false,
  refreshDestinations: () => string | null = () => null,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let lastEventTime = Date.now();
  let unwrappedNudged = false;
  // Once-per-turn guard for the task-run "<message> block was not delivered"
  // nudge — mirrors unwrappedNudged for chat turns.
  let taskBlockNudged = false;
  // Trigger ids marked as a transient a2a bounce this turn (see the result
  // branch). Returned so the outer loop's fallback markCompleted skips them.
  const bouncedIds: string[] = [];
  // Ids acked 'failed' by finalizeSilentTurn. Same contract as bouncedIds.
  const undeliveredIds: string[] = [];
  // Once-per-batch guard for the silent-turn re-send nudge, and the flag that
  // says a nudged turn is still awaiting its retry (so nothing is acked yet).
  let silentTurnNudged = false;
  let silentTurnOpen = false;
  // ONE-SHOT hard-stop deferral for native codex (#1360 re-review). When a turn
  // crosses the Tier-2 ceiling AND queued a corrective retry, the codex settle
  // defers the hard stop ONCE so that correction can run its own turn. Hoisted to
  // processQuery scope — deliberately NOT re-declared per result — so the
  // allowance cannot be re-armed turn after turn: a turn that keeps getting
  // gate-refused (the critique gate denies while awaiting approval) would
  // otherwise defer forever and spend past the ceiling without bound. The
  // correction's own result boundary then hard-stops regardless of what it queues.
  let ceilingDeferralUsed = false;
  // Outbound watermark at the start of the current turn. A turn that ends with
  // no text is only truly silent if this has not moved (see the silent-turn
  // branch); resampled after every result event.
  let turnWatermark = outboundWatermark();
  // Has ANY turn on this query answered the batch yet? The silent-turn
  // discriminator (`producedOutput`) is per-TURN, but its consequences —
  // SILENT_TURN_NOTICE and markFailed(initialBatchIds) — are per-BATCH. A
  // stream that delivers on turn 1 and then ends turn 2 empty (a trailing
  // tool call, a follow-up push) would otherwise tell the user their message
  // "was not answered" and ack the batch failed, after it had been answered.
  let batchDelivered = false;
  // How many <message> blocks were delivered from 'text' events this turn
  // (chat runs, emitsMidTurnText providers only). A frame-local count, never
  // keyed by content: it feeds the result door's nudge decision ("did this
  // turn deliver anything?"). Reset at the turn boundary (the 'result'
  // event) — NOT at the follow-up push seam: query.push() does not end the
  // in-flight turn, and its result's nudge decision still describes the
  // turn that is streaming.
  let midTurnSent = 0;
  // Outbound seq high-water mark at the turn boundary — a frame-local NUMBER,
  // not a content record. Two uses: (1) the mid-turn door recognizes a block
  // that is a verbatim repeat of a message already written to outbound.db
  // EARLIER THIS TURN by a previous streamed segment (live-observed: the
  // model re-emits the identical block as its final text after a trailing
  // tool call; delivering both copies is the double-send this design must
  // not reintroduce); (2) the result-door nudge decision asks "did ANYTHING
  // user-visible go out this turn?" — which must also see MCP send_message
  // rows the frame-local midTurnSent count never observes. The "have we sent
  // this?" truth lives in the outbound DB the door already writes to — no
  // in-process delivery ledger. Reset alongside midTurnSent at each result.
  let turnStartSeq = maxOutboundSeq();
  // Cross-segment assembly buffer: the unresolved TAIL of the previous text
  // event — an unclosed <message …> block (or a bare open-tag prefix like
  // "<mess" literally split mid-token), or an unclosed <internal span. Frame-
  // local and turn-local: it carries a fragment forward so a block opened in
  // one assistant message and closed in a later one delivers ONCE, mid-turn,
  // when its close arrives. Only the unresolved tail is ever carried —
  // settled text is consumed exactly once, so already-delivered blocks are
  // never re-matched. Dropped at the turn boundary: a block that never
  // closes anywhere is the wrap-nudge's job, not the buffer's.
  let midTurnTail = '';
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

  /**
   * Close out a turn that delivered nothing by any path: emit a durable,
   * user-visible notice (so the thread does not just stop) and ack the batch
   * 'failed' — never 'completed'. `failed` is deliberate: syncProcessingAcks
   * maps it onto the inbound row, so the silence is recorded once and the
   * message is not re-driven into an identical silent turn forever.
   */
  const finalizeSilentTurn = async (resultText: string | null): Promise<void> => {
    silentTurnOpen = false;
    log('Turn delivered nothing (no text, no outbound row) — acking failed, not completed');
    if (routing.channelType && routing.platformId && routing.channelType !== 'system') {
      await writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: SILENT_TURN_NOTICE }),
      });
    } else {
      log('No deliverable routing for the silent-turn notice — recorded in the log only');
    }
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: resultText,
      continuation: queryContinuation ?? initialContinuation,
      status: 'undelivered',
    });
    archivePrompts.shift();
    for (const id of initialBatchIds) markFailed(id);
    undeliveredIds.push(...initialBatchIds);
  };

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let mailboxFailureStreak = 0;
  const onSignalAbort = () => query.abort();
  signal?.addEventListener('abort', onSignalAbort, { once: true });
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses) and /clear (needs fresh query).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        //
        // Accumulated trigger=0 context rows must never be pushed into a live
        // turn on their own — the agent would answer ambient context that was
        // not addressed to it. They ride along only when a real trigger=1
        // follow-up is also pending; otherwise they stay pending for a future
        // batch (mirrors the two-phase initial-batch selection in
        // db/messages-in.ts).
        const hasFollowUpTrigger = pending.some((m) => m.kind !== 'system' && m.trigger === 1);
        const newMessages = pending.filter((m) => {
          if (m.kind === 'system') return false;
          if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
          return m.trigger === 1 || hasFollowUpTrigger;
        });

        // Cost-cap override mid-query (FIX #1): the router writes cost_override
        // with trigger:1, so without this it would fall through the trigger gate
        // below, get pushed to the provider as a bogus prompt, and be
        // markCompleted'd — applyCostOverride would NEVER run mid-query. Extract
        // and apply these BEFORE the trigger gate (and before routing promotion,
        // so the override's dashboard routing can't hijack the real routing),
        // ack them, and drop them from newMessages so they never reach
        // query.push. A 'stop' quiesces promptly: end the active stream and
        // return so the outer loop settles into the stop state.
        const overrides = newMessages.filter((m) => m.kind === 'cost_override');
        if (overrides.length > 0) {
          const overrideIds = overrides.map((m) => m.id);
          markProcessing(overrideIds);
          for (const o of overrides) applyCostOverride(o);
          markCompleted(overrideIds);
          for (const o of overrides) {
            const idx = newMessages.indexOf(o);
            if (idx >= 0) newMessages.splice(idx, 1);
          }
          if (costStopRequested) {
            log('cost_override stop applied mid-query — ending active stream to quiesce');
            endedForCommand = true;
            query.end();
            return;
          }
        }

        if (newMessages.length === 0) {
          // End stream when agent is idle: no SDK events and no pending messages
          if (Date.now() - lastEventTime > IDLE_END_MS) {
            log(`No SDK events for ${IDLE_END_MS / 1000}s, ending query`);
            query.end();
          }
          return;
        }

        // Cost quiesce mid-query (issue #1327). A ceiling crossing is now
        // detected DURING a turn (per-assistant-message accounting) instead of
        // only at its end, so this poller can be running while the session is
        // already quiesced. Claiming a message here would be the worst outcome
        // available: it gets markProcessing'd and pushed, the stream is ended a
        // moment later on the turn's `usage` event, and the end-of-batch
        // fallback then marks it COMPLETED — an inbound message consumed with no
        // answer and no retry. Leave every row `pending` instead; the outer
        // loop's quiesce gate keeps them that way until a human resumes.
        //
        // Placed AFTER the idle-end check on purpose: a quiesced turn that then
        // goes silent must still be able to close its stream, or the container
        // sits on an open query nothing will ever end.
        if (costStopRequested && !costImmortal) {
          log(`Cost ceiling crossed — not claiming ${newMessages.length} follow-up message(s); leaving them pending`);
          return;
        }

        // new_session bypass guard: if any arriving task defaults to fresh
        // session (a task kind with no `new_session: false` opt-out), DO NOT
        // push into the active query — that would resume the stored
        // continuation and defeat the default. End the active query instead;
        // the next poll iteration's initial-batch path will pick up the
        // pending rows via the fresh-session path. Leave rows as 'pending'.
        const wantsFreshSession = (m: { kind: string; content: string }) =>
          m.kind === 'task' && !taskOptsOutOfNewSession(m);
        if (newMessages.some(wantsFreshSession)) {
          log(
            `fresh-session task arrived mid-query (${newMessages.length} msg) — ending active query to route through fresh-session path`,
          );
          query.end();
          done = true;
          return;
        }

        // Update the shared routing when a follow-up brings richer routing
        // than the initial batch had.
        const followUpRouting = extractRouting(newMessages);
        if (followUpRouting.channelType && followUpRouting.platformId) {
          if (!routing.channelType || !routing.platformId) {
            log(
              `Promoting routing from follow-up (${followUpRouting.channelType}:${followUpRouting.platformId}); initial routing was null`,
            );
          }
          routing = followUpRouting;
        }

        // Accumulated context must not engage a warm query by itself.
        if (!newMessages.some((m) => m.trigger === 1)) return;

        // Native-codex follow-up (#1360 review, BLOCKER): never push external
        // work into an in-flight codex query. A codex turn can cross the ceiling
        // and hard-stop at its `result` boundary (the settle below), whose
        // `break` finalizes the async generator and kills the codex app-server —
        // tearing down any pushed-but-undrained turn. If we had already pushed
        // this follow-up AND markCompleted'd it (just below), that message would
        // be acked with no answer. Leave the rows PENDING (do not markProcessing)
        // and end the query; the outer poll re-claims them after the turn-boundary
        // settle — held by the cost-stop gate if the ceiling was crossed, or run
        // in a fresh query if it was not.
        if (providerName === 'codex') {
          log(
            'Codex follow-up arrived — ending the active query so it is re-claimed after the turn-boundary cost settle',
          );
          endedForCommand = true;
          query.end();
          return;
        }

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        let keep = newMessages;
        let skipped: Array<{ id: string; reason: string }> = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markScriptSkipped(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.map((s) => s.id).join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        // The SDK fires UserPromptSubmit (and the intent-router hook) only on
        // the initial query prompt. Mid-query pushes bypass the hook, so run
        // the router ourselves here so workflow classification is applied to
        // every user message — not just the first.
        let routedPrompt = await classifyAndPrepend(prompt);
        // Claude SDK pins the system prompt to the initial query — pushed
        // follow-ups don't re-read it. If destinations changed since the
        // last push, inline the current list so the agent sees it alongside
        // this user message even though its frozen system prompt is stale.
        const destNote = refreshDestinations();
        if (destNote) routedPrompt = destNote + routedPrompt;
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        taskBlockNudged = false;
        query.push(routedPrompt);
        archivePrompts.push(prompt);
        markCompleted(keptIds);
        lastEventTime = Date.now(); // new input counts as activity
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        if (getAgentMailbox().shouldRestartAfter?.(err)) {
          mailboxFailureStreak += 1;
          if (mailboxFailureStreak >= MAILBOX_FAILURE_STREAK_EXIT) {
            log(
              `Follow-up poll: ${mailboxFailureStreak} consecutive '${errMsg}' errors — ` +
                `mailbox driver requested a fresh runner. Exiting so the host respawns it.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          mailboxFailureStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, activePollIntervalMs);

  try {
    for await (const event of query.events) {
      lastEventTime = Date.now();
      handleEvent(event, routing);
      touchHeartbeat();

      // Cost cap (NanoClaw #1): accrue spend, persist, and fire the one-shot
      // soft escalation on cap crossing. Per assistant message since #1327 —
      // the aggregate `usage` event below double- to triple-counts because the
      // stream emits one message per content block, all repeating one usage.
      if (event.type === 'message_usage') {
        recordMessageCost(event);
      }

      // A genuine assistant message the provider couldn't price per-message
      // (no `usage` object). Mark the turn degraded so recordTurnCost settles
      // from the aggregate instead of skipping the fallback — otherwise this
      // message's spend, mixed with priced ones, would be free (issue #1327).
      if (event.type === 'message_missing_usage') {
        noteMessageMissingUsage();
      }

      if (event.type === 'usage') {
        // Turn boundary — settle codex (MCP tool) spend before the aggregate
        // event so a ceiling crossing driven by codex is caught by the same
        // hard-stop check below. `usage` follows `result`, so the turn's output
        // has already been delivered and acked by the time we can stop.
        foldCodexCost();
        recordTurnCost(event);
        reconcileLedger(); // #65 dual-run: log ledger-vs-counter at the turn boundary
        // Tier-2 ceiling: end the stream now rather than merely blocking the next
        // poll, so a session past its ceiling cannot be handed more work by a
        // follow-up push. This runs at the TURN BOUNDARY, not mid-turn: `usage`
        // arrives after `result`, whose branch below has already delivered and
        // acked this turn's output. That ordering is load-bearing — breaking any
        // earlier would leave an inbound message claimed, unanswered, and then
        // marked completed by the end-of-batch fallback. Per-turn overshoot is
        // the SDK's `maxBudgetUsd` brake's job, not this check's.
        if (costCeilingHardStop) {
          log(
            `Cost ceiling $${costCeilingUsd.toFixed(2)} reached — ending stream to ` +
              `hard-stop (spent=$${costSpentUsd.toFixed(2)})`,
          );
          endedForCommand = true;
          query.end();
          break;
        }
      }

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        if (!skipPersistContinuation) setContinuation(providerName, event.continuation);
      } else if (event.type === 'text') {
        // Assistant text emitted mid-turn (e.g. between tool calls). The
        // final result only carries the LAST assistant text, so complete
        // <message> blocks composed here would otherwise be lost — deliver
        // them now (chat runs only; task runs stay one-door). Gated on the
        // provider's static capability: for a provider that does not declare
        // emitsMidTurnText the result stays the only delivery door, so a
        // stray text event must not open a second one.
        if (emitsMidTurnText) {
          const scan = await deliverMidTurnBlocks(event.text, routing, turnStartSeq, midTurnTail);
          midTurnSent += scan.delivered;
          midTurnTail = scan.tail;
          // Gate refusals are sender feedback — push them back so the agent
          // re-sends correctly, same contract as the result door. The gates'
          // own 3-denial soft-cap bounds the re-send loop.
          if (scan.gateRefusals?.length) {
            query.push(`<system>${scan.gateRefusals.join('\n\n')}</system>`);
          }
        }
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. We normally
        // mark the initial batch completed (at the BOTTOM of this branch) so the
        // host sweep doesn't see stale 'processing' claims while the query stays
        // open for follow-up pushes.
        // EXCEPTION — a2a bounce (#943): a FAILED turn (structured isError) that
        // classifies transient/unknown on an a2a edge must NOT be ack'd (that
        // permanently consumes an un-actioned handoff — the #12097 bug). We skip
        // dispatch entirely (do NOT relay the auth blip to the peer) and leave
        // the trigger un-acked so the host redrive sweep re-arms it. Permanent
        // errors and non-a2a channels fall through to the normal dispatch path.
        let bounced = false;
        // Corrective retries queued by THIS result (gate-refusal / wrap /
        // task-block / silent-turn nudge) re-drive delivery of this turn's answer
        // on the SAME open query. They are COLLECTED here and flushed as ONE push
        // below (see `queuedCorrection`), because a single result can fire more
        // than one — e.g. a gate-refusal (independent of the wrap decision) plus a
        // wrap-nudge. Pushing them separately would let the codex hard-stop tear
        // down a still-pending second correction; one coalesced push cannot be
        // half-drained. For codex the `result` boundary is also the cost settle,
        // so a queued correction defers the hard stop ONCE (see ceilingDeferralUsed);
        // `costStopRequested` blocks NEW external work meanwhile. Inert for Claude
        // (its hard-stop is the separate `usage`-branch check).
        const corrections: string[] = [];
        const pushCorrection = (message: string): void => {
          corrections.push(message);
        };
        // Any result closes out an open silent turn: either it delivered (and
        // acks normally below) or it was silent again (and the branch at the
        // bottom finalizes it, because silentTurnNudged is already set).
        silentTurnOpen = false;
        const bounceClass =
          event.isError === true && event.text && routing.channelType === 'agent'
            ? classifyTurnError(event.text)
            : 'permanent';
        if (event.isError === true && event.text && routing.channelType === 'agent' && bounceClass !== 'permanent') {
          markBounced(initialBatchIds, bounceClass === 'transient' ? 'bounced-transient' : 'bounced-unknown');
          bouncedIds.push(...initialBatchIds);
          bounced = true;
          log(
            `a2a transient bounce (${bounceClass}) — trigger left pending for host redrive: ` + event.text.slice(0, 80),
          );
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? initialPrompt,
            result: event.text,
            continuation: queryContinuation ?? initialContinuation,
            status: 'error',
          });
          archivePrompts.shift();
        } else if (event.text?.trim()) {
          const { sent, hasUnwrapped, danglingOpen, gateRefusals, taskBlocks, resultBlocks } = await dispatchResultText(
            event.text,
            routing,
            {
              midTurnSent,
              // For emitsMidTurnText providers the result door NEVER delivers
              // a <message> block: mid-turn streaming is the single content
              // door. The result door's remaining jobs are the error-result
              // surface (below) and the nudge decision — see turnDelivered.
              suppressDelivery: emitsMidTurnText,
              // "Did anything user-visible go out this turn?" — door
              // deliveries (midTurnSent) plus any chat row written since the
              // turn boundary (which also sees MCP send_message calls the
              // frame-local count can't). When false and the result still
              // carries content, the wrap-nudge fires so the model re-sends
              // and the retry streams through the mid-turn door.
              turnDelivered: emitsMidTurnText ? midTurnSent > 0 || chatRowWrittenSince(turnStartSeq) : undefined,
              // The isError branch below owns the error surface; keep the
              // auto-route shortcut from writing a second, unsanitized copy.
              isErrorResult: event.isError === true,
            },
          );
          const willRetryTaskBlocks = shouldNudgeTaskBlocks(routing.taskRun, taskBlocks, taskBlockNudged);
          // Gate refusals are sender feedback — push them back to the emitting
          // agent so it re-sends correctly (parity with the bash-hook gates).
          // The gates' own 3-denial soft-cap bounds the re-send loop.
          if (gateRefusals?.length) {
            pushCorrection(`<system>${gateRefusals.join('\n\n')}</system>`);
          }
          // One-door task delivery: the final text becomes the run log entry
          // while explicit append-log calls remain optional additive notes.
          // Errors included: a failed run's text belongs in its log, not chat.
          // A corrective retry handles delivery only; its result is not a
          // second run summary.
          if (routing.taskRun && !taskBlockNudged) await autoAppendTaskLog(event.text);
          if (resultBlocks === 0 && event.isError === true && !routing.taskRun) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            //
            // Keyed on `resultBlocks` (blocks present in THIS result text),
            // NOT on `sent`. That distinction is what makes the call safe for
            // the fork's gates: when the critique/routing gate WITHHELD every
            // block, `sent` is 0 but `resultBlocks` is not, so this branch
            // stays shut and the gated body is never pushed to the channel.
            // The fork previously had to drop this call entirely for want of
            // exactly this counter.
            await deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'error',
            });
            archivePrompts.shift();
          } else {
            // An unwrapped final text only warrants the wrap-nudge when NOTHING
            // was delivered this turn — hasUnwrapped already folds in the
            // turn's mid-turn sent count. If a reply already went out as a
            // mid-turn block, the unwrapped tail is a self-summary; nudging
            // coaxes a redundant second message (live-observed). It stays in
            // the scratchpad log.
            const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
            // A turn with no meaningful text never reaches here — the branch
            // below owns it. (It used to be tested for HERE, inside a branch
            // gated on `event.text`, which made the check dead for the exact
            // `text: null` silent turn it was written to catch.)
            notifyExchangeComplete(
              onExchangeComplete,
              {
                prompt: archivePrompts[0] ?? initialPrompt,
                result: event.text,
                continuation: queryContinuation ?? initialContinuation,
                status: hasUnwrapped || willRetryTaskBlocks ? 'undelivered' : 'completed',
              },
              routing,
            );
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              // Fork: distinguish a dangling-open <message> tag from a fully
              // unwrapped response so the nudge tells the agent which to fix.
              const reason = danglingOpen
                ? `Your response was not delivered — you opened a <message to="…"> tag but never emitted the matching </message> close tag. ` +
                  `Each block must be self-contained in the same response: <message to="name">…</message>. ` +
                  `Re-send the full block with both tags.`
                : `Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Please re-send your response with the correct wrapping.`;
              pushCorrection(`<system>${reason} Your destinations: ${names}.</system>`);
            }
            if (willRetryTaskBlocks) {
              taskBlockNudged = true;
              const names = getAllDestinations()
                .map((d) => d.name)
                .join(', ');
              pushCorrection(buildTaskBlockNudge(taskBlocks, names));
            }
            // A retry result (wrapping or task-block nudge) answers the SAME
            // user prompt — keep it queued so the retry archives against it,
            // not the nudge text.
            if (!willRetryWrapping && !willRetryTaskBlocks) archivePrompts.shift();
          }
        } else {
          // SILENT TURN — the result carried no usable text (`null`, or blank).
          // A turn that delivered nothing by ANY path is not "completed": the
          // thread simply stops, with no error for anyone to notice. Codex
          // reaches here routinely — it emits turn/completed with
          // last_agent_message null (observed 2026-07-17: 7.5s turn, zero
          // output, acked completed, thread dead) and never sets isError, so
          // the bounce branch above can't catch it either. Claude has the same
          // hole structurally.
          //
          // The outbound watermark, NOT `sent`, is the discriminator: the MCP
          // tools (send_message, send_file) run in a separate stdio process,
          // so a turn that answered purely through a tool call moves the
          // watermark while `sent` stays 0. Task runs legitimately end with no
          // chat message (they append to a run log) and are excluded.
          const producedOutput = outboundWatermark() > turnWatermark;
          if (producedOutput) batchDelivered = true;
          if (producedOutput || batchDelivered || routing.taskRun) {
            archivePrompts.shift();
          } else if (!silentTurnNudged && event.isError !== true) {
            // Recovery attempt #1, owned by the poll loop (not by an optional
            // provider hook no production provider implements): ask for the
            // answer again on the SAME open query. Nothing is acked yet, and
            // the prompt stays queued so the retry archives against the user's
            // message rather than against this nudge.
            silentTurnNudged = true;
            silentTurnOpen = true;
            const names = getAllDestinations()
              .map((d) => d.name)
              .join(', ');
            log('Turn produced no output at all — pushing a re-send nudge before acking anything');
            pushCorrection(
              `<system>Your last turn produced NO output — no final text and no message sent. ` +
                `Nothing reached the user, who is still waiting on the message above. ` +
                `Re-send your answer now, wrapped in <message to="name">...</message>. ` +
                `Your destinations: ${names}.</system>`,
            );
          } else {
            // Either the nudged retry came back empty too, or the turn was
            // already flagged as an error (re-asking would just re-hammer it).
            // Emit the durable notice and ack failed.
            await finalizeSilentTurn(event.text);
          }
        }
        // `queuedCorrection` is the per-result "did THIS result queue a
        // correction?" the settle below reads.
        const queuedCorrection = corrections.length > 0;
        // TERMINAL codex ceiling stop (#1360 re-review MAJOR). The ceiling is
        // already crossed (costCeilingHardStop is latched — it never clears within
        // a query) AND the one-shot deferral is already spent, so the settle below
        // WILL hard-stop this result. If it ALSO queued a correction, that
        // correction is doomed: query.end() tears the app-server down before it
        // runs. Pushing it is futile, and leaving the batch markCompleted would
        // silently consume an unanswered message that can never be reclaimed after
        // a cost-cap continuation. Withhold-notice + markFailed instead. Decidable
        // here even though codex's own fold runs in the settle below, because
        // `ceilingDeferralUsed ⟹ costCeilingHardStop` (the deferral can only have
        // been spent on a prior crossing, and neither flag flips back mid-query).
        const terminalCeilingStop =
          providerName === 'codex' && costCeilingHardStop && ceilingDeferralUsed && queuedCorrection;
        // Flush every correction queued by this result as ONE push (see the
        // `corrections` note above), so the codex hard-stop can never strand a
        // second queued correction mid-turn — EXCEPT on the terminal stop, where
        // the correction can't run at all and is handled below instead.
        if (queuedCorrection && !terminalCeilingStop) query.push(corrections.join('\n\n'));
        if (terminalCeilingStop) {
          // Surface the withheld answer durably (same delivery mechanism as
          // finalizeSilentTurn), then ack the batch FAILED — NOT completed — so
          // the outer fallback markCompleted skips it and the row stays
          // reclaimable. The settle below still ends the stream.
          if (routing.channelType && routing.platformId && routing.channelType !== 'system') {
            await writeMessageOut({
              id: generateId(),
              in_reply_to: routing.inReplyTo,
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({ text: COST_CEILING_WITHHELD_NOTICE }),
            });
          } else {
            log('Cost-ceiling withheld notice has no deliverable routing — recorded in the log only');
          }
          for (const id of initialBatchIds) markFailed(id);
          undeliveredIds.push(...initialBatchIds);
          log(
            `Cost ceiling $${costCeilingUsd.toFixed(2)} reached with a corrective retry still queued — ` +
              `answer withheld, batch marked failed (spent=$${costSpentUsd.toFixed(2)})`,
          );
        } else if (!bounced && !silentTurnOpen && undeliveredIds.length === 0) {
          // Ack the turn as completed UNLESS it was a transient a2a bounce (left
          // pending above for the host redrive), it delivered nothing and was
          // acked 'failed' by finalizeSilentTurn, or a silent turn is still
          // awaiting its re-send retry. This replaces the former unconditional
          // markCompleted at the top of the branch.
          markCompleted(initialBatchIds);
        }
        // A turn that delivered through the content door (not just the silent
        // branch above, which only runs for empty results) also answers the
        // batch — record it before the watermark is resampled.
        if (outboundWatermark() > turnWatermark) batchDelivered = true;
        turnWatermark = outboundWatermark();
        // Turn boundary: reset the per-turn sent count after the result's
        // nudge decision has used it. A nudge retry re-counts via its own
        // text events before the retry result, so resetting on every result
        // is safe. The seq high-water mark advances past everything written
        // this turn (door and error deliveries alike), so the next turn's
        // echo check never reaches back across the boundary — a later turn
        // genuinely re-sending the same body still delivers. The assembly
        // buffer dies with the turn: a fragment that never closed is not
        // carried into the next turn — the wrap-nudge owns that case.
        midTurnSent = 0;
        turnStartSeq = maxOutboundSeq();
        midTurnTail = '';
        // Codex yields `result` and then stops — it never emits the `usage`
        // event that drives the Claude turn-boundary settle above (foldCodexCost
        // + the ceiling hard-stop). So run that settle HERE for codex: `result`
        // IS codex's turn boundary, and this turn's output is already delivered
        // and acked above, preserving the same ordering invariant the `usage`
        // branch relies on. Without it, native-codex metering is only
        // poll-granular and a single long codex turn has no per-turn bound.
        // foldCodexCost is delta-based (per-file watermark), so this does not
        // double-charge against the poll-loop fold that also runs for codex.
        if (providerName === 'codex') {
          foldCodexCost();
          if (costCeilingHardStop) {
            // ONE-SHOT deferral (#1360 re-review). If THIS result queued a
            // corrective retry and the single allowance is still unspent, let
            // that correction run its own turn before stopping — ending the
            // stream now tears down the app-server before the correction runs and
            // the already-markCompleted inbound row is left unanswered. SPEND the
            // allowance so the correction's OWN result boundary hard-stops
            // regardless of whether it queues yet another correction: at most ONE
            // extra corrective turn past the ceiling, never an unbounded chain of
            // gate-refusal retries (the critique gate keeps denying while awaiting
            // approval). `costStopRequested` blocks NEW external work throughout.
            if (queuedCorrection && !ceilingDeferralUsed) {
              ceilingDeferralUsed = true;
              log(
                `Cost ceiling $${costCeilingUsd.toFixed(2)} reached but a corrective retry is queued — ` +
                  `deferring hard-stop one turn (spent=$${costSpentUsd.toFixed(2)})`,
              );
            } else {
              log(
                `Cost ceiling $${costCeilingUsd.toFixed(2)} reached — ending stream to ` +
                  `hard-stop (spent=$${costSpentUsd.toFixed(2)})`,
              );
              endedForCommand = true;
              query.end();
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    signal?.removeEventListener('abort', onSignalAbort);
  }

  // The stream ended while a nudged silent turn was still outstanding (the
  // provider never answered the re-send). The batch is still un-acked at this
  // point — close it out the same way a second silent result would, so the
  // outer loop's fallback markCompleted can't quietly call it a success.
  if (silentTurnOpen) await finalizeSilentTurn(null);

  return { continuation: queryContinuation, bouncedIds, undeliveredIds };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
  routing?: RoutingContext,
): void {
  archiveExchange(exchange, routing);
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write the exchange to `conversations/` — the folder `container/CLAUDE.md`
 * promises every agent, regardless of provider. Done here rather than behind
 * `onExchangeComplete` because that hook is optional and no registered provider
 * implements it, so archiving through it would stay dead for all of them.
 *
 * Only `completed` exchanges, so the archive holds the conversation the agent
 * should recall rather than every attempt at it. This is NOT because error text
 * went undelivered — `deliverErrorResult` above sends some of it — so the
 * archive is deliberately a partial record, not a full transcript. Task runs are
 * skipped: they already get `tasks/<id>.md`.
 */
function archiveExchange(exchange: ProviderExchange, routing?: RoutingContext): void {
  if (exchange.status !== 'completed') return;
  if (routing?.taskRun) return;
  appendExchange(exchange, {
    assistantName: process.env.NANOCLAW_ASSISTANT_NAME || undefined,
    log,
  });
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'usage':
      // Structured per-turn accounting. Grep-friendly: every field is a
      // bare keyword=value token, same line. Stable schema so downstream
      // tooling (ccusage / ad-hoc awk / the 2×2 stress-test harness)
      // can parse without JSON.
      log(
        `Usage: sessionId=${event.sessionId ?? 'null'} ` +
          `durationMs=${event.durationMs} ` +
          `numTurns=${event.numTurns} ` +
          `input=${event.inputTokens} ` +
          `output=${event.outputTokens} ` +
          `cacheCreate=${event.cacheCreationInputTokens} ` +
          `cacheRead=${event.cacheReadInputTokens} ` +
          `ephemeral1h=${event.ephemeral1hInputTokens} ` +
          `ephemeral5m=${event.ephemeral5mInputTokens} ` +
          `costUsd=${event.totalCostUsd}`,
      );
      break;
    case 'message_usage':
      // Deliberately NOT logged per message: the stream emits one of these per
      // content block, so a busy turn would drown the container log. The
      // aggregate `usage` line above still reports the turn, and the cost cap's
      // own escalation lines report what was actually charged.
      break;
  }
}

/**
 * Critique-gate scope-extender: the bash hook
 * (container/hooks/gate-critique-on-deliver.sh) is wired as a PreToolUse
 * matcher on `mcp__nanoclaw__send_message|Bash`, so it only catches
 * delivery-marker traffic that goes through those tools. The most common
 * delivery path — the agent emitting `<message to="X">[Fix Report]…</message>`
 * as plain text and letting `dispatchResultText` parse it — uses neither
 * tool, so the hook never fires and the gate is silently bypassed.
 *
 * This in-process check mirrors the bash hook's logic (same MARKER file,
 * same workflow-state.json, same delivery-marker regex) and runs at the
 * one chokepoint left for text-output dispatch.
 *
 * Returns null when the gate either doesn't apply or permits the body.
 * Returns a string (the explanation) when the gate refuses delivery —
 * the caller substitutes that explanation for the original body so the
 * destination sees a clear refusal note instead of the gated content.
 *
 * Paths overridable for tests via the optional opts.
 */
// Anchored to line start (multiline): the chain protocol emits markers as
// message/line prefixes, and unanchored matching treated a mid-sentence
// MENTION of a marker as a delivery — burning a denial and one of the
// session's soft-cap strikes each time.
// Built-in floor = the GENERAL chain-protocol primitives only (chain-reporting.md):
// [Resolution] (terminal chain close) and [handoff] (lateral peer pass). These
// are project-agnostic and every coworker uses them. Role-specific terminal
// names ([Fix Report], [Triage Resolution], [Review Verdict], [Triage handoff])
// are NOT built in — each emitting role declares them in its coworker-type
// `delivery_markers` (materialized to .critique-delivery-markers, unioned here
// and by the routing gate). [Report] is deliberately absent: it's the status
// channel, not a gated deliverable.
const DEFAULT_DELIVERY_MARKERS = ['Resolution', 'handoff'];
const DELIVERY_MARKER_RE = /^[ \t]*\[(Resolution|handoff)\]/m;

// Critique-gate vocabulary: built-in defaults plus ADDITIVE extensions from
// .critique-delivery-markers (materialized by the composer from the
// coworker-type chain's delivery_markers declarations). Labels are
// re-validated to a regex-metachar-free charset before splicing — and since
// extensions can only add markers, tampering with the file can only widen
// the gate, never narrow it. Both the critique gate AND the always-on
// chain-routing gate resolve their vocabulary through this helper, so a
// per-role delivery_markers extension is recognized identically by both —
// otherwise moving a marker into per-role YAML would keep the critique gate
// working while silently regressing routing for that role.
function deliveryMarkerRe(markersPath: string): RegExp {
  const fs = require('fs') as typeof import('fs');
  let extra: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(markersPath, 'utf-8')) as { message_markers?: unknown };
    if (Array.isArray(parsed.message_markers)) {
      extra = parsed.message_markers.filter(
        (m): m is string => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(m),
      );
    }
  } catch {
    extra = [];
  }
  if (extra.length === 0) return DELIVERY_MARKER_RE;
  return new RegExp(`^[ \\t]*\\[(${[...DEFAULT_DELIVERY_MARKERS, ...extra].join('|')})\\]`, 'm');
}
// Default location of the per-role delivery vocabulary file (materialized by
// the composer). Shared by both gates; overridable in tests via opts.
const DEFAULT_DELIVERY_MARKERS_PATH = '/workspace/agent/.critique-delivery-markers';

// Soft-cap shared by the in-process gates, mirroring the bash hooks
// (gate-critique-on-deliver.sh:73-89). After GATE_DENIAL_CAP refusals on a
// single session the gate stops denying and yields — without this, a gate
// whose precondition the agent can't satisfy (e.g. a workflow step that
// genuinely has no inbound to reply to, or a misconfigured critique-less
// orchestrator) would thrash the agent's entire turn budget retrying. The
// counter is persisted in workflow-state.json under `<key>`; the file is
// CREATED if absent, so a coworker that never runs critique still escapes.
const GATE_DENIAL_CAP = 3;

// Returns true if the gate should yield (soft-cap reached) rather than deny.
// Mirrors gate-critique-on-deliver.sh: check the persisted count BEFORE
// incrementing, so after GATE_DENIAL_CAP denials the counter stays pinned at
// the cap and the gate yields without bumping further. Best-effort persistence
// — a state-write failure never blocks delivery, it just disables the cap.
/**
 * Merge keys into workflow-state.json. Used to consume/expire a bypass grant,
 * mirroring the bash hook's jq patch so both gate implementations leave the
 * same trail.
 */
function patchGateState(statePath: string, patch: Record<string, unknown>): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    state = {};
  }
  Object.assign(state, patch);
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // Best-effort, as elsewhere in this file.
  }
}

/**
 * Record an enforcement release into the escalation file — the session
 * bind-mount, which the host reads. Anything that ALLOWS a delivery with the
 * requirement unmet must leave a durable trace: this container runs --rm, so a
 * release logged only to stderr is a release nobody ever learns about.
 */
/**
 * Record an enforcement release where the HOST can see it, in parity with
 * container/hooks/gate-critique-on-deliver.sh.
 *
 * Two sinks, one id. `critique-releases.jsonl` is append-only and always
 * written, because the escalation file can legitimately be GONE by the time we
 * get here: the host retires a settled request, and it does that between our
 * own two writes (the consumption patch above, then this stamp). The
 * escalation file is merged into when it exists, since it carries the
 * request's audit context. The host records under the shared event id exactly
 * once, so writing both never double-counts a release.
 *
 * It deliberately never CREATES the escalation file. Fabricating one with
 * `requested_at: 0` — what this did before — made the host read a real release
 * as a brand-new escalation and card a human for it, while the release itself
 * went unrecorded and its link to the original request was destroyed.
 *
 * @returns false when nothing was recorded; an invisible release is not a
 * release the caller may allow.
 */
function stampFailedOpen(escPath: string, denialReason: string, why: string, grantId?: string | null): boolean {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const nowIso = new Date().toISOString();
  const eventId = `rel-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let recorded = false;

  const journalPath =
    process.env.CRITIQUE_RELEASE_JOURNAL ?? path.join(path.dirname(escPath), 'critique-releases.jsonl');
  try {
    fs.appendFileSync(
      journalPath,
      `${JSON.stringify({
        event_id: eventId,
        at: nowIso,
        why,
        reason: denialReason,
        hit: 'text-output delivery',
        grant_id: grantId ?? null,
      })}\n`,
    );
    recorded = true;
  } catch {
    // Reported by the caller via the return value, not swallowed here.
  }

  try {
    const esc = JSON.parse(fs.readFileSync(escPath, 'utf-8')) as Record<string, unknown>;
    esc.failed_open_at = nowIso;
    esc.failed_open_why = why;
    esc.failed_open_event_id = eventId;
    fs.writeFileSync(escPath, JSON.stringify(esc));
    recorded = true;
  } catch {
    // Absent or unreadable: the journal is the sink. Never fabricate one.
  }
  return recorded;
}

function gateShouldYield(statePath: string, key: string): boolean {
  const fs = require('fs') as typeof import('fs');
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    state = {};
  }
  const current = typeof state[key] === 'number' ? (state[key] as number) : 0;
  if (current >= GATE_DENIAL_CAP) return true;
  state[key] = current + 1;
  try {
    const path = require('path') as typeof import('path');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // Best-effort; see note above.
  }
  return false;
}

// Re-arm a gate's soft-cap counter. Called when the agent demonstrates it CAN
// satisfy the gate (e.g. a properly-linked handoff). Without this the counter
// only ever climbs, so after GATE_DENIAL_CAP denials ANYWHERE in a session's
// life the gate yields permanently and every later unlinked handoff slips
// through — the counter is meant to bound a thrash loop, not disable the gate.
// Best-effort: a read/write failure just leaves the counter as-is.
function resetGateDenials(statePath: string, key: string): void {
  const fs = require('fs') as typeof import('fs');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return; // no state file → nothing to reset
  }
  if (!state[key]) return; // already cleared
  delete state[key];
  try {
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // Best-effort.
  }
}

// The chain-routing check is ALWAYS ON — not an overlay. It enforces a pure
// structural invariant ("a chain handoff must name the inbound it answers",
// the [MUST] in chain-reporting.md), and it is self-scoping: it only fires on
// bodies carrying a chain delivery marker, which is the chain protocol's own
// vocabulary — non-chain coworkers never emit those markers, so they never
// trip it. There is nothing to select and nothing to opt into.
//
// It resolves its vocabulary through the SAME deliveryMarkerRe() union as the
// critique gate, so a per-role delivery_markers extension is recognized here
// too. Built-in defaults always apply; the per-role file (if present) only
// widens the set.
export function checkRoutingGate(
  body: string,
  attrs: { threadIdOverride?: string; inReplyToOverride?: string },
  opts: { workflowStatePath?: string; deliveryMarkersPath?: string } = {},
): { blocked: boolean; reason?: string } {
  const routingRe = deliveryMarkerRe(opts.deliveryMarkersPath ?? DEFAULT_DELIVERY_MARKERS_PATH);
  if (!routingRe.test(body)) return { blocked: false };
  // in_reply_to is the canonical routing primitive: it resolves the inbound
  // row → source_session_id → the exact edge, and the runtime auto-derives
  // thread_id from it (see applyInReplyToDefaults in mcp-tools/core.ts). So
  // in_reply_to alone is sufficient; thread_id is optional. Requiring both
  // would reject the spec's canonical upstream report form
  // (send_message(to="parent", in_reply_to=<id>, ...)).
  const statePath =
    opts.workflowStatePath ?? process.env.ROUTING_GATE_STATE_PATH ?? '/workspace/.claude/workflow-state.json';
  if (attrs.inReplyToOverride) {
    // A properly-linked handoff proves the agent CAN satisfy the gate — re-arm
    // the soft-cap so unlinked handoffs earlier in the session don't leave the
    // gate permanently yielded (routing_gate_denials otherwise only climbs).
    resetGateDenials(statePath, 'routing_gate_denials');
    return { blocked: false };
  }
  if (gateShouldYield(statePath, 'routing_gate_denials')) {
    return { blocked: false };
  }
  const marker = body.match(routingRe)?.[1] ?? '<handoff>';
  return {
    blocked: true,
    reason:
      `[chain-routing-gate] REFUSED — your message contained a [${marker}] handoff/delivery marker but the <message> tag omitted in_reply_to. ` +
      `Re-send the original body in a <message to="..." in_reply_to="...">...</message> block linked to the inbound message you are answering ` +
      `(thread_id is optional — the runtime derives it from in_reply_to). ` +
      `Do not describe the routing in prose; set the attribute on the tag. The original body was retained in the container scratchpad log only — it was not delivered to the destination.`,
  };
}

export function checkCritiqueGate(
  body: string,
  opts: {
    overlayMarkerPath?: string;
    workflowStatePath?: string;
    requiredStagesPath?: string;
    deliveryMarkersPath?: string;
  } = {},
): { blocked: boolean; reason?: string } {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  // Path resolution mirrors the bash hook's two-stage override (env var
  // wins over default), with an opts-arg layer on top for unit tests.
  const markerPath =
    opts.overlayMarkerPath ?? process.env.CRITIQUE_GATE_OVERLAY_PATH ?? '/workspace/agent/.overlay-critique-gate';
  // Activation precedence: the host-injected CRITIQUE_GATE_ACTIVE env var is
  // authoritative when set (the agent can't `rm` its way out — a child can't
  // mutate the harness's inherited env). The marker file is the fallback for
  // local mode / tests. opts.overlayMarkerPath (tests) forces file mode.
  if (opts.overlayMarkerPath === undefined && process.env.CRITIQUE_GATE_ACTIVE !== undefined) {
    if (process.env.CRITIQUE_GATE_ACTIVE !== '1') return { blocked: false };
  } else if (!fs.existsSync(markerPath)) {
    return { blocked: false };
  }
  const markerRe = deliveryMarkerRe(
    opts.deliveryMarkersPath ?? path.join(path.dirname(markerPath), '.critique-delivery-markers'),
  );
  if (!markerRe.test(body)) return { blocked: false };
  const statePath =
    opts.workflowStatePath ?? process.env.CRITIQUE_GATE_STATE_PATH ?? '/workspace/.claude/workflow-state.json';

  let state: {
    critique_rounds?: number;
    critique_stages?: Record<string, number>;
    critique_verdicts?: Record<string, string>;
    critique_gate_bypass_approved?: boolean;
    critique_gate_bypass_rejected?: boolean;
    // Grant envelope written by the host on an admin Approve. `grant_id` is the
    // approving approval_id — the host's ledger is keyed on it, so consumption
    // can be attributed to a specific grant rather than to a session.
    critique_gate_bypass_grant_id?: string;
    critique_gate_bypass_expires_at?: number; // epoch secs (shell arithmetic in the bash gate)
    critique_gate_bypass_rejected_request?: number;
    edits_since_critique?: number;
    critique_attested?: Record<string, Record<string, string>>;
  } = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as typeof state;
  } catch {
    state = {};
  }

  // Required-stages + verdict enforcement — full parity with
  // gate-critique-on-deliver.sh. The composer materializes
  // .critique-required-stages next to the overlay marker; when present (and
  // non-empty) the gate requires every listed stage recorded AND, when
  // OUTPUT_REVIEW is required, its last verdict to be "approve" — failing
  // closed on a missing verdict unless CRITIQUE_VERDICT_STRICT=0. Without
  // the file, the historical any-1-round check applies. Before this parity
  // the text-output path (the most common delivery path) enforced only the
  // count check, so a must-fix OUTPUT_REVIEW could ship via plain
  // <message> emission while the tool path denied it.
  // Required stages: env wins over file (same tamper-resistance as activation);
  // opts.requiredStagesPath (tests) forces file mode.
  const requiredPath = opts.requiredStagesPath ?? path.join(path.dirname(markerPath), '.critique-required-stages');
  let required: string[] = [];
  try {
    const raw =
      opts.requiredStagesPath === undefined && process.env.CRITIQUE_REQUIRED_STAGES !== undefined
        ? process.env.CRITIQUE_REQUIRED_STAGES
        : fs.readFileSync(requiredPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) required = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    required = [];
  }

  let denialReason = '';
  if (required.length > 0) {
    const stages = state.critique_stages ?? {};
    const verdicts = state.critique_verdicts ?? {};
    const missing = required.filter((s) => (stages[s] ?? 0) < 1);
    if (missing.length > 0) {
      denialReason = `required critique stages are missing: ${missing.join(', ')}`;
    } else if (required.includes('OUTPUT_REVIEW')) {
      const verdict = verdicts['OUTPUT_REVIEW'] ?? '';
      if (verdict !== '' && verdict !== 'approve') {
        denialReason = `OUTPUT_REVIEW last verdict is "${verdict}" (must be "approve") — re-run /codex-critique with STAGE: OUTPUT_REVIEW after fixing the issues`;
      } else if (verdict === '' && process.env.CRITIQUE_VERDICT_STRICT !== '0') {
        denialReason =
          'OUTPUT_REVIEW ran but no verdict was recorded (missing or unparseable) — re-run /codex-critique with STAGE: OUTPUT_REVIEW';
      }
    }
    // Freshness: the OUTPUT_REVIEW approve must postdate the last mutation.
    // track-edits.sh bumps edits_since_critique on every substantive edit and
    // track-critique.sh zeroes it on every recorded round — a nonzero count
    // means the approve covers code that has since changed. Mirrors the bash
    // hook; CRITIQUE_FRESHNESS=0 disables.
    if (denialReason === '' && required.includes('OUTPUT_REVIEW') && process.env.CRITIQUE_FRESHNESS !== '0') {
      const edits = typeof state.edits_since_critique === 'number' ? state.edits_since_critique : 0;
      if (edits > 0) {
        denialReason = `${edits} edit(s) recorded since the last critique round — the OUTPUT_REVIEW approve no longer covers the current state; re-run /codex-critique with STAGE: OUTPUT_REVIEW`;
      }
    }
    // Attested-hash binding: re-hash the artifacts the reviewer attested to
    // (### Attested → critique_attested, recorded by track-critique.sh) —
    // an approve whose reviewed artifacts have since changed does not ship.
    // Mirrors the bash hook; CRITIQUE_ATTEST=0 disables,
    // CRITIQUE_ATTEST_ROOT bounds verified paths (default /workspace).
    if (denialReason === '' && required.includes('OUTPUT_REVIEW') && process.env.CRITIQUE_ATTEST !== '0') {
      const attested = (state.critique_attested ?? {})['OUTPUT_REVIEW'] ?? {};
      const attestRoot = process.env.CRITIQUE_ATTEST_ROOT ?? '/workspace';
      const changed: string[] = [];
      for (const [artifactPath, hash] of Object.entries(attested).slice(0, 20)) {
        if (!artifactPath.startsWith(`${attestRoot}/`)) continue;
        try {
          const crypto = require('crypto') as typeof import('crypto');
          const digest = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
          if (digest !== hash) changed.push(artifactPath);
        } catch {
          changed.push(`${artifactPath}(missing)`);
        }
      }
      if (changed.length > 0) {
        denialReason = `reviewed artifacts changed since the OUTPUT_REVIEW approve: ${changed.join(', ')} — re-run /codex-critique with STAGE: OUTPUT_REVIEW`;
      }
    }
  } else {
    const rounds = typeof state.critique_rounds === 'number' ? state.critique_rounds : 0;
    if (rounds < 1) {
      denialReason = `no /codex-critique round has been recorded for this session (critique_rounds=${rounds})`;
    }
  }
  if (denialReason === '') return { blocked: false };

  const marker = body.match(markerRe)?.[1] ?? '<delivery>';

  // Denial cap → graduated escalation, in parity with the bash hook. At the
  // cap the gate no longer silently fails open: it writes an escalation
  // request file (the host sweep turns it into an admin approval card) and
  // keeps denying until an admin approves the bypass, rejects it, or the
  // request times out (backstop preserving the original anti-thrash
  // contract). CRITIQUE_ESCALATION=0 restores the legacy fail-open cap.
  if (gateShouldYield(statePath, 'critique_gate_denials')) {
    const escPath =
      process.env.CRITIQUE_ESCALATION_FILE ?? path.join(path.dirname(statePath), 'critique-escalation.json');
    const nowS = Math.floor(Date.now() / 1000);
    let requestedAt = 0;
    try {
      const esc = JSON.parse(fs.readFileSync(escPath, 'utf-8')) as { requested_at?: number };
      requestedAt = typeof esc.requested_at === 'number' ? esc.requested_at : 0;
    } catch {
      requestedAt = 0;
    }
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    // The kill switch still fails open, but the release is now recorded where
    // the HOST can see it: this container is --rm'd, so anything written only
    // to stderr is unrecoverable once the session ends.
    if (process.env.CRITIQUE_ESCALATION === '0') {
      // The kill switch is an operator's explicit standing instruction to let
      // deliveries through, so an unrecordable release does not convert it into
      // a refusal the way the admin-bypass path below does. It is still said
      // out loud rather than passing as success.
      if (!stampFailedOpen(escPath, denialReason, 'CRITIQUE_ESCALATION=0 kill switch')) {
        log(
          `[critique-gate] kill-switch release could NOT be recorded in ${path.dirname(escPath)} — ` +
            `the host will never learn the gate opened (${denialReason})`,
        );
      }
      return { blocked: false };
    }

    // Admin bypass — ONE-SHOT and time-limited, in parity with the bash hook.
    // This was a bare `=== true` with no expiry and no consumption, so a single
    // approval stood THIS path open for the session's whole life even after the
    // hook path was fixed — and this is the more common delivery path.
    if (state.critique_gate_bypass_approved === true) {
      const expiresAt = num(state.critique_gate_bypass_expires_at);
      // A grant with no usable expiry is NOT an unlimited grant. Treating a
      // missing or non-numeric value as "no expiry" would let a forged flag
      // with no expiry at all defeat the TTL entirely — fail closed instead.
      if (expiresAt <= 0 || nowS >= expiresAt) {
        patchGateState(statePath, {
          critique_gate_bypass_approved: false,
          critique_gate_bypass_expired_at: nowS,
        });
        // Expired (or unusable) grant: fall through to the denial path below.
      } else {
        patchGateState(statePath, {
          critique_gate_bypass_approved: false,
          critique_gate_bypass_consumed_grant_id: state.critique_gate_bypass_grant_id ?? null,
          critique_gate_bypass_consumed_at: nowS,
        });
        // The one-shot property depends on that write. If it did not land the
        // grant is still `approved` and would be reusable on every subsequent
        // delivery, so refuse rather than allow — a denied delivery is
        // recoverable, a permanently reusable waiver is not.
        let stillApproved = true;
        try {
          const after = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
            critique_gate_bypass_approved?: boolean;
          };
          stillApproved = after.critique_gate_bypass_approved === true;
        } catch {
          stillApproved = true; // unreadable → assume the worst
        }
        if (stillApproved) {
          return {
            blocked: true,
            reason:
              `[critique-gate] REFUSED — the admin bypass could NOT be recorded as consumed, so allowing it ` +
              `would leave a reusable waiver (${denialReason}).`,
          };
        }
        // Same reasoning as the consumption check above, one step further on: a
        // release nobody can see is worse than a denied delivery. The grant is
        // already spent, so the host reports it as an ORPHANED release — which
        // is exactly what it is.
        if (
          !stampFailedOpen(
            escPath,
            denialReason,
            'admin bypass consumed (one-shot)',
            state.critique_gate_bypass_grant_id ?? null,
          )
        ) {
          return {
            blocked: true,
            reason:
              `[critique-gate] REFUSED — the admin bypass was consumed but the release could NOT be recorded ` +
              `anywhere the host can see it, so allowing it would open the gate with no durable trace (${denialReason}).`,
          };
        }
        return { blocked: false };
      }
    }

    // A rejection answers the request it was made about — not every later one.
    // Unscoped, a single old "no" silently decided every subsequent delivery
    // in the session and suppressed re-escalation with it.
    if (
      state.critique_gate_bypass_rejected === true &&
      num(state.critique_gate_bypass_rejected_request) === requestedAt
    ) {
      return {
        blocked: true,
        reason:
          `[critique-gate] REFUSED — an admin REJECTED the bypass request (${denialReason}). ` +
          `Satisfy the critique requirement (/codex-critique) or report the blocker to your parent instead of delivering.`,
      };
    }

    // NOTE: there is deliberately NO timeout fail-open here any more. It used
    // to allow the delivery once CRITIQUE_ESCALATION_TIMEOUT_SECS elapsed,
    // which meant an agent could satisfy the requirement by waiting.
    if (requestedAt === 0) {
      try {
        fs.writeFileSync(
          escPath,
          JSON.stringify({
            requested_at: nowS,
            reason: denialReason,
            hit: 'text-output delivery',
            denials: GATE_DENIAL_CAP,
          }),
        );
      } catch {
        // Best-effort — an unwritable escalation file degrades to deny-only.
      }
    }
    return {
      blocked: true,
      reason:
        `[critique-gate] REFUSED — denial cap reached; a bypass request has been sent to an admin (${denialReason}). ` +
        `Satisfy the requirement with /codex-critique or wait for the decision; do not retry the delivery in a tight loop.`,
    };
  }
  return {
    blocked: true,
    reason:
      `[critique-gate] REFUSED — your message contained a [${marker}] marker but ${denialReason}. ` +
      `Run /codex-critique on the work first, then resend. The original delivery body was retained in the container scratchpad log only — it was not delivered to the destination.`,
  };
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
async function deliverErrorResult(text: string, routing: RoutingContext): Promise<void> {
  log('Error result with no <message> envelope — delivering to channel');
  await writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: stripHarnessTagArtifacts(text) }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
export interface TaskMessageBlock {
  to: string;
  body: string;
}

/** Options for `dispatchResultText`, describing the turn it closes. */
export interface ResultDispatchOptions {
  /**
   * How many <message> blocks were already delivered from streamed text
   * events this turn. Folds into the returned `sent` total so a bare final
   * text after a mid-turn delivery reads as a self-summary, not an
   * undelivered reply.
   */
  midTurnSent?: number;
  /**
   * Providers declaring `emitsMidTurnText`: the result door NEVER delivers
   * content. Mid-turn streaming (parse-time block delivery plus cross-
   * segment assembly) is the single content door; a complete <message>
   * block in the result text is at best a repeat of a mid-turn delivery and
   * at worst content the streaming door missed — either way it is not sent
   * from here. The result door keeps exactly two jobs: surfacing error
   * results (see the isError branch in processQuery) and the wrap-nudge
   * decision (`turnDelivered` below). Task runs, unknown destinations and
   * empty bodies keep their existing result-door handling, none of which
   * delivers content.
   */
  suppressDelivery?: boolean;
  /**
   * Did anything user-visible go out this turn? True when the mid-turn door
   * delivered (midTurnSent > 0) OR any chat row landed in outbound.db since
   * the turn boundary (covers MCP send_message calls the frame-local count
   * cannot see). Only meaningful with `suppressDelivery`. When false and the
   * result carries content — wrapped blocks or unwrapped prose — the turn
   * counts as undelivered and the wrap-nudge fires, so the model re-sends
   * and the retry streams through the mid-turn door. This is the deliberate
   * degradation path for streaming-door misses (SDK drift, a destination
   * appearing only after streaming, a block that never closed): nudge and
   * retry, never a direct result-door send.
   */
  turnDelivered?: boolean;
  /**
   * This result carried `isError`. The error surface is the result door's own
   * job (`deliverErrorResult` in processQuery) and it sanitizes harness-tag
   * artifacts on the way out, so the plain-text auto-route shortcut below must
   * stand down for such a turn — otherwise BOTH doors write and the channel
   * gets the notice twice, the auto-routed copy unsanitized.
   */
  isErrorResult?: boolean;
}
/**
 * `<internal>…</internal>` spans are explicitly not-for-delivery scratchpad.
 * Broader than `stripInternalTags` (which the scratchpad log uses): it also
 * matches an opening tag carrying attributes, and is case-insensitive, so a
 * draft quoted inside one can never be promoted to a real send by the
 * mid-turn scan.
 */
const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;
/**
 * Deliver complete <message to="...">...</message> blocks found in a mid-turn
 * assistant text segment. The SDK's final result carries only the last
 * assistant text, so a wrapped reply composed before a trailing tool call
 * would otherwise never be seen (and the unwrapped-nudge would coax out only
 * a mangled re-send of the final fragment). Chat runs only — in task runs
 * mid-turn blocks stay inert exactly like final-text blocks (one-door: only
 * the send_message tool delivers). Blocks inside an <internal> span are never
 * delivered. Blocks to unknown destinations are left for the result path,
 * which logs the drop into the scratchpad and lets the nudge decide.
 *
 * Cross-segment assembly: `carry` is the unresolved tail of the previous
 * text event (frame-local, turn-local — see midTurnTail in processQuery).
 * The scan runs over carry + text, delivers every complete block in the
 * SETTLED prefix, and returns the new unresolved tail: an unclosed
 * <message …> open (or a bare tag prefix literally split mid-token, e.g.
 * "<mess" / "age to=…"), or an unclosed <internal span — a draft quoted
 * inside one must never be promoted to a send by assembly, so judgment on
 * everything from an open <internal is deferred until it closes. Settled
 * text is consumed exactly once: already-delivered blocks are never inside
 * the carried tail, so they cannot re-match. Net effect: mid-turn parsing
 * behaves as if run over the concatenation of all streamed text, delivered
 * incrementally. A block that never closes anywhere stays in the tail until
 * the turn ends and is then dropped — the wrap-nudge owns that case.
 *
 * Failure ordering: a writeMessageOut failure here propagates and fails the
 * whole turn loudly — the result door never delivers content, so swallowing
 * the error would silently lose the block. An outbound write failure means
 * the session DB is broken; loud is correct.
 */
export interface MidTurnScanResult {
  delivered: number;
  tail: string;
  /**
   * Fork: gate refusals raised on blocks in THIS segment. The mid-turn door is
   * the only delivery door for an `emitsMidTurnText` provider, so the critique
   * and chain-routing gates have to run here or they would be unreachable for
   * that provider. Refusals are sender feedback — the caller pushes them back
   * as a <system> nudge, exactly as the result door does.
   */
  gateRefusals?: string[];
}

export async function deliverMidTurnBlocks(
  text: string,
  routing: RoutingContext,
  turnStartSeq?: number,
  carry = '',
): Promise<MidTurnScanResult> {
  if (routing.taskRun) return { delivered: 0, tail: '' };
  const input = carry + text;
  const tailStart = unresolvedTailStart(input);
  const settled = input.slice(0, tailStart);
  const tail = input.slice(tailStart);
  if (tail && carry !== tail) {
    log(`Mid-turn scan: carrying ${tail.length}-char unresolved tail to the next segment`);
  }
  // Seq high-water mark at THIS scan's start: the echo check below only
  // looks at rows written by EARLIER segments of the same turn — a verbatim
  // duplicate within one settled scan (two identical blocks in one text) is
  // an explicit double-send and still delivers twice, exactly as the result
  // door always treated it.
  const segStartSeq = turnStartSeq === undefined ? 0 : maxOutboundSeq();
  const visible = settled.replace(INTERNAL_SPAN_RE, '');
  // Fork regex: tolerate extra attributes (`thread_id`, `in_reply_to`, plus
  // unknown ones) between `to="…"` and `>`. Upstream's narrower form demands
  // `>` immediately after `to="…"`, which would make every branching-workflow
  // block (`<message to="X" thread_id="Y">`) invisible to this door — and with
  // the result door suppressed, invisible here means silently undelivered.
  const MESSAGE_RE = /<message\s+to="([^"]+)"((?:\s+\w+="[^"]*")*)\s*>([\s\S]*?)<\/message>/g;
  const ATTR_RE = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  let delivered = 0;
  const gateRefusals: string[] = [];
  while ((match = MESSAGE_RE.exec(visible)) !== null) {
    const toName = match[1];
    const attrsStr = match[2] ?? '';
    const rawBody = match[3];
    const body = stripHarnessTagArtifacts(rawBody.trim());
    const dest = findByName(toName);
    if (!dest) continue;
    // Never deliver a blank message: a body that is empty (or was only
    // harness-tag artifacts) is skipped here; the result path logs it.
    if (!body) {
      log(`Mid-turn <message to="${toName}"> empty after sanitization — skipped`);
      continue;
    }
    // Cross-segment echo guard (live-captured shape, SDK battery s03): after
    // a tool call the model often re-emits the ALREADY-SENT block verbatim as
    // its final text. That final text streams as its own text event, so
    // without this check the door would deliver the same message twice. The
    // check consults the outbound DB — the durable record of what this turn
    // actually wrote — over the frame-local seq window (turnStartSeq,
    // segStartSeq]: identical body, same destination, written this turn by an
    // earlier segment ⇒ echo, skip. No in-process content ledger; cross-turn
    // repeats are out of the window and deliver normally.
    if (turnStartSeq !== undefined && wasWrittenInSeqWindow(dest, body, turnStartSeq, segStartSeq)) {
      log(`Mid-turn <message to="${toName}"> is a verbatim repeat of a message already sent this turn — skipped`);
      continue;
    }

    let threadIdOverride: string | undefined;
    let inReplyToOverride: string | undefined;
    for (const am of attrsStr.matchAll(ATTR_RE)) {
      if (am[1] === 'thread_id') threadIdOverride = am[2];
      else if (am[1] === 'in_reply_to') inReplyToOverride = am[2];
      // Unknown attributes are tolerated and ignored — keeps the parser
      // forward-compatible with future protocol extensions.
    }

    // Fork gates, re-applied at this door. With `suppressDelivery` on for an
    // emitsMidTurnText provider this is the ONLY path that writes a block, so
    // gating only in dispatchResultText would let every gated body through for
    // that provider. Same gates, same state, same sender-directed refusal: the
    // body is withheld from the peer and the reason goes back to the emitter.
    const routingGate = checkRoutingGate(body, { threadIdOverride, inReplyToOverride });
    if (routingGate.blocked) {
      log(`Chain-routing gate refused mid-turn delivery to "${toName}": handoff marker missing thread_id/in_reply_to`);
      postOverlayEvent('chain-routing-gate.refused', { destination: toName, reason: routingGate.reason });
      gateRefusals.push(routingGate.reason!);
      continue;
    }
    const gate = checkCritiqueGate(body);
    if (gate.blocked) {
      log(`Critique-gate refused mid-turn delivery to "${toName}": body contained delivery marker, critique_rounds=0`);
      postOverlayEvent('critique-gate.refused', { destination: toName, reason: gate.reason });
      gateRefusals.push(gate.reason!);
      continue;
    }

    await sendToDestination(dest, body, routing, { threadIdOverride, inReplyToOverride });
    delivered++;
    log(`Mid-turn delivery: <message to="${toName}"> (${body.length} chars)`);
  }
  return { delivered, tail, ...(gateRefusals.length ? { gateRefusals } : {}) };
}

const OPEN_INTERNAL_RE = /<internal\b/i;
const OPEN_MESSAGE_RE = /<message\b/;

/**
 * Index where the UNRESOLVED tail of a mid-turn scan begins — everything
 * before it is settled (safe to parse and deliver now), everything from it
 * on must wait for the next text event. input.length when fully settled.
 *
 * Unresolved constructs, earliest wins:
 *  - an unclosed <internal span (case-insensitive, attributes allowed):
 *    blocks quoted inside must not deliver until the span closes and the
 *    exclusion can apply — assembly must never promote a draft;
 *  - an unclosed <message open after the last </message>: the growing block
 *    the assembly exists for. Opens with a close somewhere after them are
 *    finished text (a complete block, or malformed-and-done) — settled;
 *  - a bare tag prefix at the very end ("<mess", "<inter"): a tag literally
 *    split mid-token at the event boundary.
 *
 * Complete <internal> spans are blanked (same length, positions preserved)
 * before looking: an unclosed construct inside a COMPLETED span is settled
 * garbage, not a reason to buffer.
 */
export function unresolvedTailStart(input: string): number {
  const masked = input.replace(INTERNAL_SPAN_RE, (m) => ' '.repeat(m.length));
  const candidates: number[] = [];
  const internalOpen = OPEN_INTERNAL_RE.exec(masked);
  if (internalOpen) candidates.push(internalOpen.index);
  const lastClose = masked.lastIndexOf('</message>');
  const searchFrom = lastClose === -1 ? 0 : lastClose + '</message>'.length;
  const msgOpen = OPEN_MESSAGE_RE.exec(masked.slice(searchFrom));
  if (msgOpen) candidates.push(searchFrom + msgOpen.index);
  if (candidates.length > 0) return Math.min(...candidates);
  const prefixStart = trailingTagPrefixStart(masked);
  return prefixStart === -1 ? input.length : prefixStart;
}

/**
 * Start index of a proper prefix of '<message' (case-sensitive, mirroring
 * MESSAGE_RE) or '<internal' (case-insensitive, mirroring INTERNAL_SPAN_RE)
 * sitting at the very end of the string; -1 when the string does not end
 * mid-token. Longest prefix wins.
 */
function trailingTagPrefixStart(masked: string): number {
  const maxK = Math.min('<internal'.length - 1, masked.length);
  for (let k = maxK; k >= 1; k--) {
    const tailK = masked.slice(masked.length - k);
    if (tailK === '<message'.slice(0, k)) return masked.length - k;
    if (tailK.toLowerCase() === '<internal'.slice(0, k)) return masked.length - k;
  }
  return -1;
}

/** Current outbound seq high-water mark (0 when the table is empty). */
function maxOutboundSeq(): number {
  return getUndeliveredMessages().reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
}

/**
 * Has ANY chat row been written to outbound.db after `afterSeq`? Feeds the
 * result door's nudge decision: unlike the frame-local midTurnSent count,
 * this also sees MCP send_message / send_file deliveries made this turn, so
 * an agent that already replied via tools is not nudged into repeating
 * itself. Fail-open to false: if the lookup breaks, the nudge may fire
 * spuriously (a repeat coax), never silently swallow an undelivered turn.
 */
function chatRowWrittenSince(afterSeq: number): boolean {
  try {
    // ponytail: reuse the existing semantic read; add a cursor operation only if history scans show up in profiles.
    return getUndeliveredMessages().some((message) => (message.seq ?? 0) > afterSeq && message.kind === 'chat');
  } catch (err) {
    log(`chatRowWrittenSince failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Does messages_out already hold a chat row with this exact destination and
 * body, written in the seq window (afterSeq, uptoSeq]? Used by the mid-turn
 * door's cross-segment echo guard. Content equality is exact: the door writes
 * `JSON.stringify({ text: body })` after the same trim/sanitize pipeline, so
 * a true door-written duplicate always matches; a body differing by even one
 * character is a different message and delivers.
 */
function wasWrittenInSeqWindow(dest: DestinationEntry, body: string, afterSeq: number, uptoSeq: number): boolean {
  if (uptoSeq <= afterSeq) return false;
  try {
    const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
    const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
    const content = JSON.stringify({ text: body });
    return getUndeliveredMessages().some(
      (message) =>
        (message.seq ?? 0) > afterSeq &&
        (message.seq ?? 0) <= uptoSeq &&
        message.kind === 'chat' &&
        message.platform_id === platformId &&
        message.channel_type === channelType &&
        message.content === content,
    );
  } catch (err) {
    // The guard is an anti-duplication refinement; if the lookup itself
    // fails, fall through to delivery (the write will surface any real DB
    // breakage loudly).
    log(`Echo-guard lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function dispatchResultText(
  text: string,
  routing: RoutingContext,
  options?: ResultDispatchOptions,
): Promise<{
  sent: number;
  hasUnwrapped: boolean;
  danglingOpen?: boolean;
  gateRefusals?: string[];
  taskBlocks: TaskMessageBlock[];
  resultBlocks: number;
}> {
  // <internal> spans are not-for-delivery scratchpad. Remove them BEFORE block
  // extraction so a <message> drafted inside one is never delivered from the
  // final text either — the mid-turn seam already guarantees this; without the
  // same strip here the guarantee had a final-text hole. Span content still
  // never reaches the user (the closing stripInternalTags pass removed it from
  // the scratchpad already), so nudge/scratchpad semantics are unchanged.
  text = text.replace(INTERNAL_SPAN_RE, '');
  // Capture the destination name (group 1), any additional attributes as one
  // string (group 2), and the body (group 3). Extra attributes — `thread_id`,
  // `in_reply_to`, plus unknown ones — are tolerated. Earlier versions of
  // this regex demanded `>` immediately after `to="..."`, so any agent
  // emitting `<message to="X" thread_id="Y">` saw the entire markup fall
  // through to the scratchpad path and get dumped to the inbound channel
  // instead of routed to the chain target. Branching workflows need the
  // explicit thread_id channel because `resolveDestinationThread` only
  // recovers a thread from prior inbound history — it has no way to
  // synthesize a NEW thread.
  const MESSAGE_RE = /<message\s+to="([^"]+)"((?:\s+\w+="[^"]*")*)\s*>([\s\S]*?)<\/message>/g;
  const ATTR_RE = /(\w+)="([^"]*)"/g;

  let match: RegExpExecArray | null;
  // Blocks delivered mid-turn count toward this turn's sent total — a final
  // text with no (new) blocks after a mid-turn delivery is scratchpad, not an
  // undelivered reply.
  let sent = options?.midTurnSent ?? 0;
  let blocked = 0;
  // <message> blocks present in THIS result text (delivered, stripped, task
  // or dropped alike) — drives the bare-error-text delivery gate, which must
  // key on the error result itself, not on earlier mid-turn deliveries.
  let resultBlocks = 0;
  // <message to> blocks left inert in a task run — drives the same-turn
  // "use send_message" nudge in processQuery (upstream task-delivery feature).
  const taskBlocks: TaskMessageBlock[] = [];
  let lastIndex = 0;
  const scratchpadParts: string[] = [];
  // Gate refusals are feedback for the SENDER, not the peer destination — the
  // caller pushes these back to the emitting agent as a <system> nudge (parity
  // with the bash-hook gates, which exit 2 and surface the error to the sender).
  const gateRefusals: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const attrsStr = match[2] ?? '';
    const body = stripHarnessTagArtifacts(match[3].trim());
    lastIndex = MESSAGE_RE.lastIndex;
    resultBlocks++;

    // One-door delivery in task sessions: only the send_message tool delivers.
    // A final-text <message to> block here is either an echo of a tool send the
    // agent already made (the double-delivery class) or a send down the wrong
    // path — never deliver it, keep it visible in the scratchpad/run log.
    if (routing.taskRun) {
      log(`Task run: <message to="${toName}"> block not delivered — task sessions send only via explicit tools`);
      scratchpadParts.push(
        `[not delivered — task sessions send only via the send_message tool; to="${toName}"] ${body}`,
      );
      taskBlocks.push({ to: toName, body });
      continue;
    }

    let threadIdOverride: string | undefined;
    let inReplyToOverride: string | undefined;
    for (const am of attrsStr.matchAll(ATTR_RE)) {
      if (am[1] === 'thread_id') threadIdOverride = am[2];
      else if (am[1] === 'in_reply_to') inReplyToOverride = am[2];
      // Unknown attributes are tolerated and ignored — keeps the parser
      // forward-compatible with future protocol extensions.
    }

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    // Never deliver a blank message: a body that is empty (or was only
    // harness-tag artifacts stripped by sanitization) goes to the scratchpad
    // log instead of writing an empty chat row.
    if (!body) {
      log(`Empty <message to="${toName}"> body after sanitization — not delivered`);
      scratchpadParts.push(`[not delivered — empty after sanitization; to="${toName}"]`);
      continue;
    }
    const routingGate = checkRoutingGate(body, { threadIdOverride, inReplyToOverride });
    if (routingGate.blocked) {
      log(`Chain-routing gate refused delivery to "${toName}": handoff marker missing thread_id/in_reply_to`);
      // Keep the body in the scratchpad log (the refusal text claims it's
      // "retained in the container scratchpad log only") and emit the overlay
      // event for measurement, but do NOT deliver the refusal to the peer —
      // collect it for the sender-directed nudge instead.
      scratchpadParts.push(`[chain-routing-gate refused delivery to "${toName}"] ${body}`);
      postOverlayEvent('chain-routing-gate.refused', { destination: toName, reason: routingGate.reason });
      gateRefusals.push(routingGate.reason!);
      blocked++;
      continue;
    }

    // Critique-gate scope extension (#67): the bash PreToolUse hook only
    // catches send_message/Bash invocations; this text-output path is
    // where most delivery markers actually land. Same gate, same state,
    // re-applied here. When gated, the body is withheld from the peer and the
    // refusal is routed back to the SENDER (see the routing-gate block above) —
    // delivering it to the peer mis-routed gate feedback into the chain.
    const gate = checkCritiqueGate(body);
    if (gate.blocked) {
      log(`Critique-gate refused delivery to "${toName}": body contained delivery marker, critique_rounds=0`);
      scratchpadParts.push(`[critique-gate refused delivery to "${toName}"] ${body}`);
      postOverlayEvent('critique-gate.refused', { destination: toName, reason: gate.reason });
      gateRefusals.push(gate.reason!);
      blocked++;
      continue;
    }
    // One content door: with an emitsMidTurnText provider the result door
    // never sends. A deliverable block here is either a repeat of a mid-turn
    // delivery (turnDelivered — keep it out of the scratchpad so it does not
    // read as an undelivered reply) or content the streaming door missed —
    // then it goes to the scratchpad as undelivered content, which makes the
    // turn count as undelivered and fires the wrap-nudge: the model re-sends
    // and the retry streams through the mid-turn door.
    //
    // Placed AFTER the gates deliberately: a gated block must be counted as
    // gated (blocked++, refusal to the sender) rather than silently folded
    // into "the streaming door already handled it".
    if (options?.suppressDelivery) {
      if (options.turnDelivered) {
        log(`<message to="${toName}"> in final result after a same-turn delivery — repeat, result door does not send`);
      } else {
        log(
          `<message to="${toName}"> in final result but nothing was delivered this turn — nudging for a mid-turn resend`,
        );
        scratchpadParts.push(`[not delivered — the result door does not send; to="${toName}"] ${body}`);
      }
      continue;
    }
    await sendToDestination(dest, body, routing, { threadIdOverride, inReplyToOverride });
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  // Refuse to deliver when an opening `<message to="…">` was emitted with no
  // matching close tag — the regex above silently skipped the block, and the
  // single-destination/auto-route shortcut below would otherwise dump the
  // entire half-finished payload onto the inbound channel (the case that
  // mis-routed an a2a "Review Resume" dispatch to the dashboard in May 2026).
  // Treat it as undelivered so the nudge fires and the agent re-sends.
  const danglingOpen = /<message\s+to="[^"]+"[^>]*>/.test(scratchpad);

  // Single-destination shortcut: plain text is auto-routed.
  // 'system' is blocked — its inbound carries platformId=null, so there's
  // nowhere to send anyway; explicit gate as defense-in-depth.
  // 'agent' auto-routes to platformId (the source agent group). Same-session
  // protection lives in agent-route.ts's same-session guard, which catches
  // any write that resolves back to the emitting session regardless of how
  // it was emitted (auto-route, <message to=…>, or send_message).
  //
  // NOT in a task run (upstream one-door contract): a task session's final
  // text is its run-log summary (autoAppendTaskLog handles it in processQuery),
  // never auto-delivered to a destination. Without this guard the fork's
  // single-destination shortcut would deliver task-run scratchpad, breaking the
  // "final-output blocks stay inert" invariant.
  //
  // NOT under `suppressDelivery` either: auto-routing IS a result-door
  // delivery, and for an emitsMidTurnText provider the result door never
  // delivers content. Letting it through here would re-open the double-send
  // the one-door design closes — and would deliver the "[not delivered — the
  // result door does not send]" scratchpad note itself as chat. Unwrapped
  // final text from a streaming provider is a self-summary; the wrap-nudge
  // owns it. Non-streaming providers (codex, opencode) keep the shortcut.
  if (
    !routing.taskRun &&
    !options?.suppressDelivery &&
    !options?.isErrorResult &&
    sent === 0 &&
    blocked === 0 &&
    scratchpad &&
    !danglingOpen
  ) {
    const internalChannel = routing.channelType === 'system';
    if (routing.channelType && routing.platformId && !internalChannel) {
      await writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return { sent: 1, hasUnwrapped: false, taskBlocks: [], resultBlocks };
    }
    if (!internalChannel) {
      const all = getAllDestinations();
      if (all.length === 1) {
        await sendToDestination(all[0], scratchpad, routing);
        return { sent: 1, hasUnwrapped: false, taskBlocks: [], resultBlocks };
      }
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  // A purely-gated batch (blocked > 0, sent === 0) is NOT "unwrapped" — the
  // agent wrapped its output correctly; the gate withheld it. It gets the
  // gate-specific refusal nudge instead of the generic "wrap your output" one.
  // In a task run, plain final text is the NORMAL ending (it becomes the run
  // log) — never treat it as an undelivered reply or nudge the agent to wrap it.
  // With suppressDelivery the delivered-this-turn question is answered by
  // turnDelivered (door deliveries + DB-visible sends like MCP send_message);
  // otherwise by this dispatch's own send count.
  const anythingDelivered = options?.suppressDelivery ? options.turnDelivered === true : sent > 0;
  const hasUnwrapped = !routing.taskRun && !anythingDelivered && blocked === 0 && (!!scratchpad || danglingOpen);
  if (hasUnwrapped) {
    if (danglingOpen) {
      log(`WARNING: agent emitted <message to="..."> with no closing </message>; nothing was sent`);
    } else {
      log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
    }
  }
  return {
    sent,
    hasUnwrapped,
    danglingOpen,
    gateRefusals: gateRefusals.length ? gateRefusals : undefined,
    taskBlocks,
    resultBlocks,
  };
}

/**
 * Should this task-run result get the same-turn "your <message> block was
 * not delivered — use send_message" nudge? True at most once per turn
 * (mirrors the unwrappedNudged flag for chat turns).
 */
export function shouldNudgeTaskBlocks(
  taskRun: boolean,
  taskBlocks: TaskMessageBlock[],
  alreadyNudged: boolean,
): boolean {
  return taskRun && taskBlocks.length > 0 && !alreadyNudged;
}

export function buildTaskBlockNudge(taskBlocks: TaskMessageBlock[], destinationNames: string): string {
  const blocks = taskBlocks
    .map(
      ({ to, body }) =>
        `<undelivered_message to="${escapePromptXml(to)}">${escapePromptXml(body)}</undelivered_message>`,
    )
    .join('\n');
  return (
    '<system>The final-output content below was not delivered from this task run:\n' +
    `${blocks}\n` +
    'If and only if any of it still needs to be sent, call send_message with an explicit to destination. ' +
    'If it was already sent or no notification is required, do not send it again. ' +
    `Your destinations: ${escapePromptXml(destinationNames)}. ` +
    'The original task result is already recorded in the run log; do not repeat it.</system>'
  );
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Task runs: the final text is the automatic run summary. Explicit
 * `ncl tasks append-log` calls are additive mid-run notes. Written as a
 * `task_log` outbound row; the host appends it to the series' tasks/<id>.md
 * with its usual timestamp stamp. Never delivered to anyone.
 */
export async function autoAppendTaskLog(text: string): Promise<void> {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!line) return;
  await writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    content: JSON.stringify({ text: line }),
  });
  log('Task run log auto-appended from final text');
}

/**
 * Resolve an agent-supplied `in_reply_to` override to the canonical inbound
 * message id, mirroring `resolveInReplyTo` in the send_message MCP tool.
 *
 * The formatter shows each inbound message as id="<seq>", so agents quote the
 * integer seq. Returns:
 *   - `undefined` when there is no override (so the caller's `??` chain falls
 *     through to the destination/routing default),
 *   - the resolved canonical id when the seq maps to a real inbound row,
 *   - `undefined` when a numeric seq does NOT resolve (fall back to the
 *     canonical routing value — never persist a bare seq),
 *   - the raw value unchanged when it is already a non-numeric canonical id.
 */
export function resolveInReplyToOverride(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const seq = Number(raw);
  if (Number.isNaN(seq)) return raw; // non-numeric → already a canonical id, use as-is
  if (!Number.isInteger(seq) || seq <= 0) return undefined; // numeric but not a valid seq → fall back
  try {
    const row = getMessageInBySeq(seq);
    return row ? row.id : undefined; // resolved id, or fall back — never persist a bare seq
  } catch {
    return undefined; // never worse than the canonical routing fallback
  }
}

async function sendToDestination(
  dest: DestinationEntry,
  body: string,
  routing: RoutingContext,
  overrides?: { threadIdOverride?: string; inReplyToOverride?: string },
): Promise<void> {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Task runs: an explicitly-addressed final-text block that duplicates an MCP
  // send the agent already made this turn is a turn-final echo — drop it here,
  // where the duplication originates (#943). `taskRun` is the upstream-sync
  // rename of the fork's former `taskFire`.
  if (routing.taskRun && hasIdenticalSend(platformId, channelType, body)) {
    log(`Dropping turn-final echo of an already-sent task message to ${dest.name}`);
    return;
  }
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  // Agent-supplied overrides win: a `<message to="X" thread_id="...">` is
  // explicit branching intent (e.g. starting a new chain on a destination
  // we've never received from), and inbound-history resolution can't
  // produce a thread we've never seen.
  const destRouting = resolveDestinationThread(channelType, platformId);
  const threadId = overrides?.threadIdOverride ?? destRouting?.threadId ?? null;
  // An agent-supplied `in_reply_to` override is the integer id shown on an
  // inbound message (the formatter renders id="<seq>"). Resolve it to the
  // canonical message id the same way `send_message` does — otherwise the raw
  // seq is persisted as `in_reply_to`, the host's id-based source lookup
  // (getInboundSourceSessionId) misses, and routing silently falls back to
  // peer-affinity guessing. That is the seq-as-id ("D2") misroute.
  const resolvedOverride = resolveInReplyToOverride(overrides?.inReplyToOverride);
  const inReplyTo = resolvedOverride ?? destRouting?.inReplyTo ?? routing.inReplyTo;
  await writeMessageOut({
    id: generateId(),
    in_reply_to: routing.taskRun ? null : inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: threadId,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    return getAgentMailbox().operations.getLatestInboundRoute(channelType, platformId);
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
