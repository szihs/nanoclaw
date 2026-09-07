/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, DEFAULT_MODEL, FAST_MODE, GROUPS_DIR, TIMEZONE } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getCostCapPolicy } from './db/cost-cap-policy.js';
import { getAgentGroup } from './db/agent-groups.js';
import { isValidTimezone } from './timezone.js';
import { log } from './log.js';
import type { AgentGroup, ContainerConfigRow, ContainerSpeed } from './types.js';

/**
 * Container-side path where a group's stamped plugins are mounted read-only.
 * Lockstep: create-agent.ts records `pluginRoot` under this prefix and
 * container-runner.ts mounts groups/<folder>/plugins here.
 */
export const CONTAINER_PLUGINS_DIR = '/workspace/agent/plugins';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Working directory in the Agent Plugins fixed forms (./p, ${PLUGIN_ROOT}[/p],
   * ${PLUGIN_DATA}[/p]). For plugin servers the agent-runner (plugin-mcp.ts)
   * resolves it to an absolute container path; providers consume it natively
   * (codex) or via a launch shim (cwd-shim.ts). Without a pluginRoot there is
   * nothing to resolve against, so the host strips it before container.json
   * is materialized (sanitizeStoredMcpServers — the only layer that does;
   * the runtime passes provenance-less servers through untouched). No CLI flag
   * or self-mod tool param exposes it; raw payloads carrying one are rejected
   * at intake (validateAddMcpServer), on original submission and approval
   * replay alike, and sanitizeStoredMcpServers strips it from stored entries
   * that lack plugin provenance.
   */
  cwd?: string;
  /**
   * Container-side plugin root (e.g. /workspace/agent/plugins/<name>), set at
   * stamp time for servers that arrived in a plugin. Internal — never part of
   * CLI input. The agent-runner expands ${PLUGIN_ROOT}/${PLUGIN_DATA} against
   * it and injects both env vars when building the provider's server map.
   */
  pluginRoot?: string;
  /**
   * Name of the plugin that stamped this server. Ownership marker: plugin-owned
   * servers reject CLI/self-mod edits and are swapped wholesale on restamp
   * (`ncl groups create --template`). Internal — never CLI input, and not
   * re-attached by sanitizeStoredMcpServers, so it never reaches container.json.
   */
  plugin?: string;
  instructions?: string;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** See McpStdioServerConfig.plugin — same ownership marker. */
  plugin?: string;
  instructions?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/**
 * Query keys that name a credential. Keys are camelCase-normalized, then
 * matched as whole words between [_.-] separators: `author` never matches
 * `auth`, but `authToken`, `clientSecret`, and `x-auth` all do. A match
 * hard-blocks registration — the URL persists to the container config and
 * renders on the approval card, so secrets must ride via OneCLI. Non-secret
 * query params are legitimate endpoint config (e.g. Datadog's `?toolsets=apm`).
 */
const SECRET_QUERY_KEY_RE =
  /(^|[_.-])(o?auth(orization)?|(auth|access|api|session|id)?[_-]?token|secret|passw(or)?d|pwd|api[_-]?key|private[_-]?key|credentials?|bearer|jwt|sig(nature)?)([_.-]|$)/i;

/** camelCase → snake_case before matching, so `authToken` hits the word list. */
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

/**
 * Server names and env keys end up in provider config writers that emit
 * formats with structural syntax (codex writes TOML table headers), so an
 * unconstrained name is an injection vector even though the writers escape.
 * Allowlist the charset at every entry point (approval flow, ncl, templates)
 * so no downstream writer has to defend. Mirrored in
 * container/agent-runner/src/mcp-tools/self-mod.ts; keep the two in sync.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The owning plugin's name when a stored MCP server entry was stamped from a plugin. */
export function mcpServerPluginOwner(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const plugin = (entry as Record<string, unknown>).plugin;
  return typeof plugin === 'string' && plugin !== '' ? plugin : undefined;
}

/** Throws unless `name` is a safe MCP server name (1-64 chars of [A-Za-z0-9_-]). */
export function validateMcpServerName(name: string): void {
  // "__proto__" passes the regex but assigning servers["__proto__"] sets the
  // record's prototype instead of an own key — the server would be silently
  // dropped (or worse) on every intake path, so reject it by name.
  if (!MCP_SERVER_NAME_RE.test(name) || name === '__proto__') {
    throw new Error('server name must be 1-64 characters of letters, digits, "_" or "-"');
  }
}

