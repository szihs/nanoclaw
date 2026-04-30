/**
 * MCP Server Registry for NanoClaw v2.
 *
 * Manages multiple MCP servers — each gets its own supergateway process
 * bound to loopback on an auto-assigned port.  The auth proxy routes
 * requests to the correct upstream by path prefix (/mcp/<serverName>).
 *
 * Servers are defined in config or auto-detected from container/mcp-servers/.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { log } from './log.js';
import { ONECLI_URL } from './config.js';
import { readEnvFile } from './env.js';
import { clearDiscoveredTools, discoverTools } from './mcp-auth-proxy.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface McpServerDef {
  /** Unique server name used in URL paths and tool prefixes. */
  name: string;
  /** 'stdio' = local process via supergateway; 'http' = remote URL. */
  type: 'stdio' | 'http';
  /** For stdio: shell command to run the server. */
  command?: string;
  /** For stdio: working directory. */
  workDir?: string;
  /** For stdio: env var names to read from .env and pass to the server. */
  envVars?: string[];
  /** For http: upstream URL (e.g. https://mcp.deepwiki.com/mcp). */
  url?: string;
  /** Auth method: 'none', 'shared-token' (env var), 'per-user-oauth'. */
  auth?: 'none' | 'shared-token' | 'per-user-oauth';
}

interface RunningServer {
  def: McpServerDef;
  process?: ChildProcess;
  /** Loopback port for stdio servers, or null for remote HTTP. */
  upstreamPort: number | null;
  alive: boolean;
}

// ── OneCLI proxy for host-side MCP servers ─────────────────────────────────

let _onecliProxyEnvCache: Record<string, string> | null = null;

/**
 * Build env vars that route HTTP traffic through the OneCLI gateway.
 * Returns HTTPS_PROXY, CA cert path, etc. — or null if OneCLI isn't configured.
 * MCP servers inherit these so their outbound API calls get credential injection.
 */
