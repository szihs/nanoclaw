import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { Codex, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

const STALE_SESSION_RE = /session.*not found|no such session|invalid session|thread.*not found|no rollout found/i;

/**
 * Agent provider wrapping the OpenAI Codex SDK (`@openai/codex-sdk`).
 *
 * Each query creates or resumes a Thread and calls `thread.runStreamed()`.
 * Events from the SDK's AsyncGenerator<ThreadEvent> are mapped to our
 * ProviderEvent types for consumption by the poll-loop.
 */
export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private codex: Codex;
  private env: Record<string, string | undefined>;
  private configDir: string;
  private mcpServers: Record<string, McpServerConfig>;

  constructor(options: ProviderOptions = {}) {
    this.env = options.env ?? {};
    this.configDir = (options as CodexProviderOptions).configDir
      ?? path.join(os.homedir(), '.codex');
    this.mcpServers = options.mcpServers ?? {};

    const codexEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (v !== undefined) codexEnv[k] = v;
    }

    // Auth: OneCLI gateway injects credentials via HTTPS_PROXY, which
    // intercepts outbound API requests and adds the Authorization header.
    // The Codex CLI requires the env_key variable (set in config.toml) to
    // exist or it errors at startup. We inject a placeholder since OneCLI
    // handles the real credential injection via HTTPS_PROXY MITM.
    const envKeyName = this.env.NVIDIA_API_KEY ? 'NVIDIA_API_KEY' : 'OPENAI_API_KEY';
    if (!codexEnv[envKeyName]) {
      codexEnv[envKeyName] = 'onecli-placeholder';
    }

    // Write config.toml so the Codex CLI uses the correct model provider,
    // base URL, and wire_api. Written to this.configDir (defaults to
    // ~/.codex but overridable for tests).
    writeConfigToml(this.env, this.configDir, undefined, this.mcpServers);

    // Symlink Claude skills to Codex skills location so Codex CLI can
    // discover them. Claude uses ~/.claude/skills/, Codex uses ~/.agents/skills/.
    const claudeSkills = path.join(os.homedir(), '.claude', 'skills');
    const agentsSkills = path.join(os.homedir(), '.agents', 'skills');
    if (fs.existsSync(claudeSkills) && !fs.existsSync(agentsSkills)) {
      fs.mkdirSync(path.dirname(agentsSkills), { recursive: true });
      try {
        fs.symlinkSync(claudeSkills, agentsSkills);
        log(`Symlinked ${agentsSkills} → ${claudeSkills}`);
      } catch {
        // Race condition or permission issue — non-fatal
      }
    }

    this.codex = new Codex({
      env: codexEnv,
    });
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    // Create or resume a thread.
    // sandboxMode: 'danger-full-access' — agent containers are already
    //   isolated Linux VMs with a dedicated filesystem; the sandbox inside
    //   Codex would double-jail and break workspace writes.
    // approvalPolicy: 'never' — headless container, no human in the loop;
    //   approval gates would deadlock the process.
    const threadOpts = {
      workingDirectory: input.cwd,
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
    };

    let thread = input.continuation
      ? this.codex.resumeThread(input.continuation, threadOpts)
      : this.codex.startThread(threadOpts);

    let aborted = false;
    let ended = false;
    const pendingMessages: string[] = [];
    let waitingResolve: (() => void) | null = null;
    const abortController = new AbortController();

    const self = this;

    // Inject developer_instructions (Codex CLI's native system prompt) via
    // config.toml. Rewrite the config on each query so per-coworker
    // instructions are applied correctly.
    const instructions = input.systemContext?.instructions;
    writeConfigToml(this.env, this.configDir, instructions, this.mcpServers);

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        // Run the initial turn, retrying inline if a persisted continuation
        // points at a stale server-side rollout.
        try {
          yield* runTurn(thread, input.prompt, abortController.signal);
        } catch (err) {
          if (!input.continuation || !self.isSessionInvalid(err)) {
            throw err;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Stale continuation ${input.continuation}; retrying with fresh thread (${errMsg})`);
          thread = self.codex.startThread(threadOpts);
          yield { type: 'progress', message: 'Codex session expired; starting fresh thread' };
          yield* runTurn(thread, input.prompt, abortController.signal);
        }

        // Handle follow-up messages (push/end pattern)
        while (!ended && !aborted) {
          if (pendingMessages.length > 0) {
            const msg = pendingMessages.shift()!;
            log('Processing follow-up message');
            yield* runTurn(thread, msg, abortController.signal);
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waitingResolve = resolve;
          });
          waitingResolve = null;
        }
      },
    };

    return {
      push(message: string) {
        pendingMessages.push(message);
        waitingResolve?.();
      },
      end() {
        ended = true;
        waitingResolve?.();
      },
      events,
      abort() {
        aborted = true;
        abortController.abort();
        waitingResolve?.();
      },
    };
  }
}

/**
 * Run a single turn on a Codex thread and yield ProviderEvents.
 */
async function* runTurn(
  thread: ReturnType<Codex['startThread']>,
  prompt: string,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  let streamedTurn;
  try {
    streamedTurn = await thread.runStreamed(prompt, { signal });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to start turn: ${errMsg}`);
    // Stale session errors must propagate so the poll-loop can clear the
    // stored continuation and start a fresh thread on the next attempt.
    if (STALE_SESSION_RE.test(errMsg)) throw err;
    yield { type: 'error', message: errMsg, retryable: true };
    return;
  }

  let lastResultText: string | null = null;

  try {
    for await (const event of streamedTurn.events) {
      // Every event is activity for idle detection
      yield { type: 'activity' };

      switch (event.type) {
        case 'thread.started':
          yield { type: 'init', continuation: event.thread_id };
          break;

        case 'turn.started':
          yield { type: 'progress', message: 'Codex turn started' };
          break;

        case 'item.started':
          yield* handleItemProgress(event.item, 'started');
          break;

        case 'item.completed':
          if (event.item.type === 'agent_message') {
            lastResultText = event.item.text;
          }
          yield* handleItemProgress(event.item, 'completed');
          break;

        case 'item.updated':
          yield* handleItemProgress(event.item, 'updated');
          break;

        case 'turn.completed':
          if (lastResultText !== null) {
            yield { type: 'result', text: lastResultText };
            lastResultText = null;
          } else {
            yield { type: 'result', text: null };
          }
          break;

        case 'turn.failed':
          yield {
            type: 'error',
            message: event.error?.message || 'Codex turn failed',
            retryable: false,
          };
          break;

        case 'error':
          yield {
            type: 'error',
            message: event.message || 'Codex error',
            retryable: true,
          };
          break;
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Stream error: ${errMsg}`);
    if (STALE_SESSION_RE.test(errMsg)) throw err;
    yield { type: 'error', message: errMsg, retryable: true };
  }
}

/**
 * Yield progress events for ThreadItem state changes.
 */
function* handleItemProgress(
  item: ThreadItem,
  phase: 'started' | 'updated' | 'completed',
): Generator<ProviderEvent> {
  switch (item.type) {
    case 'command_execution':
      if (phase === 'started' && item.command) {
        yield { type: 'progress', message: `Running: ${item.command.slice(0, 100)}` };
      } else if (phase === 'completed') {
        const exitCode = item.exit_code ?? '?';
        yield { type: 'progress', message: `${item.command.slice(0, 80)} (exit ${exitCode})` };
      }
      break;

    case 'file_change':
      if (phase === 'completed') {
        yield { type: 'progress', message: `File change: ${item.status}` };
      }
      break;

    case 'mcp_tool_call':
      if (phase === 'started') {
        yield { type: 'progress', message: `MCP: ${item.server}/${item.tool}` };
      }
      break;

    case 'web_search':
      if (phase === 'started') {
        yield { type: 'progress', message: `Search: ${item.query.slice(0, 80)}` };
      }
      break;

    case 'error':
      yield { type: 'error', message: item.message, retryable: true };
      break;
  }
}

/** Extended options accepted by CodexProvider (superset of ProviderOptions). */
interface CodexProviderOptions extends ProviderOptions {
  /** Override the directory where config.toml is written (default: ~/.codex).
   *  Used by tests to avoid clobbering the host's personal Codex config. */
  configDir?: string;
}

function writeConfigToml(
  env: Record<string, string | undefined>,
  configDir: string,
  instructions?: string,
  mcpServers?: Record<string, McpServerConfig>,
): void {
  const lines: string[] = [];

  if (env.CODEX_MODEL) {
    lines.push(`model = "${env.CODEX_MODEL}"`);
  }
  if (env.CODEX_REASONING_EFFORT) {
    lines.push(`model_reasoning_effort = "${env.CODEX_REASONING_EFFORT}"`);
  }
  lines.push('approval_policy = "never"');

  // developer_instructions — the Codex CLI equivalent of a system prompt.
  // Composed CLAUDE.md content is injected here so the model treats it as
  // system-level context rather than user input.
  if (instructions) {
    // TOML multiline literal strings (''') pass content verbatim — no
    // escaping needed. Only risk is the content containing ''' itself,
    // which we guard against by replacing with single quotes.
    const safe = instructions.replace(/'''/g, "'''");
    lines.push(`developer_instructions = '''`);
    lines.push(safe);
    lines.push(`'''`);
  }

  const providerName = env.CODEX_MODEL_PROVIDER;
  if (providerName && env.CODEX_BASE_URL) {
    const envKey = env.NVIDIA_API_KEY ? 'NVIDIA_API_KEY' : 'OPENAI_API_KEY';
    lines.push(`model_provider = "${providerName}"`);
    lines.push('');
    lines.push(`[model_providers.${providerName}]`);
    lines.push(`name = "${providerName}"`);
    lines.push('wire_api = "responses"');
    lines.push(`base_url = "${env.CODEX_BASE_URL}"`);
    lines.push(`env_key = "${envKey}"`);
  }

  // MCP servers — Codex reads these from config.toml [mcp_servers.*] sections.
  // Claude passes them via SDK options; for Codex we write them to config.
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    lines.push('');
    for (const [name, server] of Object.entries(mcpServers)) {
      lines.push(`[mcp_servers.${name}]`);
      if ('url' in server && (server as any).url) {
        // HTTP/SSE transport (MCP proxy servers)
        lines.push(`url = "${(server as any).url}"`);
        // Codex CLI doesn't support arbitrary headers — it uses
        // bearer_token_env_var to name an env var holding the token.
        // Claude SDK accepts { headers: { Authorization: "Bearer ..." } }
        // directly; for Codex we translate that to the env-var reference.
        const headers = (server as any).headers as Record<string, string> | undefined;
        if (headers?.Authorization) {
          // Find which env var holds this token value so Codex can read it
          const tokenValue = headers.Authorization.replace(/^Bearer\s+/i, '');
          const envVarName = Object.entries(env).find(([, v]) => v === tokenValue)?.[0];
          if (envVarName) {
            lines.push(`bearer_token_env_var = "${envVarName}"`);
          }
        }
      } else {
        // stdio transport (local command)
        lines.push(`command = "${server.command}"`);
        if (server.args.length > 0) {
          lines.push(`args = [${server.args.map((a: string) => `"${a}"`).join(', ')}]`);
        }
      }
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push(`[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(server.env)) {
          lines.push(`${k} = "${v}"`);
        }
      }
      lines.push('');
    }
  }

  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, lines.join('\n') + '\n');
  log(`Wrote ${configPath}${instructions ? ' (with developer_instructions)' : ''}${mcpServers && Object.keys(mcpServers).length ? ` (${Object.keys(mcpServers).length} MCP servers)` : ''}`);
}

registerProvider('codex', (opts) => new CodexProvider(opts));
