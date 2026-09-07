/**
 * `cost-cap` CLI resource — the elevated-only scope gate, plus `set` input
 * validation.
 *
 * The gate is enforced by the shared CLI guard (src/cli/guard.ts): `cost-cap`
 * is deliberately NOT in GROUP_SCOPE_RESOURCES, so a container under
 * `cli_scope: 'group'` or `'disabled'` is denied, while the host operator and a
 * `cli_scope: 'global'` orchestrator are allowed. We assert that decision
 * directly against the registered command guard, mocking only the cli_scope
 * lookup (as dispatch.test.ts does).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
}));

// guard.ts imports getPendingApproval for the grant path (unused here — these
// are open commands invoked with no grant). getSession keeps parity with the
// real module's surface.
vi.mock('../../db/sessions.js', () => ({
  getPendingApproval: vi.fn(),
  getSession: vi.fn(),
}));

// `status`'s handler is a thin delegate to session-cost-cap.ts — mocked here so
// the wiring test below doesn't need a real session/outbound.db; the reader's
// own SQLite read/parse logic has its own tests in session-cost-cap.test.ts.
const mockReadSessionCostCapStatus = vi.fn();
vi.mock('../session-cost-cap.js', () => ({
  readSessionCostCapStatus: (...a: unknown[]) => mockReadSessionCostCapStatus(...a),
}));

// `stopped`'s handler is a thin delegate to cost-cap-sessions.ts'
// listStoppedSessions (which reads the dashboard's /api/sessions). Mock only that
// export, preserving the rest of the module so the other verbs still register.
const mockListStoppedSessions = vi.fn();
vi.mock('../cost-cap-sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost-cap-sessions.js')>()),
  listStoppedSessions: (...a: unknown[]) => mockListStoppedSessions(...a),
}));

// `set-ceiling` dynamic-imports submitCostCeilingAdjustment; mock it so the
// verb's OWN logic (live-epoch read → cents conversion → money-safe failure
// surfacing) is what's under test, not the full ledger/runner flow (which has
// its own tests in db/cost-ceiling-adjustments.test.ts + the module test).
const mockSubmitCostCeilingAdjustment = vi.fn();
const mockSubmitCostReconcile = vi.fn();
vi.mock('../../modules/cost-ceiling-adjustment/index.js', () => ({
  submitCostCeilingAdjustment: (...a: unknown[]) => mockSubmitCostCeilingAdjustment(...a),
  submitCostReconcile: (...a: unknown[]) => mockSubmitCostReconcile(...a),
}));

// `continue`/`stop` dynamic-import the shared decision path; mock it so we
// assert the delegation (session + decision + ncl: actor tag) without the
// episode CAS / router (covered by cost-approval's own tests).
const mockApplyCostOverrideDecision = vi.fn();
vi.mock('../../modules/cost-approval/index.js', () => ({
  applyCostOverrideDecision: (...a: unknown[]) => mockApplyCostOverrideDecision(...a),
}));

import './cost-cap.js'; // side-effect: registers cost-cap-{get,set,clear,status,stopped,escalations,sessions,continue,stop,set-ceiling,reconcile,coworkers}
import { commandGuard, lookup } from '../registry.js';
import { guard, type GuardActor } from '../../guard/index.js';
import type { CallerContext } from '../frame.js';

const AGENT: GuardActor = { kind: 'agent', agentGroupId: 'ag-orchestrator', sessionId: 's' };
const COMMANDS = [
  'cost-cap-set',
  'cost-cap-get',
  'cost-cap-clear',
  'cost-cap-status',
  'cost-cap-stopped',
  'cost-cap-escalations',
  'cost-cap-sessions',
  'cost-cap-continue',
  'cost-cap-stop',
  'cost-cap-set-ceiling',
  'cost-cap-reconcile',
] as const;

describe('cost-cap scope gate (elevated only)', () => {
  beforeEach(() => mockGetContainerConfig.mockReset());

  for (const cmd of COMMANDS) {
    it(`${cmd}: the host operator is allowed`, async () => {
      expect((await guard(commandGuard(cmd), { actor: { kind: 'host' }, payload: {} })).effect).toBe('allow');
    });

    it(`${cmd}: a cli_scope=global agent is allowed`, async () => {
      mockGetContainerConfig.mockResolvedValue({ cli_scope: 'global' });
      expect((await guard(commandGuard(cmd), { actor: AGENT, payload: {} })).effect).toBe('allow');
    });

    it(`${cmd}: a cli_scope=group agent is denied`, async () => {
      mockGetContainerConfig.mockResolvedValue({ cli_scope: 'group' });
      expect((await guard(commandGuard(cmd), { actor: AGENT, payload: {} })).effect).toBe('deny');
    });

    it(`${cmd}: a cli_scope=disabled agent is denied`, async () => {
      mockGetContainerConfig.mockResolvedValue({ cli_scope: 'disabled' });
      expect((await guard(commandGuard(cmd), { actor: AGENT, payload: {} })).effect).toBe('deny');
    });

    it(`${cmd}: an agent with no config row (defaults to group) is denied`, async () => {
      mockGetContainerConfig.mockResolvedValue(undefined);
      expect((await guard(commandGuard(cmd), { actor: AGENT, payload: {} })).effect).toBe('deny');
    });
  }
});

describe('cost-cap set — input validation (pre-DB)', () => {
  const HOST: CallerContext = { caller: 'host' };
  const run = async (raw: Record<string, unknown>) => {
    const cmd = lookup('cost-cap-set');
    if (!cmd) throw new Error('cost-cap-set not registered');
    return cmd.handler(cmd.parseArgs(raw), HOST);
  };

  it('rejects an invocation with neither --ceiling nor --cap', async () => {
    await expect(run({})).rejects.toThrow(/at least one of --ceiling or --cap/);
  });

  it('rejects --cap without --group (a fleet-wide cap is not supported)', async () => {
    await expect(run({ cap: '60' })).rejects.toThrow(/--cap is a per-group override and requires --group/);
  });

  it('rejects a negative --ceiling', async () => {
    await expect(run({ ceiling: '-5' })).rejects.toThrow(/--ceiling must be a number >= 0/);
  });

  it('rejects an unknown flag', async () => {
    // Strict validation on the declared args rejects stray flags with usage.
    await expect(run({ celing: '150' })).rejects.toThrow(/unknown flag/);
  });
});

describe('cost-cap status', () => {
  const HOST: CallerContext = { caller: 'host' };
  const run = async (raw: Record<string, unknown>) => {
    const cmd = lookup('cost-cap-status');
    if (!cmd) throw new Error('cost-cap-status not registered');
    return cmd.handler(cmd.parseArgs(raw), HOST);
  };

  beforeEach(() => mockReadSessionCostCapStatus.mockReset());

  it('requires --session', () => {
    const cmd = lookup('cost-cap-status');
    if (!cmd) throw new Error('cost-cap-status not registered');
    expect(() => cmd.parseArgs({})).toThrow(/--session is required/);
  });

  it('rejects an unknown flag', () => {
    const cmd = lookup('cost-cap-status');
    if (!cmd) throw new Error('cost-cap-status not registered');
    expect(() => cmd.parseArgs({ session: 's1', bogus: 'x' })).toThrow(/unknown flag/);
  });

  it('delegates to readSessionCostCapStatus with the given session id and returns its result verbatim', async () => {
    mockReadSessionCostCapStatus.mockReturnValue({
      session_id: 's1',
      agent_group_id: 'ag-1',
      status: 'stopped',
      cap_usd: 10,
      spent_usd: 10.2,
    });
    const result = await run({ session: 's1' });
    expect(mockReadSessionCostCapStatus).toHaveBeenCalledWith('s1');
    expect(result).toEqual({
      session_id: 's1',
      agent_group_id: 'ag-1',
      status: 'stopped',
      cap_usd: 10,
      spent_usd: 10.2,
    });
  });
});

describe('cost-cap stopped — the LIVE currently-blocked set (distinct from the escalations history)', () => {
  const HOST: CallerContext = { caller: 'host' };
  const run = async (raw: Record<string, unknown>) => {
    const cmd = lookup('cost-cap-stopped');
    if (!cmd) throw new Error('cost-cap-stopped not registered');
    return cmd.handler(cmd.parseArgs(raw), HOST);
  };

  beforeEach(() => mockListStoppedSessions.mockReset());

  it('delegates to listStoppedSessions with no group filter and returns its result verbatim', async () => {
    const result = {
      count: 2,
      group: null,
      costUnavailable: null,
      stopped: [
        { session_id: 's2', agent_group_id: 'ag-2', status: 'stopped', spent_usd: 60, group_folder: 'slang-fixer' },
        { session_id: 's1', agent_group_id: 'ag-1', status: 'stopped', spent_usd: 42, group_folder: 'slang-reader' },
      ],
    };
    mockListStoppedSessions.mockResolvedValue(result);
    const res = await run({});
    expect(mockListStoppedSessions).toHaveBeenCalledWith({ group: undefined });
    expect(res).toBe(result); // returned verbatim, incl. the dashboard's costUnavailable signal
  });

  it('passes --group through as the folder filter', async () => {
    mockListStoppedSessions.mockResolvedValue({ count: 0, group: 'slang-fixer', costUnavailable: null, stopped: [] });
    await run({ group: 'slang-fixer' });
    expect(mockListStoppedSessions).toHaveBeenCalledWith({ group: 'slang-fixer' });
  });

  it('does NOT read the episode ledger — the stopped set comes only from the live /api/sessions delegate', async () => {
    // listEscalationEpisodes is the history ledger; the stopped verb must never
    // consult it. We assert this indirectly: the only source it calls is the
    // live listStoppedSessions delegate.
    mockListStoppedSessions.mockResolvedValue({ count: 0, group: null, costUnavailable: null, stopped: [] });
    await run({});
    expect(mockListStoppedSessions).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown flag', () => {
    const cmd = lookup('cost-cap-stopped');
    if (!cmd) throw new Error('cost-cap-stopped not registered');
    expect(() => cmd.parseArgs({ groop: 'x' })).toThrow(/unknown flag/);
  });
});

describe('cost-cap set-ceiling — live-epoch CAS precondition + money-safe failure surfacing', () => {
  const HOST: CallerContext = { caller: 'host' };
  const run = async (raw: Record<string, unknown>) => {
    const cmd = lookup('cost-cap-set-ceiling');
    if (!cmd) throw new Error('cost-cap-set-ceiling not registered');
    return cmd.handler(cmd.parseArgs(raw), HOST);
  };

  // A healthy live session: ceiling $150, budget generation 3.
  const liveOk = { session_id: 's1', agent_group_id: 'ag-1', status: 'ok', ceiling_usd: 150, budget_gen: 3 };

  beforeEach(() => {
    mockReadSessionCostCapStatus.mockReset();
    mockSubmitCostCeilingAdjustment.mockReset();
  });

  it('reads live epoch/ceiling and submits protocolVersion:2 set_ceiling with the CAS precondition + cents', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(liveOk);
    mockSubmitCostCeilingAdjustment.mockResolvedValue({ status: 202, body: { ok: true, adjustmentId: 'cca-x' } });

    const res = (await run({ session: 's1', ceiling: '300' })) as Record<string, unknown>;

    expect(mockSubmitCostCeilingAdjustment).toHaveBeenCalledTimes(1);
    const [payload, requestedBy] = mockSubmitCostCeilingAdjustment.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      protocolVersion: 2,
      sessionId: 's1',
      targetCeilingCents: 30000, // $300 -> cents
      expectedEpochKey: '3', // String(budget_gen) — the CAS epoch fence
      expectedCeilingCents: 15000, // live ceiling * 100 — the CAS precondition
    });
    expect(String(payload.requestId)).toMatch(/^cca-/); // module's adjustmentId format
    expect(requestedBy).toMatch(/^ncl:/);
    expect(res).toMatchObject({ session_id: 's1', targetCeilingCents: 30000, status: 202 });
  });

  it('FAILS LOUDLY on a stale-epoch 409 rather than reporting success (no silent over-raise)', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(liveOk);
    mockSubmitCostCeilingAdjustment.mockResolvedValue({
      status: 409,
      body: { ok: false, error: 'stale', message: 'the session moved since this value was read' },
    });
    await expect(run({ session: 's1', ceiling: '300' })).rejects.toThrow(/set-ceiling refused \(409 stale\)/);
  });

  it('FAILS LOUDLY on an epoch_conflict 409 (another request already claimed the epoch)', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(liveOk);
    mockSubmitCostCeilingAdjustment.mockResolvedValue({
      status: 409,
      body: { ok: false, error: 'epoch_conflict', winner: 'cca-other' },
    });
    await expect(run({ session: 's1', ceiling: '300' })).rejects.toThrow(/set-ceiling refused \(409 epoch_conflict\)/);
  });

  it('refuses a no-op where target equals the live ceiling (never submits)', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue(liveOk); // live 150
    await expect(run({ session: 's1', ceiling: '150' })).rejects.toThrow(/equals the current live ceiling/);
    expect(mockSubmitCostCeilingAdjustment).not.toHaveBeenCalled();
  });

  it('refuses an immortal session before ever submitting', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue({ ...liveOk, immortal: true });
    await expect(run({ session: 's1', ceiling: '300' })).rejects.toThrow(/immortal/);
    expect(mockSubmitCostCeilingAdjustment).not.toHaveBeenCalled();
  });

  it('refuses when there is no live cost state, or no live ceiling', async () => {
    mockReadSessionCostCapStatus.mockResolvedValue({ session_id: 's1', agent_group_id: 'ag-1', status: 'unknown' });
    await expect(run({ session: 's1', ceiling: '300' })).rejects.toThrow(/no live cost-cap state/);

    mockReadSessionCostCapStatus.mockResolvedValue({ ...liveOk, ceiling_usd: 0 });
    await expect(run({ session: 's1', ceiling: '300' })).rejects.toThrow(/no live Tier-2 ceiling/);
    expect(mockSubmitCostCeilingAdjustment).not.toHaveBeenCalled();
  });

  it('validates --ceiling bounds before ever reading live state', async () => {
    await expect(run({ session: 's1', ceiling: '0' })).rejects.toThrow(/--ceiling must be a number > 0/);
    await expect(run({ session: 's1', ceiling: '1001' })).rejects.toThrow(/between \$0.01 and \$1000.00/);
    expect(mockReadSessionCostCapStatus).not.toHaveBeenCalled();
  });
});

describe('cost-cap reconcile — USD→cents conversion, actor tag, money-safe failure surfacing', () => {
  const HOST: CallerContext = { caller: 'host' };
  const run = async (raw: Record<string, unknown>) => {
    const cmd = lookup('cost-cap-reconcile');
    if (!cmd) throw new Error('cost-cap-reconcile not registered');
    return cmd.handler(cmd.parseArgs(raw), HOST);
  };

  beforeEach(() => mockSubmitCostReconcile.mockReset());

  it('passes the USD target verbatim (module does cents) with an ncl: source tag; force defaults to false', async () => {
    mockSubmitCostReconcile.mockResolvedValue({
      status: 202,
      body: { ok: true, adjustmentId: 'csr-x', state: 'enqueued' },
    });
    const res = (await run({ session: 's1', to: '42.17' })) as Record<string, unknown>;
    expect(mockSubmitCostReconcile).toHaveBeenCalledTimes(1);
    const [sessionId, targetSpentUsd, source, force] = mockSubmitCostReconcile.mock.calls[0] as [
      string,
      number,
      string,
      boolean,
    ];
    expect(sessionId).toBe('s1');
    expect(targetSpentUsd).toBeCloseTo(42.17);
    expect(source).toMatch(/^ncl:/);
    expect(force).toBe(false);
    expect(res).toMatchObject({ status: 202, targetSpentUsd: 42.17, adjustmentId: 'csr-x' });
  });

  it('--force is threaded through to submitCostReconcile and surfaced in output', async () => {
    mockSubmitCostReconcile.mockResolvedValue({
      status: 202,
      body: { ok: true, adjustmentId: 'csr-f', state: 'enqueued', forced: true },
    });
    const res = (await run({ session: 's1', to: '116', force: true })) as Record<string, unknown>;
    const [, , , force] = mockSubmitCostReconcile.mock.calls[0] as [string, number, string, boolean];
    expect(force).toBe(true);
    expect(res).toMatchObject({ forced: true });
  });

  it('accepts a $0 target (full absorb)', async () => {
    mockSubmitCostReconcile.mockResolvedValue({ status: 202, body: { ok: true, adjustmentId: 'csr-z' } });
    await run({ session: 's1', to: '0' });
    const [, targetSpentUsd] = mockSubmitCostReconcile.mock.calls[0] as [string, number, string];
    expect(targetSpentUsd).toBe(0);
  });

  it('requires --session and --to', () => {
    const cmd = lookup('cost-cap-reconcile');
    if (!cmd) throw new Error('cost-cap-reconcile not registered');
    expect(() => cmd.parseArgs({ to: '10' })).toThrow(/--session is required/);
    expect(() => cmd.parseArgs({ session: 's1' })).toThrow(/--to is required/);
  });

  it('rejects a negative --to before ever submitting', async () => {
    await expect(run({ session: 's1', to: '-5' })).rejects.toThrow(/--to must be a number >= 0/);
    expect(mockSubmitCostReconcile).not.toHaveBeenCalled();
  });

  it('FAILS LOUDLY on a stale-epoch 409 rather than reporting success', async () => {
    mockSubmitCostReconcile.mockResolvedValue({
      status: 409,
      body: {
        ok: false,
        error: 'epoch_conflict',
        message: 'another live cost action already claimed this exact epoch',
      },
    });
    await expect(run({ session: 's1', to: '42' })).rejects.toThrow(/cost reconcile failed \(409 epoch_conflict\)/);
  });

  it('FAILS LOUDLY on an unsupported-protocol 426', async () => {
    mockSubmitCostReconcile.mockResolvedValue({
      status: 426,
      body: { ok: false, error: 'unsupported_protocol', message: 'runner too old' },
    });
    await expect(run({ session: 's1', to: '42' })).rejects.toThrow(
      /cost reconcile failed \(426 unsupported_protocol\)/,
    );
  });

  it('surfaces a 200 no-op without throwing', async () => {
    mockSubmitCostReconcile.mockResolvedValue({
      status: 200,
      body: { ok: true, noop: true, message: 'already at target' },
    });
    const res = (await run({ session: 's1', to: '42' })) as Record<string, unknown>;
    expect(res).toMatchObject({ status: 200, noop: true });
  });
});

describe('cost-cap continue / stop — delegate to the shared money-safe decision path', () => {
  const HOST: CallerContext = { caller: 'host' };
  const run = async (verb: 'continue' | 'stop', raw: Record<string, unknown>) => {
    const cmd = lookup(`cost-cap-${verb}`);
    if (!cmd) throw new Error(`cost-cap-${verb} not registered`);
    return cmd.handler(cmd.parseArgs(raw), HOST);
  };

  beforeEach(() => mockApplyCostOverrideDecision.mockReset());

  it('continue routes decision=continue with an ncl: actor tag', async () => {
    mockApplyCostOverrideDecision.mockResolvedValue(undefined);
    const res = await run('continue', { session: 's1' });
    expect(mockApplyCostOverrideDecision).toHaveBeenCalledWith('s1', 'continue', expect.stringMatching(/^ncl:/));
    expect(res).toMatchObject({ session_id: 's1', decision: 'continue', ok: true });
  });

  it('stop routes decision=stop with an ncl: actor tag', async () => {
    mockApplyCostOverrideDecision.mockResolvedValue(undefined);
    const res = await run('stop', { session: 's1' });
    expect(mockApplyCostOverrideDecision).toHaveBeenCalledWith('s1', 'stop', expect.stringMatching(/^ncl:/));
    expect(res).toMatchObject({ session_id: 's1', decision: 'stop', ok: true });
  });

  it('requires --session', () => {
    const cmd = lookup('cost-cap-continue');
    if (!cmd) throw new Error('cost-cap-continue not registered');
    expect(() => cmd.parseArgs({})).toThrow(/--session is required/);
  });
});
