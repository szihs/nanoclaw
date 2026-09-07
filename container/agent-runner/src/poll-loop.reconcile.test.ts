/**
 * `{protocolVersion:2, operation:'reconcile'}` — set live enforcement spend
 * (`costSpentUsd`) to the transcript oracle (issue #1327 remediation). Pins the
 * money-safety invariants `applyReconcileOverride` (poll-loop.ts) must uphold,
 * seeding/reading the SAME module-private accumulator via `__costCapTestHooks`
 * exactly as `poll-loop.setCeiling.test.ts` does (no module mocks, real in-memory
 * session DB).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getCostCap, getCostControlProtocol } from './db/session-state.js';
import { __setConfigForTest } from './config.js';
import { __costCapTestHooks as H } from './poll-loop.js';
import type { RunnerConfig } from './config.js';
import type { MessageInRow } from './db/messages-in.js';

function cfg(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    provider: 'claude',
    assistantName: 'test',
    groupName: 'test',
    agentGroupId: 'ag-test',
    maxMessagesPerPrompt: 10,
    mcpServers: {},
    model: 'claude-opus-4-8',
    ...over,
  };
}

function seed(over: Parameters<typeof H.setState>[0] = {}): void {
  H.setState({
    costEnabled: true,
    costImmortal: false,
    costWindow: 'lifetime',
    costDayKey: undefined,
    costAllotmentUsd: 10,
    costCapUsd: 10,
    costSpentUsd: 0,
    costEscalatedAt: undefined,
    costDecision: undefined,
    costDecidedAt: undefined,
    costStopRequested: false,
    costCeilingUsd: 0,
    costCeilingAllotmentUsd: 0,
    costCeilingEscalated: false,
    costCeilingHardStop: false,
    costBudgetGen: 0,
    costEpisodeId: undefined,
    pendingCostNudge: undefined,
    // Reset the #65 ledger identity + accounting markers so buildCostCapState
    // assertions start from a known place.
    codexLedger: {},
    codexUsdCharged: 0,
    codexLedgerBaselinePending: false,
    ledgerGen: 0,
    ledgerAdjSeq: 0,
    ledgerBaselinePending: false,
    ledgerBaselineVersion: 1,
    ...over,
  });
}

/** A reconcile `cost_override` inbound row. `expectedSpentCents` defaults to the
 *  live seeded spend so the third CAS leg passes unless a test overrides it. */
function reconcileMsg(over: {
  adjustmentId?: string;
  expectedEpochKey?: string | number;
  expectedCeilingCents?: number;
  expectedSpentCents?: number;
  targetSpentCents?: number;
  forced?: boolean;
  id?: string;
}): MessageInRow {
  const adjustmentId = over.adjustmentId ?? 'csr-test';
  const expectedSpentCents = over.expectedSpentCents ?? Math.round(H.getState().costSpentUsd * 100);
  return {
    id: over.id ?? `in-${adjustmentId}`,
    kind: 'cost_override',
    content: JSON.stringify({
      protocolVersion: 2,
      operation: 'reconcile',
      adjustmentId,
      expectedEpochKey: String(over.expectedEpochKey ?? '0'),
      expectedCeilingCents: over.expectedCeilingCents ?? 0,
      expectedSpentCents,
      targetSpentCents: over.targetSpentCents ?? 0,
      ...(over.forced !== undefined ? { forced: over.forced } : {}),
    }),
  } as unknown as MessageInRow;
}

/** `cost_reconcile_result` receipts written to the real outbound DB. */
function receipts(adjustmentId?: string): Array<{ content: string }> {
  return getUndeliveredMessages().filter((m) => {
    if (m.kind !== 'system') return false;
    let c: { action?: string; adjustmentId?: string };
    try {
      c = JSON.parse(m.content) as { action?: string; adjustmentId?: string };
    } catch {
      return false;
    }
    return c.action === 'cost_reconcile_result' && (adjustmentId ? c.adjustmentId === adjustmentId : true);
  });
}

function receiptPayload(adjustmentId: string): Record<string, unknown> {
  const rows = receipts(adjustmentId);
  expect(rows).toHaveLength(1);
  return JSON.parse(rows[0].content) as Record<string, unknown>;
}

function ackStatus(messageId: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
    | { status: string }
    | undefined;
  return row?.status;
}

