/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig, ProviderSpeed } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
  fallbackModel?: string;
  /**
   * Immortality (NanoClaw #1 cost cap): orchestrator / admin groups escalate
   * for visibility only and are NEVER quiesced by a cost stop. Host-materialized
   * from `agent_groups.is_admin === 1 || coworker_type === 'main'`. Sourced from
   * an authoritative host field, never inferred from the group name.
   */
  immortal?: boolean;
  /**
   * Per-session soft cost cap (USD). One "allotment" — a 'continue' override
   * raises the effective cap by this same amount. Host-materialized from the
   * per-group threshold; falls back to NANOCLAW_COST_T2_USD then a conservative
   * default. Host-materialized from the group's own 7-day p90.
   */
  costCapT2Usd?: number;
  /**
   * Tier-2 hard ceiling (USD). When a NON-IMMORTAL session's spend reaches this,
   * it HARD-STOPS (quiesce, no more tokens) regardless of Tier-1 escalation or a
   * 'continue' override. Immortal groups are NEVER hard-stopped — they only
   * re-escalate for visibility. Host-materialized from
   * NANOCLAW_COST_T2_CEILING_USD. 0/undefined = no ceiling (escalate-only).
   */
  costCeilingT2Usd?: number;
  /** API fast serving tier (host-configured; see the host's container-config). */
  fastMode?: boolean;
  speed?: ProviderSpeed;
}

const DEFAULT_MAX_MESSAGES = 10;

/**
 * Conservative default per-session cost cap (USD) when neither container.json
 * nor NANOCLAW_COST_T2_USD supplies one. Sized against the known cost driver:
 * a small tail of 1M-context sessions accounts for most fleet spend, so a
 * three-figure cap flags those without tripping ordinary sessions.
 */
const DEFAULT_COST_CAP_T2_USD = 100;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = runnerConfigFromRaw(raw);

  return _config;
}

/** Build the runner config from a parsed container.json; missing fields take their defaults. */
export function runnerConfigFromRaw(raw: Record<string, unknown>): RunnerConfig {
  return {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    fallbackModel: (raw.fallbackModel as string) || process.env.ANTHROPIC_FALLBACK_MODEL || undefined,
    immortal: raw.immortal === true,
    costCapT2Usd: resolveCostCapT2Usd(raw.costCapT2Usd),
    costCeilingT2Usd: resolveCostCeilingT2Usd(raw.costCeilingT2Usd),
    fastMode: raw.fastMode === true || undefined,
    speed: readSpeed(raw),
  };
}

/**
 * `speed` wins when present; the host already validated it against the
 * provider's declared tiers, so any non-empty name passes through. A host from
 * before `speed` existed wrote only `fastMode: true`, so that alone still
 * means `fast`.
 */
function readSpeed(raw: Record<string, unknown>): ProviderSpeed | undefined {
  if (typeof raw.speed === 'string' && raw.speed !== '') return raw.speed;
  return raw.fastMode === true ? 'fast' : undefined;
}

/**
 * Resolve the per-session cost cap. Precedence: NANOCLAW_COST_T2_USD env
 * override → container.json `costCapT2Usd` (host-materialized) → conservative
 * default. A non-positive or unparseable value falls through to the next
 * source so a bad hand-edit can't silently disable the cap.
 */
function resolveCostCapT2Usd(rawValue: unknown): number {
  const env = Number(process.env.NANOCLAW_COST_T2_USD);
  if (Number.isFinite(env) && env > 0) return env;
  const fromConfig = Number(rawValue);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  return DEFAULT_COST_CAP_T2_USD;
}

/**
 * Resolve the Tier-2 hard ceiling. Precedence: NANOCLAW_COST_T2_CEILING_USD env
 * → container.json `costCeilingT2Usd` (host-materialized) → 0 (no ceiling).
 * Unlike the Tier-1 cap this has NO default: a ceiling is opt-in, so an install
 * without one keeps today's escalate-only behavior.
 */
function resolveCostCeilingT2Usd(rawValue: unknown): number {
  const env = Number(process.env.NANOCLAW_COST_T2_CEILING_USD);
  if (Number.isFinite(env) && env > 0) return env;
  const fromConfig = Number(rawValue);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  return 0;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

/**
 * Test-only: set (or clear) the module config singleton directly, bypassing the
 * fixed-path `loadConfig()` read. Additive — no runtime path calls this. Tests
 * that need a specific config (e.g. the cost-cap state machine) set it in a
 * setup hook and MUST restore the pristine state by passing `null` in teardown,
 * so nothing leaks into other test files sharing the process.
 */
export function __setConfigForTest(cfg: RunnerConfig | null): void {
  _config = cfg;
}
