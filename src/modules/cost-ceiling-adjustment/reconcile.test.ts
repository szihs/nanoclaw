/**
 * `cost_reconcile` (issue #1327) — the host module's submission flow + receipt
 * ingest, reusing the SAME `cost_ceiling_adjustments` ledger + CAS + reconciler as
 * set-ceiling. Real central DB and REAL inbound.db files on disk; the
 * container-runner / live-state reader / path modules are mocked exactly as in
 * `index.test.ts`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, openInboundDb as openInboundDbRaw } from '../../mailbox/sqlite/session-db.js';

const mockIsContainerRunning = vi.fn();
const mockWakeContainer = vi.fn();
const mockGetActiveContainerInstanceId = vi.fn();
vi.mock('../../container-runner.js', () => ({
  isContainerRunning: (...a: unknown[]) => mockIsContainerRunning(...a),
  wakeContainer: (...a: unknown[]) => mockWakeContainer(...a),
  getActiveContainerInstanceId: (...a: unknown[]) => mockGetActiveContainerInstanceId(...a),
}));

const mockReadSessionCostCapStatus = vi.fn();
const mockReadSessionCostControlProtocol = vi.fn();
vi.mock('../../cli/session-cost-cap.js', () => ({
  readSessionCostCapStatus: (...a: unknown[]) => mockReadSessionCostCapStatus(...a),
  readSessionCostControlProtocol: (...a: unknown[]) => mockReadSessionCostControlProtocol(...a),
}));

let tmpDir: string;
function inboundPathFor(agentGroupId: string, sessionId: string): string {
  return path.join(tmpDir, `${agentGroupId}__${sessionId}__inbound.db`);
}
vi.mock('../../mailbox/sqlite/paths.js', () => ({
  inboundDbPath: (agentGroupId: string, sessionId: string) => inboundPathFor(agentGroupId, sessionId),
}));
vi.mock('../../session-manager.js', () => ({
  openInboundDb: (agentGroupId: string, sessionId: string) => openInboundDbRaw(inboundPathFor(agentGroupId, sessionId)),
}));

import { createAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import {
  createCostCeilingAdjustment,
  getCostCeilingAdjustment,
  getLatestCostCeilingAdjustmentBySession,
} from '../../db/cost-ceiling-adjustments.js';
import { getCostCapPolicy, setCostCapPolicy } from '../../db/cost-cap-policy.js';
import { ingestEpisode } from '../../db/cost-escalation-episodes.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import {
  __testHooks,
  ingestCostReconcileReceipt,
  reconcileCostCeilingAdjustments,
  submitCostReconcile,
} from './index.js';

const SESSION_ID = 'sess-rec-1';
const AGENT_GROUP_ID = 'ag-rec';
const NOW = '2026-09-02T12:00:00.000Z';

function healthyCapView(over: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    agent_group_id: AGENT_GROUP_ID,
    status: 'stopped',
    cap_usd: 10,
    spent_usd: 155, // inflated enforcement spend (the #1327 problem)
    immortal: false,
    window: 'lifetime',
    ceiling_usd: 150,
    budget_gen: 7,
    ...over,
  };
}

function readyHandshake(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    runner_instance_id: 'nonce-current',
    ready_at: NOW,
    operations: ['set_ceiling', 'reconcile'],
    ...over,
  };
}

function wireDefaults(): void {
  mockIsContainerRunning.mockReturnValue(true);
  mockWakeContainer.mockResolvedValue(true);
  mockGetActiveContainerInstanceId.mockReturnValue('nonce-current');
  mockReadSessionCostCapStatus.mockResolvedValue(healthyCapView());
  mockReadSessionCostControlProtocol.mockResolvedValue(readyHandshake());
}

/** The reconcile control message the runner receives, keyed by the ledger row's adjustment id. */
function latestReconcileControlMessage(): { kind: string; content: string } | undefined {
  const db = openInboundDbRaw(inboundPathFor(AGENT_GROUP_ID, SESSION_ID));
  try {
    return db
      .prepare("SELECT kind, content FROM messages_in WHERE kind = 'cost_override' ORDER BY rowid DESC LIMIT 1")
      .get() as { kind: string; content: string } | undefined;
  } finally {
    db.close();
  }
}

