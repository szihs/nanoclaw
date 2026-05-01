/**
 * Local-process agent runner for AGENT_RUNTIME=local.
 *
 * Spawns the in-container agent-runner (container/agent-runner/src/index.ts)
 * directly on the host via `bun`, with env vars replacing Docker volume mounts.
 * The agent-runner reads SESSION_*_DB_PATH, WORKSPACE_AGENT, WORKSPACE_OUTBOX
 * from env so hardcoded `/workspace/*` defaults don't leak onto the host.
 *
 * No container isolation — agents share the host filesystem and any per-group
 * state (groups/<folder>/) across concurrent sessions. This mode is the
 * `remove-docker` skill's payload; Docker remains the default for production.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_HOST_GATEWAY,
  DASHBOARD_PORT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_MESSAGES_PER_PROMPT,
  MCP_PROXY_PORT,
  TIMEZONE,
} from './config.js';
import { readContainerConfig } from './container-config.js';
import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';
import type { ProviderContainerContribution } from './providers/provider-container-registry.js';
import { heartbeatPath, inboundDbPath, outboundDbPath, sessionDir } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

/** Entry point the `bun` spawn targets. */
const AGENT_RUNNER_ENTRY = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'index.ts');

export interface LocalAgentContext {
  session: Session;
  agentGroup: AgentGroup;
  provider: string;
  contribution: ProviderContainerContribution;
  proxyToken: string;
  allowedTools: string[];
  mcpServers: Record<string, unknown>;
}

export interface LocalAgentHandle {
  process: ChildProcess;
  name: string;
}

function gatherAdminUserIds(agentGroup: AgentGroup): string[] {
  if (!hasTable(getDb(), 'user_roles')) return [];
  const db = getDb();
  const owners = db
    .prepare("SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL")
    .all() as Array<{ user_id: string }>;
  const globalAdmins = db
    .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' AND agent_group_id IS NULL")
    .all() as Array<{ user_id: string }>;
  const scopedAdmins = db
    .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' AND agent_group_id = ?")
    .all(agentGroup.id) as Array<{ user_id: string }>;
  const ids = new Set<string>();
  for (const r of owners) ids.add(r.user_id);
  for (const r of globalAdmins) ids.add(r.user_id);
  for (const r of scopedAdmins) ids.add(r.user_id);
  return [...ids];
}

/**
 * Build the child-process env map. Mirrors what Docker's buildContainerArgs
 * sets via `-e`, adapted to host paths. Caller provides groupDir + sessDir so
 * this function is trivially testable.
 */