async function getOneCLIProxyEnv(): Promise<Record<string, string> | null> {
  if (_onecliProxyEnvCache) return _onecliProxyEnvCache;
  if (!ONECLI_URL) return null;

  try {
    const onecli = new OneCLI({ url: ONECLI_URL });
    const config = await onecli.getContainerConfig();

    // Write combined CA bundle (system + OneCLI MITM CA) so Python httpx trusts the proxy.
    const combinedCaPath = path.join(os.tmpdir(), 'nanoclaw-onecli-mcp-ca.pem');
    let systemCa = '';
    const systemCaPath = '/etc/ssl/certs/ca-certificates.crt';
    if (fs.existsSync(systemCaPath)) {
      systemCa = fs.readFileSync(systemCaPath, 'utf-8');
    }
    fs.writeFileSync(combinedCaPath, systemCa + '\n' + config.caCertificate, { mode: 0o644 });

    // Rewrite host.docker.internal → 127.0.0.1 since MCP servers run on the
    // host, not inside containers.
    const rewriteProxy = (url: string) => url.replace(/host\.docker\.internal/g, '127.0.0.1');

    _onecliProxyEnvCache = {
      HTTPS_PROXY: rewriteProxy(config.env.HTTPS_PROXY || ''),
      HTTP_PROXY: rewriteProxy(config.env.HTTP_PROXY || ''),
      https_proxy: rewriteProxy(config.env.https_proxy || ''),
      http_proxy: rewriteProxy(config.env.http_proxy || ''),
      SSL_CERT_FILE: combinedCaPath,
      REQUESTS_CA_BUNDLE: combinedCaPath,
      NODE_EXTRA_CA_CERTS: combinedCaPath,
    };

    log.info('OneCLI proxy env prepared for MCP servers', { caPath: combinedCaPath });
    return _onecliProxyEnvCache;
  } catch (err) {
    log.warn('Failed to get OneCLI proxy config for MCP servers', { err });
    return null;
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

const servers = new Map<string, RunningServer>();
let nextInternalPort = 0;

/**
 * Auto-detect stdio MCP servers from container/mcp-servers/ directory.
 * Each subdirectory with a pyproject.toml is a candidate.
 */
function detectStdioServers(): McpServerDef[] {
  const mcpDir = path.join(process.cwd(), 'container', 'mcp-servers');
  if (!fs.existsSync(mcpDir)) return [];

  const defs: McpServerDef[] = [];
  for (const entry of fs.readdirSync(mcpDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const serverDir = path.join(mcpDir, entry.name);
    if (!fs.existsSync(path.join(serverDir, 'pyproject.toml'))) continue;

    const name = entry.name;

    // Per-server env vars: read from .env-vars file in the server directory.
    const envVarsFile = path.join(serverDir, '.env-vars');
    let envVars: string[] = [];
    if (fs.existsSync(envVarsFile)) {
      envVars = fs
        .readFileSync(envVarsFile, 'utf-8')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    }

    defs.push({
      name,
      type: 'stdio',
      command: `uv run --directory ${serverDir} ${name}-server`,
      workDir: serverDir,
      envVars,
      auth: envVars.length > 0 ? 'shared-token' : 'none',
    });
  }
  return defs;
}

/**
 * Auto-detect remote HTTP MCP servers from REMOTE_MCP_SERVERS env var.
 * Format: comma-separated "name|url" pairs, e.g. "deepwiki|https://mcp.deepwiki.com/mcp"
 */
function detectRemoteServers(): McpServerDef[] {
  const raw = process.env.REMOTE_MCP_SERVERS || '';
  if (!raw) return [];
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [name, url] = entry.split('|').map((s) => s.trim());
      return { name, type: 'http' as const, url, auth: 'none' as const };
    })
    .filter((d) => d.name && d.url);
}

/**
 * Start all registered MCP servers.
 * Stdio servers get a supergateway process on loopback.
 * Remote HTTP servers get a supergateway proxy on loopback.
 *
 * @param baseInternalPort Starting port for loopback supergateway instances.
 */
export async function startMcpServers(baseInternalPort: number): Promise<{
  stop: () => void;
  getUpstreamPort: (name: string) => number | null;
}> {
  nextInternalPort = baseInternalPort;

  const defs = [...detectStdioServers(), ...detectRemoteServers()];
  if (defs.length === 0) {
    log.info('No MCP servers detected');
    return { stop: () => {}, getUpstreamPort: () => null };
  }

  // If OneCLI is configured, get proxy config so MCP servers that are missing
  // .env tokens can route through OneCLI for credential injection instead.
  const onecliProxyEnv = await getOneCLIProxyEnv();

  const supergwPath = path.join(process.cwd(), 'node_modules', '.bin', 'supergateway');

  for (const def of defs) {
    if (def.type === 'stdio') {
      const port = nextInternalPort++;

      // Read tokens from .env — some may be config (channel IDs, paths),
      // others may be secrets that have been moved to OneCLI.
      const tokens = def.envVars ? readEnvFile(def.envVars) : {};
      const hasSomeTokens = Object.keys(tokens).length > 0;

      if (!hasSomeTokens && def.auth === 'shared-token') {
        if (onecliProxyEnv) {
          // Tokens removed from .env — set placeholders so the MCP server
          // initializes, and route requests through OneCLI proxy for real
          // credential injection.
          for (const varName of def.envVars || []) {
            if (!tokens[varName]) tokens[varName] = 'onecli-placeholder';
          }
          log.info('MCP server using OneCLI proxy for credentials', { server: def.name });
        } else {
          log.info('No tokens configured, skipping MCP server', { server: def.name });
          continue;
        }
      }

      const proc = spawn(
        supergwPath,
        ['--stdio', def.command!, '--outputTransport', 'streamableHttp', '--port', String(port), '--host', '127.0.0.1'],
        {
          env: { ...(process.env as Record<string, string>), ...tokens, ...onecliProxyEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.debug('MCP server stderr', { server: def.name, msg });
      });

      proc.on('error', (err) => {
        log.error('MCP server failed to start', { server: def.name, err });
      });

      proc.on('exit', (code) => {
        const entry = servers.get(def.name);
        if (entry) entry.alive = false;
        clearDiscoveredTools(def.name);
        if (code !== null && code !== 0) {
          log.warn('MCP server exited unexpectedly', { server: def.name, code });
        }
      });

      servers.set(def.name, { def, process: proc, upstreamPort: port, alive: true });
      log.info('MCP server started (loopback)', { server: def.name, port });
    } else if (def.type === 'http' && def.url) {
      const port = nextInternalPort++;
      const proc = spawn(
        supergwPath,
        [
          '--streamableHttp',
          def.url,
          '--outputTransport',
          'streamableHttp',
          '--port',
          String(port),
          '--host',
          '127.0.0.1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.debug('Remote MCP server stderr', { server: def.name, msg });
      });
      proc.on('error', (err) => {
        log.error('Remote MCP server proxy failed to start', { server: def.name, err });
      });
      proc.on('exit', (code) => {
        const entry = servers.get(def.name);
        if (entry) entry.alive = false;
        clearDiscoveredTools(def.name);
        if (code !== null && code !== 0) {
          log.warn('Remote MCP server proxy exited unexpectedly', { server: def.name, code });
        }
      });

      servers.set(def.name, { def, process: proc, upstreamPort: port, alive: true });
      log.info('Remote MCP server proxied (loopback)', { server: def.name, port, url: def.url });
    }
  }

  // Wait for supergateway processes to initialize (Python servers need longer)
  await new Promise((resolve) => setTimeout(resolve, 5000));

  return {
    stop: () => {
      for (const [name, running] of servers) {
        if (running.process?.pid) {
          try {
            running.process.kill('SIGTERM');
          } catch {
            // Process already gone
          }
          log.info('MCP server stopped', { server: name });
        }
      }
      servers.clear();
    },
    getUpstreamPort: (name: string) => {
      return servers.get(name)?.upstreamPort ?? null;
    },
  };
}

/** Get all alive server names. */
export function getRunningServerNames(): string[] {
  return [...servers.entries()].filter(([, s]) => s.alive).map(([name]) => name);
}

/** Get server status by name. */
export function isServerAlive(name: string): boolean {
  return servers.get(name)?.alive ?? false;
}

/** Get a server's upstream port (loopback) by name. */
export function getServerUpstreamPort(name: string): number | null {
  return servers.get(name)?.upstreamPort ?? null;
}

/** Get a server's definition by name. */
export function getServerDef(name: string): McpServerDef | undefined {
  return servers.get(name)?.def;
}

/** Stop a running local MCP server (keeps definition for restart). */
export function stopServer(name: string): void {
  const running = servers.get(name);
  if (!running) throw new Error(`Server "${name}" not found`);
  running.alive = false;
  clearDiscoveredTools(name);
  if (running.process?.pid) {
    try {
      running.process.kill('SIGTERM');
    } catch {
      // Already gone
    }
    running.process = undefined;
    log.info('MCP server stopped', { server: name });
  }
}

/** Restart an MCP server (stop + re-start). Works for both stdio and remote HTTP servers. */
export async function restartServer(name: string): Promise<void> {
  const running = servers.get(name);
  if (!running?.def) throw new Error(`Server "${name}" not found`);
  const def = running.def;
  const port = running.upstreamPort;
  if (!port) throw new Error(`Server "${name}" has no assigned port`);

  stopServer(name);

  const supergwPath = path.join(process.cwd(), 'node_modules', '.bin', 'supergateway');

  const proxyEnv = await getOneCLIProxyEnv();

  let proc: ReturnType<typeof spawn>;
  if (def.type === 'stdio') {
    const tokens = def.envVars ? readEnvFile(def.envVars) : {};
    if (proxyEnv) {
      for (const varName of def.envVars || []) {
        if (!tokens[varName]) tokens[varName] = 'onecli-placeholder';
      }
    }
    proc = spawn(
      supergwPath,
      ['--stdio', def.command!, '--outputTransport', 'streamableHttp', '--port', String(port), '--host', '127.0.0.1'],
      {
        env: { ...(process.env as Record<string, string>), ...tokens, ...proxyEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } else if (def.type === 'http' && def.url) {
    proc = spawn(
      supergwPath,
      [
        '--streamableHttp',
        def.url,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } else {
    throw new Error(`Server "${name}" has unknown type: ${def.type}`);
  }

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log.debug('MCP server stderr', { server: name, msg });
  });
  proc.on('error', (err) => {
    const entry = servers.get(name);
    if (entry) entry.alive = false;
    log.error('MCP server failed to restart', { server: name, err });
  });
  proc.on('exit', (code) => {
    const entry = servers.get(name);
    if (entry) entry.alive = false;
    clearDiscoveredTools(name);
    if (code !== null && code !== 0) {
      log.warn('Restarted MCP server exited unexpectedly', { server: name, code });
    }
  });

  servers.set(name, { def, process: proc, upstreamPort: port, alive: true });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Rediscover tools after restart (server may have changed)
  await discoverTools(name, port).catch((err) => {
    log.warn('Tool rediscovery failed after restart', { server: name, err });
  });

  log.info('MCP server restarted', { server: name, port });
}