function provisionSessionDb(): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPathFor(AGENT_GROUP_ID, SESSION_ID), 'inbound');
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-reconcile-test-'));
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AGENT_GROUP_ID, name: 'rec', folder: 'rec', created_at: NOW });
  await createSession({
    id: SESSION_ID,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'running',
    last_active: NOW,
    created_at: NOW,
  });
  provisionSessionDb();
  wireDefaults();
  __testHooks.setHandshakeTimingForTest(60, 10);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  __testHooks.resetHandshakeTimingForTest();
});

describe('submitCostReconcile — validation', () => {
  it('rejects an empty session id', async () => {
    const res = await submitCostReconcile('', 42, 'test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_session_id');
  });

  it.each([-1, NaN, Infinity])('rejects a non-finite/negative target: %p', async (bad) => {
    const res = await submitCostReconcile(SESSION_ID, bad as number, 'test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target_spent');
  });

  it('rejects a target above the $1,000,000 sanity max', async () => {
    const res = await submitCostReconcile(SESSION_ID, 1_000_000.01, 'test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target_spent');
  });

  it('404s an unknown session', async () => {
    const res = await submitCostReconcile('sess-nope', 42, 'test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session_not_found');
  });
});

describe('submitCostReconcile — immortal / live-state guards', () => {
  it('422s immortal authoritatively (central field) before reading live state', async () => {
    await createAgentGroup({ id: 'ag-adm', name: 'adm', folder: 'adm', is_admin: 1, created_at: NOW });
    await createSession({
      id: 'sess-adm',
      agent_group_id: 'ag-adm',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'claude',
      status: 'active',
      container_status: 'running',
      last_active: NOW,
      created_at: NOW,
    });
    const res = await submitCostReconcile('sess-adm', 42, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('immortal');
    expect(mockReadSessionCostCapStatus).not.toHaveBeenCalled();
  });

  it("422s immortal from coworker_type='main'", async () => {
    await updateAgentGroup(AGENT_GROUP_ID, { coworker_type: 'main' });
    const res = await submitCostReconcile(SESSION_ID, 42, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('immortal');
  });

  it('422s cost_tracking_unavailable when status is unknown', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue({
      session_id: SESSION_ID,
      agent_group_id: AGENT_GROUP_ID,
      status: 'unknown',
    });
    const res = await submitCostReconcile(SESSION_ID, 42, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('cost_tracking_unavailable');
  });

  it('422s no_live_ceiling when ceiling is 0', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(healthyCapView({ ceiling_usd: 0 }));
    const res = await submitCostReconcile(SESSION_ID, 42, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_live_ceiling');
  });

  it('422s ceiling_out_of_range when the live ceiling exceeds $1000 (reconcile-supported bound)', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(healthyCapView({ ceiling_usd: 2000 }));
    const res = await submitCostReconcile(SESSION_ID, 42, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('ceiling_out_of_range');
  });

  it('422s cost_tracking_unavailable when no live spend is reported', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(healthyCapView({ spent_usd: undefined }));
    const res = await submitCostReconcile(SESSION_ID, 42, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('cost_tracking_unavailable');
  });

  it('422s target_above_live_spend — reconcile only ever LOWERS spend to the oracle', async () => {
    // live spend $155; asking to raise to $200 is refused before any submission.
    const res = await submitCostReconcile(SESSION_ID, 200, 'test');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('target_above_live_spend');
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined();
  });
});

describe('submitCostReconcile — no-op guard', () => {
  it('200s a no-op when the target already equals live spend (never submits, never rotates)', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(healthyCapView({ spent_usd: 42 }));
    const res = await submitCostReconcile(SESSION_ID, 42, 'test');
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true);
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined(); // no ledger row
  });
});