// The Agent Plugins fixed cwd shapes: ./p, ${PLUGIN_ROOT}[/p], ${PLUGIN_DATA}[/p].
const CWD_FORM_RE = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/**
 * Parse one CLI or approval payload into the persisted MCP config shape.
 * Duplicated in container/agent-runner/src/mcp-tools/self-mod.ts
 * (parseMcpServerInput) — no shared modules across the host/container
 * boundary; keep the two in sync.
 */
export function parseMcpServerConfig(input: Record<string, unknown>): McpServerConfig {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;

  // A declared transport is honored; absence keeps the legacy CLI inference
  // (url → http, command → stdio). "streamable-http" is the Agent Plugins
  // spelling of the internal "http".
  const type = input.type === 'streamable-http' ? 'http' : input.type;
  if (type === 'sse') throw new Error('unsupported transport "sse"');
  if (type !== undefined && type !== 'stdio' && type !== 'http') {
    throw new Error('type must be "stdio", "http", or "streamable-http"');
  }
  if (type === 'stdio' && !command) throw new Error('type "stdio" requires command');
  if (type === 'http' && !url) throw new Error('type "http" requires url');

  const instructions = input.instructions;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('MCP instructions must be a string');
  }

  if (url !== undefined) {
    if (command !== undefined) throw new Error('Provide exactly one of command or url');
    if (input.args !== undefined || input.env !== undefined || input.cwd !== undefined) {
      throw new Error('args, env, and cwd are only valid with command');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error('url must be a valid HTTP(S) URL', { cause: err });
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('url must use HTTPS (plain HTTP is allowed only for localhost and host.docker.internal)');
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new Error('url must not contain credentials or fragments; use OneCLI for authentication');
    }
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_QUERY_KEY_RE.test(key.replace(CAMEL_SPLIT_RE, '$1_$2'))) {
        throw new Error(`url query parameter "${key}" looks like a credential; use OneCLI for authentication`);
      }
    }
    const headers = parseStringRecord(input.headers, 'headers');
    return {
      type: 'http',
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  }
  if (command === undefined) throw new Error('Provide exactly one of command or url');

  if (input.headers !== undefined) throw new Error('headers is only valid with url');
  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be a JSON array of strings');
  }
  const env = parseStringRecord(input.env, 'env') ?? {};
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`env key ${JSON.stringify(key)} must be a valid environment variable name`);
    }
  }
  const cwd = parseCwd(input.cwd);
  return {
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function parseStringRecord(value: unknown, flag: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${flag} must be a JSON object with string values`);
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${flag} must be a JSON object with string values`);
    record[key] = entry;
  }
  return record;
}

/** Accept only the spec's fixed cwd shapes, lexically contained (no ".." segments). */
function parseCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CWD_FORM_RE.test(value)) {
    throw new Error('cwd must be ./path, ${PLUGIN_ROOT}[/path], or ${PLUGIN_DATA}[/path]');
  }
  // rest === '' is the bare form (`${PLUGIN_DATA}`, `./`); empty segments in a
  // non-empty rest are rejected for symmetry with the command validator.
  const rest = value.startsWith('./') ? value.slice(2) : value.replace(CWD_FORM_RE, '');
  if (
    rest.includes('${') ||
    rest.includes('\\') ||
    (rest !== '' && rest.split('/').some((s) => s === '..' || s === ''))
  ) {
    throw new Error('cwd escapes the plugin root');
  }
  return value;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  /**
   * Legacy mirror of `speed: 'fast'`, written exactly as the host did before
   * `speed` existed so an agent image built then keeps fast mode working.
   */
  fastMode?: true;
  /** Provider-declared speed tier (`standard` or `fast` for Claude); the group value overrides the install default. */
  speed?: ContainerSpeed;
  timezone?: string;
  /** Session isolation tier for the group's containers; absent = the composer's default ('container'). */
  runtimeTier?: 'container' | 'vm';
  /**
   * Immortality (NanoClaw #1 cost cap): orchestrator / admin groups escalate
   * for cost-cap visibility only and are never quiesced. Derived from an
   * authoritative host field so a renamed orchestrator keeps its exemption.
   */
  immortal?: boolean;
  /**
   * Per-session soft cost cap (USD) — Tier 1. Precedence: a per-group DB override
   * (`ncl cost-cap set --cap … --group <folder>`) → env `NANOCLAW_COST_T2_USD` →
   * the group's OWN 7-day p90 in `data/cost-thresholds.json` `perGroupP90Usd[folder]`
   * → fleet `p90Usd` → a conservative $100 default. Materialized for ALL groups.
   * See `resolveCostCapT2Usd`.
   */
  costCapT2Usd?: number;
  /**
   * Tier-2 hard ceiling (USD). A non-immortal session that reaches it hard-stops;
   * immortal groups re-escalate for visibility only (never blocked). Precedence: a
   * per-group DB override → the fleet DB ceiling (both set via `ncl cost-cap set`)
   * → env `NANOCLAW_COST_T2_CEILING_USD`; 0/absent = no ceiling. See
   * `resolveCostCeilingT2Usd`.
   */
  costCeilingT2Usd?: number;
}

