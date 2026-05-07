/**
 * mcp-registry detects MCP server definitions from container/mcp-servers/*
 * and from the REMOTE_MCP_SERVERS env var, then spawns one supergateway
 * process per server. Tests cover the pure detection path (no process spawn)
 * and the registry-accessor contract for the empty-registry case.
 *
 * Spawning is mocked at the child_process layer so we can assert what args
 * the registry would pass to supergateway without actually launching anything.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StubProcess = EventEmitter & {
  pid?: number;
  kill?: (sig?: string) => void;
  stderr?: EventEmitter;
  stdout?: EventEmitter;
};

// Capture every spawn() call so tests can inspect args and simulate lifecycle.
const spawnCalls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
const stubProcesses: StubProcess[] = [];

function makeStubProcess(): StubProcess {
  const proc = new EventEmitter() as StubProcess;
  proc.pid = Math.floor(Math.random() * 100000) + 1000;
  proc.kill = vi.fn();
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  stubProcesses.push(proc);
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ cmd, args, options });
    return makeStubProcess();
  }),
}));

// Prevent the 5-second timer after startMcpServers from slowing down every
// test — vi.useFakeTimers() is noisy here; instead we short-circuit the
// timeout wrapper via a setTimeout monkey-patch.
const realSetTimeout = global.setTimeout;
beforeEach(() => {
  spawnCalls.length = 0;
  stubProcesses.length = 0;
  // Fast-resolve the 5s boot wait and the 2s restart wait.
  (global.setTimeout as unknown as typeof setTimeout) = ((fn: () => void, ms?: number) => {
    if (ms && ms >= 1000) {
      return realSetTimeout(fn, 1);
    }
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
});

afterEach(() => {
  global.setTimeout = realSetTimeout;
  delete process.env.REMOTE_MCP_SERVERS;
});

// The registry scans process.cwd()/container/mcp-servers; run each test in a
// sandboxed tempdir so real repo state doesn't leak in.
function sandbox(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-reg-'));
  const origCwd = process.cwd();
  process.chdir(root);
  return {
    root,
    cleanup: () => {
      process.chdir(origCwd);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('mcp-registry — empty registry', () => {
  let sb: ReturnType<typeof sandbox>;

  beforeEach(() => {
    sb = sandbox();
  });

  afterEach(() => {
    sb.cleanup();
  });

  it('returns a no-op handle when no servers are detected', async () => {
    const { startMcpServers, getRunningServerNames } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    expect(spawnCalls).toHaveLength(0);
    expect(handle.getUpstreamPort('any')).toBeNull();
    expect(getRunningServerNames()).toEqual([]);

    // Stop should be safe
    expect(() => handle.stop()).not.toThrow();
  });

  it('accessor functions return null/false for unknown server names', async () => {
    const { getServerUpstreamPort, isServerAlive, getServerDef } = await import('./mcp-registry.js');
    expect(getServerUpstreamPort('ghost')).toBeNull();
    expect(isServerAlive('ghost')).toBe(false);
    expect(getServerDef('ghost')).toBeUndefined();
  });

  it('stopServer throws for an unknown server', async () => {
    const { stopServer } = await import('./mcp-registry.js');
    expect(() => stopServer('ghost')).toThrow(/not found/);
  });

  it('restartServer throws for an unknown server', async () => {
    const { restartServer } = await import('./mcp-registry.js');
    await expect(restartServer('ghost')).rejects.toThrow(/not found/);
  });
});

describe('mcp-registry — remote HTTP server detection', () => {
  let sb: ReturnType<typeof sandbox>;

  beforeEach(() => {
    sb = sandbox();
  });

  afterEach(async () => {
    const { getRunningServerNames, stopServer } = await import('./mcp-registry.js');
    for (const name of getRunningServerNames()) {
      try {
        stopServer(name);
      } catch {
        /* already gone */
      }
    }
    sb.cleanup();
  });

  it('parses REMOTE_MCP_SERVERS as comma-separated "name|url" pairs', async () => {
    process.env.REMOTE_MCP_SERVERS = 'deepwiki|https://mcp.deepwiki.com/mcp,context7|https://ctx7.example/mcp';

    const { startMcpServers, getRunningServerNames, getServerDef } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    const names = getRunningServerNames().sort();
    expect(names).toEqual(['context7', 'deepwiki']);

    expect(getServerDef('deepwiki')?.type).toBe('http');
    expect(getServerDef('deepwiki')?.url).toBe('https://mcp.deepwiki.com/mcp');
    expect(getServerDef('context7')?.url).toBe('https://ctx7.example/mcp');

    // Each remote server gets its own supergateway proxy on a unique
    // loopback port, assigned sequentially from the base.
    expect(handle.getUpstreamPort('deepwiki')).toBe(45000);
    expect(handle.getUpstreamPort('context7')).toBe(45001);
    expect(handle.getUpstreamPort('ghost')).toBeNull();

    expect(spawnCalls).toHaveLength(2);
    for (const call of spawnCalls) {
      expect(call.args).toContain('--streamableHttp');
      expect(call.args).toContain('--host');
      expect(call.args).toContain('127.0.0.1');
    }

    handle.stop();
  });

  it('skips malformed REMOTE_MCP_SERVERS entries without a url', async () => {
    process.env.REMOTE_MCP_SERVERS = 'bare-name,no-url|,good|https://example.test/mcp';
    const { startMcpServers, getRunningServerNames } = await import('./mcp-registry.js');
    await startMcpServers(45000);
    expect(getRunningServerNames()).toEqual(['good']);
  });

  it('returns empty handle when REMOTE_MCP_SERVERS is empty string', async () => {
    process.env.REMOTE_MCP_SERVERS = '';
    const { startMcpServers, getRunningServerNames } = await import('./mcp-registry.js');
    await startMcpServers(45000);
    expect(getRunningServerNames()).toEqual([]);
  });
});