describe('submitCostReconcile — runner readiness', () => {
  it('503s when the runner is not ready; never creates a ledger row or control message', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    mockWakeContainer.mockResolvedValue(false);
    mockGetActiveContainerInstanceId.mockReturnValue(undefined);
    mockReadSessionCostControlProtocol.mockResolvedValue(undefined);
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    expect(res.status).toBe(503);
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined();
    expect(latestReconcileControlMessage()).toBeUndefined();
  });

  it('426s when the runner advertises a version other than 2', async () => {
    mockReadSessionCostControlProtocol.mockResolvedValue(readyHandshake({ version: 1 }));
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    expect(res.status).toBe(426);
    expect(res.body.error).toBe('unsupported_protocol');
    expect(latestReconcileControlMessage()).toBeUndefined();
  });

  it('426s a set-ceiling-only runner (protocol 2 but no reconcile capability) — never strands the ledger', async () => {
    // A container that started before this feature deployed: version 2, but its
    // operations list has no 'reconcile'. Refused LOUDLY rather than enqueued to a
    // runner that would consume-and-drop the control message without a receipt.
    mockReadSessionCostControlProtocol.mockResolvedValue(readyHandshake({ operations: ['set_ceiling'] }));
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    expect(res.status).toBe(426);
    expect(res.body.error).toBe('unsupported_protocol');
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined();
    expect(latestReconcileControlMessage()).toBeUndefined();
  });

  it('426s a pre-capability runner (no operations list at all)', async () => {
    mockReadSessionCostControlProtocol.mockResolvedValue(readyHandshake({ operations: undefined }));
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    expect(res.status).toBe(426);
    expect(res.body.error).toBe('unsupported_protocol');
  });
});

describe('submitCostReconcile — happy path', () => {
  it('202s and durably enqueues a reconcile ledger row + real reconcile control message', async () => {
    const res = await submitCostReconcile(SESSION_ID, 50, 'ncl:host');
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    const adjustmentId = res.body.adjustmentId as string;
    expect(adjustmentId).toMatch(/^csr-/);

    const row = await getCostCeilingAdjustment(adjustmentId);
    expect(row?.state).toBe('enqueued');
    expect(row?.operation).toBe('reconcile');
    expect(row?.target_spent_cents).toBe(5000);
    expect(row?.expected_spent_cents).toBe(15500); // live spend the host read (CAS third leg)
    expect(row?.target_ceiling_cents).toBe(15000); // == expected ceiling (unchanged)
    expect(row?.expected_epoch_key).toBe('7');
    expect(row?.requested_by).toBe('ncl:host');

    const msg = latestReconcileControlMessage();
    expect(msg?.kind).toBe('cost_override');
    expect(JSON.parse(msg!.content)).toEqual({
      protocolVersion: 2,
      operation: 'reconcile',
      adjustmentId,
      expectedEpochKey: '7',
      expectedCeilingCents: 15000,
      expectedSpentCents: 15500,
      targetSpentCents: 5000,
      forced: false,
    });
    expect(mockWakeContainer).toHaveBeenCalled();
  });

  it('409s epoch_conflict when a second reconcile races the same (session, epoch)', async () => {
    const first = await submitCostReconcile(SESSION_ID, 50, 'test');
    expect(first.status).toBe(202);
    const second = await submitCostReconcile(SESSION_ID, 60, 'test');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('epoch_conflict');
  });

  it('a normal (non-forced) reconcile records forced=0', async () => {
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    expect(res.status).toBe(202);
    expect(res.body.forced).toBe(false);
    const row = await getCostCeilingAdjustment(res.body.adjustmentId as string);
    expect(row?.forced).toBe(0);
  });
});

