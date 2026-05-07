/**
 * Codex app-server JSON-RPC transport primitives.
 *
 * Communicates with `codex app-server` over stdio. This module is just the
 * plumbing — spawn the process, send requests, dispatch responses and
 * notifications. Higher-level semantics (threads, turns, event translation)
 * live in codex.ts.
 *
 * Kept separate so the transport can be unit-tested without pulling in the
 * full provider and so any future Codex tooling (e.g. a CLI for manual
 * debugging) can reuse the same primitives.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

function log(msg: string): void {
  console.error(`[codex-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

/**
 * Errors from `thread/resume` that indicate the thread ID is unusable —
 * typically because the app-server has no memory of it (thread transcript
 * was deleted, server was wiped, ID is from a different codex version).
 * Only errors matching this pattern trigger silent fallback to a fresh
 * thread; everything else bubbles up so the caller can decide what to do.
 *
 * Shared with `codex.ts`'s `isSessionInvalid` to keep the two detection
 * paths in sync.
 */
export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

/**
 * Escape a string for emission inside a TOML basic string (double-quoted).
 * Handles `"` and `\`. Rejects newlines: basic strings can't contain raw
 * newlines, and silently converting them to `\n` would mask misconfiguration
 * (e.g. a secret pasted with a trailing newline). Multiline strings are
 * unsupported for `config.toml` use here.
 */
export function tomlBasicString(value: string): string {
  if (value == null) return '""';
  if (typeof value !== 'string') value = String(value);
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── JSON-RPC types ──────────────────────────────────────────────────────────

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ── App-server handle ───────────────────────────────────────────────────────

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export function spawnCodexAppServer(configOverrides: string[] = []): AppServer {
  const args = ['app-server', '--listen', 'stdio://'];
  for (const override of configOverrides) args.push('-c', override);

  log(`Spawning: codex ${args.join(' ')}`);
  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendCodexRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCodexResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killCodexAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

// ── Workflow state (hook parity) ────────────────────────────────────────────
// Claude SDK fires hooks (plan-gate, edit-counter, critique-tracker, etc.)
// via settings.json PreToolUse/PostToolUse events. Codex has no hook system,
// so we replicate the same enforcement by intercepting approval requests
// (≈ PreToolUse) and completion notifications (≈ PostToolUse).

const STATE_PATH = '/workspace/.claude/workflow-state.json';
const PLAN_EDIT_LIMIT = 15;
const CRITIQUE_EDIT_LIMIT = 3;

const BOOKKEEPING_PATTERNS = [
  '/workspace/agent/plans/',
  '/workspace/agent/reports/',
  '/workspace/agent/critiques/',
  '/workspace/agent/memory/',
  '/workspace/agent/conversations/',
  'CLAUDE.local.md',
  '.claude/',
];

interface WorkflowState {
  task_id: string;
  plan_written: boolean;
  plan_stale: boolean;
  edits_since_plan: number;
  edits_since_critique: number;
  critique_rounds: number;
  critique_recorded_for_round: number;
  critique_required: boolean;
  last_activity: string;
}

function readState(): WorkflowState {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch { /* corrupt — reset */ }
  const fresh: WorkflowState = {
    task_id: `task-${Date.now()}`,
    plan_written: false,
    plan_stale: false,
    edits_since_plan: 0,
    edits_since_critique: 0,
    critique_rounds: 0,
    critique_recorded_for_round: 0,
    critique_required: false,
    last_activity: new Date().toISOString(),
  };
  writeState(fresh);
  return fresh;
}

function writeState(state: WorkflowState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`[hooks] Failed to write workflow state: ${err}`);
  }
}

function isBookkeeping(filePath: string): boolean {
  return BOOKKEEPING_PATTERNS.some((p) => filePath.includes(p));
}

export interface HookConfig {
  hasPlan: boolean;
  hasCritique: boolean;
}

// ── Auto-approval with workflow hooks ──────────────────────────────────────
// The container sandbox is the security boundary. Inside it, we enforce
// workflow discipline (plan gates, critique tracking, edit counting) before
// approving file changes — mirroring the shell hooks Claude SDK fires.

