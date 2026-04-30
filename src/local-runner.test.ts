import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { killLocalAgent, type LocalAgentHandle } from './local-runner.js';

// Minimal ChildProcess fake — just the bits killLocalAgent touches.
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  signals: NodeJS.Signals[] = [];
  kill(sig: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(sig);
    // SIGTERM: by default do nothing (tests control exit timing).
    // SIGKILL: simulate immediate exit on next tick.
    if (sig === 'SIGKILL') {
      queueMicrotask(() => {
        this.exitCode = 137;
        this.signalCode = 'SIGKILL';
        this.emit('exit', null, 'SIGKILL');
      });
    }
    this.killed = true;
    return true;
  }
}

function makeHandle(proc: FakeChild): LocalAgentHandle {
  return { process: proc as unknown as LocalAgentHandle['process'], name: 'test', worktreePath: '/tmp/wt' };
}

describe('killLocalAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately if the process has already exited', async () => {
    const proc = new FakeChild();
    proc.exitCode = 0;
    await expect(killLocalAgent(makeHandle(proc))).resolves.toBeUndefined();
    expect(proc.signals).toEqual([]);
  });

  it('sends SIGTERM and resolves when the process exits cleanly', async () => {
    const proc = new FakeChild();
    const pending = killLocalAgent(makeHandle(proc), 2000);
    // kill('SIGTERM') was called; simulate a clean exit before the timeout fires.
    expect(proc.signals).toEqual(['SIGTERM']);
    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    await expect(pending).resolves.toBeUndefined();
    // Timeout never elapsed → no SIGKILL.
    expect(proc.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL if the process does not exit before the timeout', async () => {
    const proc = new FakeChild();
    const pending = killLocalAgent(makeHandle(proc), 1000);
    expect(proc.signals).toEqual(['SIGTERM']);
    // No exit — advance past the timeout.
    await vi.advanceTimersByTimeAsync(1001);
    // FakeChild queues SIGKILL exit via microtask — let it drain.
    await Promise.resolve();
    await pending;
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