export function buildLocalAgentEnv(
  ctx: LocalAgentContext,
  paths: { groupDir: string; sessDir: string; globalDir: string | null; outboxDir: string },
): NodeJS.ProcessEnv {
  const { session, agentGroup, provider, contribution, proxyToken, allowedTools, mcpServers } = ctx;

  // Start from the host env so proxy / CA cert / bun tooling all work as on
  // the host. Override with agent-specific vars below.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TZ: TIMEZONE,
    AGENT_PROVIDER: provider,
    // Two-DB split: the agent-runner reads inbound, writes outbound.
    SESSION_INBOUND_DB_PATH: inboundDbPath(agentGroup.id, session.id),
    SESSION_OUTBOUND_DB_PATH: outboundDbPath(agentGroup.id, session.id),
    SESSION_HEARTBEAT_PATH: heartbeatPath(agentGroup.id, session.id),
    // Workspace root paths — the env-var fallbacks inside agent-runner pick these up.
    WORKSPACE_SESSION: paths.sessDir,
    WORKSPACE_AGENT: paths.groupDir,
    WORKSPACE_GLOBAL: paths.globalDir ?? '',
    WORKSPACE_OUTBOX: paths.outboxDir,
    // Additional host-mounted dirs. Docker points /workspace/extra at a
    // validated additionalMounts set; local mode has no such plumbing, so
    // point at an empty dir (a sibling of the session dir) to make the
    // agent-runner's extra-dir scan a safe no-op.
    WORKSPACE_EXTRA: path.join(paths.sessDir, '.extra-empty'),
    HOME: path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared'),
  };

  // Ensure the empty extra dir exists so existsSync() returns true but
  // readdirSync() returns []. Also ensure outbox exists for the runner.
  fs.mkdirSync(env.WORKSPACE_EXTRA as string, { recursive: true });
  fs.mkdirSync(paths.outboxDir, { recursive: true });

  // Same env vars the Docker path forwards (see container-runner.ts).
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ENABLE_PROMPT_CACHING_1H',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    'CLAUDE_CODE_FORK_SUBAGENT',
    'CODEX_PROFILE',
    'CODEX_HOME',
    'CODEX_BASE_URL',
    'CODEX_MODEL',
    'CODEX_MODEL_PROVIDER',
    'CODEX_REASONING_EFFORT',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }

  // Local mode runs without per-agent OneCLI credential injection; the
  // process inherits the host's HTTPS_PROXY / NODE_EXTRA_CA_CERTS. Set the
  // placeholders the Docker path uses so provider code paths that expect
  // these env vars don't crash on unset reads.
  env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || 'onecli-placeholder';
  env.GH_TOKEN = process.env.GH_TOKEN || 'placeholder';

  if (agentGroup.name) {
    env.NANOCLAW_ASSISTANT_NAME = agentGroup.name;
  }
  env.NANOCLAW_AGENT_GROUP_ID = agentGroup.id;
  env.NANOCLAW_AGENT_GROUP_NAME = agentGroup.name;
  env.NANOCLAW_MAX_MESSAGES_PER_PROMPT = String(MAX_MESSAGES_PER_PROMPT);

  if (contribution.env) {
    for (const [k, v] of Object.entries(contribution.env)) env[k] = v;
  }

  const adminIds = gatherAdminUserIds(agentGroup);
  if (adminIds.length > 0) {
    env.NANOCLAW_ADMIN_USER_IDS = adminIds.join(',');
  }

  // Append local-required bypass entries to inherited NO_PROXY rather than
  // overwriting — preserves any corporate/internal hosts already bypassed
  // on the host (e.g. *.internal.corp).
  const localBypass = [AGENT_HOST_GATEWAY, 'localhost', '127.0.0.1'];
  const existing = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  env.NO_PROXY = [...new Set([...localBypass, ...existing])].join(',');
  env.no_proxy = env.NO_PROXY;

  if (Object.keys(mcpServers).length > 0) {
    env.NANOCLAW_MCP_SERVERS = JSON.stringify(mcpServers);
  }

  env.MCP_PROXY_TOKEN = proxyToken;
  env.MCP_PROXY_URL = `http://${AGENT_HOST_GATEWAY}:${MCP_PROXY_PORT}`;
  if (allowedTools.length > 0) {
    env.NANOCLAW_ALLOWED_MCP_TOOLS = JSON.stringify(allowedTools);
  }

  if (DASHBOARD_PORT) {
    env.DASHBOARD_URL = `http://${AGENT_HOST_GATEWAY}:${DASHBOARD_PORT}`;
  }

  const containerConfig = readContainerConfig(agentGroup.folder);
  if (containerConfig.imageTag) {
    // Surface this as a hint only; local mode does not build images.
    log.debug('container.json imageTag is ignored in local mode', {
      folder: agentGroup.folder,
      imageTag: containerConfig.imageTag,
    });
  }

  return env;
}

/**
 * Spawn the agent-runner as a local `bun` process with the group dir as cwd.
 * Resolves with a handle once spawn completes; rejects if `bun` can't be
 * started. Bun is required because the agent-runner imports `bun:sqlite`.
 */
export function spawnLocalAgent(ctx: LocalAgentContext): Promise<LocalAgentHandle> {
  const { session, agentGroup } = ctx;

  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const globalDirRaw = path.join(GROUPS_DIR, 'global');
  const globalDir = fs.existsSync(globalDirRaw) ? globalDirRaw : null;
  const outboxDir = path.join(sessDir, 'outbox');

  const env = buildLocalAgentEnv(ctx, { groupDir, sessDir, globalDir, outboxDir });
  const name = `${agentGroup.folder}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['run', AGENT_RUNNER_ENTRY], {
      cwd: groupDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.once('spawn', () => {
      log.info('Spawned local agent', {
        sessionId: session.id,
        agentGroup: agentGroup.name,
        name,
        cwd: groupDir,
        pid: proc.pid,
      });
      resolve({ process: proc, name });
    });

    proc.once('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            'Failed to spawn local agent: `bun` not found on PATH. ' +
              'Install it (https://bun.sh) or switch AGENT_RUNTIME back to docker.',
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

/** Stop a local agent. SIGTERM first, SIGKILL after `timeoutMs` if still alive. */
export function killLocalAgent(handle: LocalAgentHandle, timeoutMs = 2000): Promise<void> {
  const proc = handle.process;
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onExit = (): void => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        log.warn('Local agent did not exit on SIGTERM; sending SIGKILL', { name: handle.name });
        proc.kill('SIGKILL');
      }
    }, timeoutMs);
    proc.kill('SIGTERM');
  });
}
