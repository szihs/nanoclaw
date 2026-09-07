import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

/**
 * A speed tier name. The vocabulary is provider-declared (the host validates
 * `--speed` against the provider's `inference.speedTiers`), so this is an
 * opaque token here; a provider reacts to the names it declared and ignores
 * the rest.
 */
export type ProviderSpeed = string;

export interface AgentProvider {
  /**
   * Register shared memory through the provider's native session-start
   * mechanism. `memory` is the contract's resolved memory capability (core
   * calls the contract's `memory` function with the hook, or takes its
   * declared constant, and passes the result); absent for providers without
   * a contract or without a memory capability.
   */
  readonly emitsMidTurnText?: boolean;

  /**
   * Register shared memory through the provider's native session-start
   * mechanism. Returns whether the provider has one: `false` means the runner
   * must deliver memory some other way (it falls back to the system prompt),
   * so a provider without a session-start mechanism is a no-op that returns
   * false, never a silent one.
   *
   * `memory` is the contract-resolved payload the provider-contract realizer
   * hands through (`provider-contracts/realize.ts`); the boolean return is this
   * fork's, and the poll-loop reads it to choose the system-prompt fallback, so
   * it outlives upstream's `void`.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration, memory?: unknown): boolean;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * Contractless providers implement this directly. For a declared
   * core-owned archive, the factory replaces it with the core executor while
   * the provider implementation remains an old-core compatibility fallback.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Provider-internal: only the provider knows its transcript format. This
   * guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
  /**
   * Fallback model to use when the primary model is unavailable (429/503).
   * Passed through to the underlying SDK.
   */
  fallbackModel?: string;
  /**
   * Provider-declared speed tier (`standard` or `fast` for Claude). A provider
   * maps `fast` onto its own fast serving tier when it has one; `standard`
   * keeps the provider default; a tier it did not declare never reaches it.
   */
  speed?: ProviderSpeed;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Per-turn spend ceiling in USD (the Tier-2 cost ceiling's remaining headroom).
   * A provider that supports it (Claude → `maxBudgetUsd`) ends the in-flight query
   * once this turn's cost reaches it — a SOFT brake on runaway spend. Best-effort:
   * the SDK checks between calls, so a turn may overshoot by ≤ one in-flight call;
   * `recordTurnCost` remains the canonical spend basis and the sole close decider.
   * Undefined = no applicable ceiling (disabled, no ceiling, or an immortal group,
   * which is never hard-stopped).
   */
  maxBudgetUsd?: number;
}

/**
 * MCP server config — stdio OR streamable HTTP.
 *
 * The shape accepts Claude Agent SDK native fields (`type`, `headers`) AND
 * codex-friendly fields (`bearerTokenEnvVar`, `envHttpHeaders`) so the same
 * record can be passed to either provider. Each provider picks the fields
 * it understands; codex's serializer prefers env-var indirection over
 * plaintext headers when both are present.
 */
export type McpServerConfig =
  | {
      /** stdio transport */
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /**
       * Env-var names to forward by NAME (not value) to the subprocess.
       * Codex's TOML writer emits `env_vars = [...]`; codex-cli resolves
       * each name from its own process env at spawn time — so secrets
       * (OneCLI proxy bearer in HTTPS_PROXY, API keys) never land in
       * `~/.codex/config.toml`. Providers without TOML-style name
       * indirection (Claude SDK, OpenCode) resolve names to values from
       * `process.env` before handing the child's env map to the SDK;
       * those providers keep secrets in-process only, never on disk.
       */
      envInherit?: string[];
      /**
       * Container-side root of the plugin this server shipped in, recorded by
       * the host at stamp time. Consumed (and stripped) by plugin-mcp.ts,
       * which expands ${PLUGIN_ROOT}/${PLUGIN_DATA} and injects both env vars
       * before the config reaches a provider.
       */
      pluginRoot?: string;
      /**
       * Working directory for the server process. By the time a provider sees
       * it, plugin-mcp.ts has resolved it to an absolute container path.
       * A provider whose runtime cannot set a spawn directory must shim it
       * (cwd-shim.ts) or drop it — never launch in the wrong directory.
       */
      cwd?: string;
    }
  | {
      /** http (streamable) transport */
      type: 'http'; // Claude SDK requires literal; codex ignores
      url: string;
      /** Claude-SDK-native static headers (e.g. {Authorization: 'Bearer XYZ'}) */
      headers?: Record<string, string>;
      /** Codex-only: env-var name to read a Bearer token from at request time. */
      bearerTokenEnvVar?: string;
      /** Codex-only: header-name → env-var-name indirection. */
      envHttpHeaders?: Record<string, string>;
      /** Codex-only: static headers. If absent, `headers` is used as a fallback. */
      httpHeaders?: Record<string, string>;
    };

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   */
  | { type: 'result'; text: string | null; isError?: boolean }
  /**
   * An assistant text segment emitted mid-turn (e.g. between tool calls).
   * The SDK's final `result` carries only the LAST assistant text, so a
   * complete <message to="..."> block composed before a trailing tool call
   * never reaches the result event. For providers declaring
   * `textDelivery: 'mid-turn-complete'`, the poll-loop scans these segments for closed
   * message blocks and delivers them as they are emitted (chat runs only,
   * with cross-segment assembly of split blocks); the final result never
   * delivers content — repeats are inert there, and an undelivered turn
   * gets the wrap-nudge instead.
   */
  | { type: 'text'; text: string }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'file'; path: string }
  /**
   * Per-turn usage accounting. Emitted once after a turn completes when the
   * underlying provider surfaces token/cost numbers. Lets the poll-loop log
   * a structured line per turn (grep/aggregate for perf investigations).
   * Fields mirror the Anthropic usage shape; providers that don't know a
   * value (e.g. Codex doesn't separate cache tiers) pass 0 rather than omit.
   */
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      ephemeral1hInputTokens: number;
      ephemeral5mInputTokens: number;
      durationMs: number;
      totalCostUsd: number;
      numTurns: number;
      sessionId: string | null;
    }
  /**
   * PER-MESSAGE usage — one per assistant message the provider streams, carrying
   * that message's OWN `usage` and the wire id that identifies it.
   *
   * This is the cost-cap's primary accounting basis (issue #1327). The
   * end-of-turn `usage` event above is NOT a safe basis: the underlying stream
   * emits one assistant message per CONTENT BLOCK (thinking / text / tool_use
   * are separate messages) and every block of one API response repeats the same
   * `message.id` AND the same message-level `usage`. Measured on real prod
   * transcripts, summing those without deduplication double- to triple-counts
   * (1.7x–2.8x; the reported session ran 2.1x over its true cost and enforced
   * its ceiling that much too early).
   *
   * `messageId` is the dedup key. A consumer MUST ignore a repeat of an id it
   * already charged, and MUST NOT charge an event whose id is null (it cannot be
   * deduplicated) — see `recordMessageCost` in poll-loop.ts.
   *
   * `model` is the model that actually served THIS message, which is not
   * necessarily the configured one (fallback model, a subagent on a cheaper
   * model, …). Providers that cannot supply a value pass undefined and the
   * consumer falls back to the configured model.
   */
  | {
      type: 'message_usage';
      /** Wire message id — the dedup key. Null when the provider has none. */
      messageId: string | null;
      /** Model that served this message; undefined → consumer uses the configured one. */
      model: string | undefined;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      ephemeral1hInputTokens: number;
      ephemeral5mInputTokens: number;
      /** True when this message was produced by a Task-tool subagent. */
      isSubagent: boolean;
    }
  /**
   * A genuine assistant message the provider could NOT attach per-message
   * `usage` to. Distinct from `message_usage` with a null id (usage present,
   * id absent): here there is no usage at all, so there is nothing to price
   * per-message. The consumer must treat the turn as degraded and settle from
   * the end-of-turn aggregate `usage` event — otherwise a turn that mixes
   * usage-bearing and usage-less assistant messages would look fully accounted
   * (some message priced, no explicit gap) and skip the fallback, making the
   * usage-less message's spend free. Empirically the Claude SDK attaches usage
   * to every assistant message, so this is a money-safe guard, not a hot path.
   */
  | { type: 'message_missing_usage'; isSubagent: boolean }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
