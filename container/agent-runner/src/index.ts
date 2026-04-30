/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
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
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, skills, working files)
 *     .claude/          ← Claude SDK session data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createCodexConfigOverrides } from './providers/codex-app-server.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { parseAllowedMcpTools } from './providers/claude.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const providerName = (process.env.AGENT_PROVIDER || 'claude').toLowerCase() as ProviderName;
  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME;
  const adminUserIds = new Set(
    (process.env.NANOCLAW_ADMIN_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Build the system context instructions.
  // Claude Code loads CLAUDE.md natively from the filesystem; Codex loads it
  // in its own provider (codex.ts:composeBaseInstructions). index.ts only
  // provides the routing addendum — CLAUDE.md ownership lives in the provider.
  const instructions = buildSystemPromptAddendum();

  // Discover additional directories: /workspace/extra/* (host-mounted)
  // and /workspace/agent/* subdirs that have their own .claude/ config
  // (e.g. cloned repos with skills/commands/CLAUDE.md).
  const additionalDirectories: string[] = [];
  for (const base of ['/workspace/extra', CWD]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const fullPath = path.join(base, entry);
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue;
      } catch { continue; }
      // For CWD subdirs, only include if they have .claude/ (skills, commands, CLAUDE.md)
      if (base === CWD) {
        if (!fs.existsSync(path.join(fullPath, '.claude'))) continue;
      }
      additionalDirectories.push(fullPath);
    }
  }
  if (additionalDirectories.length > 0) {
    log(`Additional directories: ${additionalDirectories.join(', ')}`);
  }

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
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {
        SESSION_INBOUND_DB_PATH: process.env.SESSION_INBOUND_DB_PATH || '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: process.env.SESSION_OUTBOUND_DB_PATH || '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: process.env.SESSION_HEARTBEAT_PATH || '/workspace/.heartbeat',
      },
    },
    codex: {
      command: 'codex',
      args: codexArgs,
      env: {},
    },
  };

  // Merge additional MCP servers from host configuration
  if (process.env.NANOCLAW_MCP_SERVERS) {
    try {
      const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      for (const [name, config] of Object.entries(additional)) {
        mcpServers[name] = config;
        log(`Additional MCP server: ${name} (${config.command})`);
      }
    } catch (e) {
      log(`Failed to parse NANOCLAW_MCP_SERVERS: ${e}`);
    }
  }

  // MCP proxy integration: add proxy-connected servers for allowed MCP tools
  const allowedMcpTools = parseAllowedMcpTools(process.env as Record<string, string | undefined>);
  if (allowedMcpTools.length > 0 && process.env.MCP_PROXY_URL) {
    log('Using legacy MCP proxy auto-discovery from allowed tool names; prefer explicit NANOCLAW_MCP_SERVERS provisioning for HTTP MCP servers.');
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
        headers.Authorization = `Bearer ${process.env.MCP_PROXY_TOKEN}`;
      }
      serverConfig.headers = headers;
      mcpServers[serverName] = serverConfig as any;
      log(`MCP proxy server: ${serverName} via ${serverUrl}`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    adminUserIds,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