describe('mcp-registry — stdio server detection', () => {
  let sb: ReturnType<typeof sandbox>;

  beforeEach(() => {
    sb = sandbox();
  });

  afterEach(async () => {
    const { getRunningServerNames, stopServer } = await import('./mcp-registry.js');
    for (const name of getRunningServerNames()) {
      try {
        stopServer(name);
      } catch {
        /* already gone */
      }
    }
    sb.cleanup();
  });

  function writeServerDir(name: string, opts: { envVars?: string[] } = {}): void {
    const dir = path.join(sb.root, 'container', 'mcp-servers', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "stub"\n');
    if (opts.envVars) {
      fs.writeFileSync(path.join(dir, '.env-vars'), opts.envVars.join('\n'));
    }
  }

  it('detects servers that have a pyproject.toml and ignores others', async () => {
    writeServerDir('has-pyproject');
    fs.mkdirSync(path.join(sb.root, 'container', 'mcp-servers', 'no-pyproject'), { recursive: true });

    const { startMcpServers, getRunningServerNames } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    // has-pyproject has no .env-vars → auth=none → it gets started without
    // shared-token check; no-pyproject is filtered out.
    expect(getRunningServerNames()).toEqual(['has-pyproject']);
    handle.stop();
  });

  it('skips stdio servers with shared-token auth when no tokens are present in .env', async () => {
    writeServerDir('needs-tokens', { envVars: ['MISSING_TOKEN', 'ALSO_MISSING'] });
    // No .env file → readEnvFile returns {} → server is skipped.

    const { startMcpServers, getRunningServerNames } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    expect(getRunningServerNames()).toEqual([]);
    expect(spawnCalls).toHaveLength(0);
    handle.stop();
  });

  it('starts stdio servers when their .env-vars tokens are available', async () => {
    writeServerDir('slang-mcp', { envVars: ['GITHUB_TOKEN'] });
    fs.writeFileSync(path.join(sb.root, '.env'), 'GITHUB_TOKEN=ghp_supersecret\n');

    const { startMcpServers, getRunningServerNames, getServerDef } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    expect(getRunningServerNames()).toEqual(['slang-mcp']);
    expect(getServerDef('slang-mcp')?.auth).toBe('shared-token');
    expect(getServerDef('slang-mcp')?.envVars).toEqual(['GITHUB_TOKEN']);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args[0]).toBe('--stdio');
    // Tokens flow in via env (not argv) — never in supergateway args.
    expect(spawnCalls[0].args.join(' ')).not.toContain('ghp_supersecret');
    const env = (spawnCalls[0].options as { env?: Record<string, string> }).env;
    expect(env?.GITHUB_TOKEN).toBe('ghp_supersecret');

    handle.stop();
  });

  it('ignores commented and blank lines in .env-vars', async () => {
    writeServerDir('slang-mcp', { envVars: ['# comment', '', '  # indented', 'REAL_TOKEN'] });
    fs.writeFileSync(path.join(sb.root, '.env'), 'REAL_TOKEN=value\n');

    const { startMcpServers, getServerDef } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    expect(getServerDef('slang-mcp')?.envVars).toEqual(['REAL_TOKEN']);
    handle.stop();
  });

  it('marks server dead and clears its state on process exit', async () => {
    writeServerDir('slang-mcp', { envVars: ['T'] });
    fs.writeFileSync(path.join(sb.root, '.env'), 'T=1\n');

    const { startMcpServers, isServerAlive } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);
    expect(isServerAlive('slang-mcp')).toBe(true);

    // Simulate supergateway exiting unexpectedly.
    stubProcesses[0].emit('exit', 1);
    expect(isServerAlive('slang-mcp')).toBe(false);

    handle.stop();
  });

  it('stopServer kills the child, clears alive flag, and is idempotent', async () => {
    writeServerDir('slang-mcp', { envVars: ['T'] });
    fs.writeFileSync(path.join(sb.root, '.env'), 'T=1\n');

    const { startMcpServers, stopServer, isServerAlive } = await import('./mcp-registry.js');
    const handle = await startMcpServers(45000);

    stopServer('slang-mcp');
    expect(isServerAlive('slang-mcp')).toBe(false);
    expect(stubProcesses[0].kill).toHaveBeenCalledWith('SIGTERM');

    // Second stop: the process handle is already cleared, so no kill.
    (stubProcesses[0].kill as ReturnType<typeof vi.fn>).mockClear();
    stopServer('slang-mcp');
    expect(stubProcesses[0].kill).not.toHaveBeenCalled();

    handle.stop();
  });
});