beforeEach(() => {
  initTestSessionDb();
  __setConfigForTest(cfg());
  seed();
});

afterEach(() => {
  __setConfigForTest(null);
  closeSessionDb();
});

describe('reconcile — the core #1327 correction (inflated -> real)', () => {
  it('lowers spend to the oracle, resumes a falsely-stopped session, rotates the epoch, acks', () => {
    // Falsely stopped: $155 enforcement spend over a $150 ceiling (a 3.1x-style
    // inflation of a real ~$50 cost).
    seed({
      costCeilingUsd: 150,
      costBudgetGen: 7,
      costSpentUsd: 155,
      costStopRequested: true,
      costCeilingHardStop: true,
    });
    expect(H.computeCostStatus()).toBe('stopped');

    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-1',
        expectedEpochKey: 7,
        expectedCeilingCents: 15000,
        expectedSpentCents: 15500,
        targetSpentCents: 5000,
      }),
    );

    const s = H.getState();
    expect(s.costSpentUsd).toBeCloseTo(50); // set verbatim to the oracle
    expect(s.costCeilingUsd).toBeCloseTo(150); // ceiling UNCHANGED
    expect(s.costBudgetGen).toBe(8); // rotated
    expect(s.costStopRequested).toBe(false); // resumed: 50 < 150
    expect(s.costCeilingHardStop).toBe(false);
    expect(s.pendingCostNudge).toBeUndefined(); // a correction, not a budget grant -> no nudge
    expect(H.computeCostStatus()).not.toBe('stopped');
    expect(ackStatus('in-csr-1')).toBe('completed');

    const receipt = receiptPayload('csr-1');
    expect(receipt).toMatchObject({
      action: 'cost_reconcile_result',
      outcome: 'applied',
      expectedEpochKey: '7',
      previousEpochKey: '7',
      resultEpochKey: '8',
      expectedCeilingCents: 15000,
      resultCeilingCents: 15000,
      expectedSpentCents: 15500,
      targetSpentCents: 5000,
      previousSpentCents: 15500,
      resultSpentCents: 5000,
    });
    expect(getCostCap()?.spentUsd).toBeCloseTo(50);
  });

  it('a correction that stays at/over the ceiling remains stopped, at exactly the oracle value', () => {
    // Real cost genuinely exceeds the ceiling — reconcile does NOT resume it.
    seed({
      costCeilingUsd: 150,
      costBudgetGen: 2,
      costSpentUsd: 2550,
      costStopRequested: true,
      costCeilingHardStop: true,
    });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-2',
        expectedEpochKey: 2,
        expectedCeilingCents: 15000,
        expectedSpentCents: 255000,
        targetSpentCents: 20000,
      }),
    );

    const s = H.getState();
    expect(s.costSpentUsd).toBeCloseTo(200); // verbatim, not clamped
    expect(s.costStopRequested).toBe(true); // 200 >= 150 -> still stopped
    expect(s.costCeilingHardStop).toBe(true);
    expect(H.computeCostStatus()).toBe('stopped');
    expect(receiptPayload('csr-2').outcome).toBe('applied'); // it applied — just didn't resume
  });

  it('reconcile to $0 is accepted (fully absorbs an inflated figure)', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300, costStopRequested: true });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-zero',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 0,
      }),
    );
    expect(H.getState().costSpentUsd).toBeCloseTo(0);
    expect(H.getState().costStopRequested).toBe(false);
    expect(receiptPayload('csr-zero').outcome).toBe('applied');
  });

  it('a lower on a healthy (never-stopped) session moves the status band and re-arms cap escalation', () => {
    // spent $12 over a $10 cap (escalated) but under a $150 ceiling -> reconcile to
    // $5 drops it back to 'ok' AND clears escalatedAt so a future crossing re-fires.
    seed({
      costCeilingUsd: 150,
      costCapUsd: 10,
      costBudgetGen: 3,
      costSpentUsd: 12,
      costEscalatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(H.computeCostStatus()).toBe('escalated');
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-band',
        expectedEpochKey: 3,
        expectedCeilingCents: 15000,
        expectedSpentCents: 1200,
        targetSpentCents: 500,
      }),
    );
    expect(H.getState().costSpentUsd).toBeCloseTo(5);
    expect(H.getState().costEscalatedAt).toBeUndefined(); // re-armed (5 < 10 cap)
    expect(H.computeCostStatus()).toBe('ok');
  });
});

