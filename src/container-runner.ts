/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import yaml from 'js-yaml';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_PREFIX,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MCP_PROXY_PORT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  gpuArgs,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  getDiscoveredToolInventory,
  registerContainerToken,
  revokeContainerToken,
} from './mcp-auth-proxy.js';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

interface ManifestConfig {
  base: string;
  sections: string[];
  project_overlays: boolean;
}

/**
 * Compose a CLAUDE.md from a YAML manifest.
 * Layers: upstream base -> platform sections -> project overlays -> role templates
 */
function composeClaudeMd(
  templatesDir: string,
  manifestName: string,
  group: RegisteredGroup,
  projectRoot: string,
): string {
  const manifestPath = path.join(
    templatesDir,
    'manifests',
    `${manifestName}.yaml`,
  );
  const manifest = yaml.load(
    fs.readFileSync(manifestPath, 'utf-8'),
  ) as ManifestConfig;

  // Layer 0: upstream base
  const basePath =
    manifest.base === 'upstream-main'
      ? path.join(projectRoot, 'groups', 'main', 'CLAUDE.md')
      : path.join(projectRoot, 'groups', 'global', 'CLAUDE.md');
  let composed = fs.readFileSync(basePath, 'utf-8');

  // Layer 1: platform sections
  for (const section of manifest.sections || []) {
    const sectionPath = path.join(templatesDir, 'sections', `${section}.md`);
    if (fs.existsSync(sectionPath)) {
      composed += `\n\n---\n\n${fs.readFileSync(sectionPath, 'utf-8')}`;
    }
  }

  // Layer 2: project overlays
  if (manifest.project_overlays) {
    const projectsDir = path.join(templatesDir, 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const proj of fs.readdirSync(projectsDir).sort()) {
        const projDir = path.join(projectsDir, proj);
        if (!fs.statSync(projDir).isDirectory()) continue;
        if (manifestName === 'coworker') {
          const f = path.join(projDir, 'coworker-base.md');
          if (fs.existsSync(f)) {
            composed += `\n\n---\n\n${fs.readFileSync(f, 'utf-8')}`;
          }
        } else {
          const f = path.join(projDir, `${manifestName}-overlay.md`);
          if (fs.existsSync(f)) {
            composed += `\n\n---\n\n${fs.readFileSync(f, 'utf-8')}`;
          }
        }
      }
    }
  }

  // Layer 3: role templates (typed coworkers only)
  if (group.coworkerType) {
    try {
      const types = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, 'groups', 'coworker-types.json'),
          'utf-8',
        ),
      );
      for (const role of group.coworkerType.split('+')) {
        const entry = types[role.trim()];
        const templates = Array.isArray(entry?.template)
          ? entry.template
          : entry?.template
            ? [entry.template]
            : [];
        for (const tpl of templates) {
          try {
            composed += `\n\n---\n\n${fs.readFileSync(path.resolve(projectRoot, tpl), 'utf-8')}`;
          } catch {
            /* template missing */
          }
        }
        const focusFiles: string[] | undefined = entry?.focusFiles;
        if (focusFiles && focusFiles.length > 0) {
          composed += `\n\n## Priority Files\n\nFocus your work on these paths first:\n`;
          for (const f of focusFiles) composed += `- \`${f}\`\n`;
        }
      }
    } catch {
      /* coworker-types.json missing */
    }
  }

  return composed;
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  allowedMcpTools?: string[];
  /** Full MCP tool inventory (auto-discovered). Agent-runner uses this to build disallowedTools. */
  mcpToolInventory?: Record<string, string[]>;
  /** Skip initial query, go straight to IPC polling. Used for interactive resume. */
  interactive?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const managedEnv: Record<string, string> = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    NANOCLAW_GROUP_FOLDER: group.folder,
  };

  // Dashboard integration: only if the dashboard skill is installed
  const dashboardInstalled = fs.existsSync(
    path.join(process.cwd(), 'dashboard', 'server.ts'),
  );
  if (dashboardInstalled) {
    const dashboardPort = process.env.DASHBOARD_PORT || '3737';
    managedEnv.DASHBOARD_URL = `http://${CONTAINER_HOST_GATEWAY}:${dashboardPort}`;
  }

  // Read existing settings to preserve user-added keys
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    /* file missing or invalid — start fresh */
  }

  // Merge env: NanoClaw-managed keys override, user keys preserved
  const mergedEnv = { ...(existing.env || {}), ...managedEnv };

  // Merge hooks: if dashboard is installed, set up HTTP hooks to POST events.
  // Claude Code sends the full event JSON as the POST body. The group folder is
  // passed via X-Group-Folder header (interpolated from env var at hook runtime).
  let mergedHooks = existing.hooks || {};
  // Always clean stale NanoClaw hooks (even if dashboard was uninstalled)
  for (const event of Object.keys(mergedHooks)) {
    const existingList: { hooks?: any[]; command?: string }[] =
      mergedHooks[event] || [];
    mergedHooks[event] = existingList.filter((h) => {
      if (h.command && h.command.includes('notify-dashboard.sh')) return false;
      if (
        h.hooks &&
        h.hooks.some(
          (inner: any) =>
            (inner.type === 'http' &&
              inner.url &&
              inner.url.includes('/api/hook-event')) ||
            (inner.type === 'command' &&
              inner.command &&
              inner.command.includes('/api/hook-event')),
        )
      )
        return false;
      return true;
    });
  }
  if (dashboardInstalled) {
    const dashboardPort = process.env.DASHBOARD_PORT || '3737';
    const hookEvents = [
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'Notification',
      'UserPromptSubmit',
      'PermissionRequest',
      'SubagentStart',
      'SubagentStop',
      'TaskCompleted',
      'TeammateIdle',
      'PreCompact',
      'PostCompact',
      'InstructionsLoaded',
    ];
    for (const event of hookEvents) {
      const userHooks = mergedHooks[event] || [];
      mergedHooks[event] = [
        {
          hooks: [
            {
              type: 'command',
              // Use curl instead of type:"http" because OneCLI injects
              // HTTP_PROXY+NODE_USE_ENV_PROXY=1 which Claude Code's hook client
              // routes through, ignoring NO_PROXY → "Protocol http: not supported".
              // --proxy '' bypasses proxy; $(cat) reads hook JSON from stdin.
              // socat inside the container forwards 127.0.0.1:PORT → host gateway.
              command: `curl -sf --proxy '' -X POST http://127.0.0.1:${dashboardPort}/api/hook-event -H 'Content-Type: application/json' -H "X-Group-Folder: $NANOCLAW_GROUP_FOLDER" -d "$(cat)" > /dev/null 2>&1 || true`,
              timeout: 5,
            },
          ],
        },
        ...userHooks,
      ];
    }
  }

  const settings: Record<string, unknown> = {
    ...existing,
    env: mergedEnv,
    hooks: mergedHooks,
    // Auto-approve all tools so subagents (agent teams) don't hang waiting for TTY approval
    permissions: existing.permissions || {
      allow: [
        'Bash(*)',
        'Read(*)',
        'Write(*)',
        'Edit(*)',
        'Glob(*)',
        'Grep(*)',
        'WebFetch(*)',
        'mcp__*',
      ],
      deny: [],
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  // Sync skills from container/skills/ into each group's .claude/skills/
  // Clean stale dirs first (e.g., after skill renames) then copy fresh
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    const srcDirs = new Set(
      fs
        .readdirSync(skillsSrc)
        .filter((d) => fs.statSync(path.join(skillsSrc, d)).isDirectory()),
    );
    if (fs.existsSync(skillsDst)) {
      for (const existing of fs.readdirSync(skillsDst)) {
        if (!srcDirs.has(existing)) {
          fs.rmSync(path.join(skillsDst, existing), {
            recursive: true,
            force: true,
          });
        }
      }
    }
    for (const skillDir of srcDirs) {
      fs.cpSync(
        path.join(skillsSrc, skillDir),
        path.join(skillsDst, skillDir),
        { recursive: true },
      );
    }
  }

  // Compose CLAUDE.md from manifest at every startup (keeps templates fresh).
  // Uses groups/templates/ system: upstream base -> platform sections -> project overlays -> role templates
  {
    const projectRoot = process.cwd();
    const templatesDir = path.join(projectRoot, 'groups', 'templates');
    const claudeMd = path.join(groupDir, 'CLAUDE.md');

    // Determine which manifest to use
    const manifestName = isMain
      ? 'main'
      : group.coworkerType
        ? 'coworker'
        : null; // static coworkers keep their hand-edited CLAUDE.md

    if (
      manifestName &&
      fs.existsSync(
        path.join(templatesDir, 'manifests', `${manifestName}.yaml`),
      )
    ) {
      try {
        const composed = composeClaudeMd(
          templatesDir,
          manifestName,
          group,
          projectRoot,
        );
        fs.writeFileSync(claudeMd, composed);
        logger.debug(
          {
            folder: group.folder,
            manifest: manifestName,
            coworkerType: group.coworkerType,
          },
          'Composed CLAUDE.md from manifest',
        );
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to compose CLAUDE.md from manifest',
        );
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Sync agent-runner source into a per-group writable location.
  // Copied fresh on every startup to pick up code changes (e.g. MCP tool enforcement).
  // Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Copy fresh on every startup to pick up code changes (e.g. MCP tool enforcement).
    // Recompiled on container startup via entrypoint.sh.
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Mount subagent definitions if provided by the active skill
  const subagentsConfig = path.join(
    projectRoot,
    'container',
    'config',
    'subagents.json',
  );
  if (fs.existsSync(subagentsConfig)) {
    mounts.push({
      hostPath: subagentsConfig,
      containerPath: '/workspace/config/subagents.json',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  groupFolder: string,
  allowedMcpTools: string[],
  agentIdentifier?: string,
): Promise<{ args: string[]; mcpToken: string | null }> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_GROUP_FOLDER=${groupFolder}`);
  args.push('-e', `NANOCLAW_HOST_GATEWAY=${CONTAINER_HOST_GATEWAY}`);

  // Dashboard env vars — only if the dashboard skill is installed
  const dashboardInstalled = fs.existsSync(
    path.join(process.cwd(), 'dashboard', 'server.ts'),
  );
  if (dashboardInstalled) {
    const dashboardPort = process.env.DASHBOARD_PORT || '3737';
    args.push(
      '-e',
      `DASHBOARD_URL=http://${CONTAINER_HOST_GATEWAY}:${dashboardPort}`,
    );
    // socat proxy needs these to forward 127.0.0.1:PORT → host gateway:PORT
    args.push('-e', `NANOCLAW_DASHBOARD_PORT=${dashboardPort}`);
  }

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
  }

  // GH_TOKEN placeholder — gh CLI refuses to run without it, but the real token
  // is injected by OneCLI's MITM proxy for api.github.com requests.
  args.push('-e', 'GH_TOKEN=placeholder');

  // Pass MCP proxy URL so containers connect via authenticated SSE proxy
  const mcpProxyPort = String(MCP_PROXY_PORT);
  args.push(
    '-e',
    `MCP_PROXY_URL=http://${CONTAINER_HOST_GATEWAY}:${mcpProxyPort}/mcp`,
  );

  // Generate a per-container token for MCP auth proxy (tool-level ACL)
  let mcpToken: string | null = null;
  if (allowedMcpTools.length > 0) {
    mcpToken = registerContainerToken(groupFolder, allowedMcpTools);
    args.push('-e', `MCP_PROXY_TOKEN=${mcpToken}`);
  }

  // Exclude internal hosts from OneCLI's HTTP proxy so MCP and dashboard
  // connections go direct instead of through the MITM gateway.
  args.push(
    '-e',
    `NO_PROXY=${CONTAINER_HOST_GATEWAY},host.docker.internal,127.0.0.1,localhost`,
  );
  args.push(
    '-e',
    `no_proxy=${CONTAINER_HOST_GATEWAY},host.docker.internal,127.0.0.1,localhost`,
  );

  // Pass model overrides and SDK config so the container uses the same settings as the host
  const passthroughEnvVars = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  ];
  const passthroughFromFile = readEnvFile(passthroughEnvVars);
  for (const key of passthroughEnvVars) {
    const val = process.env[key] || passthroughFromFile[key];
    if (val) args.push('-e', `${key}=${val}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Pass GPU access to containers when NVIDIA runtime is available
  args.push(...gpuArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return { args, mcpToken };
}

/**
 * Resolve which MCP tools a coworker is allowed to use.
 * Priority: group.allowedMcpTools (DB) > coworker-types.json > base tier defaults.
 * mcp__nanoclaw__* is always added by the agent-runner, not here.
 */
function resolveAllowedMcpTools(
  group: RegisteredGroup,
  isMain: boolean,
): string[] | undefined {
  // If explicitly set on the group (custom coworker or DB override), use it
  if (group.allowedMcpTools && group.allowedMcpTools.length > 0) {
    return group.allowedMcpTools;
  }

  // If typed coworker, look up from coworker-types.json
  if (group.coworkerType) {
    try {
      const typesPath = path.join(
        process.cwd(),
        'groups',
        'coworker-types.json',
      );
      const types = JSON.parse(fs.readFileSync(typesPath, 'utf-8'));
      const entry = types[group.coworkerType];
      if (entry?.allowedMcpTools) {
        return entry.allowedMcpTools;
      }
    } catch {
      /* coworker-types.json missing or invalid */
    }
  }

  // Default MCP tools — configurable via env, empty by default (skill-neutral)
  const raw = process.env.DEFAULT_MCP_TOOLS || '';
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  // Resolve MCP tool permissions and inject into input
  if (!input.allowedMcpTools) {
    input.allowedMcpTools = resolveAllowedMcpTools(group, input.isMain);
  }

  // Inject auto-discovered tool inventory so agent-runner can build disallowedTools
  // without maintaining a hardcoded list.
  input.mcpToolInventory = getDiscoveredToolInventory();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `${CONTAINER_PREFIX}-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const { args: containerArgs, mcpToken } = await buildContainerArgs(
    mounts,
    containerName,
    group.folder,
    input.allowedMcpTools || [],
    agentIdentifier,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs
        .join(' ')
        .replace(/MCP_PROXY_TOKEN=[^\s]+/, 'MCP_PROXY_TOKEN=<redacted>'),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { group: group.name, error: err },
                  'onOutput callback failed — continuing chain',
                );
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Absolute lifetime cap — container cannot live longer than this regardless of activity.
    // 3x the configured timeout, minimum 1 hour.
    const absoluteMaxMs = Math.max(configTimeout * 3, 3_600_000);
    const absoluteTimeout = setTimeout(() => {
      logger.warn(
        { group: group.name, containerName, absoluteMaxMs },
        'Container hit absolute lifetime cap, killing',
      );
      killOnTimeout();
    }, absoluteMaxMs);

    // Reset the idle timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(absoluteTimeout);
      if (mcpToken) revokeContainerToken(mcpToken);
      const duration = Date.now() - startTime;

      // Notify dashboard that this container has stopped so status flips to idle.
      // Only if dashboard is installed. The SDK may not fire SessionEnd/Stop
      // on kill/timeout, so we send it from the host.
      if (fs.existsSync(path.join(process.cwd(), 'dashboard', 'server.ts'))) {
        const dashPort = process.env.DASHBOARD_PORT || '3737';
        const body = JSON.stringify({
          event: 'SessionEnd',
          session_id: input.sessionId || '',
          timestamp: new Date().toISOString(),
        });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: parseInt(dashPort, 10),
            path: '/api/hook-event',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Group-Folder': group.folder,
              'Content-Length': Buffer.byteLength(body),
            },
          },
          () => {},
        );
        req.on('error', () => {});
        req.end(body);
      }

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            })
            .catch(() => {
              resolve({ status: 'success', result: null, newSessionId });
            });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs
            .join(' ')
            .replace(/MCP_PROXY_TOKEN=[^\s]+/, 'MCP_PROXY_TOKEN=<redacted>'),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain
          .then(() => {
            logger.info(
              { group: group.name, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          })
          .catch(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
