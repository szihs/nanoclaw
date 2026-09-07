/**
 * Inference pricing core for HOST-side cost surfaces (`ncl cost-cap coworkers`).
 *
 * VERBATIM MIRROR of the rate tables in the dashboard (`dashboard/session-costs.ts`,
 * `dashboard/codex-costs.ts`, nv-dashboard tree) and their container copies
 * (`container/agent-runner/src/{pricing,codex-cost}.ts`) — copied, not imported,
 * because `src/` (tsconfig rootDir) shares no modules with either tree by rule.
 * `inference-pricing.test.ts` loads the container copies at runtime and asserts
 * every rate agrees, so this copy cannot drift silently. Change a rate in one
 * place → change it in all of them (the tests on each side will tell you).
 *
 * The ONLY intentional difference from the shipped normalizers: these also
 * accept the ids a provider writes INTO a streamed response body — what the
 * OneCLI body tap records as `usage_model` — i.e. raw Bedrock ids like
 * `anthropic.claude-haiku-4-5-20251001-v1:0` and Azure deployment suffixes
 * like `gpt-5.6-sol-global`. For every id the shipped normalizers resolve,
 * these resolve identically (asserted by the parity test).
 */

export interface ModelRate {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

/** Keyed by BASE model id (no provider prefix, no `[1m]`/`-v1`/date suffix). */
export const MODEL_PRICING: Record<string, ModelRate> = {
  'claude-opus-5': { input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 5e-7 },
  'claude-opus-4-8': { input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 5e-7 },
  'claude-opus-4-7': { input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 5e-7 },
  'claude-opus-4-6': { input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 5e-7 },
  'claude-sonnet-5': { input: 2e-6, output: 10e-6, cacheCreate: 2.5e-6, cacheRead: 2e-7 },
  'claude-sonnet-4-6': { input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 3e-7 },
  'claude-haiku-4-5': { input: 1e-6, output: 5e-6, cacheCreate: 1.25e-6, cacheRead: 1e-7 },
};

export interface CodexModelRate {
  /** Per-token cost of UNCACHED input (`input_tokens - cached_input_tokens`). */
  input: number;
  /** Per-token cost of output (reasoning tokens are a subset, never added on top). */
  output: number;
  /** Per-token cost of a cache read (`cached_input_tokens`). */
  cacheRead: number;
}

/** Keyed by BASE model id — `normalizeCodexModel` strips the provider routing prefix. */
export const CODEX_MODEL_PRICING: Record<string, CodexModelRate> = {
  'gpt-5.6-sol': { input: 5e-6, output: 3e-5, cacheRead: 5e-7 },
  'gpt-5.6': { input: 5e-6, output: 3e-5, cacheRead: 5e-7 },
  'gpt-5.6-terra': { input: 2e-6, output: 1.2e-5, cacheRead: 2e-7 },
  'gpt-5.6-luna': { input: 2e-7, output: 1.2e-6, cacheRead: 2e-8 },
  'gpt-5.5': { input: 5e-6, output: 3e-5, cacheRead: 5e-7 },
  'gpt-5.5-codex': { input: 5e-6, output: 3e-5, cacheRead: 5e-7 },
  'gpt-5.3-codex': { input: 1.75e-6, output: 1.4e-5, cacheRead: 1.75e-7 },
  'gpt-5.2-codex': { input: 1.75e-6, output: 1.4e-5, cacheRead: 1.75e-7 },
  'gpt-5.1-codex': { input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7 },
  'gpt-5-codex': { input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7 },
};

// Own-property membership: a plain object inherits truthy `constructor`/`toString`
// from Object.prototype, so a wire id like `constructor` must NOT resolve.
const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

/**
 * Map every Claude wire variant onto a `MODEL_PRICING` key, or '' when unknown
 * (callers treat '' as UNPRICED, never as $0). Accepts litellm aliases
 * (`aws/anthropic/bedrock-claude-opus-5`, `aws/anthropic/claude-haiku-4-5-v1`),
 * `claude-opus-4-8[1m]`, bare ids, dated snapshots, and raw Bedrock body ids
 * (`anthropic.claude-haiku-4-5-20251001-v1:0`).
 */
export function normalizeModel(model: string | undefined): string {
  if (!model) return '';
  let m = model.trim().toLowerCase();
  m = m.replace(/\[1m\]$/, ''); // context-window flag, not a distinct model
  m = m
    .replace(/^aws\/anthropic\/bedrock-/, '')
    .replace(/^aws\/anthropic\//, '')
    .replace(/^anthropic\//, '');
  // Raw Bedrock id as reported inside a streamed body: `anthropic.<model>-<date>-v1:0`.
  m = m.replace(/^anthropic\./, '').replace(/:\d+$/, '');
  m = m.replace(/-v\d+$/, ''); // bedrock revision suffix (…-v1)
  if (has(MODEL_PRICING, m)) return m;
  const undated = m.replace(/-\d{8}$/, ''); // …-20251001 snapshot
  if (has(MODEL_PRICING, undated)) return undated;
  return '';
}

/**
 * Map a Codex/OpenAI wire id onto a `CODEX_MODEL_PRICING` key, or '' when
 * unknown. Only the last path segment names the model (`azure/openai/gpt-5.6-sol`);
 * dated snapshots, `-latest`, and Azure `-global` deployment suffixes are stripped.
 */
export function normalizeCodexModel(model: string | undefined): string {
  if (!model) return '';
  const last = model.trim().toLowerCase().split('/').pop() || '';
  const candidates = [
    last,
    last.replace(/-\d{8}$/, ''),
    last.replace(/-latest$/, ''),
    last.replace(/-global$/, ''),
    last.replace(/-\d{8}$/, '').replace(/-global$/, ''),
    last.replace(/-global$/, '').replace(/-\d{8}$/, ''),
  ];
  for (const c of candidates) if (c && has(CODEX_MODEL_PRICING, c)) return c;
  return '';
}

/** Token totals for one (coworker, model) bucket of Anthropic-API calls. */
export interface ClaudeTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  /** `cache_creation_input_tokens` from calls that carried NO 5m/1h split (priced at the 5m rate). */
  cacheCreateFlat: number;
  cacheCreate5m: number;
  /** 1-hour cache writes cost 2× the input rate (ENABLE_PROMPT_CACHING_1H fleet). */
  cacheCreate1h: number;
}

/** USD for Anthropic-API token totals, or null when the model is unpriced. */
export function priceClaudeTokens(model: string | undefined, t: ClaudeTokenTotals): number | null {
  const key = normalizeModel(model);
  if (!key) return null;
  const r = MODEL_PRICING[key];
  return (
    t.input * r.input +
    t.output * r.output +
    t.cacheRead * r.cacheRead +
    t.cacheCreateFlat * r.cacheCreate +
    t.cacheCreate5m * r.cacheCreate +
    t.cacheCreate1h * (r.input * 2)
  );
}

/** Token totals for one (coworker, model) bucket of OpenAI-API calls. `input` INCLUDES `cacheRead`. */
export interface CodexTokenTotals {
  input: number;
  cacheRead: number;
  output: number;
}

/** USD for OpenAI-API token totals, or null when the model is unpriced. */
export function priceCodexTokens(model: string | undefined, t: CodexTokenTotals): number | null {
  const key = normalizeCodexModel(model);
  if (!key) return null;
  const r = CODEX_MODEL_PRICING[key];
  const uncached = Math.max(0, t.input - t.cacheRead);
  return uncached * r.input + t.cacheRead * r.cacheRead + t.output * r.output;
}

/**
 * Price one aggregated usage bucket by the API family the OneCLI body tap
 * recorded (`usage_api`). Returns null (UNKNOWN) for an unrecognised API or an
 * unpriced model — never $0.
 */
export function priceUsageBucket(usageApi: string, model: string | undefined, t: ClaudeTokenTotals): number | null {
  if (usageApi.startsWith('anthropic_')) return priceClaudeTokens(model, t);
  if (usageApi.startsWith('openai_')) {
    return priceCodexTokens(model, { input: t.input, cacheRead: t.cacheRead, output: t.output });
  }
  return null;
}