describe('reconcile — preserves an explicit human stop (does not resurrect it)', () => {
  it('a session a human STOPPED stays stopped even when the correction drops below the ceiling', () => {
    seed({
      costCeilingUsd: 150,
      costBudgetGen: 4,
      costSpentUsd: 300,
      costStopRequested: true,
      costDecision: 'stop', // human clicked Stop
    });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-humanstop',
        expectedEpochKey: 4,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 5000, // $50 < $150 ceiling
      }),
    );
    const s = H.getState();
    expect(s.costSpentUsd).toBeCloseTo(50); // spend corrected
    expect(s.costStopRequested).toBe(true); // human stop PRESERVED
    expect(s.costCeilingHardStop).toBe(false); // ceiling hard-stop cleared
    expect(H.computeCostStatus()).toBe('stopped');
    expect(receiptPayload('csr-humanstop').outcome).toBe('applied');
  });

  it('a FORCED reconcile on a human-stopped session still preserves the stop and echoes forced:true', () => {
    // DEFENSE IN DEPTH: the host now refuses to force past a `stopped` card at
    // submit (that would defeat a human stop), so this message should never be
    // enqueued. But the runner has no card concept, so even if one arrived, `forced`
    // changes NO logic — the human stop is still preserved, and the flag is echoed.
    seed({
      costCeilingUsd: 150,
      costBudgetGen: 4,
      costSpentUsd: 300,
      costStopRequested: true,
      costDecision: 'stop',
    });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-forcedstop',
        expectedEpochKey: 4,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 4400, // $44 real, well under the ceiling
        forced: true,
      }),
    );
    const s = H.getState();
    expect(s.costSpentUsd).toBeCloseTo(44); // phantom spend removed
    expect(s.costStopRequested).toBe(true); // stop still preserved despite --force
    const receipt = receiptPayload('csr-forcedstop');
    expect(receipt.outcome).toBe('applied');
    expect(receipt.forced).toBe(true); // audit echo
  });

  it('a non-forced reconcile echoes forced:false', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300 });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-unforced',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 5000,
      }),
    );
    expect(receiptPayload('csr-unforced').forced).toBe(false);
  });

  it('--force does NOT bypass the lower-only rule at the runner either', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 100 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-forceraise',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 10000,
        targetSpentCents: 20000, // above live spend
        forced: true,
      }),
    );
    expect(H.getState()).toEqual(before); // zero mutation
    expect(receiptPayload('csr-forceraise').reason).toBe('invalid_value');
  });
});

describe('reconcile — preserves the #1327 accounting version + #65 ledger identity in the persisted blob', () => {
  it('the committed cost_cap keeps accountingVersion:2 and the ledger identity (not the minimal set-ceiling blob)', () => {
    seed({
      costCeilingUsd: 150,
      costBudgetGen: 1,
      costSpentUsd: 400,
      ledgerGen: 4,
      ledgerAdjSeq: 2,
      ledgerBaselineVersion: 1,
    });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-acct',
        expectedEpochKey: 1,
        expectedCeilingCents: 15000,
        expectedSpentCents: 40000,
        targetSpentCents: 5000,
      }),
    );
    const blob = getCostCap();
    expect(blob?.accountingVersion).toBe(2); // NOT dropped -> no spurious re-upgrade log on respawn
    expect(blob?.ledgerGen).toBe(4); // #65 identity preserved
    expect(blob?.ledgerBaselineVersion).toBe(1); // NOT re-seeded on respawn
    expect(blob?.protocolVersion).toBe(2);
    expect(blob?.spentUsd).toBeCloseTo(50);
  });
});