/**
 * Conservative fallback per-session cost cap (USD) when neither the env
 * override nor the dashboard's computed p90 threshold is available.
 */
const DEFAULT_COST_CAP_T2_USD = 100;

/**
 * Absolute floor for the auto-sourced cap (USD). A brand-new agent group (or one
 * with no priced sessions in the window) has no per-group and possibly no fleet
 * p90 — without a floor its cap could resolve to ~$0 and escalate on the first
 * turn. The floor guarantees every group escalates somewhere sane. Not applied to
 * an explicit NANOCLAW_COST_T2_USD operator override (that wins outright).
 */
const MIN_COST_CAP_T2_USD = 10;

/**
 * Resolve the per-session cost cap (USD) materialized into every group's
 * container.json (NanoClaw #1 cost cap v2).
 *
 * Precedence:
 *   0. cost_cap_policy DB per-group `cap_usd` — the operator override set at
 *      runtime via `ncl cost-cap set --cap … --group <folder>`. Highest priority,
 *      wins outright and unfloored (same class as the env override).
 *   1. NANOCLAW_COST_T2_USD env — explicit operator override, wins outright.
 *   2. data/cost-thresholds.json `perGroupP90Usd[folder]` — the group's OWN p90.
 *      A fleet number under-serves expensive groups (fixer p90 ~$91) and
 *      over-caps cheap ones (reviewer ~$12), so per-group wins when present.
 *   3. data/cost-thresholds.json `p90Usd` — fleet p90 fallback (group too new to
 *      have its own priced sample yet).
 *   4. DEFAULT_COST_CAP_T2_USD ($100) — conservative fallback.
 *
 * The auto-sourced tail (2–4) is floored at MIN_COST_CAP_T2_USD; the two explicit
 * operator overrides (0, 1) bypass the floor.
 *
 * Fail-soft: an uninitialized DB, a missing table, or a missing/unreadable/
 * malformed/non-positive thresholds file falls through to the next source rather
 * than throwing or disabling the cap.
 */
export async function resolveCostCapT2Usd(groupFolder?: string): Promise<number> {
  // 0. Runtime DB per-group override — an explicit operator decision; wins
  //    outright and unfloored, exactly like the env override below.
  if (groupFolder) {
    const dbCap = (await getCostCapPolicy(groupFolder))?.cap_usd;
    if (typeof dbCap === 'number' && Number.isFinite(dbCap) && dbCap > 0) return dbCap;
  }

  const env = Number(process.env.NANOCLAW_COST_T2_USD);
  if (Number.isFinite(env) && env > 0) return env;

  let cap = DEFAULT_COST_CAP_T2_USD;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cost-thresholds.json'), 'utf8')) as {
      p90Usd?: unknown;
      perGroupP90Usd?: Record<string, unknown>;
    };
    const g =
      groupFolder && parsed.perGroupP90Usd && typeof parsed.perGroupP90Usd === 'object'
        ? Number(parsed.perGroupP90Usd[groupFolder])
        : NaN;
    if (Number.isFinite(g) && g > 0) {
      cap = g;
    } else {
      const p90 = Number(parsed.p90Usd);
      if (Number.isFinite(p90) && p90 > 0) cap = p90;
    }
  } catch {
    // Fail-soft — missing/corrupt thresholds file falls through to the default.
  }
  // Floor the auto-sourced value so a new/zero-p90 group never caps near $0.
  return Math.max(MIN_COST_CAP_T2_USD, cap);
}

