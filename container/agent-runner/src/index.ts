/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All message IO goes through the registered mailbox.
 *
 * Config:
 *   - SESSION_INBOUND_DB_PATH:  path to host-owned inbound DB (default: /workspace/inbound.db)
 *   - SESSION_OUTBOUND_DB_PATH: path to container-owned outbound DB (default: /workspace/outbound.db)
 *   - SESSION_HEARTBEAT_PATH:   heartbeat file path (default: /workspace/.heartbeat)
 *   - AGENT_PROVIDER: any registered provider name (default: claude). The
 *     set of registered providers is whatever `providers/index.ts` imports.
 *   - NANOCLAW_ASSISTANT_NAME: assistant name for transcript archiving
 *   - NANOCLAW_ADMIN_USER_IDS: comma-separated user IDs allowed to run admin commands
 *
 * Mount structure:
 *   /workspace/
 *     mailbox state     ← selected implementation
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       CLAUDE.md       ← composed project document (RO nested mount)
 *       container.json  ← per-group config (RO nested mount)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { discoverAdditionalDirectories } from './additional-directories.js';
import { refreshPrimaryClones } from './refresh-clones.js';
import { loadConfig } from './config.js';
import { buildSystemPromptAddendum, type SessionMode } from './destinations.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { appendMemorySection, memoryContextForSystemPrompt } from './memory/context.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
import { parseMcpPolicy, serverHasAllowedTools } from './mcp-policy.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createCodexConfigOverrides } from './providers/codex-app-server.js';
import { createProvider } from './providers/factory.js';
import { parseAllowedMcpTools } from './providers/claude.js';
// Provider-contracts barrel — each provider's runtime contract attaches to its
// registration on import. Provider skills append imports to
// provider-contracts/index.ts alongside the providers barrel line.
import './provider-contracts/index.js';
import { registerProviderMemorySessionHook } from './provider-contracts/realize.js';
import { getProviderRuntimeContract, requireProviderName } from './providers/provider-registry.js';
import { resolvePluginServer } from './plugin-mcp.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  // Load /workspace/agent/container.json once at startup. Without this call,
  // getConfig() throws on first read, leaving features like maxMessagesPerPrompt
  // stuck on the hardcoded fallback. Safe to call multiple times (memoized).
  const config = loadConfig();

  // AGENT_PROVIDER (env) still wins over container.json on this fork.
  // requireProviderName lowercases and asserts the provider is registered.
  const providerName = requireProviderName(process.env.AGENT_PROVIDER || config.provider || 'claude');
  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME || config.assistantName || undefined;

  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Every provider shares one persistent memory tree, scaffolded (idempotently)
  // in the agent's host-backed workspace. Before the addendum, because the
  // memory fallback below reads the tree it creates.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity (name) plus the
  // live destinations map and session-mode (chat vs isolated task run).
  // Everything else lives in CLAUDE.md, loaded natively by Claude Code from the
  // filesystem; Codex loads it in its own provider (codex.ts:composeBaseInstructions).
  // index.ts only provides this routing addendum — CLAUDE.md ownership lives in
  // the provider. Per-group memory lives in CLAUDE.local.md (auto-loaded).
  const taskId = getTaskSeriesId();
  const sessionMode: SessionMode = taskId ? { kind: 'task', taskId } : { kind: 'chat' };
  const buildInstructions = (): string => buildSystemPromptAddendum(config.assistantName || undefined, sessionMode);

  // Discover additional directories: /workspace/extra/* (host-mounted) and
  // /workspace/agent/* subdirs with their own .claude/ (cloned repos), skipping
  // linked git worktrees so a repo's .claude/ isn't registered once per worktree
  // (that duplication thrashes the context window — see the helper's doc).
  const additionalDirectories = discoverAdditionalDirectories(['/workspace/extra', CWD], CWD);
  if (additionalDirectories.length > 0) {
    log(`Additional directories: ${additionalDirectories.join(', ')}`);
  }

  // Keep the primary clones fresh before we load their .claude/ + CLAUDE.md and
  // before any worktree is branched off them. Fast-forward only (never merge,
  // rebase, or reset — the clone is shared across all group sessions), guarded
  // by a per-clone lock plus a recency check re-taken inside that lock so a
  // group-restart's simultaneous boots don't storm the remote, and best-effort
  // (never blocks boot). See refresh-clones.ts.
  refreshPrimaryClones(additionalDirectories, { log });

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + codex stdio child + any
  // additional from host. The codex entry runs the local codex CLI as an
  // MCP child process so it can read /workspace/agent files directly when
  // it reviews. Routing/auth come from `-c` overrides built from container
  // env vars — no ~/.codex/config.toml file is needed.
  const codexArgs: string[] = [];
  for (const override of createCodexConfigOverrides()) {
    codexArgs.push('-c', override);
  }
  codexArgs.push('mcp-server');
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {
        SESSION_INBOUND_DB_PATH: process.env.SESSION_INBOUND_DB_PATH || '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: process.env.SESSION_OUTBOUND_DB_PATH || '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: process.env.SESSION_HEARTBEAT_PATH || '/workspace/.heartbeat',
        // The SDK spawns MCP children with a LITERAL env map — nothing is
        // inherited — so the policy has to be forwarded by name here or the
        // built-in server boots with no policy and (correctly, but uselessly)
        // denies everything but the transport floor.
        NANOCLAW_MCP_POLICY: process.env.NANOCLAW_MCP_POLICY || '',
      },
    },
    codex: {
      command: 'codex',
      args: codexArgs,
      // Env for the `codex mcp-server` subprocess.
      //
      // Two mechanisms to get variables to the child:
      //   1. `env` — literal key=value pairs, serialized verbatim into
      //      `[mcp_servers.codex.env]` in ~/.codex/config.toml.
      //      Used ONLY for non-secret, non-sensitive values (HOME, PATH).
      //   2. `envInherit` — names-only allowlist, serialized as
      //      `env_vars = [...]`. codex-cli resolves each name from its
      //      own process env at subprocess spawn time — values never
      //      reach disk. Used for anything derived from OneCLI/secrets
      //      (proxy token in HTTPS_PROXY authority, NVIDIA_API_KEY).
      //
      // Why NVIDIA_API_KEY has to be forwarded at all — even though
      // OneCLI handles auth transparently:
      //
      // OneCLI's HTTPS proxy DOES swap secrets transparently at the TLS
      // layer (the value in container env is usually `onecli-placeholder`,
      // not a real token — the real secret never enters the container).
      // BUT codex-cli validates `model_providers.<p>.env_key` at SESSION
      // START — before any HTTP call is attempted. If the named env var
      // is undefined it errors `Missing environment variable: NVIDIA_API_KEY`
      // and the subprocess exits before OneCLI gets a chance to inject.
      // The var must therefore be *defined* in the child env (placeholder
      // is fine); OneCLI rewrites the Authorization header on the way out.
      //
      // Verified empirically 2026-05-07 via `codex exec` A/B test:
      //   - without the var → codex errors at startup
      //   - with `onecli-placeholder` → request reaches nvinference, OneCLI
      //     swaps credentials, succeeds.
      //
      // envInherit forwards by NAME only, so even if the host passes a
      // real NVIDIA_API_KEY (uncommon), it never lands in TOML.
      // OPENAI_API_KEY is intentionally NOT forwarded — codex is routed
      // through nvinference per the deployment's credential policy.
      env: {
        HOME: process.env.HOME ?? '/home/node',
        PATH: process.env.PATH ?? '',
      },
      envInherit: [
        'NVIDIA_API_KEY',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NO_PROXY',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'NODE_EXTRA_CA_CERTS',
      ],
    },
  };

  // The spawn-time MCP policy. Read BEFORE any server is wired, because the
  // first line of enforcement is not wiring a server the policy allows nothing
  // on: a direct stdio server that was never started has no tools to deny, and
  // no wildcard-matching semantics have to be trusted to keep it that way.
  //
  // `codex` is the case that motivated this. It is a direct child process, so
  // the host MCP proxy — which used to be the ONLY thing the allow-list
  // actually configured — could never see, let alone block, a call to it.
  const mcpPolicy = parseMcpPolicy(process.env as Record<string, string | undefined>);
  log(
    mcpPolicy.restrict
      ? `MCP policy: explicit external allow-list (${mcpPolicy.origin}) — ${mcpPolicy.tools.length} tool(s); servers outside it will not be wired`
      : `MCP policy: no external restrictions (${mcpPolicy.origin})`,
  );

  // Merge additional MCP servers from host configuration
  if (process.env.NANOCLAW_MCP_SERVERS) {
    try {
      const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      >;
      for (const [name, config] of Object.entries(additional)) {
        mcpServers[name] = config;
        log(`Additional MCP server: ${name} (${config.command})`);
      }
    } catch (e) {
      log(`Failed to parse NANOCLAW_MCP_SERVERS: ${e}`);
    }
  }

  // Additional MCP servers from container.json (per-instance subset). Runs
  // alongside the NANOCLAW_MCP_SERVERS loop above, which is the only transport
  // for type-level coworker-registry servers — neither replaces the other.
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    // Plugin-shipped servers get ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion and
    // the two injected env vars; everything else passes through untouched.
    mcpServers[name] = resolvePluginServer(serverConfig);
    log(
      serverConfig.type === 'http'
        ? `Additional MCP server: ${name} (HTTP)`
        : `Additional MCP server: ${name} (${serverConfig.command})`,
    );
  }

  // MCP proxy integration: add proxy-connected servers for allowed MCP tools
  const allowedMcpTools = parseAllowedMcpTools(process.env as Record<string, string | undefined>);
  if (allowedMcpTools.length > 0 && process.env.MCP_PROXY_URL) {
    log(
      'Using legacy MCP proxy auto-discovery from allowed tool names; prefer explicit NANOCLAW_MCP_SERVERS provisioning for HTTP MCP servers.',
    );
    // Derive which MCP servers to connect based on allowed tool prefixes
    const neededServers = new Set<string>();
    for (const tool of allowedMcpTools) {
      // Split on __ delimiter: mcp__<server>__<tool>
      const parts = tool.split('__');
      if (parts.length >= 3 && parts[0] === 'mcp' && parts[1] !== 'nanoclaw') {
        neededServers.add(parts[1]);
      }
    }

    for (const serverName of neededServers) {
      // Don't overwrite a server that's already wired (e.g. the hardcoded
      // codex stdio entry above). Auto-discovery only fills in proxy-routed
      // servers we haven't already provisioned explicitly.
      if (mcpServers[serverName]) continue;
      const baseUrl = process.env.MCP_PROXY_URL!.replace(/\/$/, '');
      const serverUrl = `${baseUrl}/mcp/${serverName}`;
      const serverConfig: Record<string, unknown> = {
        type: 'http',
        url: serverUrl,
      };
      const headers: Record<string, string> = {
        Accept: 'application/json, text/event-stream',
      };
      if (process.env.MCP_PROXY_TOKEN) {
        // Claude SDK-native: plaintext Authorization header
        headers.Authorization = `Bearer ${process.env.MCP_PROXY_TOKEN}`;
        // Codex-friendly: env-var indirection so the token isn't written
        // into ~/.codex/config.toml as plaintext. Codex emits
        // `bearer_token_env_var = "MCP_PROXY_TOKEN"` and reads from the
        // subprocess env (forwarded below) at request time.
        serverConfig.bearerTokenEnvVar = 'MCP_PROXY_TOKEN';
      }
      serverConfig.headers = headers;
      mcpServers[serverName] = serverConfig as any;
      log(`MCP proxy server: ${serverName} via ${serverUrl}`);
    }
  }

  // Drop every server the policy allows no tool on. `nanoclaw` is exempt: it
  // carries the mandatory message transport, so it is always wired and instead
  // filters itself per-tool (see mcp-tools/server.ts). Everything else — the
  // codex stdio child included — simply does not exist for this session.
  for (const name of Object.keys(mcpServers)) {
    if (name === 'nanoclaw') continue;
    if (!serverHasAllowedTools(mcpPolicy, name)) {
      delete mcpServers[name];
      log(`MCP server "${name}" withheld — the explicit allow-list names no tool on it`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
    fallbackModel: config.fallbackModel,
    speed: config.speed,
  });

  // Wire the shared memory tree into the provider's native session-start
  // mechanism. Only Claude Code has one; the rest report false and get the
  // section in the system prompt instead, so `container/CLAUDE.md`'s promise
  // that memory arrives in context holds for every provider. Registration goes
  // through the contract helper so the memory capability is resolved too.
  const needsMemoryInPrompt = !registerProviderMemorySessionHook(providerName, provider, MEMORY_SESSION_HOOK);
  if (needsMemoryInPrompt) log(`Memory delivered via system prompt (${providerName} has no session-start hook)`);

  // Re-read on every rebuild rather than caching a boot-time copy: the agent
  // edits its own memory during the session, and this string outlives the
  // container's whole life.
  const rebuild = (): string =>
    needsMemoryInPrompt
      ? appendMemorySection(buildInstructions(), memoryContextForSystemPrompt(CWD))
      : buildInstructions();
  try {
    await runPollLoop({
      provider,
      providerContract: getProviderRuntimeContract(providerName),
      providerName,
      cwd: CWD,
      systemContext: { instructions: rebuild(), rebuild },
    });
  } finally {
    await mailbox.stop();
  }
}

// Only auto-run when invoked as the entrypoint — not when imported (e.g. by
// tests that exercise the pure helpers above without booting the poll loop).
if (import.meta.main) {
  main().catch((err) => {
    log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
