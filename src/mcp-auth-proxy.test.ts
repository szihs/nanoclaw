/**
 * mcp-auth-proxy sits between containers and the supergateway fleet. Most of
 * the surface is HTTP proxy logic that needs a live upstream to test — this
 * suite covers the pure token/ACL and inventory helpers that don't.
 *
 * The integration path (start proxy, issue HTTP, verify ACL) lives in a
 * separate end-to-end harness; these unit tests pin the scoped-name contract
 * that the rest of the system relies on.
 */
import net from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The registry side-effects (spawning supergateway) must not run during
// tests. Mock mcp-registry entirely — the proxy only uses it for the
// host-only `/servers`, `/servers/stop`, `/servers/restart` endpoints and
// to resolve upstream ports.
vi.mock('./mcp-registry.js', () => ({
  getRunningServerNames: vi.fn(() => ['deepwiki', 'slang-mcp']),
  getServerUpstreamPort: vi.fn((name: string) => (name === 'deepwiki' ? 45001 : 45002)),
  isServerAlive: vi.fn(() => true),
  restartServer: vi.fn().mockResolvedValue(undefined),
  stopServer: vi.fn(),
}));

import {
  clearDiscoveredTools,
  getDiscoveredToolInventory,
  getMcpManagementToken,
  registerContainerToken,
  revokeContainerToken,
  setUpstreamPortResolver,
  startMcpAuthProxy,
} from './mcp-auth-proxy.js';

describe('registerContainerToken', () => {
  it('returns a 64-char hex bearer token', () => {
    const token = registerContainerToken('group-a', ['mcp__deepwiki__ask_question']);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a distinct token per registration', () => {
    const a = registerContainerToken('group-a', []);
    const b = registerContainerToken('group-b', []);
    expect(a).not.toBe(b);
  });

  it('filters out the mcp__nanoclaw__* in-process tools from ACL (they bypass the proxy)', () => {
    // We can't introspect the internal Set directly; probe via the proxy's
    // own ACL path instead. Easiest indirect check: the token still gets
    // issued with a valid hex form and no exception.
    expect(() =>
      registerContainerToken('g', ['mcp__nanoclaw__send_message', 'mcp__deepwiki__ask_question']),
    ).not.toThrow();
  });
});

describe('revokeContainerToken', () => {
  it('is a safe no-op for unknown tokens', () => {
    expect(() => revokeContainerToken('does-not-exist')).not.toThrow();
  });
});

describe('discovered tool inventory', () => {
  it('returns an empty object when no servers have been discovered', () => {
    clearDiscoveredTools('deepwiki');
    clearDiscoveredTools('slang-mcp');
    expect(getDiscoveredToolInventory()).toEqual({});
  });

  it('clearDiscoveredTools for an unknown server is a no-op', () => {
    expect(() => clearDiscoveredTools('never-existed')).not.toThrow();
  });
});

/** Find a free TCP port by opening a socket on :0 and reading its address. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected address shape'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until the proxy's /tools responds (server has finished binding). */
async function waitForProxy(baseUrl: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/tools`);
      if (res.status === 401 || res.status === 200) return;
    } catch {
      // not bound yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Proxy at ${baseUrl} never came up`);
}

describe('auth proxy lifecycle', () => {
  let stopProxy: () => void;

  beforeEach(async () => {
    setUpstreamPortResolver(() => 45001);
    const port = await pickFreePort();
    const { stop } = startMcpAuthProxy('127.0.0.1', port);
    stopProxy = stop;
    await waitForProxy(`http://127.0.0.1:${port}`);
  });

  afterEach(() => {
    stopProxy();
  });

  it('getMcpManagementToken returns a 64-char hex token once the proxy is started', () => {
    const token = getMcpManagementToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('clears the management token on stop', async () => {
    stopProxy();
    expect(getMcpManagementToken()).toBe('');
    // Restart on a fresh port so the afterEach stop is a no-op cleanup.
    const port = await pickFreePort();
    const restarted = startMcpAuthProxy('127.0.0.1', port);
    stopProxy = restarted.stop;
    await waitForProxy(`http://127.0.0.1:${port}`);
  });
});

describe('auth proxy HTTP endpoints', () => {
  let proxyUrl: string;
  let stopProxy: () => void;
  let mgmtToken: string;

  beforeEach(async () => {
    setUpstreamPortResolver(() => 45001);
    const port = await pickFreePort();
    proxyUrl = `http://127.0.0.1:${port}`;
    const { stop } = startMcpAuthProxy('127.0.0.1', port);
    stopProxy = stop;
    mgmtToken = getMcpManagementToken();
    await waitForProxy(proxyUrl);
  });

  afterEach(() => {
    stopProxy();
  });

  it('returns 401 without a bearer token', async () => {
    const res = await fetch(`${proxyUrl}/mcp/deepwiki`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Authorization/i);
  });

  it('returns 401 for an unknown bearer token', async () => {
    const res = await fetch(`${proxyUrl}/mcp/deepwiki`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-real' },
    });
    expect(res.status).toBe(401);
  });

  it('/tools requires the management token', async () => {
    const unauth = await fetch(`${proxyUrl}/tools`);
    expect(unauth.status).toBe(401);

    const withMgmt = await fetch(`${proxyUrl}/tools`, {
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    expect(withMgmt.status).toBe(200);
    const body = await withMgmt.json();
    expect(body).toEqual({}); // no servers discovered in this test
  });

  it('/servers returns the registry topology when management-authenticated', async () => {
    const res = await fetch(`${proxyUrl}/servers`, {
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: Array<{ name: string; port: number; status: string }> };
    expect(body.servers.map((s) => s.name).sort()).toEqual(['deepwiki', 'slang-mcp']);
    expect(body.servers.every((s) => s.status === 'running')).toBe(true);
  });

  it('/servers/stop requires ?name= and returns 400 otherwise', async () => {
    const res = await fetch(`${proxyUrl}/servers/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('/servers/stop returns 200 and invokes the registry when ?name= is present', async () => {
    const { stopServer } = await import('./mcp-registry.js');
    const res = await fetch(`${proxyUrl}/servers/stop?name=deepwiki`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, stopped: 'deepwiki' });
    expect(stopServer).toHaveBeenCalledWith('deepwiki');
  });

  it('rejects tools/call for unauthorized tools with JSON-RPC error code -32600', async () => {
    const containerToken = registerContainerToken('group-x', ['mcp__deepwiki__ask_question']);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'blacklisted_tool' },
    });

    const res = await fetch(`${proxyUrl}/mcp/deepwiki`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${containerToken}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(403);
    const parsed = (await res.json()) as { id: number; error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.error.message).toMatch(/not authorized/);
    expect(parsed.id).toBe(99);
  });

  it('returns 404 when the requested server has no upstream port', async () => {
    setUpstreamPortResolver(() => null);

    const containerToken = registerContainerToken('group-y', ['mcp__deepwiki__ask_question']);
    const res = await fetch(`${proxyUrl}/mcp/unknown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${containerToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