/**
 * Resolve the Tier-2 hard ceiling (USD) materialized into every container.json.
 *
 * Precedence:
 *   0. cost_cap_policy DB per-group `ceiling_usd` (`ncl cost-cap set --ceiling …
 *      --group <folder>`) — a per-group override, when present.
 *   1. cost_cap_policy DB fleet `ceiling_usd` (`ncl cost-cap set --ceiling …`) —
 *      the runtime operator ceiling.
 *   2. NANOCLAW_COST_T2_CEILING_USD env — the back-compat fallback.
 *   3. 0 — no ceiling (opt-in: an install with none keeps escalate-only behavior).
 *
 * A stored DB value wins over the env var, INCLUDING 0 (an explicit "no ceiling"
 * that overrides an env-configured ceiling). NULL/absent in the DB falls through.
 * `ncl cost-cap clear` removes a DB row to restore the env fallback. DB reads are
 * fail-soft (uninitialized DB / missing table → skip).
 */
export async function resolveCostCeilingT2Usd(groupFolder?: string): Promise<number> {
  if (groupFolder) {
    const g = (await getCostCapPolicy(groupFolder))?.ceiling_usd;
    if (typeof g === 'number' && Number.isFinite(g) && g >= 0) return g;
  }
  const fleet = (await getCostCapPolicy())?.ceiling_usd;
  if (typeof fleet === 'number' && Number.isFinite(fleet) && fleet >= 0) return fleet;

  const env = Number(process.env.NANOCLAW_COST_T2_CEILING_USD);
  if (Number.isFinite(env) && env > 0) return env;
  return 0;
}

/**
 * Effective timezone for an agent group: per-group override → install global.
 * The ncl write path validates, but a hand-edited DB value must not silently
 * flip scheduling to UTC — an invalid override falls back to the global tz,
 * same as no override.
 */
export async function resolveGroupTimezone(agentGroupId: string): Promise<string> {
  const tz = (await getContainerConfig(agentGroupId))?.timezone;
  return tz && isValidTimezone(tz) ? tz : TIMEZONE;
}

/**
 * Defense-in-depth re-validation of the stored MCP server blob (threat: a
 * hand-edited DB value bypassing the three validated write paths). Invalid
 * entries are dropped + logged instead of shipped to the container.
 */
export function sanitizeStoredMcpServers(raw: unknown, groupName: string): Record<string, McpServerConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('Stored mcp_servers is not an object; ignoring all entries', { group: groupName });
    return {};
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      log.warn('Dropping invalid stored MCP server', { group: groupName, server: name, reason: 'not an object' });
      continue;
    }
    try {
      validateMcpServerName(name);
      const server = parseMcpServerConfig(entry as Record<string, unknown>);
      const pluginRoot = (entry as Record<string, unknown>).pluginRoot;
      if (
        server.type !== 'http' &&
        typeof pluginRoot === 'string' &&
        pluginRoot.startsWith(`${CONTAINER_PLUGINS_DIR}/`)
      ) {
        server.pluginRoot = pluginRoot;
      }
      if (server.type !== 'http' && server.cwd && !server.pluginRoot) {
        // cwd resolves against a plugin root; without provenance nothing can
        // resolve it. This strip is the ONLY layer (the runtime passes
        // provenance-less servers through untouched), and the breadcrumb
        // lands in host logs instead of nowhere.
        delete server.cwd;
        log.warn('Stripping cwd from stored MCP server without plugin provenance', { group: groupName, server: name });
      }
      servers[name] = server;
      // eslint-disable-next-line no-catch-all/no-catch-all -- validation failures are data errors, not bugs
    } catch (err) {
      log.warn('Dropping invalid stored MCP server', {
        group: groupName,
        server: name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return servers;
}

/**
 * runtime_tier is an isolation control: dropping an unknown stored value would
 * silently compose the group at the default tier — a weaker boundary than the
 * one the value asked for. Fail closed instead: the group refuses to compose
 * until the stored value is fixed. (A *declared* tier the driver cannot
 * realize is refused separately by validateSpec, against the driver's
 * capabilities.)
 */
function parseRuntimeTier(raw: string | null | undefined, groupName: string): 'container' | 'vm' | undefined {
  if (raw == null) return undefined;
  if (raw === 'container' || raw === 'vm') return raw;
  throw new Error(`agent group "${groupName}" has invalid runtime_tier "${raw}" — expected "container" or "vm"`);
}

/**
 * `'all'`, or the names the group selected. Anything else is treated as `'all'`:
 * a bare string would otherwise turn an `includes` filter into a substring
 * match and silently drop skills.
 *
 * The single reading of this column. `configFromDb` used to cast it instead,
 * which threw on a corrupt row before the composer's tolerance could apply:
 * every spawn failed, and `wakeContainer`'s retry contract darkened the group.
 * Two readings that must agree is also how the document ends up teaching a
 * skill the agent was never given.
 */
export function parseSkillSelection(raw: string | undefined, groupName: string): string[] | 'all' {
  if (raw === undefined) return 'all';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === 'all') return 'all';
  if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'string')) return parsed;
  log.warn('Stored skill selection is not "all" or a string list; inlining every skill', { group: groupName });
  return 'all';
}