describe('reconcile — idempotency + 3-leg CAS (epoch / ceiling / spend)', () => {
  it('a redelivered copy of the SAME request does not apply twice (epoch rotated)', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300 });
    const msg = reconcileMsg({
      adjustmentId: 'csr-dup',
      expectedEpochKey: 0,
      expectedCeilingCents: 15000,
      expectedSpentCents: 30000,
      targetSpentCents: 5000,
    });

    H.applyCostOverride(msg);
    expect(H.getState().costBudgetGen).toBe(1);
    expect(H.getState().costSpentUsd).toBeCloseTo(50);
    expect(receiptPayload('csr-dup').outcome).toBe('applied');

    // Redelivered: the epoch fence catches it before any mutation, and the
    // deterministic receipt id then collides -> the doomed commit throws.
    expect(() => H.applyCostOverride(msg)).toThrow();
    expect(H.getState().costBudgetGen).toBe(1); // not rotated again
    expect(H.getState().costSpentUsd).toBeCloseTo(50); // unchanged by the failed replay
  });

  it('epoch mismatch is a conflict/epoch_mismatch with zero mutation', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 7, costSpentUsd: 300 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-em',
        expectedEpochKey: 6,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 5000,
      }),
    );
    expect(H.getState()).toEqual(before);
    const receipt = receiptPayload('csr-em');
    expect(receipt.outcome).toBe('conflict');
    expect(receipt.reason).toBe('epoch_mismatch');
    expect(receipt.resultEpochKey).toBe('7');
    expect(receipt.resultSpentCents).toBe(30000); // reports live (uncorrected) spend
  });

  it('ceiling mismatch (right epoch, wrong expected ceiling) is a conflict/ceiling_mismatch', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 7, costSpentUsd: 300 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-cm',
        expectedEpochKey: 7,
        expectedCeilingCents: 14999,
        expectedSpentCents: 30000,
        targetSpentCents: 5000,
      }),
    );
    expect(H.getState()).toEqual(before);
    const receipt = receiptPayload('csr-cm');
    expect(receipt.outcome).toBe('conflict');
    expect(receipt.reason).toBe('ceiling_mismatch');
    expect(receipt.resultCeilingCents).toBe(15000);
  });

  it('SPEND mismatch (a turn accrued since the host read) is a conflict/spent_mismatch — accrual never erased', () => {
    // Host read spend at $120 (12000c); by the time the control lands, live spend
    // is $125 — a legitimate turn accrued. The absolute set must NOT erase it.
    seed({ costCeilingUsd: 150, costBudgetGen: 2, costSpentUsd: 125 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-sm',
        expectedEpochKey: 2,
        expectedCeilingCents: 15000,
        expectedSpentCents: 12000, // stale
        targetSpentCents: 4000,
      }),
    );
    expect(H.getState()).toEqual(before); // zero mutation — accrual preserved
    const receipt = receiptPayload('csr-sm');
    expect(receipt.outcome).toBe('conflict');
    expect(receipt.reason).toBe('spent_mismatch');
    expect(receipt.resultSpentCents).toBe(12500);
  });

  it('a set_ceiling that lands first makes a same-epoch reconcile conflict (cross-operation fence)', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300, costStopRequested: true });
    // set_ceiling raises to $500 and rotates the gen 0 -> 1.
    H.applyCostOverride({
      id: 'in-sc',
      kind: 'cost_override',
      content: JSON.stringify({
        protocolVersion: 2,
        operation: 'set_ceiling',
        adjustmentId: 'cca-x',
        expectedEpochKey: '0',
        expectedCeilingCents: 15000,
        targetCeilingCents: 50000,
      }),
    } as unknown as MessageInRow);
    expect(H.getState().costBudgetGen).toBe(1);

    // The reconcile was stamped against epoch 0 -> now stale.
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-cross',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 5000,
      }),
    );
    expect(receiptPayload('csr-cross').outcome).toBe('conflict');
    expect(receiptPayload('csr-cross').reason).toBe('epoch_mismatch');
  });
});

