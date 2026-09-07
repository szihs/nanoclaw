import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { BUILTIN_MCP_SERVER, isMcpToolAllowed, parseMcpPolicy, type McpPolicy } from '../mcp-policy.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { resolveEnvInherit } from './codex-app-server.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { shimCwd } from './cwd-shim.js';
import type { ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';
// The execution-policy, inference, MCP, and memory derivations live in
// claude-config.ts. The runtime contract (provider-contracts/claude.ts)
// declares them; core calls them and hands the results to this provider's
// constructor and registerMemorySessionHook. This module never imports the
// contract — registration is two-step so it compiles on a core without one.
import {
  SDK_DISALLOWED_TOOLS,
  TOOL_ALLOWLIST,
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  type resolveClaudeMemoryRuntime,
} from './claude-config.js';
// Transcript archiving and rotation are this provider's own concern: both
// read the SDK's on-disk .jsonl, which no other provider has.
import { archiveClaudeTranscript, rotateClaudeContinuation } from './claude-history.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal quota error: on a stock install that logged a
 * spurious "Rate limit (retryable: false, quota)" on perfectly healthy turns
 * (#3016), and any consumer acting on the classification aborted those turns
 * outright. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

// Re-exported because callers still import these from here; both are read by this
// module's own MCP allow-list helpers, so they come in through the import above.
import type { McpServerConfig } from './types.js';
export { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST };

export function parseAllowedMcpTools(env?: Record<string, string | undefined>): string[] {
  if (!env?.NANOCLAW_ALLOWED_MCP_TOOLS) return [];
  try {
    return (JSON.parse(env.NANOCLAW_ALLOWED_MCP_TOOLS) as string[]).filter((tool) => tool.startsWith('mcp__'));
  } catch {
    log('Failed to parse NANOCLAW_ALLOWED_MCP_TOOLS');
    return [];
  }
}

/**
 * Extra names for the SDK's `disallowedTools`, derived from the host's
 * discovered inventory.
 *
 * Kept as a backstop only. It is inventory-derived, so it can never be proven
 * complete — which is exactly why it must not be the mechanism the policy
 * relies on. The mechanisms that are complete: a server the policy allows
 * nothing on is never wired (index.ts), the built-in server filters itself
 * (mcp-tools/server.ts), and `mcpPolicyPreToolUseDecision` below default-denies
 * every `mcp__` call the policy does not name.
 *
 * No longer bails out on an empty allowed list: that early return is precisely
 * what made `--tools '[]'` install zero blocks.
 */
function computeBlockedTools(
  env: Record<string, string | undefined> | undefined,
  policy: McpPolicy,
): string[] | undefined {
  if (!policy.restrict || !env?.NANOCLAW_MCP_TOOL_INVENTORY) return undefined;
  try {
    const inventory = JSON.parse(env.NANOCLAW_MCP_TOOL_INVENTORY) as Record<string, string[]>;
    const blocked: string[] = [];
    for (const tools of Object.values(inventory)) {
      for (const tool of tools) {
        if (!isMcpToolAllowed(policy, tool)) blocked.push(tool);
      }
    }
    if (blocked.length > 0) {
      log(`Blocking ${blocked.length} MCP tools not in allowed list`);
      return blocked;
    }
  } catch {
    log('Failed to parse NANOCLAW_MCP_TOOL_INVENTORY');
  }
  return undefined;
}

/** NanoClaw's own server, which the allow-list never governs. */
function isBuiltinMcpServer(serverName: string): boolean {
  return serverName === BUILTIN_MCP_SERVER;
}

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

/**
 * What to put in the SDK's `allowedTools` for MCP.
 *
 * Under `unrestricted` this stays what it always was: one wildcard per wired
 * server, so a server added at runtime is reachable without a code change.
 *
 * Under a restrictive state the EXTERNAL wildcards are dropped and the exact
 * permitted names are listed instead. Emitting `mcp__<external>__*` alongside a
 * narrow allow-list was the shape of the original bug: the wildcard re-admitted
 * the whole namespace the policy had just excluded. The built-in namespace
 * keeps its wildcard — the allow-list does not govern it.
 */
export function mcpAllowedToolEntries(policy: McpPolicy, serverNames: string[]): string[] {
  if (!policy.restrict) return serverNames.map(mcpAllowPattern);
  // The built-in namespace keeps its wildcard under every state: it is out of
  // this policy's scope, and enumerating it here would mean this file has to
  // know every tool `registerTools` ever adds — a list that would silently
  // fall behind and quietly drop new built-ins.
  const builtinWildcards = serverNames.filter(isBuiltinMcpServer).map(mcpAllowPattern);
  return [...builtinWildcards, ...policy.tools];
}

/**
 * Default-deny check for every `mcp__*` tool call, evaluated at the call.
 *
 * This is the one enforcement point in the provider that does not depend on
 * how the SDK interprets an allow/deny pattern, on the host inventory being
 * complete, or on which servers happened to be wired. It answers the only
 * question that matters — "may this agent group call THIS tool?" — from the
 * policy the host resolved at spawn.
 *
 * Non-MCP tools are none of its business; `SDK_DISALLOWED_TOOLS` and the
 * issue-close backstop handle those.
 *
 * Returns null to allow. Exported for tests.
 */
export function mcpPolicyPreToolUseDecision(policy: McpPolicy, toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  // `isMcpToolAllowed` passes every built-in: they are outside this policy.
  if (isMcpToolAllowed(policy, toolName)) return null;
  return (
    `Tool '${toolName}' is not in this agent group's external MCP tool allow-list ` +
    `(${policy.origin}). This is a configuration boundary, not a transient ` +
    `failure: retrying or reaching the same capability another way is not appropriate. ` +
    `An admin can widen it with \`ncl groups mcp-tools set\`; an agent may never widen its own.`
  );
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * Detect a Bash command that would CLOSE a GitHub issue. Closing a
 * contributor's issue (even a genuine duplicate of a maintainer-owned issue)
 * is a maintainer privilege — coworkers triage and comment, they do not close.
 * This is a deterministic backstop for the instruction-level guardrail: the
 * #11719 regression closed an issue as a duplicate after the prose guardrail
 * (scoped to "PRs", not issues) let it through and the orchestrator authorized
 * it. We block the command's *content* because the close rides inside a Bash
 * `gh` / GraphQL call, which the SDK's tool-name `disallowedTools` can't see.
 *
 * Covers the two paths observed in the wild:
 *   - REST:    gh issue close … / gh api … issues/<n> -f state=closed / state_reason=…
 *   - GraphQL: a `closeIssue(` mutation (used because REST state_reason 403s for the App token)
 *
 * Deliberately does NOT match `gh pr close` or `closePullRequest` — PR close is
 * a separate surface the fixer/reviewer legitimately use. Returns the matched
 * fragment (for the block message) or null.
 */
export function detectIssueClose(command: string | undefined): string | null {
  if (!command || typeof command !== 'string') return null;
  // GraphQL mutation: closeIssue( … ). PR equivalent is closePullRequest, which
  // won't match this because of the trailing `(` boundary after "Issue".
  if (/\bcloseIssue\s*\(/i.test(command)) return 'GraphQL closeIssue mutation';
  // REST via gh CLI: `gh issue close <n>` (allow flags/`-R` between).
  if (/\bgh\s+issue\s+close\b/i.test(command)) return 'gh issue close';
  // REST via gh api: a PATCH to issues/<n> that sets state=closed or any
  // state_reason. Require an issues path so we don't catch PR endpoints.
  if (/\bgh\s+api\b/i.test(command) && /\/issues\/\d+/i.test(command) && /\bstate(_reason)?=/i.test(command)) {
    return 'gh api issues state change';
  }
  return null;
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
function createPreToolUseHook(policy: McpPolicy): HookCallback {
  return async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // MCP allow-list, default-deny. Placed first among the policy checks because
  // it is the broadest: it covers direct servers the host proxy never sees
  // (the built-in `nanoclaw` server, the `codex` stdio child) as well as
  // proxied ones, and it does not care whether the SDK honoured the
  // allowedTools/disallowedTools it was handed.
  const mcpDenial = mcpPolicyPreToolUseDecision(policy, toolName);
  if (mcpDenial) {
    log(`PreToolUse: denied ${toolName} — not in the explicit external allow-list`);
    return { decision: 'block', stopReason: mcpDenial } as unknown as ReturnType<HookCallback>;
  }
  // Backstop: no coworker closes GitHub issues. Block the close at the tool
  // boundary regardless of what the model was told or authorized. Opt-out is a
  // per-group env flag (unset everywhere today) so a future maintainer-grade
  // group can be granted the capability via container config, not a code change.
  if (toolName === 'Bash' && process.env.NANOCLAW_ALLOW_ISSUE_CLOSE !== '1') {
    const match = detectIssueClose(i.tool_input?.command as string | undefined);
    if (match) {
      return {
        decision: 'block',
        stopReason:
          `Closing a GitHub issue (${match}) is a maintainer-only action — coworkers triage and comment, they do not close. ` +
          `Post your duplicate/wontfix verdict as an issue comment and leave the close to a human maintainer.`,
      } as unknown as ReturnType<HookCallback>;
    }
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
  };
}

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** The real clock for archive names and rotation stamps; tests hand the history functions a fixed one. */
const REAL_CLOCK = { now: () => Date.now() };

// The PreCompact hook is provider-originated: the SDK raises it from inside
// the query, and the archive it triggers reads the SDK's own transcript.
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveClaudeTranscript(
      {
        transcriptPath: preCompact.transcript_path,
        sessionId: preCompact.session_id,
        assistantName,
        log,
      },
      REAL_CLOCK,
    );
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Default is
 * tuned for a 200K context model (~80% fill). For 1M models (model ID
 * contains "[1m]"), we raise the window to 900K so the agent can use the
 * full context before compacting. Operator override: set
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to raise or lower the
 * threshold without editing source.
 */
function getAutoCompactWindow(): string {
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const model = process.env.ANTHROPIC_MODEL || '';
  if (model.includes('[1m]')) return '900000';
  return '165000';
}
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = getAutoCompactWindow();

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  private assistantName?: string;
  private mcp: ReturnType<typeof resolveClaudeMcpServers>;
  private inference: ReturnType<typeof resolveClaudeInference>;
  private executionPolicy: ReturnType<typeof resolveClaudeExecutionPolicy>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  // The envInherit-resolved MCP map this provider hands the SDK. Distinct from
  // `this.mcp` (the contract resolver's output, which applies shimCwd only).
  private mcpServers: Record<string, McpServerConfig>;
  private mcpPolicy: McpPolicy;
  private blockedTools?: string[];
  // Kept as a field: upstream's inference resolver has no fallbackModel.
  private fallbackModel?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  /**
   * `configuration` is the contract's configuration as resolved by core
   * (createProvider): execution policy, inference, and MCP servers. This
   * provider does not call the resolves itself.
   */
  constructor(options: ProviderOptions = {}, configuration?: ResolvedRuntimeConfiguration) {
    // `configuration` is what core resolved from the runtime contract, and
    // createProvider always supplies it. It stays OPTIONAL because direct
    // construction is still a supported entry point — other branches of this fork
    // construct the provider straight in their tests, and a required argument turns
    // that into a crash they cannot see until the composed-state CI run. Resolving
    // the same functions here as a fallback is tolerant in exactly the way the rest
    // of this refactor is (an absent seamVersion means 1; dropped declarations are
    // accepted and ignored), and the resolves are the provider's OWN, so nothing
    // reaches for the contract.
    const runtimeConfiguration: ResolvedRuntimeConfiguration = configuration ?? {
      executionPolicy: resolveClaudeExecutionPolicy(),
      inference: resolveClaudeInference(
        { model: options.model, effort: options.effort, speed: options.speed },
        process.env,
      ),
      mcpServers: resolveClaudeMcpServers(options.mcpServers ?? {}, process.env),
    };
    this.assistantName = options.assistantName;
    this.mcp = runtimeConfiguration.mcpServers as ReturnType<typeof resolveClaudeMcpServers>;
    this.additionalDirectories = options.additionalDirectories;
    this.inference = runtimeConfiguration.inference as ReturnType<typeof resolveClaudeInference>;
    this.executionPolicy = runtimeConfiguration.executionPolicy as ReturnType<typeof resolveClaudeExecutionPolicy>;
    this.fallbackModel = options.fallbackModel;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      // NanoClaw owns memory (the OKF tree + session-start hook), so Claude
      // Code's native auto-memory must stay off or the two disagree about
      // recall. group-init.ts writes the same flag into each group's
      // settings.json; this covers the SDK child for groups scaffolded before
      // that flag existed. Spread last so a caller env cannot re-enable it.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    };
    // Resolve `envInherit` names → values from process env for every stdio
    // MCP entry. Claude Agent SDK spawns MCP children with a literal env
    // map and has no name-indirection; we resolve in-memory and drop the
    // envInherit field. Resolved values live only in this record and are
    // handed straight to the SDK (which uses them for child_process.spawn
    // env); they MUST NOT be written anywhere on disk.
    const src = options.mcpServers ?? {};
    const resolved: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(src)) {
      if ('url' in cfg) {
        resolved[name] = cfg;
        continue;
      }
      const mergedEnv = resolveEnvInherit(cfg, process.env, name);
      // shimCwd runs last and consumes `cwd`: the Agent SDK's stdio config has
      // no cwd field, so the only way to honour it is the /bin/sh chdir wrap,
      // which rewrites command/args. Nothing may re-resolve them afterwards.
      resolved[name] = shimCwd({
        command: cfg.command,
        args: cfg.args,
        env: mergedEnv,
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      });
    }
    this.mcpServers = resolved;
    // Policy is snapshotted at construction — deliberately. It changes only
    // when the container is respawned, which is exactly what `ncl groups
    // mcp-tools set` now forces for every session in the group. A live-mutable
    // seam here would be a second, weaker source of truth: the SDK caches the
    // allowedTools/mcpServers it was handed at query start, and a wired stdio
    // server is a running child process, so "narrow the snapshot" could not
    // actually revoke a direct tool mid-session. Restart can, and does.
    this.mcpPolicy = parseMcpPolicy(this.env);
    this.blockedTools = computeBlockedTools(this.env, this.mcpPolicy);
    // A server the policy allows nothing on should already have been dropped
    // by index.ts before it got here. Drop it again rather than trusting that:
    // wiring a server is what creates its tools, so this is the cheapest
    // complete revocation available and it costs one filter.
    for (const name of Object.keys(this.mcpServers)) {
      if (isBuiltinMcpServer(name)) continue;
      const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
      if (this.mcpPolicy.restrict && !this.mcpPolicy.tools.some((t) => t.startsWith(prefix))) {
        log(`Not wiring MCP server "${name}" — the explicit allow-list names no tool on it`);
        delete this.mcpServers[name];
      }
    }
  }

  /**
   * `memory` is the contract's resolved memory capability (the runtime env
   * that keeps the SDK's own auto-memory off). Core registers the hook before
   * any query, so the SDK sees the same env it always did. The hook FILE is
   * written by the contract's `lifecycle.memorySessionHookRegistration`
   * (provider-contracts/claude.ts), which is why this no longer calls
   * writeMemorySessionHook itself.
   *
   * Returns true: Claude Code has a native session-start mechanism, so the
   * runner does NOT add the memory section to the system prompt.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration, memory?: unknown): boolean {
    this.memorySessionHook = hook;
    this.env = {
      ...this.env,
      ...((memory as ReturnType<typeof resolveClaudeMemoryRuntime> | undefined) ?? {}),
    };
    return true;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /**
   * Pre-resume maintenance: drop a transcript too large or too old to
   * cold-resume within the host's idle ceiling (see claude-history.ts).
   */
  maybeRotateContinuation(continuation: string, _cwd: string): string | null {
    return rotateClaudeContinuation({ continuation, assistantName: this.assistantName, log }, REAL_CLOCK);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // The executable the SDK spawns. Defaults to the bundled native claude
    // binary. CLAUDE_CODE_EXECUTABLE points it at the claude-trace wrapper (the
    // real binary under a request-logging reverse proxy) so each session dumps
    // .claude-trace/*.jsonl + *.html. The wrapper MUST keep the child's stdout
    // (SDK stream-json) clean; claude-trace's own logs go to stderr.
    const claudeExecutable =
      process.env.CLAUDE_CODE_EXECUTABLE || '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        pathToClaudeCodeExecutable: claudeExecutable,
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...TOOL_ALLOWLIST, ...mcpAllowedToolEntries(this.mcpPolicy, Object.keys(this.mcpServers))],
        disallowedTools: [...SDK_DISALLOWED_TOOLS, ...(this.blockedTools ?? [])],
        env: this.env,
        model: this.inference.model,
        fallbackModel: this.fallbackModel,
        // Tier-2 ceiling SOFT brake: the SDK ends this query once its cost reaches the
        // remaining headroom (checked between calls → best-effort, ≤ one in-flight-call
        // overshoot). Omitted (undefined) when there is no applicable ceiling.
        ...(input.maxBudgetUsd != null ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
        // Forward subagent (Task tool) text/thinking messages into this stream.
        // Cost, not rendering, is why: by default the SDK forwards only a
        // subagent's tool_use/tool_result blocks, so a subagent message that is
        // pure text — typically its final answer — never reaches us and its
        // tokens are invisible to the cost cap. Subagent transcripts are written
        // to a SEPARATE file (`<sdk-session-id>/subagents/agent-*.jsonl`), and
        // the on-disk route cannot attribute them: `.claude-shared` is shared by
        // every session in the agent group, and the directory is named after the
        // ORIGINAL sdk session id, which after a few resumes is no longer the
        // live continuation. Forwarding is the only seam that attributes
        // correctly. The `text` event below is gated on `parent_tool_use_id ==
        // null` so this does NOT open a second delivery door (issue #1327).
        forwardSubagentText: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.inference.effort as any,
        permissionMode: this.executionPolicy.permissionMode,
        allowDangerouslySkipPermissions: this.executionPolicy.allowDangerouslySkipPermissions,
        settingSources: ['project', 'user', 'local'],
        // Only sent when enabled, so an install that never turns it on passes
        // exactly the options it always did. `fastMode` is a Settings member
        // rather than a query option, which is why it rides `settings`.
        ...(this.inference.settings ? { settings: this.inference.settings } : {}),
        // this.mcpServers, not this.mcp.mcpServers: the contract resolver applies
        // shimCwd but NOT envInherit, and the fork resolves `envInherit` names to
        // values in the constructor. Using the resolver's map drops those values.
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [createPreToolUseHook(this.mcpPolicy)] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant') {
          // Surface each assistant message's text as it streams in. The final
          // `result` event only carries the LAST assistant text — a wrapped
          // <message> block composed between tool calls would otherwise be
          // invisible to the poll-loop and silently lost.
          //
          // ONE text event per assistant message, joining its text blocks in
          // content order ('' separator — the blocks are adjacent output).
          // Emitting per-BLOCK events would hand the poll-loop's block parser
          // fragments: a <message> block (or an <internal> span) spanning two
          // text blocks of the same assistant message would look unterminated
          // in each event, while the turn's result text — which reports the
          // final message's text as a whole — could still contain it complete.
          // Joining pins the containment premise at the granularity the
          // result reports. Blocks split across ASSISTANT MESSAGES (a tool
          // call between them) remain unparseable mid-turn by design; the
          // poll-loop's midTurnSent===0 fallback and wrap-nudge cover that.
          const asst = message as {
            parent_tool_use_id?: string | null;
            message?: {
              id?: string;
              model?: string;
              content?: Array<{ type?: string; text?: string }>;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation?: {
                  ephemeral_1h_input_tokens?: number;
                  ephemeral_5m_input_tokens?: number;
                };
              };
            };
          };
          // A subagent's messages carry `parent_tool_use_id`. They are forwarded
          // for COST only (see forwardSubagentText above) — never for delivery:
          // the poll-loop parses `text` events for complete <message> blocks and
          // sends them, so letting a subagent's prose through here would deliver
          // a nested agent's scratchpad to the user. Gating here is also
          // behavior-preserving for the pre-#1327 default, where the only
          // forwarded subagent blocks were tool_use/tool_result and the filter
          // below already dropped them.
          const isSubagent = asst.parent_tool_use_id != null;
          const content = asst.message?.content;
          if (!isSubagent && Array.isArray(content)) {
            const text = content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('');
            if (text) yield { type: 'text', text };
          }
          // PER-MESSAGE usage — the cost cap's accounting basis (issue #1327).
          // One assistant message per content block, all blocks of one API
          // response repeating the same `message.id` and the same `usage`, so
          // the consumer dedupes by id; see the ProviderEvent doc comment.
          const mu = asst.message?.usage;
          if (mu) {
            yield {
              type: 'message_usage',
              messageId: asst.message?.id ?? null,
              model: asst.message?.model,
              inputTokens: mu.input_tokens ?? 0,
              outputTokens: mu.output_tokens ?? 0,
              cacheCreationInputTokens: mu.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: mu.cache_read_input_tokens ?? 0,
              ephemeral1hInputTokens: mu.cache_creation?.ephemeral_1h_input_tokens ?? 0,
              ephemeral5mInputTokens: mu.cache_creation?.ephemeral_5m_input_tokens ?? 0,
              isSubagent,
            };
          } else {
            // A genuine assistant message with no `usage` object. Signal it so
            // the poll-loop treats the turn as degraded and settles from the
            // aggregate — otherwise, mixed with usage-bearing messages, this
            // one's spend would be invisible and free (issue #1327).
            yield { type: 'message_missing_usage', isSubagent };
          }
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Surface either so the poll-loop can deliver a
          // billing/quota notice to the user rather than dropping the turn.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
          const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
          yield { type: 'result', text, isError: m.is_error === true };
          // Emit structured per-turn usage so the poll-loop can log
          // a grep-friendly line. Fields come from the SDK's result
          // message (shape: { usage: { input_tokens, cache_*_input_tokens,
          // output_tokens, cache_creation: { ephemeral_*_input_tokens } },
          // duration_ms, total_cost_usd, num_turns, session_id }).
          const r = message as {
            session_id?: string;
            duration_ms?: number;
            total_cost_usd?: number;
            num_turns?: number;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation?: {
                ephemeral_1h_input_tokens?: number;
                ephemeral_5m_input_tokens?: number;
              };
            };
          };
          if (r.usage) {
            yield {
              type: 'usage',
              inputTokens: r.usage.input_tokens ?? 0,
              outputTokens: r.usage.output_tokens ?? 0,
              cacheCreationInputTokens: r.usage.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: r.usage.cache_read_input_tokens ?? 0,
              ephemeral1hInputTokens: r.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
              ephemeral5mInputTokens: r.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
              durationMs: r.duration_ms ?? 0,
              totalCostUsd: r.total_cost_usd ?? 0,
              numTurns: r.num_turns ?? 0,
              sessionId: r.session_id ?? null,
            };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
          // not necessarily an error. `rate_limit_info.status` is usually
          // 'allowed' (here's your remaining headroom). Treating every one of
          // these as a terminal quota error logged a spurious rate-limit line
          // on healthy turns (#3016) — and aborted them outright wherever the
          // classification is acted on. ONLY 'rejected' is an actual block.
          //
          // When it IS rejected the SDK tells us WHY, so we can finally
          // distinguish the two cases properly instead of guessing:
          //   errorCode 'credits_required' / overageDisabledReason
          //   'out_of_credits'  → genuinely out of credits (billing)
          //   otherwise         → a transient window limit that resets.
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
          const blocked = classifyRateLimitEvent(info);
          if (!blocked) {
            // Informational ('allowed' / 'allowed_warning') — never kill the turn.
            if (info?.status === 'allowed_warning') {
              log(
                `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                  info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                } utilization`,
              );
            }
          } else {
            yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          // Not a `result`: the poll loop treats result text as the agent's turn
          // output — a synthetic "Context compacted." result has no <message>
          // block, so it triggers the "response was not delivered — please
          // re-send" nudge and the agent duplicates its previous message.
          // Compaction is bookkeeping: log it, count it as activity only.
          log(`Context compacted${detail}.`);
          yield { type: 'activity' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

// Function-form registration only; the runtime contract attaches itself from
// provider-contracts/claude.ts through the same two-step path any
// skill-installed provider uses.
registerProvider('claude', (opts, configuration) => {
  if (!configuration) {
    throw new Error('Claude provider requires its runtime contract; construct it through createProvider');
  }
  return new ClaudeProvider(opts, configuration);
});
