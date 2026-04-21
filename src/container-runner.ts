/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  composeCoworkerSpine,
  readCoworkerTypes,
  readSkillCatalog,
  resolveCoworkerManifest,
  type CoworkerTypeEntry,
  type SkillMeta,
} from './claude-composer.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_PREFIX,
  DASHBOARD_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  MCP_PROXY_PORT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { registerContainerToken, revokeContainerToken, getDiscoveredToolInventory } from './mcp-auth-proxy.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { markContainerRunning, markContainerStopped, sessionDir, writeSessionRouting } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

/**
 * Cached coworker types + skill catalog — reloaded when any coworker-types.yaml
 * or SKILL.md mtime changes. Tool derivation walks the catalog so both inputs
 * participate in the fingerprint.
 */
let registryCache: {
  types: Record<string, CoworkerTypeEntry>;
  catalog: Record<string, SkillMeta>;
  fingerprint: number;
} | null = null;

function registryFingerprint(): number {
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  let maxMtime = 0;
  try {
    for (const dir of fs.readdirSync(skillsDir)) {
      for (const file of ['coworker-types.yaml', 'SKILL.md']) {
        try {
          maxMtime = Math.max(maxMtime, fs.statSync(path.join(skillsDir, dir, file)).mtimeMs);
        } catch {
          /* file does not exist */
        }
      }
    }
  } catch {
    /* skills dir does not exist */
  }
  return maxMtime;
}

function loadRegistry(): { types: Record<string, CoworkerTypeEntry>; catalog: Record<string, SkillMeta> } {
  try {
    const fp = registryFingerprint();
    if (registryCache && registryCache.fingerprint === fp) {
      return { types: registryCache.types, catalog: registryCache.catalog };
    }
    const projectRoot = process.cwd();
    const types = readCoworkerTypes(projectRoot);
    const catalog = readSkillCatalog(projectRoot);
    registryCache = { types, catalog, fingerprint: fp };
    return { types, catalog };
  } catch (err) {
    log.warn('Failed to load coworker registry', { err });
    return { types: {}, catalog: {} };
  }
}