describe('reconcile — lower-only, immortal, disabled, and the sanity maximum', () => {
  it('a target ABOVE the expected live spend is REJECTED as invalid_value (reconcile only lowers)', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 100 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-raise',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 10000,
        targetSpentCents: 20000, // above live spend
      }),
    );
    expect(H.getState()).toEqual(before);
    expect(receiptPayload('csr-raise').reason).toBe('invalid_value');
  });

  it('immortal request is REJECTED with zero mutation', () => {
    seed({ costImmortal: true, costWindow: 'daily', costCeilingUsd: 150, costBudgetGen: 1, costSpentUsd: 300 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-imm',
        expectedEpochKey: 1,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 5000,
      }),
    );
    expect(H.getState()).toEqual(before);
    const receipt = receiptPayload('csr-imm');
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.reason).toBe('immortal');
  });

  it('cost tracking disabled -> REJECTED (cost_tracking_disabled), still acks', () => {
    seed({ costEnabled: false });
    const msg = reconcileMsg({ adjustmentId: 'csr-off' });
    H.applyCostOverride(msg);
    expect(receiptPayload('csr-off').outcome).toBe('rejected');
    expect(receiptPayload('csr-off').reason).toBe('cost_tracking_disabled');
    expect(ackStatus(msg.id)).toBe('completed');
  });

  it('a target above the $1,000,000 sanity max is REJECTED as invalid_value, zero mutation', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300 });
    const before = H.getState();
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-max',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 100_000_001,
      }),
    );
    expect(H.getState()).toEqual(before);
    expect(receiptPayload('csr-max').reason).toBe('invalid_value');
  });

  it('a non-integer / negative target is REJECTED as invalid_value', () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300 });
    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-frac',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: 12.5,
      }),
    );
    expect(receiptPayload('csr-frac').reason).toBe('invalid_value');

    H.applyCostOverride(
      reconcileMsg({
        adjustmentId: 'csr-neg',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 30000,
        targetSpentCents: -100,
      }),
    );
    expect(receiptPayload('csr-neg').reason).toBe('invalid_value');
  });
});

describe('reconcile — atomicity', () => {
  it('state + receipt + ack are all committed, or all absent, under an injected transaction failure', async () => {
    seed({ costCeilingUsd: 150, costBudgetGen: 0, costSpentUsd: 300 });
    const adjustmentId = 'csr-boom';
    // Poison the deterministic receipt id so the INSERT inside the atomic commit
    // throws a REAL UNIQUE-constraint violation.
    await writeMessageOut({
      id: `cost-reconcile-result:${adjustmentId}`,
      kind: 'system',
      content: JSON.stringify({ poison: true }),
    });
    const capBefore = getCostCap();
    const msg = reconcileMsg({
      adjustmentId,
      expectedEpochKey: 0,
      expectedCeilingCents: 15000,
      expectedSpentCents: 30000,
      targetSpentCents: 5000,
    });

    expect(() => H.applyCostOverride(msg)).toThrow();

    // Nothing new committed: cost_cap unchanged, processing_ack never written ->
    // the message is reprocessed from the same pre-mutation persisted state.
    expect(getCostCap()).toEqual(capBefore);
    expect(ackStatus(msg.id)).toBeUndefined();
  });
});

describe('reconcile — the control payload never reaches the model prompt', () => {
  it('a reconcile cost_override row is excluded from the formatted prompt, by kind', async () => {
    const { formatMessages } = await import('./formatter.js');
    const batch = [
      { id: 'chat-1', kind: 'chat', content: JSON.stringify({ sender: 'User', text: 'hello there' }) },
      reconcileMsg({
        adjustmentId: 'csr-secret-marker-xyz',
        expectedEpochKey: 0,
        expectedCeilingCents: 15000,
        expectedSpentCents: 0,
        targetSpentCents: 0,
      }),
    ] as unknown as MessageInRow[];

    const normalMessages = batch.filter((m) => m.kind !== 'cost_override');
    expect(normalMessages).toHaveLength(1);

    const prompt = formatMessages(normalMessages);
    expect(prompt).toContain('hello there');
    expect(prompt).not.toContain('csr-secret-marker-xyz');
    expect(prompt).not.toContain('reconcile');
    expect(prompt).not.toContain('targetSpentCents');
  });
});

describe('reconcile — the runner advertises the reconcile capability', () => {
  it('publishRunnerReadiness includes both set_ceiling and reconcile in operations', () => {
    const prior = process.env.NANOCLAW_RUNNER_INSTANCE_ID;
    process.env.NANOCLAW_RUNNER_INSTANCE_ID = 'nonce-xyz';
    try {
      H.publishRunnerReadiness();
      const handshake = getCostControlProtocol();
      expect(handshake?.operations).toContain('set_ceiling');
      expect(handshake?.operations).toContain('reconcile');
    } finally {
      if (prior === undefined) delete process.env.NANOCLAW_RUNNER_INSTANCE_ID;
      else process.env.NANOCLAW_RUNNER_INSTANCE_ID = prior;
    }
  });
});