export function attachCodexAutoApproval(server: AppServer, hookConfig?: HookConfig): void {
  const hasPlan = hookConfig?.hasPlan ?? (process.env.OVERLAY_HAS_PLAN === '1');
  const hasCritique = hookConfig?.hasCritique ?? (process.env.OVERLAY_HAS_CRITIQUE === '1');

  server.serverRequestHandlers.push((req) => {
    const method = req.method;
    log(`[approval] ${method}`);

    switch (method) {
      case 'item/fileChange/requestApproval': {
        const params = req.params as { path?: string } | undefined;
        const filePath = params?.path || '';

        if (!isBookkeeping(filePath)) {
          const state = readState();

          // Plan gate: block edits if no plan written (or plan stale)
          if (hasPlan && !state.plan_written) {
            log(`[hooks] Plan gate: blocking edit to ${filePath} — no plan written`);
            sendCodexResponse(server, req.id, {
              decision: 'reject',
              reason: 'Write a plan to /workspace/agent/reports/ before editing source files.',
            });
            return;
          }
          if (hasPlan && state.plan_stale) {
            log(`[hooks] Plan gate: blocking edit to ${filePath} — plan stale (${state.edits_since_plan} edits)`);
            sendCodexResponse(server, req.id, {
              decision: 'reject',
              reason: `Plan is stale (${state.edits_since_plan} edits since last plan). Write an updated plan to /workspace/agent/reports/ before continuing.`,
            });
            return;
          }

          // Critique-record gate: block if critique round unrecorded
          if (hasCritique && state.critique_rounds > state.critique_recorded_for_round) {
            if (!filePath.includes('/workspace/agent/critiques/')) {
              log(`[hooks] Critique-record gate: blocking edit — verdict not written for round ${state.critique_rounds}`);
              sendCodexResponse(server, req.id, {
                decision: 'reject',
                reason: `Write the critique verdict to /workspace/agent/critiques/ before editing other files (round ${state.critique_rounds} unrecorded).`,
              });
              return;
            }
          }
        }

        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
      }
      case 'item/commandExecution/requestApproval':
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
      case 'item/permissions/requestApproval':
        sendCodexResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendCodexResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/tool/call': {
        const toolName = (req.params as { tool?: string }).tool || 'unknown';
        log(`[approval] Unexpected dynamic tool call: ${toolName}`);
        sendCodexResponse(server, req.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
        });
        break;
      }
      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        sendCodexResponse(server, req.id, { input: null });
        break;
      default:
        log(`[approval] Unknown method ${method}, generic accept`);
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });

  // Post-completion hooks: track edits, plans, critiques via notifications
  if (hasPlan || hasCritique) {
    server.notificationHandlers.push((n: JsonRpcNotification) => {
      if (n.method !== 'item/completed') return;
      const item = n.params?.item as { type?: string; path?: string; text?: string } | undefined;
      if (!item) return;

      const state = readState();
      state.last_activity = new Date().toISOString();

      // File change completed — edit counter + plan/critique tracker
      if (item.type === 'fileChange' || item.type === 'applyPatch') {
        const filePath = item.path || '';

        // Plan tracker: writing to reports/ (new canonical) or plans/ (legacy) sets plan_written
        if (filePath.includes('/workspace/agent/reports/') || filePath.includes('/workspace/agent/plans/')) {
          state.plan_written = true;
          state.plan_stale = false;
          state.edits_since_plan = 0;
          log(`[hooks] Plan written: ${filePath}`);
          writeState(state);
          return;
        }

        // Critique tracker: writing to critiques/ bumps recorded round
        if (filePath.includes('/workspace/agent/critiques/')) {
          state.critique_recorded_for_round = state.critique_rounds;
          log(`[hooks] Critique recorded for round ${state.critique_rounds}`);
          writeState(state);
          return;
        }

        // Edit counter: non-bookkeeping edits
        if (!isBookkeeping(filePath)) {
          state.edits_since_plan++;
          state.edits_since_critique++;
          if (hasPlan && state.edits_since_plan >= PLAN_EDIT_LIMIT) {
            state.plan_stale = true;
          }
          if (hasCritique && state.edits_since_critique >= CRITIQUE_EDIT_LIMIT) {
            state.critique_required = true;
          }
          writeState(state);
        }
      }

      // MCP tool completed — critique round tracking
      if (item.type === 'toolCall') {
        const text = item.text || '';
        if (text.includes('mcp__codex__codex')) {
          state.critique_rounds++;
          state.edits_since_critique = 0;
          state.critique_required = false;
          log(`[hooks] Critique round ${state.critique_rounds} completed`);
          writeState(state);
        }
      }
    });
  }
}

