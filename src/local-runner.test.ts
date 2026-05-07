import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Config module: local-runner imports constants. Stub them so the env-build
// tests don't depend on repo cwd, and so path.join calls are deterministic.
vi.mock('./config.js', () => ({
  AGENT_HOST_GATEWAY: '127.0.0.1',
  DASHBOARD_PORT: 3737,
  DATA_DIR: '/tmp/data',
  GROUPS_DIR: '/tmp/groups',
  MAX_MESSAGES_PER_PROMPT: 10,
  MCP_PROXY_PORT: 3100,
  TIMEZONE: 'UTC',
}));

vi.mock('./container-config.js', () => ({
  readContainerConfig: () => ({ additionalMounts: [], packages: { apt: [], npm: [] }, mcpServers: {} }),
}));

vi.mock('./db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
  hasTable: () => false,
}));

vi.mock('./session-manager.js', () => ({
  sessionDir: (ag: string, sid: string) => `/tmp/data/v2-sessions/${ag}/${sid}`,
  inboundDbPath: (ag: string, sid: string) => `/tmp/data/v2-sessions/${ag}/${sid}/inbound.db`,
  outboundDbPath: (ag: string, sid: string) => `/tmp/data/v2-sessions/${ag}/${sid}/outbound.db`,
  heartbeatPath: (ag: string, sid: string) => `/tmp/data/v2-sessions/${ag}/${sid}/.heartbeat`,
}));

import { buildLocalAgentEnv, killLocalAgent, type LocalAgentContext, type LocalAgentHandle } from './local-runner.js';

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
  return { process: proc as unknown as LocalAgentHandle['process'], name: 'test' };
}

function makeCtx(overrides: Partial<LocalAgentContext> = {}): LocalAgentContext {
  return {
    session: { id: 'sess-1', agent_group_id: 'ag-1', agent_provider: null } as LocalAgentContext['session'],
    agentGroup: { id: 'ag-1', folder: 'acme', name: 'Acme' } as LocalAgentContext['agentGroup'],
    provider: 'claude',
    contribution: {},
    proxyToken: 'tok-xyz',
    allowedTools: ['mcp__github__list'],
    mcpServers: {},
    ...overrides,
  };
}

describe('buildLocalAgentEnv', () => {
  it('composes session DB paths, workspace paths, MCP proxy URL', () => {
    const env = buildLocalAgentEnv(makeCtx(), {
      groupDir: '/tmp/groups/acme',
      sessDir: '/tmp/data/v2-sessions/ag-1/sess-1',
      globalDir: '/tmp/groups/global',
      outboxDir: '/tmp/data/v2-sessions/ag-1/sess-1/outbox',
    });
    expect(env.SESSION_INBOUND_DB_PATH).toBe('/tmp/data/v2-sessions/ag-1/sess-1/inbound.db');
    expect(env.SESSION_OUTBOUND_DB_PATH).toBe('/tmp/data/v2-sessions/ag-1/sess-1/outbound.db');
    expect(env.SESSION_HEARTBEAT_PATH).toBe('/tmp/data/v2-sessions/ag-1/sess-1/.heartbeat');
    expect(env.WORKSPACE_AGENT).toBe('/tmp/groups/acme');
    expect(env.WORKSPACE_OUTBOX).toBe('/tmp/data/v2-sessions/ag-1/sess-1/outbox');
    expect(env.WORKSPACE_GLOBAL).toBe('/tmp/groups/global');
    expect(env.WORKSPACE_EXTRA).toMatch(/\.extra-empty$/);
    expect(env.HOME).toBe('/tmp/data/v2-sessions/ag-1/.claude-shared');
    expect(env.MCP_PROXY_URL).toBe('http://127.0.0.1:3100');
    expect(env.MCP_PROXY_TOKEN).toBe('tok-xyz');
    expect(env.DASHBOARD_URL).toBe('http://127.0.0.1:3737');
    expect(env.NANOCLAW_ALLOWED_MCP_TOOLS).toBe('["mcp__github__list"]');
  });

  it('appends local bypass entries to inherited NO_PROXY rather than overwriting', () => {
    const originalNoProxy = process.env.NO_PROXY;
    process.env.NO_PROXY = 'corp.internal,metrics.corp';
    try {
      const env = buildLocalAgentEnv(makeCtx(), {
        groupDir: '/tmp/groups/acme',
        sessDir: '/tmp/data/v2-sessions/ag-1/sess-1',
        globalDir: null,
        outboxDir: '/tmp/data/v2-sessions/ag-1/sess-1/outbox',
      });
      const entries = new Set((env.NO_PROXY as string).split(','));
      expect(entries).toContain('127.0.0.1');
      expect(entries).toContain('localhost');
      expect(entries).toContain('corp.internal');
      expect(entries).toContain('metrics.corp');
    } finally {
      if (originalNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = originalNoProxy;
    }
  });

  it('provider contribution env overrides placeholders', () => {
    const env = buildLocalAgentEnv(makeCtx({ contribution: { env: { XDG_DATA_HOME: '/tmp/xdg' } } }), {
      groupDir: '/tmp/groups/acme',
      sessDir: '/tmp/data/v2-sessions/ag-1/sess-1',
      globalDir: null,
      outboxDir: '/tmp/data/v2-sessions/ag-1/sess-1/outbox',
    });
    expect(env.XDG_DATA_HOME).toBe('/tmp/xdg');
  });
});

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