export function resetCoworkerTypesCacheForTests(): void {
  registryCache = null;
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<void>>();

/**
 * Compose CLAUDE.md from the lego coworker model: spine fragments + skills +
 * workflows + overlays + trait bindings, all discovered under
 * `container/skills/*`. See docs/lego-coworker-workflows.md.
 *
 * Runs for ALL non-admin coworkers on every container wake. CLAUDE.md is
 * system-owned (regenerated from the manifest + .instructions.md on every
 * wake). User edits go in .instructions.md and are appended after the spine.
 */
function composeCoworkerClaudeMd(agentGroup: AgentGroup): void {
  if (agentGroup.is_admin) return;

  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const instructionsPath = path.join(groupDir, '.instructions.md');

  if (!agentGroup.coworker_type && !fs.existsSync(instructionsPath) && fs.existsSync(claudeMdPath)) {
    fs.renameSync(claudeMdPath, instructionsPath);
    log.info('Auto-migrated CLAUDE.md to .instructions.md', { folder: agentGroup.folder });
  }

  if (!agentGroup.coworker_type) return;

  try {
    let extraInstructions: string | null = null;
    try {
      extraInstructions = fs.readFileSync(instructionsPath, 'utf-8');
    } catch {
      /* no explicit instructions */
    }

    const composed = composeCoworkerSpine({
      coworkerType: agentGroup.coworker_type,
      extraInstructions,
    });

    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(claudeMdPath, composed);
    log.debug('CLAUDE.md composed from lego spine', { folder: agentGroup.folder });
  } catch (err) {
    log.warn('Failed to compose CLAUDE.md from lego spine', { folder: agentGroup.folder, err });
  }
}

export function resolveAllowedMcpTools(agentGroup: AgentGroup): string[] {
  if (agentGroup.is_admin) {
    const adminOverride = process.env.ADMIN_MCP_TOOLS || '';
    if (adminOverride) {
      return adminOverride
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    const inv = getDiscoveredToolInventory();
    const allTools = Object.values(inv).flat();
    return allTools.length > 0 ? allTools : [];
  }

  if (agentGroup.allowed_mcp_tools) {
    return agentGroup.allowed_mcp_tools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  if (!agentGroup.coworker_type) return [];

  try {
    const { types, catalog } = loadRegistry();
    const manifest = resolveCoworkerManifest(types, agentGroup.coworker_type, catalog, process.cwd());
    return manifest.tools.filter((t) => t.startsWith('mcp__'));
  } catch (err) {
    log.warn('Failed to resolve MCP tools for coworker type', {
      coworkerType: agentGroup.coworker_type,
      err,
    });
    return [];
  }
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 */
export function wakeContainer(session: Session): Promise<void> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve();
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session).finally(() => {
    wakePromises.delete(session.id);
  });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Compose CLAUDE.md for typed coworkers (lego spine model).
  composeCoworkerClaudeMd(agentGroup);

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup);

  const mounts = buildMounts(agentGroup, session, contribution);
  const containerName = `${CONTAINER_PREFIX}-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(mounts, containerName, agentGroup, provider, contribution, agentIdentifier);

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = (session.agent_provider || agentGroup.agent_provider || 'claude').toLowerCase();
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Pulling in upstream
  // built-in skill or agent-runner source updates is an explicit operation
  // (host-mediated tools), not something the spawn path does silently.
  initGroupFilesystem(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Global memory directory — always read-only. Edits to global config
  // happen through the approval flow, not by handing one workspace RW.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skills — initialized once at group creation, persistent thereafter)
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  const settingsFile = path.join(claudeDir, 'settings.json');

  // Dashboard hook injection (port comes from config/.env)
  const dashboardPort = DASHBOARD_PORT ? String(DASHBOARD_PORT) : '';
  if (dashboardPort) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    const hookUrl = `http://host.docker.internal:${dashboardPort}/api/hook-event`;
    if (!settings.hooks) settings.hooks = {};
    // Use command-type hooks with curl --proxy '' to bypass OneCLI HTTPS_PROXY.
    // The Claude SDK pipes hook event JSON to stdin; curl reads it via $(cat).
    const hookConfig = {
      hooks: [
        {
          type: 'command',
          command: `curl -sf --proxy '' -X POST ${hookUrl} -H 'Content-Type: application/json' -H 'X-Group-Folder: ${agentGroup.folder}' -d "$(cat)" > /dev/null 2>&1 || true`,
          timeout: 5,
        },
      ],
    };
    for (const event of [
      // Tool lifecycle
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'PermissionDenied',
      // Session lifecycle
      'SessionStart',
      'SessionEnd',
      'Stop',
      'StopFailure',
      // Turn lifecycle
      'UserPromptSubmit',
      'Notification',
      // Subagent lifecycle
      'SubagentStart',
      'SubagentStop',
      // Task lifecycle
      'TaskCreated',
      'TaskCompleted',
      // Context
      'PreCompact',
      'PostCompact',
      // Configuration
      'ConfigChange',
      'InstructionsLoaded',
      // File/directory
      'FileChanged',
      'CwdChanged',
      // Worktree
      'WorktreeCreate',
      'WorktreeRemove',
      // MCP
      'Elicitation',
      'ElicitationResult',
    ]) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      // Strip stale entries (old transport/http format)
      settings.hooks[event] = settings.hooks[event].filter(
        (h: { transport?: string; type?: string; url?: string }) =>
          !((h.transport || h.type === 'http') && h.url?.includes(hookUrl)),
      );
      // Dedup: check if a command hook for this URL already exists
      const hasHook = settings.hooks[event].some((h: { hooks?: { command?: string }[] }) =>
        h.hooks?.some((inner: { command?: string }) => inner.command?.includes(hookUrl)),
      );
      if (!hasHook) {
        settings.hooks[event].push(hookConfig);
      }
    }
    // Guard hook: block direct edits to CLAUDE.md — agents must edit .instructions.md instead.
    // CLAUDE.md is auto-composed from templates + .instructions.md on every container wake,
    // so direct edits are silently lost. This hook enforces the single source of truth.
    const guardCmd = `INPUT=$(cat); FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty'); if echo "$FILE" | grep -q 'CLAUDE\\.md$'; then echo "CLAUDE.md is auto-generated from templates + .instructions.md on every container start. Your edits here will be overwritten. Edit .instructions.md instead — it lives in the same directory and its contents are appended to the composed CLAUDE.md." >&2; exit 2; fi; exit 0`;
    const guardHookConfig = {
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: guardCmd, timeout: 5 }],
    };
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    const hasGuard = settings.hooks.PreToolUse.some(
      (h: { matcher?: string; hooks?: { command?: string }[] }) =>
        h.matcher === 'Edit|Write' &&
        h.hooks?.some((inner: { command?: string }) => inner.command?.includes('CLAUDE\\\\.md')),
    );
    if (!hasGuard) {
      settings.hooks.PreToolUse.push(guardHookConfig);
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Per-group agent-runner source at /app/src (initialized once at group
  // creation, persistent thereafter — agents can modify their runner)
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'agent-runner-src');
  mounts.push({ hostPath: groupRunnerDir, containerPath: '/app/src', readonly: false });

  // Additional mounts from container config (groups/<folder>/container.json)
  const containerConfig = readContainerConfig(agentGroup.folder);
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Environment
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `AGENT_PROVIDER=${provider}`);
  // Two-DB split: container reads inbound.db, writes outbound.db
  args.push('-e', 'SESSION_INBOUND_DB_PATH=/workspace/inbound.db');
  args.push('-e', 'SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db');
  args.push('-e', 'SESSION_HEARTBEAT_PATH=/workspace/.heartbeat');

  // Codex MCP support: mount host config.toml and set placeholder API key
  const codexConfigPaths = [
    path.join(process.env.HOME || '/home/ubuntu', '.codex', 'config.toml'),
    path.join(process.env.HOME || '/home/ubuntu', '.config', 'codex', 'config.toml'),
  ];
  for (const codexConfig of codexConfigPaths) {
    if (fs.existsSync(codexConfig)) {
      args.push(...readonlyMountArgs(codexConfig, '/tmp/codex-config.toml'));
      break;
    }
  }

  // Model + API routing + SDK tuning — forward host .env vars so the Claude
  // SDK inside the container talks to the right endpoint with the right model.
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ENABLE_PROMPT_CACHING_1H',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    'CODEX_PROFILE',
    'CODEX_HOME',
    'CODEX_BASE_URL',
    'CODEX_MODEL',
    'CODEX_MODEL_PROVIDER',
    'CODEX_REASONING_EFFORT',
  ]) {
    if (process.env[key]) args.push('-e', `${key}=${process.env[key]}`);
  }
  args.push('-e', 'NVIDIA_API_KEY=onecli-placeholder');
  args.push('-e', 'GH_TOKEN=placeholder');

  if (agentGroup.name) {
    args.push('-e', `NANOCLAW_ASSISTANT_NAME=${agentGroup.name}`);
  }
  args.push('-e', `NANOCLAW_AGENT_GROUP_ID=${agentGroup.id}`);
  args.push('-e', `NANOCLAW_AGENT_GROUP_NAME=${agentGroup.name}`);
  // Cap on how many pending messages reach one prompt. Accumulated context
  // (trigger=0 rows) rides along with wake-eligible rows up to this cap.
  args.push('-e', `NANOCLAW_MAX_MESSAGES_PER_PROMPT=${MAX_MESSAGES_PER_PROMPT}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Users allowed to run admin commands (e.g. /clear) inside this container.
  // Computed at wake time: owners + global admins + admins scoped to this
  // agent group. Role changes take effect on next container spawn.
  //
  // SQL inlined to keep core independent of the permissions module — we
  // guard on the `user_roles` table directly. If the permissions module
  // isn't installed, the table doesn't exist and the set stays empty; the
  // formatter treats an empty admin set as permissionless mode (every
  // sender is admin).
  const adminUserIds = new Set<string>();
  if (hasTable(getDb(), 'user_roles')) {
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
    for (const r of owners) adminUserIds.add(r.user_id);
    for (const r of globalAdmins) adminUserIds.add(r.user_id);
    for (const r of scopedAdmins) adminUserIds.add(r.user_id);
  }
  if (adminUserIds.size > 0) {
    args.push('-e', `NANOCLAW_ADMIN_USER_IDS=${Array.from(adminUserIds).join(',')}`);
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  // Must ensureAgent first for non-admin groups, otherwise applyContainerConfig
  // rejects the unknown agent identifier and returns false.
  try {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (onecliApplied) {
      log.info('OneCLI gateway applied', { containerName });
    } else {
      log.warn('OneCLI gateway not applied — container will have no credentials', { containerName });
    }
  } catch (err) {
    log.warn('OneCLI gateway error — container will have no credentials', { containerName, err });
  }

  // Bypass proxy for host-local traffic (dashboard hooks, MCP proxy)
  args.push('-e', 'NO_PROXY=host.docker.internal,localhost,127.0.0.1');
  args.push('-e', 'no_proxy=host.docker.internal,localhost,127.0.0.1');

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Pass additional MCP servers from container config (groups/<folder>/container.json)
  const containerConfig = readContainerConfig(agentGroup.folder);
  if (containerConfig.mcpServers && Object.keys(containerConfig.mcpServers).length > 0) {
    args.push('-e', `NANOCLAW_MCP_SERVERS=${JSON.stringify(containerConfig.mcpServers)}`);
  }

  // Dashboard URL
  if (DASHBOARD_PORT) {
    args.push('-e', `DASHBOARD_URL=http://host.docker.internal:${DASHBOARD_PORT}`);
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  // The image's ENTRYPOINT (tini → entrypoint.sh) handles the stdin-piped
  // invocation path; the host-spawned sessions don't need stdin because all
  // IO flows through the mounted session DBs.
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push(
    '-c',
    'if [ -f /tmp/codex-config.toml ]; then mkdir -p ~/.codex && cp /tmp/codex-config.toml ~/.codex/config.toml; fi && exec bun run /app/src/index.ts',
  );

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `nanoclaw-agent:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