// ── High-level helpers ──────────────────────────────────────────────────────

export async function initializeCodexAppServer(server: AppServer): Promise<void> {
  log('Sending initialize…');
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
}

export interface ThreadParams {
  model: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

/**
 * Start or resume a Codex thread. If `threadId` is provided, attempts
 * `thread/resume` first and falls back to a fresh `thread/start` on failure
 * (stale thread IDs commonly outlive containers). Returns the active thread
 * ID either way.
 */
export async function startOrResumeCodexThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  if (threadId) {
    log(`Resuming thread: ${threadId}`);
    const resp = await sendCodexRequest(server, 'thread/resume', {
      threadId,
      ...(params as unknown as Record<string, unknown>),
    });
    if (!resp.error) {
      log(`Thread resumed: ${threadId}`);
      return threadId;
    }
    // Only fall through to fresh-thread on recognized stale-thread errors.
    // Auth, version, or transient failures would otherwise silently discard
    // session state — fail loud instead so the caller can retry or surface.
    if (!STALE_THREAD_RE.test(resp.error.message)) {
      throw new Error(`thread/resume failed: ${resp.error.message}`);
    }
    log(`Stale thread ${threadId}; starting fresh thread.`);
  }

  log('Starting new thread…');
  const resp = await sendCodexRequest(server, 'thread/start', {
    ...(params as unknown as Record<string, unknown>),
  });
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  log(`New thread: ${newThreadId}`);
  return newThreadId;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  model?: string;
  cwd?: string;
}

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<void> {
  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText }],
    model: params.model,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
}

// ── MCP config.toml ─────────────────────────────────────────────────────────
// Codex discovers MCP servers by reading ~/.codex/config.toml at startup.
// We rewrite it on every spawn from whatever mcpServers the agent-runner
// passes in, so the container's config reflects the current host wiring.

/**
 * Codex MCP server config — stdio OR http.
 *
 * Codex config.toml discriminates on presence of `command` (stdio) vs `url`
 * (streamable HTTP). There is no explicit `type = "stdio"|"http"` field per
 * https://developers.openai.com/codex/config-reference.
 *
 * Accepts a superset of fields because the same record is passed to both
 * Claude and Codex providers. Claude-SDK-native fields (`type`, `headers`)
 * are accepted; codex-only fields (`bearerTokenEnvVar`, `envHttpHeaders`,
 * `httpHeaders`) win when present to keep secrets out of TOML.
 */
export type CodexMcpServer =
  | {
      /** stdio transport */
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /**
       * Names of env vars to forward to the subprocess by NAME only —
       * rendered as `env_vars = [...]`. codex-cli 0.124.0+ resolves each
       * name from the codex process's own env at spawn time, so secrets
       * (OneCLI proxy bearer in HTTPS_PROXY, NVIDIA_API_KEY) never reach
       * `~/.codex/config.toml`.
       *
       * Precedence: if a name appears in both `env` and `envInherit`, the
       * literal `env` value wins and the name is dropped from `env_vars`
       * (with a warning log). Prevents placeholder/value double-writes.
       */
      envInherit?: string[];
    }
  | {
      /** http (streamable) transport */
      type?: 'http';
      url: string;
      /**
       * Claude-SDK-native static headers. Serialized as
       * `[mcp_servers.<name>.http_headers]` EXCEPT when
       * `bearerTokenEnvVar` is also set — then the Authorization header
       * is dropped from the plaintext block (codex reads the token from
       * env at request time instead).
       */
      headers?: Record<string, string>;
      /** Preferred codex-only static headers (wins over `headers`). */
      httpHeaders?: Record<string, string>;
      /** Header-name → env-var-name. Renders as `[env_http_headers]`. */
      envHttpHeaders?: Record<string, string>;
      /** Env-var containing a bearer token. Renders as `bearer_token_env_var = "..."`. */
      bearerTokenEnvVar?: string;
    };