describe('submitCostReconcile — --force relaxes ONLY the card_already_decided fence (#1327 deadlock escape)', () => {
  // A resolved decision card on the CURRENT live epoch (7) — the deadlock: a
  // session card-decided on inflated spend, now falsely-stopped.
  async function seedDecidedCard(decision: 'continued' | 'stopped' = 'continued'): Promise<void> {
    await ingestEpisode({
      episode_id: `esc-force-${decision}`,
      short_id: 'cst-frc',
      session_id: SESSION_ID,
      agent_group_id: AGENT_GROUP_ID,
      reason: 'ceiling',
      window: 'lifetime',
      epoch_key: '7',
      immortal: false,
      created_at: NOW,
      decision_state: decision,
    });
  }

  it('without --force → 409 card_already_decided (the deadlock)', async () => {
    await seedDecidedCard('continued');
    const res = await submitCostReconcile(SESSION_ID, 116, 'test');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('card_already_decided');
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined();
  });

  it('with --force → applies, records forced=1 on the row + body, and stamps forced:true into the control message', async () => {
    await seedDecidedCard('continued');
    const res = await submitCostReconcile(SESSION_ID, 116, 'ncl:host', true);
    expect(res.status).toBe(202);
    expect(res.body.forced).toBe(true);
    const adjustmentId = res.body.adjustmentId as string;
    const row = await getCostCeilingAdjustment(adjustmentId);
    expect(row?.forced).toBe(1);
    expect(row?.operation).toBe('reconcile');
    expect(row?.target_spent_cents).toBe(11600);

    const msg = latestReconcileControlMessage();
    expect(JSON.parse(msg!.content).forced).toBe(true);
  });

  it('--force NEVER overrides a STOPPED card — that would defeat a human stop, so it still 409s', async () => {
    await seedDecidedCard('stopped');
    const res = await submitCostReconcile(SESSION_ID, 44, 'ncl:host', true);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('card_already_decided');
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined();
  });

  it('--force does NOT bypass lower-only — a target above live spend is still refused', async () => {
    await seedDecidedCard('continued');
    // live spend $155; a raise to $200 is refused even with --force.
    const res = await submitCostReconcile(SESSION_ID, 200, 'ncl:host', true);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('target_above_live_spend');
    expect(await getLatestCostCeilingAdjustmentBySession(SESSION_ID)).toBeUndefined();
  });

  it('--force with NO decided card records forced=0 (nothing was overridden)', async () => {
    const res = await submitCostReconcile(SESSION_ID, 50, 'ncl:host', true);
    expect(res.status).toBe(202);
    expect(res.body.forced).toBe(false);
    const row = await getCostCeilingAdjustment(res.body.adjustmentId as string);
    expect(row?.forced).toBe(0);
  });

  it('force is scoped to reconcile — a set_ceiling row with force still hits episode-already-won', async () => {
    // Defense in depth: force must never let a set-ceiling row bypass a decided card
    // (its own submit path never sets force, but the shared accessor must enforce it).
    await seedDecidedCard('continued');
    const created = await createCostCeilingAdjustment({
      adjustment_id: 'cca-forced-sc',
      protocol_version: 2,
      operation: 'set_ceiling',
      session_id: SESSION_ID,
      agent_group_id: AGENT_GROUP_ID,
      expected_epoch_key: '7',
      expected_ceiling_cents: 15000,
      target_ceiling_cents: 17500,
      force: true,
      inbound_message_id: 'cost-ceiling-adjustment:cca-forced-sc',
      requested_at: NOW,
      requested_by: 'test',
    });
    expect(created.outcome).toBe('episode-already-won');
  });
});