/**
 * The AUTHORITATIVE immortality check — the admin group (`is_admin`) or the
 * orchestrator coworker type ('main'), read from central-DB fields only.
 * Deliberately independent of anything a runner self-reports: a container
 * that claims `immortal:true` in its own live state is not proof of
 * anything — this is the check every host-side money-safety decision that
 * depends on immortality (the cost-cap materialization below, and NanoClaw
 * #1 "set ceiling v2"'s live-control submission gate in
 * `src/modules/cost-ceiling-adjustment/index.ts`) must use instead of
 * trusting the runner's own claim.
 */
export function isImmortalGroup(group: Pick<AgentGroup, 'is_admin' | 'coworker_type'>): boolean {
  return group.is_admin === 1 || group.coworker_type === 'main';
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export async function configFromDb(row: ContainerConfigRow, group: AgentGroup): Promise<ContainerConfig> {
  // NanoClaw #1 cost cap. The cap value (v2) auto-sources the fleet-wide p90
  // threshold and is emitted for ALL groups so every session carries a cap.
  const immortal = isImmortalGroup(group);
  const costCapT2Usd = await resolveCostCapT2Usd(group.folder);
  const costCeilingT2Usd = await resolveCostCeilingT2Usd(group.folder);
  return {
    mcpServers: sanitizeStoredMcpServers(JSON.parse(row.mcp_servers), group.name),
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: parseSkillSelection(row.skills, group.name),
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    // The group's own model wins; NANOCLAW_DEFAULT_MODEL fills in for groups
    // that have none. Both absent leaves the field out and the SDK decides.
    model: row.model ?? (DEFAULT_MODEL || undefined),
    effort: row.effort ?? undefined,
    // A cleared group value falls back to the install-wide default.
    ...speedFields(parseContainerSpeed(row.speed) ?? (FAST_MODE ? 'fast' : undefined)),
    timezone: row.timezone && isValidTimezone(row.timezone) ? row.timezone : undefined,
    runtimeTier: parseRuntimeTier(row.runtime_tier, group.name),
    immortal,
    costCapT2Usd,
    costCeilingT2Usd,
  };
}

/** The stored tier was validated against the provider's declaration when written; empty means unset. */
function parseContainerSpeed(value: string | null): ContainerSpeed | undefined {
  return value ? value : undefined;
}

/**
 * Unset writes neither key, so an install that sets nothing produces the same
 * file it always did. `fast` also writes the legacy `fastMode: true`, in the
 * position it always had, for agent images that still read only that key.
 */
function speedFields(speed: ContainerSpeed | undefined): Pick<ContainerConfig, 'fastMode' | 'speed'> {
  if (speed === undefined) return {};
  return speed === 'fast' ? { fastMode: true, speed } : { speed };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, composeSessionSpec, etc.).
 */
export async function materializeContainerJson(agentGroupId: string): Promise<ContainerConfig> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = await getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = await configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