function isHttpServer(
  s: CodexMcpServer,
): s is Extract<CodexMcpServer, { url: string }> {
  return typeof (s as { url?: unknown }).url === 'string';
}

/**
 * Resolve `envInherit` names (e.g. HTTPS_PROXY, NVIDIA_API_KEY) against a
 * process env snapshot and merge them into a literal env map — for providers
 * that spawn MCP subprocesses directly (Claude SDK, OpenCode) and have no
 * TOML-style name indirection.
 *
 * Resolved values live ONLY in the returned Record; callers MUST pass it
 * straight to spawn/sdk-level env and must NOT serialize it to any
 * persistent config file. That would regress the "no secrets on disk"
 * invariant this whole path exists to protect.
 *
 * Mirrors the writer's duplicate-safety: a name appearing in both `env`
 * and `envInherit` is a caller bug and throws.
 */
export function resolveEnvInherit(
  config: { command: string; args?: string[]; env?: Record<string, string>; envInherit?: string[] },
  processEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  serverName = '<unnamed>',
): Record<string, string> {
  const literal = { ...(config.env ?? {}) };
  const literalKeys = new Set(Object.keys(literal));
  for (const n of config.envInherit ?? []) {
    if (literalKeys.has(n)) {
      throw new Error(
        `MCP ${serverName}: env var "${n}" appears in both env and envInherit — pick one. ` +
          `envInherit is for names-only secret forwarding (no value in TOML); ` +
          `env is for literal non-secret values.`,
      );
    }
    const v = processEnv[n];
    if (typeof v === 'string' && v.length > 0) {
      literal[n] = v;
    }
  }
  return literal;
}