describe('ingestCostReconcileReceipt', () => {
  const session = { id: SESSION_ID, agent_group_id: AGENT_GROUP_ID } as never;

  async function submitAndGetId(): Promise<string> {
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    return res.body.adjustmentId as string;
  }

  function receipt(adjustmentId: string, over: Record<string, unknown> = {}) {
    return {
      action: 'cost_reconcile_result',
      protocolVersion: 2,
      adjustmentId,
      sessionId: SESSION_ID,
      outcome: 'applied',
      expectedEpochKey: '7',
      previousEpochKey: '7',
      resultEpochKey: '8',
      expectedCeilingCents: 15000,
      resultCeilingCents: 15000,
      targetSpentCents: 5000,
      previousSpentCents: 15500,
      resultSpentCents: 5000,
      spentUsd: 50,
      status: 'escalated',
      ...over,
    };
  }

  it('records a valid applied receipt (validated on target_spent_cents, not target_ceiling_cents)', async () => {
    const id = await submitAndGetId();
    await ingestCostReconcileReceipt(receipt(id), session);
    const row = await getCostCeilingAdjustment(id);
    expect(row?.state).toBe('applied');
    expect(row?.result_spent_usd).toBe(50);
    expect(row?.result_cost_status).toBe('escalated');
  });

  it('is idempotent under an identical replay', async () => {
    const id = await submitAndGetId();
    await ingestCostReconcileReceipt(receipt(id), session);
    const before = await getCostCeilingAdjustment(id);
    await ingestCostReconcileReceipt(receipt(id), session);
    expect(await getCostCeilingAdjustment(id)).toEqual(before);
  });

  it('rejects a forged receipt whose target_spent_cents disagrees with the central row', async () => {
    const id = await submitAndGetId();
    await ingestCostReconcileReceipt(receipt(id, { targetSpentCents: 1 }), session);
    expect((await getCostCeilingAdjustment(id))?.state).toBe('enqueued'); // untouched
  });

  it('a receipt for an unknown adjustment id does not throw', async () => {
    await expect(ingestCostReconcileReceipt(receipt('csr-nope'), session)).resolves.toBeUndefined();
  });
});

describe('reconcileCostCeilingAdjustments re-drives reconcile rows with the reconcile control shape', () => {
  it('re-writes the reconcile-shaped control message after a crash-before-inbox-write', async () => {
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    const adjustmentId = res.body.adjustmentId as string;
    // Simulate: ledger row landed but the inbox write was lost.
    const db = openInboundDbRaw(inboundPathFor(AGENT_GROUP_ID, SESSION_ID));
    db.prepare('DELETE FROM messages_in').run();
    db.close();
    await getDb().run(
      `UPDATE cost_ceiling_adjustments SET state='pending', enqueued_at=NULL WHERE adjustment_id=?`,
      adjustmentId,
    );

    await reconcileCostCeilingAdjustments(NOW);

    expect((await getCostCeilingAdjustment(adjustmentId))?.state).toBe('enqueued');
    const msg = latestReconcileControlMessage();
    const content = JSON.parse(msg!.content);
    expect(content.operation).toBe('reconcile');
    expect(content.targetSpentCents).toBe(5000);
  });
});

describe('cost_reconcile never writes to cost_cap_policy', () => {
  it('a full submit -> reconcile -> receipt cycle leaves an existing policy row untouched', async () => {
    await setCostCapPolicy({ groupFolder: '', ceilingUsd: 999, capUsd: 5, updatedBy: 'test' });
    const before = await getCostCapPolicy('');
    const res = await submitCostReconcile(SESSION_ID, 50, 'test');
    await reconcileCostCeilingAdjustments(NOW);
    await ingestCostReconcileReceipt(
      {
        action: 'cost_reconcile_result',
        protocolVersion: 2,
        adjustmentId: res.body.adjustmentId,
        sessionId: SESSION_ID,
        outcome: 'applied',
        expectedEpochKey: '7',
        resultEpochKey: '8',
        expectedCeilingCents: 15000,
        resultCeilingCents: 15000,
        targetSpentCents: 5000,
        resultSpentCents: 5000,
        spentUsd: 50,
        status: 'escalated',
      },
      { id: SESSION_ID, agent_group_id: AGENT_GROUP_ID } as never,
    );
    expect(await getCostCapPolicy('')).toEqual(before);
  });
});