export function writeCodexMcpConfigToml(
  servers: Record<string, CodexMcpServer>,
  additionalDirectories?: string[],
): void {
  const codexConfigDir = path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  // Preserve non-MCP settings (model_provider, base_url, profiles, projects)
  // from the host-mounted config that the entrypoint copied in.
  let existingNonMcp = '';
  try {
    const existing = fs.readFileSync(configTomlPath, 'utf-8');
    const filtered = existing.split('\n').filter((line) => {
      // Drop all [mcp_servers*] blocks — we'll rewrite them below.
      return true;
    });
    // Strip mcp_servers sections: everything from [mcp_servers. to the next top-level section
    const sections: string[] = [];
    let inMcp = false;
    for (const line of filtered) {
      if (/^\[mcp_servers[.\]]/.test(line)) { inMcp = true; continue; }
      if (/^\[/.test(line) && !/^\[mcp_servers/.test(line)) { inMcp = false; }
      if (!inMcp) sections.push(line);
    }
    existingNonMcp = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch { /* no existing config */ }

  const lines: string[] = [];
  if (existingNonMcp) {
    lines.push(existingNonMcp);
    lines.push('');
  }

  // Trust the agent workspace and any additional directories (cloned repos).
  // Dedupe: only append if not already present in the preserved config.
  const trustPaths = ['/workspace/agent', ...(additionalDirectories ?? [])];
  for (const trustPath of trustPaths) {
    const tomlKey = `[projects."${trustPath}"]`;
    if (existingNonMcp.includes(tomlKey)) continue;
    lines.push(tomlKey);
    lines.push('trust_level = "trusted"');
    lines.push('');
  }

  let writtenCount = 0;
  for (const [name, config] of Object.entries(servers)) {
    if (isHttpServer(config)) {
      // Streamable HTTP transport. Codex config keys:
      //   url, bearer_token_env_var, http_headers, env_http_headers
      // (per https://developers.openai.com/codex/config-reference — no
      // `type` or `[...headers]` literal keys).
      if (!config.url) {
        log(`MCP ${name}: missing url on http server spec — skipping`);
        continue;
      }
      lines.push(`[mcp_servers.${name}]`);
      lines.push(`url = ${tomlBasicString(config.url)}`);
      if (config.bearerTokenEnvVar) {
        lines.push(`bearer_token_env_var = ${tomlBasicString(config.bearerTokenEnvVar)}`);
      }
      // Effective static headers: prefer `httpHeaders`, else fall back to
      // Claude-SDK-native `headers`. When `bearerTokenEnvVar` is set,
      // strip Authorization from BOTH sources — bearer-env wins.
      const rawHeaders = config.httpHeaders ?? config.headers ?? {};
      const effectiveHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (config.bearerTokenEnvVar && key.toLowerCase() === 'authorization') continue;
        effectiveHeaders[key] = value;
      }
      if (Object.keys(effectiveHeaders).length > 0) {
        lines.push(`[mcp_servers.${name}.http_headers]`);
        for (const [key, value] of Object.entries(effectiveHeaders)) {
          lines.push(`${key} = ${tomlBasicString(value)}`);
        }
      }
      if (config.envHttpHeaders && Object.keys(config.envHttpHeaders).length > 0) {
        lines.push(`[mcp_servers.${name}.env_http_headers]`);
        for (const [key, varName] of Object.entries(config.envHttpHeaders)) {
          lines.push(`${key} = ${tomlBasicString(varName)}`);
        }
      }
      lines.push('');
      writtenCount++;
      continue;
    }
    // stdio transport
    if (!config.command) {
      log(`MCP ${name}: missing command on stdio server spec — skipping`);
      continue;
    }
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlBasicString(config.command)}`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map(tomlBasicString).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    // env_vars: names-only allowlist. codex-cli resolves each name from
    // its own process env at subprocess spawn time (no plaintext values
    // in TOML). Required for anything touching OneCLI secrets.
    // Duplicate guard: envInherit declares a name as secret-bearing, so a
    // literal value for the same name would silently re-leak under
    // [mcp_servers.<n>.env]. Any overlap is a caller bug — fail loud.
    const literalEnvKeys = new Set(config.env ? Object.keys(config.env) : []);
    const inheritNames = config.envInherit ?? [];
    for (const n of inheritNames) {
      if (literalEnvKeys.has(n)) {
        throw new Error(
          `MCP ${name}: env var "${n}" appears in both env and envInherit — pick one. ` +
            `envInherit is for names-only secret forwarding (no value in TOML); ` +
            `env is for literal non-secret values.`,
        );
      }
    }
    if (inheritNames.length > 0) {
      const namesStr = inheritNames.map(tomlBasicString).join(', ');
      lines.push(`env_vars = [${namesStr}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${tomlBasicString(value)}`);
      }
    }
    lines.push('');
    writtenCount++;
  }

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  // `writeFileSync({mode})` only applies on file creation — existing files
  // retain their prior mode. chmodSync unconditionally forces 0600.
  fs.chmodSync(configTomlPath, 0o600);
  log(`Wrote MCP config.toml (${writtenCount}/${Object.keys(servers).length} server(s), ${trustPaths.length} trusted project(s))`);
}

export function createCodexConfigOverrides(): string[] {
  const overrides = ['features.use_linux_sandbox_bwrap=false'];
  if (process.env.CODEX_MODEL) overrides.push(`model=${process.env.CODEX_MODEL}`);
  if (process.env.CODEX_MODEL_PROVIDER) {
    const p = process.env.CODEX_MODEL_PROVIDER;
    overrides.push(`model_provider=${p}`);
    // Emit the [model_providers.<p>] block fields too. Without this, codex
    // would only know the provider's *name*, not how to reach it. The values
    // come from container env vars (set on the host's docker-run -e flags),
    // so no host ~/.codex/config.toml is needed — the entire codex routing
    // configuration is derivable from .env.
    overrides.push(`model_providers.${p}.name="${p}"`);
    overrides.push(`model_providers.${p}.env_key="NVIDIA_API_KEY"`);
    if (process.env.CODEX_BASE_URL) overrides.push(`model_providers.${p}.base_url="${process.env.CODEX_BASE_URL}"`);
    if (process.env.CODEX_WIRE_API) overrides.push(`model_providers.${p}.wire_api="${process.env.CODEX_WIRE_API}"`);
    else overrides.push(`model_providers.${p}.wire_api="responses"`);
  }
  if (process.env.CODEX_REASONING_EFFORT) overrides.push(`model_reasoning_effort=${process.env.CODEX_REASONING_EFFORT}`);
  return overrides;
}
