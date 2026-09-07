/**
 * Container Runner v2
 *
 * Composes a fully-resolved `SessionSpec` for each session and hands it to the
 * selected `SessionDriver`. Everything runtime-specific — argv, kill/stop,
 * orphan listing — lives behind the driver seam in `src/drivers/`. What stays
 * here is composition and lifecycle policy: which mounts, which env, restart
 * ordering, exit bookkeeping.
 */
import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  asNonEmpty,
  composedDocHeader,
  getAppliedOverlayNames,
  materializeCritiqueDeliveryMarkers,
  materializeCritiqueRequiredStages,
  materializeOverlayMarkers,
  readCoworkerTypes,
  readSkillCatalog,
  renderCoworkerSections,
  resolveCoworkerManifest,
  type CoworkerTypeEntry,
  type SkillMeta,
} from './claude-composer.js';
import { PROJECT_DOC_MAX_BYTES, ProjectDocTooLargeError } from './claude-composer/doc-size-cap.js';
import { renderProjectDoc, type CapDiagnostics } from './claude-composer/project-doc.js';
import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_PREFIX,
  DASHBOARD_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  INSTALL_SLUG,
  MAX_MESSAGES_PER_PROMPT,
  MCP_PROXY_PORT,
  TIMEZONE,
} from './config.js';
// resolveGroupTimezone: the fork's per-group timezone override (migration 020)
// grounds the container's TZ, falling back to the install global.
import {
  CONTAINER_PLUGINS_DIR,
  materializeContainerJson,
  resolveGroupTimezone,
  sanitizeStoredMcpServers,
} from './container-config.js';
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
// Only the binary name survives here: spawn argv, mounts, kill/stop and orphan
// reaping now live behind the driver seam (hostGatewayArgs → the driver-private
// networkArgsFor, readonlyMountArgs → MountSpec + mountArgs, stopContainer →
// SessionHandle.stop()).
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  getLiveHostInstance,
  getSessionClaim,
  listSessionsWithStopIntent,
  releaseSessionClaim,
  setStopIntent,
  shadowWrite,
  tryClaimSession,
  type SessionClaimRow,
} from './db/coordination.js';
import { getHostInstanceId } from './host-instance.js';
import { getDb, hasTable } from './db/connection.js';
import { getSession } from './db/sessions.js';
import { getSessionDriver, isSessionEventsDriver } from './drivers/index.js';
import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';
import { GROUP_FOLDER_LABEL, labelValueLegal, specInvalid } from './drivers/types.js';
import type { ContainerSpec, MountSpec, SessionFailure, SessionSpec } from './drivers/types.js';
import { getGatewayProvider, type GatewayContribution } from './gateway-providers/index.js';
import { initGroupFilesystem } from './group-init.js';
import {
  PERSONA_PREPEND_FILE,
  isComposedDocument,
  readStandingInstructionsFile,
  writeComposedDocument,
} from './group-persona.js';
import { getAgentMailbox } from './mailbox/index.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import {
  registerContainerToken,
  revokeContainerToken,
  getDiscoveredToolInventory,
  getDiscoveredToolAnnotations,
} from './mcp-auth-proxy.js';
import {
  resolveMcpAllowlist,
  serverHasAllowedTools,
  toMcpPolicyWire,
  type McpAllowlistResolution,
} from './mcp-allowlist.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionContextPath,
  sessionDir,
  writeSessionContext,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

/**
 * Cached coworker types + skill catalog — reloaded when any coworker-types.yaml
 * or SKILL.md mtime changes. Tool derivation walks the catalog so both inputs
 * participate in the fingerprint.
 */
let registryCache: {
  types: Record<string, CoworkerTypeEntry>;
  catalog: Record<string, SkillMeta>;
  fingerprint: number;
} | null = null;

function registryFingerprint(): number {
  const root = process.cwd();
  // Mirror discovery roots in src/claude-composer/registry.ts. Any change to a
  // spine, workflow, overlay, or capability skill file invalidates the cache.
  const roots: { dir: string; files: string[] }[] = [
    { dir: path.join(root, 'container', 'skills'), files: ['coworker-types.yaml', 'SKILL.md'] },
    { dir: path.join(root, 'container', 'workflows'), files: ['WORKFLOW.md'] },
    { dir: path.join(root, 'container', 'overlays'), files: ['OVERLAY.md'] },
    { dir: path.join(root, 'container', 'spines'), files: ['coworker-types.yaml'] },
  ];
  let maxMtime = 0;
  for (const { dir, files } of roots) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        for (const file of files) {
          try {
            maxMtime = Math.max(maxMtime, fs.statSync(path.join(dir, entry, file)).mtimeMs);
          } catch {
            /* file does not exist */
          }
        }
      }
    } catch {
      /* root dir does not exist */
    }
  }
  return maxMtime;
}

function loadRegistry(): { types: Record<string, CoworkerTypeEntry>; catalog: Record<string, SkillMeta> } {
  try {
    const fp = registryFingerprint();
    if (registryCache && registryCache.fingerprint === fp) {
      return { types: registryCache.types, catalog: registryCache.catalog };
    }
    const projectRoot = process.cwd();
    const types = readCoworkerTypes(projectRoot);
    const catalog = readSkillCatalog(projectRoot);
    registryCache = { types, catalog, fingerprint: fp };
    return { types, catalog };
  } catch (err) {
    log.warn('Failed to load coworker registry', { err });
    return { types: {}, catalog: {} };
  }
}

export function resetCoworkerTypesCacheForTests(): void {
  registryCache = null;
}

// GPU passthrough moved to the driver seam (src/drivers/index.ts's
// driver-private `hostDeviceArgs` lane): whether this host has an NVIDIA
// runtime is a property of the host, not of the session, so it never rides
// the composed spec.

/**
 * Docker defaults /dev/shm to 64m, which silently short-writes past that size.
 * agent-browser passes --disable-dev-shm-usage, but a third-party puppeteer or
 * Playwright launcher may not.
 */
const SHM_SIZE_MB = 1024;
/** Grace before SIGKILL. One second, as `docker stop -t 1` has always been. */
const STOP_GRACE_SECONDS = 1;

/** Active sessions tracked by session ID. */
interface ActiveSessionRuntime {
  /**
   * The realized session. Was `process: ChildProcess` — a session that is not
   * a child process of the host could not be represented at all, and that
   * single field was what made every runtime other than a locally-spawned
   * docker CLI inexpressible.
   */
  handle: SupervisedHandle;
  containerName: string;
  /**
   * NanoClaw #1 "set ceiling v2" readiness-handshake nonce — the value this
   * host stamped as `NANOCLAW_RUNNER_INSTANCE_ID` on THIS spawn, echoed back
   * by the runner in `session_state.cost_control_protocol`. Comparing the two
   * closes a TOCTOU gap: a stale handshake left behind by a PRIOR container
   * instance of the same session id (died and respawned between a browser's
   * read and the host's accept-or-reject decision) carries the OLD instance's
   * nonce, not this one's, so it is provably stale rather than silently
   * accepted. Undefined for an ADOPTED runtime (`adopted: true`): the host
   * restarted and re-attached to an already-running container it did not
   * itself spawn, so it has no verified nonce to compare against — by design,
   * a live ceiling adjustment cannot be confirmed ready for an adopted
   * session until that session next respawns with a fresh nonce (fail
   * closed: never a false match, not a regression from before this feature
   * existed).
   */
  instanceId?: string;
  /**
   * When this host started tracking the runtime. Backs the sweep's ceiling
   * check when no heartbeat file exists yet (see `host-sweep.ts`): a container
   * that finishes its turn without ever reaching an SDK event never writes one,
   * and without this it would sit alive-but-idle forever, immune to the check.
   * An adopted runtime records the adoption, which is the honest answer — this
   * host has no spawn time for a container a previous host started, and leaving
   * it unset would exempt every adopted session from the ceiling.
   */
  startedAtMs: number;
  /** True when this runtime was adopted at startup rather than spawned here. */
  adopted: boolean;
  exitCallbacks: Array<() => void>;
  finished: boolean;
  finishedPromise: Promise<void>;
  resolveFinished: () => void;
  stopReason?: string;
  /** Incarnation this process shadow-claimed in session_claims, if the write landed. */
  claimIncarnation?: number;
  /** A deferred fenced finalization is already queued for this runtime. */
  deferredFinishScheduled?: boolean;
}

const activeContainers = new Map<string, ActiveSessionRuntime>();

// Claimant identity for the session_claims rows: the host's durable lease
// instance id when the lease is running, else a process-scoped fallback
// (tests, tools). The lease id is what makes claims answerable against
// host_instances liveness below.
function claimantId(): string {
  return getHostInstanceId() ?? `${os.hostname()}:${process.pid}`;
}

/**
 * Claim a session this process is about to run (spawn or adopt). The
 * `session_claims` row is the authority for which process/incarnation owns a
 * session: losing the compare-and-set means another live claimant got there
 * first, and the caller must not start or adopt a container for it. Returns
 * the claimed incarnation, or null when the claim was lost. Throws on a
 * failed write — a claim that cannot be recorded is a claim not held.
 *
 * A claim held by a LIVE peer host (a host_instances row that is not stopped
 * and whose lease is unexpired) is refused outright — two live hosts must
 * never trade a session back and forth. A claim whose holder is stopped,
 * lease-expired, or unknown (older claimant-id schemes) stays takeover-able:
 * a crashed claimant must never wedge a session.
 */
async function claimSessionRun(sessionId: string, containerRef: string): Promise<number | null> {
  const current = await getSessionClaim(sessionId);
  const self = claimantId();
  if (current?.claimed_by && current.claimed_by !== self) {
    const holder = await getLiveHostInstance(current.claimed_by, new Date().toISOString());
    if (holder) {
      log.warn('Refusing session claim held by a live peer host', {
        sessionId,
        holder: current.claimed_by,
        claimant: self,
      });
      return null;
    }
  }
  return tryClaimSession({
    sessionId,
    instanceId: self,
    expectedIncarnation: current?.incarnation ?? 0,
    containerRef,
    now: new Date().toISOString(),
  });
}

/** Release our claim at this incarnation. Never throws — a failed release is
 *  self-healing (the next claimant's CAS supersedes it). */
async function releaseClaimQuietly(sessionId: string, incarnation: number): Promise<void> {
  await shadowWrite('session-claim-release', () =>
    releaseSessionClaim({
      sessionId,
      instanceId: claimantId(),
      incarnation,
      now: new Date().toISOString(),
    }),
  );
}

/**
 * The runner-instance nonce for a session's CURRENTLY active container, if one
 * is running AND was freshly spawned by this host process (see
 * `ActiveSessionRuntime.instanceId`). Returns undefined both when no
 * container is tracked as running for this session, and when the tracked
 * container was adopted rather than spawned — either way the caller (the
 * cost-ceiling-adjustment readiness check) must treat that as "nothing to
 * match against yet," not as a match.
 */
export function getActiveContainerInstanceId(sessionId: string): string | undefined {
  return activeContainers.get(sessionId)?.instanceId;
}

/**
 * Normalize the operator override for the transcript age-rotation trigger into
 * the value forwarded to the container. Default '0' (disabled). Only a finite
 * numeric string is passed through verbatim; undefined, blank, whitespace, or
 * a non-numeric value all become '0'. This is deliberately stricter than a
 * `?? '0'` guard: the container reader treats a blank/non-numeric value as the
 * 14-day DEFAULT, so forwarding one would silently re-enable the age rotation
 * this override exists to disable (issue #1327).
 */
export function normalizeRotateAgeDays(raw: string | undefined): string {
  if (raw === undefined) return '0';
  const trimmed = raw.trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return '0';
  return trimmed;
}

/** SHA-256 hash of CLAUDE.md at spawn time, keyed by session ID. */
const spawnedClaudeMdHash = new Map<string, string>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup — otherwise a
 * second wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing racy
 * double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

/**
 * Compose CLAUDE.md from the lego coworker model: spine fragments + skills +
 * workflows + overlays + trait bindings, discovered under
 * `container/{spines,skills,workflows,overlays}/`. See docs/lego-coworker-workflows.md.
 *
 * Runs for ALL non-admin coworkers on every container wake. CLAUDE.md is
 * system-owned (regenerated from the manifest + .instructions.md on every
 * wake). User edits go in .instructions.md and are appended after the spine.
 */
/**
 * A group's standing instructions, converging on ONE file.
 *
 * `instructions.prepend.md` is canonical. It is what four writers already use
 * (`group-init.ts`, `templates/create-agent.ts`, `templates/restamp.ts`,
 * `scripts/init-first-agent.ts`), what upstream reads, and — the deciding
 * reason — what every agent-facing doc tells the agent to edit:
 * `container/CLAUDE.md`, the memory-system definition, `self-customize`,
 * `okf-synthesis`. Its only reader used to be the project-doc composer this
 * fork replaced with the spine, so an agent that followed its own instructions
 * wrote to a file nothing composed, and a template-stamped group or the OWNER
 * group from `init-first-agent` got no persona at all. Silently.
 *
 * `.instructions.md` was the fork's parallel surface. Rather than read both
 * forever — two names for one concept is what caused this — migrate it once, on
 * the spawn that finds it, and read only the canonical file afterwards.
 *
 * READ-ONLY, and that is load-bearing. Four call sites need standing
 * instructions: the two spawn paths and the two staleness-hash paths. The sweep
 * hashes every group's candidate document every 60 seconds, so a rename in here
 * meant the "pure" render mutated the shared group directory on a timer — the one
 * thing the seam's design and `composed-doc-render-seam.test.ts` both claim it
 * does not do. The rename now lives in `migrateStandingInstructions`, called once
 * from the publication path, which is the only caller allowed to write.
 */
export function readStandingInstructions(groupDir: string, instructionsPath: string): string | null {
  // PRESENCE decides precedence, not content. A canonical file that exists but
  // yields nothing usable — empty, whitespace-only, a directory, a symlink — must
  // not hand precedence back to a stale legacy file. The rename made that
  // unreachable at base; reading both files makes it reachable again.
  const canonical = readStandingInstructionsFile(path.join(groupDir, PERSONA_PREPEND_FILE));
  if (canonical.present) return canonical.content;

  // Same no-follow reader for the legacy name. Both files sit in the read-WRITE
  // group mount and both land verbatim in the composed system prompt, so both
  // need the same guard: a plain `readFileSync` here lets a symlinked
  // `.instructions.md` read an arbitrary host file into the next document.
  // Measured, before this call went through the guard: a symlink to a file
  // outside the group dir was returned as the persona.
  return readStandingInstructionsFile(instructionsPath).content;
}

/**
 * Perform the one-time `.instructions.md` → `instructions.prepend.md` rename.
 *
 * Skipped when the canonical file also exists: that means someone wrote it too,
 * and clobbering it would lose the newer intent. A failure is not fatal —
 * `readStandingInstructions` still finds the legacy file, so the group keeps its
 * persona this spawn and the rename is retried on the next one.
 */
export function migrateStandingInstructions(groupDir: string, instructionsPath: string): void {
  const canonical = path.join(groupDir, PERSONA_PREPEND_FILE);
  if (!fs.existsSync(instructionsPath) || fs.existsSync(canonical)) return;
  try {
    fs.renameSync(instructionsPath, canonical);
    log.info('Migrated .instructions.md to instructions.prepend.md', { dir: groupDir });
  } catch (err) {
    log.warn('Could not migrate .instructions.md; reading it in place', { dir: groupDir, err });
  }
}

/**
 * Decide whether a failed composition may still spawn.
 *
 * Both compose paths used to swallow every error as a `log.warn` and let the
 * spawn continue. A group whose composition threw then ran with NO project
 * document at all — no persona, no invariants, no chain-reporting rules — and
 * nothing went red. That is the worst outcome available: an agent that looks
 * healthy while operating without its instructions.
 *
 * Stale beats absent, so a pre-existing non-empty document is tolerated (loudly)
 * — the group keeps the last good instructions until the cause is fixed. With no
 * usable document there is nothing to degrade to, and spawning cannot be made
 * safe, so this throws and the caller aborts the spawn.
 */
/**
 * The compose inputs for one agent group, in ONE place.
 *
 * Four call sites need them: the two spawn paths (untyped and typed) plus the two
 * staleness-hash paths. When each built its own options object, a section added
 * to one and not the others made the digests disagree — the sweep would either
 * see permanent drift and restart containers on every pass, or miss a real change
 * and never refresh. Neither failure is visible in a test that only exercises
 * spawn.
 *
 * Untyped groups compose through the `default` leaf: it extends `base-common`
 * with no project skills, i.e. the bare spine.
 */
async function composeOptionsFor(agentGroup: AgentGroup): Promise<{
  coworkerType: string;
  extraInstructions: string | null;
  disableOverlays: boolean;
  overlays: string[] | undefined;
  cliScope: 'disabled' | 'group' | 'global';
  mcpInstructions: Record<string, string> | undefined;
}> {
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const configRow = await getContainerConfig(agentGroup.id);
  return {
    coworkerType: agentGroup.coworker_type || 'default',
    extraInstructions: readStandingInstructions(groupDir, path.join(groupDir, '.instructions.md')),
    disableOverlays: agentGroup.disable_overlays === 1,
    overlays: agentGroup.overlays ? JSON.parse(agentGroup.overlays) : undefined,
    cliScope: (configRow?.cli_scope ?? 'group') as 'disabled' | 'group' | 'global',
    mcpInstructions: readMcpInstructions(configRow?.mcp_servers, agentGroup.name),
  };
}

/**
 * Extract per-server `instructions` from a group's stored `mcp_servers` JSON.
 *
 * Routed through `sanitizeStoredMcpServers` rather than reading the JSON
 * directly: that is the layer which validates each entry and drops malformed
 * ones, and `instructions` is copied verbatim into an always-loaded document, so
 * it must not come from an unvalidated blob. A server whose config is rejected
 * contributes no prose — the alternative would be honouring guidance for a
 * server the agent cannot actually reach.
 *
 * Returns `undefined` when no server carries instructions, so the composer emits
 * no section at all rather than an empty heading.
 */
function readMcpInstructions(rawMcpServers: string | undefined, groupName: string): Record<string, string> | undefined {
  if (!rawMcpServers) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMcpServers);
  } catch (err) {
    // The sanitizer handles a well-formed-but-wrong shape; unparseable JSON never
    // reaches it. Composition must not die over one bad config row.
    log.warn('Stored mcp_servers is not valid JSON; omitting MCP instructions', { group: groupName, err });
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [name, server] of Object.entries(sanitizeStoredMcpServers(parsed, groupName))) {
    if (server.instructions?.trim()) out[name] = server.instructions;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Render a group's document and hash it, from the single options builder above.
 * Both staleness paths and the spawn hash agree by construction rather than by
 * four separate call sites happening to stay in sync.
 */
export async function renderComposedDocument(agentGroup: AgentGroup): Promise<{
  content: string;
  hash: string;
  dropped: readonly string[];
  diagnostics: CapDiagnostics;
  opts: Awaited<ReturnType<typeof composeOptionsFor>>;
}> {
  const opts = await composeOptionsFor(agentGroup);
  // Cap applied by the assembler now, which is what makes eviction possible: the
  // ladder drops the largest droppable section (per-server MCP guidance) before
  // concluding the document cannot fit, instead of refusing outright. Only when
  // nothing droppable is left does it throw, and the caller's `catch` still routes
  // to `assertComposedDocUsable`.
  //
  // Here rather than at the write sites: this seam is the one place both spawn
  // paths and both staleness paths pass through, so an oversized document can
  // never reach `writeComposedDocument`, and the sweep sees the same decision
  // instead of hashing a document spawn would reject.
  const rendered = renderProjectDoc(composedDocHeader(), {
    fileName: 'CLAUDE.md',
    maxBytes: PROJECT_DOC_MAX_BYTES,
    extraSections: asNonEmpty(
      renderCoworkerSections(process.cwd(), opts.coworkerType, opts.extraInstructions, {
        disableOverlays: opts.disableOverlays,
        overlays: opts.overlays,
        cliScope: opts.cliScope,
        mcpInstructions: opts.mcpInstructions,
      }),
    ),
  });

  return {
    content: rendered.content,
    // Of the bytes just assembled, not of a second composition: the file and the
    // hash come from one render, so an input edited between two calls can no
    // longer make `spawnedClaudeMdHash` describe a document never published.
    hash: rendered.hash,
    dropped: rendered.dropped,
    diagnostics: rendered.diagnostics,
    opts,
  };
}

/**
 * Returns the RETAINED document so the caller can report it, rather than only
 * asserting it exists.
 *
 * The bytes and the digest come from one read of the same unmodified string:
 * `trim()` decides usability only, and hashing a trimmed copy would produce a
 * digest of a document that was never on disk — which `detectStaleContainers`
 * would then compare against a real one, forever.
 */
export function assertComposedDocUsable(
  claudeMdPath: string,
  agentGroup: AgentGroup,
  err: unknown,
): { content: string; hash: string } {
  let content: string | undefined;
  try {
    // Read, don't stat. `size > 0` accepted a file of pure whitespace as
    // "usable", so a group could spawn on a document carrying no instructions at
    // all while the log claimed a healthy fallback. Cheap: these documents are
    // tens of KB, bounded by the size cap.
    content = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    /* absent or unreadable — handled below */
  }

  if (content !== undefined && content.trim().length > 0) {
    // "render/publication", not "composition": this is reached both when the
    // render throws and when the atomic write fails, and "retained" rather than
    // "previous" because the distinction that matters is that these bytes were
    // NOT produced by this attempt.
    log.error('CLAUDE.md render/publication failed; spawning on the retained document', {
      folder: agentGroup.folder,
      bytes: content.length,
      err,
    });
    return { content, hash: crypto.createHash('sha256').update(content).digest('hex') };
  }

  log.error('CLAUDE.md composition failed and no usable document exists — refusing to spawn', {
    folder: agentGroup.folder,
    path: claudeMdPath,
    err,
  });
  throw new Error(
    `CLAUDE.md composition failed for '${agentGroup.folder}' and no usable document exists: ${String(err)}`,
  );
}

/**
 * What one publication attempt did. Consumed by spawn, the only caller that
 * publishes and the only one that can act on a marker failure — because it has
 * not started the container yet.
 */
export type PublishedProjectDoc =
  | {
      published: true;
      content: string;
      hash: string;
      dropped: readonly string[];
      diagnostics: CapDiagnostics;
      /** Document written atomically, but marker materialization threw. */
      markersStale: boolean;
    }
  /** `content`/`hash` describe the RETAINED document, still on disk. */
  | { published: false; content: string; hash: string; attemptedDropped: readonly string[] };

/**
 * Report size-cap pressure after a successful publication.
 *
 * At base this warning came from `assertWithinDocSizeCap`, which spawn called
 * inside `renderComposedDocument`. Moving the cap into the assembler removed that
 * helper's last production caller, so until this existed a group could sit one
 * byte under the cap, or silently lose whole sections to eviction, with nothing in
 * the log — the diagnostics were computed and thrown away.
 *
 * It cannot live in the render: the 60s sweep renders every group to compare
 * hashes, so a near-cap document would repeat the same warning forever.
 * Publication happens once per spawn, which is the rate this should fire at.
 *
 * A separate exported function rather than an inline block so the three
 * conditions can be asserted behaviourally against a mocked logger. Asserting
 * them by matching the runner's source text passes for logging that is dead or
 * fires on the wrong condition.
 */
export function reportProjectDocPressure(
  folder: string,
  coworkerType: string,
  rendered: { dropped: readonly string[]; diagnostics: CapDiagnostics },
): void {
  const { diagnostics } = rendered;
  if (diagnostics.nearCap || rendered.dropped.length > 0 || diagnostics.structurallyOmitted.length > 0) {
    log.warn('Composed document is under size-cap pressure', {
      folder,
      coworkerType,
      bytes: diagnostics.bytes,
      maxBytes: diagnostics.maxBytes,
      dropped: rendered.dropped.length > 0 ? rendered.dropped : undefined,
      structurallyOmitted: diagnostics.structurallyOmitted.length > 0 ? diagnostics.structurallyOmitted : undefined,
      largestSections: diagnostics.sections.slice(0, 5),
    });
    return;
  }

  log.debug('CLAUDE.md composed from lego spine', { folder, coworkerType });
}

async function composeCoworkerClaudeMd(agentGroup: AgentGroup): Promise<PublishedProjectDoc> {
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const instructionsPath = path.join(groupDir, '.instructions.md');

  // A hand-written CLAUDE.md from before this fork composed the file becomes the
  // group's standing instructions. Lands on the canonical name directly: writing
  // `.instructions.md` here would recreate the legacy surface that
  // `readStandingInstructions` migrates away from.
  const personaPath = path.join(groupDir, PERSONA_PREPEND_FILE);
  if (
    !agentGroup.coworker_type &&
    !fs.existsSync(instructionsPath) &&
    !fs.existsSync(personaPath) &&
    fs.existsSync(claudeMdPath)
  ) {
    // Only a HAND-WRITTEN document is a persona. A composed CLAUDE.md is this
    // function's own output — spine fragments, workflows, skills and
    // instructions.prepend.md merged — so migrating one into the persona input
    // folds the whole document into the next composition, and again on the spawn
    // after that. Reachable whenever an untyped group loses its persona file
    // while a composed CLAUDE.md remains.
    let composed = true;
    try {
      composed = isComposedDocument(fs.readFileSync(claudeMdPath, 'utf-8'));
    } catch (err) {
      // Unreadable is not migratable: leave it for the composer to overwrite
      // rather than rename a document we could not classify.
      log.warn('Could not read CLAUDE.md to classify it; skipping persona migration', {
        folder: agentGroup.folder,
        err,
      });
    }
    if (composed) {
      log.debug('CLAUDE.md is composer output, not a persona — not migrating', { folder: agentGroup.folder });
    } else {
      // COPY, don't rename. A rename removed the group's only document BEFORE
      // composition ran, so a compose failure left `assertComposedDocUsable` with
      // nothing to fall back on and it refused to spawn a group that had a
      // perfectly good document moments earlier.
      //
      // No cleanup is needed on success: `writeComposedDocument` publishes by
      // renaming over this very path, so the composed document replaces the
      // legacy one. On failure the legacy document survives — which is the point.
      // `COPYFILE_EXCL` closes the gap between the `existsSync` check above and
      // this write; a failed migration must not cost the group its spawn, so it
      // is logged rather than thrown.
      try {
        fs.copyFileSync(claudeMdPath, personaPath, fs.constants.COPYFILE_EXCL);
        log.info('Auto-migrated CLAUDE.md to instructions.prepend.md', { folder: agentGroup.folder });
      } catch (err) {
        log.warn('Could not migrate CLAUDE.md to instructions.prepend.md; leaving both in place', {
          folder: agentGroup.folder,
          err,
        });
      }
    }
  }

  // Converge the two standing-instruction filenames, here and nowhere else. The
  // read path is shared with the 60s staleness sweep, so a rename inside it turned
  // every hash comparison into a write against the shared group directory.
  // Publication runs once per spawn and already owns the writes.
  migrateStandingInstructions(groupDir, instructionsPath);

  // ONE publication path for typed and untyped groups. They were two
  // near-identical arms differing only in the coworker type they named, and
  // `composeOptionsFor` already resolves an untyped group to the 'default' leaf —
  // so the duplication bought nothing and was exactly the shape that lets two
  // behaviours drift apart.
  //
  // Phase 1 — render and publish the document. Only these three operations belong
  // in this catch, because only they leave the previous document intact on failure.
  let rendered: Awaited<ReturnType<typeof renderComposedDocument>>;
  let attemptedDropped: readonly string[] = [];
  try {
    rendered = await renderComposedDocument(agentGroup);
    // The ladder may have evicted sections before succeeding; report them even on
    // the happy path's failure sibling below.
    attemptedDropped = rendered.dropped;

    fs.mkdirSync(groupDir, { recursive: true });
    writeComposedDocument(claudeMdPath, rendered.content);
  } catch (err) {
    // Drop-some-then-still-fail: the eviction list exists only inside the render,
    // which threw, so the error is the only path it can travel.
    if (err instanceof ProjectDocTooLargeError) attemptedDropped = err.dropped;

    const previous = assertComposedDocUsable(claudeMdPath, agentGroup, err);
    return { published: false, content: previous.content, hash: previous.hash, attemptedDropped };
  }

  // Phase 2 — markers, in their OWN catch. Sharing the phase-1 catch was the
  // misattribution bug: a marker throw sent `assertComposedDocUsable` to read the
  // document THIS call just wrote, which is non-empty, so it logged "spawning on
  // the previous document" (wrong file, wrong cause) and let the spawn proceed with
  // markers describing the old document.
  const coworkerType = rendered.opts.coworkerType;
  try {
    // Materialize MARKER files for overlays carrying one (e.g. buddy-monitor).
    // Containers see /workspace/agent/.overlay-<name> via the standard mount;
    // hooks like spawn-buddy.sh test for these files to gate themselves.
    const appliedOverlays = getAppliedOverlayNames(process.cwd(), coworkerType, rendered.opts);
    const types = readCoworkerTypes(process.cwd());
    materializeOverlayMarkers(appliedOverlays, process.cwd(), groupDir);
    materializeCritiqueRequiredStages(coworkerType, types, appliedOverlays, groupDir);
    materializeCritiqueDeliveryMarkers(coworkerType, types, appliedOverlays, groupDir);
  } catch (err) {
    // Deliberately NOT `assertComposedDocUsable`: the document has already been
    // replaced, so there is nothing to fall back to and that helper would inspect
    // the new document and call it the previous one.
    log.error('CLAUDE.md published but marker materialization failed — refusing to spawn', {
      folder: agentGroup.folder,
      coworkerType,
      hash: rendered.hash.slice(0, 12),
      err,
    });
    return {
      published: true,
      content: rendered.content,
      hash: rendered.hash,
      dropped: rendered.dropped,
      diagnostics: rendered.diagnostics,
      markersStale: true,
    };
  }

  // After the markers, so the log describes a fully published document.
  reportProjectDocPressure(agentGroup.folder, coworkerType, rendered);

  return {
    published: true,
    content: rendered.content,
    hash: rendered.hash,
    dropped: rendered.dropped,
    diagnostics: rendered.diagnostics,
    markersStale: false,
  };
}

/** Resolve the coworker manifest once; returns tools, mcpServers, overlay names, and workflow summaries. */
function resolveTypeManifest(agentGroup: AgentGroup): {
  tools: string[];
  mcpServers: Record<string, unknown>;
  overlayNames: string[];
  workflows: { name: string; description: string }[];
} {
  // Untyped coworker → resolve as 'default' so it gets the same tool
  // allowlist, MCP servers, and overlays as its composed CLAUDE.md
  // (composeCoworkerClaudeMd above also renders via 'default').
  const effectiveType = agentGroup.coworker_type || 'default';
  try {
    const { types, catalog } = loadRegistry();
    const manifest = resolveCoworkerManifest(types, effectiveType, catalog, process.cwd());
    const overlayNames = [
      ...new Set(
        manifest.customizations.filter((c) => c.kind === 'overlay' && c.overlayName).map((c) => c.overlayName!),
      ),
    ];
    return {
      tools: manifest.tools.filter((t) => t.startsWith('mcp__')),
      mcpServers: manifest.mcpServers ?? {},
      overlayNames,
      workflows: manifest.workflows.map((w) => ({ name: w.name, description: w.description })),
    };
  } catch (err) {
    log.warn('Failed to resolve coworker manifest', { coworkerType: effectiveType, err });
    return { tools: [], mcpServers: {}, overlayNames: [], workflows: [] };
  }
}

/**
 * Whether the runtime overlay hooks (gate-plan, gate-critique-on-deliver,
 * track-edits, track-critique, intent-router, workflow-state-reset) should
 * be injected into the container's settings.json for this agent group.
 *
 * Critique enforcement under Model A is overlay-marker-gated at the hook
 * level (gate-critique-on-deliver.sh first-line `[ -f .overlay-critique-gate ]`),
 * so wiring the hook universally is safe — coworkers without the overlay
 * are no-op'd by the hook itself. The flags returned here decide whether to
 * wire the hook configuration AT ALL into settings.json; we keep it
 * unconditional now (always wire), matching the symmetric opt-in design.
 *
 * `disable_overlays=1` still wins as a hard kill switch: when set, neither
 * gate runs, mirroring the compose-time strip of overlay prose.
 *
 * Exported for the R20 runtime-side counterpart of the R19 compose-time test.
 */
export function resolveOverlayHookFlags(agentGroup: AgentGroup): { hasPlan: boolean; hasCritique: boolean } {
  if (agentGroup.disable_overlays === 1) return { hasPlan: false, hasCritique: false };
  // Hooks are wired unconditionally; per-coworker activation lives in the
  // hook's marker check (`/workspace/agent/.overlay-<name>`), materialized by
  // the composer when the coworker's `overlays:` list includes the relevant
  // overlay. See container/overlays/{buddy-monitor,critique-gate}/MARKER.
  return { hasPlan: true, hasCritique: true };
}

/**
 * The tools this group's container may call, per the single allow-list policy
 * in mcp-allowlist.ts — the same resolver `ncl groups mcp-tools get/set` reads,
 * so what an operator is shown is what the next spawn enforces.
 *
 * The coworker manifest is passed in because this path already resolves it
 * (behind the registry fingerprint cache) and would otherwise re-read the
 * registry on every spawn.
 */
export function resolveAllowedMcpTools(agentGroup: AgentGroup): string[] {
  return resolveMcpPolicy(agentGroup).tools;
}

/**
 * The full allow-list resolution for a group — state included, not just the
 * list. Enforcement needs the state: an empty `explicit` list has zero tools
 * and denies everything, while an `inherited` group has whatever the inventory
 * happens to hold and denies nothing. Length cannot tell those apart.
 */
export function resolveMcpPolicy(agentGroup: AgentGroup): McpAllowlistResolution {
  return resolveMcpAllowlist(agentGroup);
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

/**
 * Tail of a session id used in container names (strips the `sess-` prefix).
 * Exported so the dashboard can reconstruct the `<prefix>-<folder>-<tail>`
 * shape when matching `docker ps` output to a specific NanoClaw session.
 */
export function containerSessionTail(sessionId: string): string {
  return sessionId.startsWith('sess-') ? sessionId.slice(5) : sessionId;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

export function getContainerStartedAtMs(sessionId: string): number | undefined {
  return activeContainers.get(sessionId)?.startedAtMs;
}

/**
 * Sessions whose running container could not be claim-fenced at adoption (the
 * store was unreachable). They are deliberately NOT in the registry — nothing
 * supervises them yet — but they are alive, so the wake path must reclaim them
 * instead of spawning a duplicate. Cleared on a successful retry, on
 * discovering the container gone, or on losing the claim to another live host.
 */
const pendingAdoptions = new Set<string>();

export function _resetAdoptionRetryStateForTesting(): void {
  pendingAdoptions.clear();
}

/**
 * Retry the claim-fenced adoption of a container that survived a failed claim
 * write. Re-lists from the driver (fresher truth than any cached handle):
 * container gone → false, a fresh spawn is correct; claim lost to a live
 * host → throws, no spawn either; store still down → throws, wake retries.
 */
async function retryPendingAdoption(session: Session): Promise<boolean> {
  const driver = getSessionDriver();
  const snapshots = await driver.listSessions(INSTALL_SLUG);
  const snapshot = snapshots.find(({ handle, phase }) => handle.key.sessionId === session.id && phase === 'running');
  if (!snapshot) {
    pendingAdoptions.delete(session.id);
    return false;
  }
  const claimIncarnation = await claimSessionRun(session.id, snapshot.handle.name);
  if (claimIncarnation === null) {
    pendingAdoptions.delete(session.id);
    throw new Error(
      `session ${session.id} is claimed by another live host process — not adopting or spawning a duplicate`,
    );
  }
  const runtime = registerRuntime(session.id, snapshot.handle, snapshot.handle.name, true);
  runtime.claimIncarnation = claimIncarnation;
  runtime.stopReason = undefined;
  snapshot.handle.onTerminal((failure) => {
    void finishAndResolve(session.id, runtime, failure);
  });
  await markContainerRunning(session.id);
  pendingAdoptions.delete(session.id);
  log.info('Adopted surviving container on retry after a failed claim write', { sessionId: session.id });
  return true;
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` if the container is (or becomes)
 * running, `false` on a skipped wake (closed session or paused agent group) or
 * a transient spawn failure (e.g. the container runtime / OneCLI gateway is
 * unreachable). Callers don't need to wrap — the inbound row stays pending and
 * host-sweep retries on its next tick — but callers that care (e.g. a typing
 * indicator) can branch on it.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = wakeGuarded(session).finally(() => {
    wakePromises.delete(session.id);
  });
  wakePromises.set(session.id, promise);
  return promise;
}

/**
 * The wake's async body: the closed/paused gates plus the spawn.
 *
 * Split out of `wakeContainer` so the in-flight promise is registered
 * SYNCHRONOUSLY. Both gates now read the central DB asynchronously, and running
 * them before the dedup check would give two concurrent wakes an interleaving
 * point between the check and the registration — both would miss the other and
 * spawn a container for the same session.
 */
async function wakeGuarded(session: Session): Promise<boolean> {
  // Never respawn a session that has been closed (e.g. admin clicked Stop on a
  // runaway card). The approval response-handler fires wakeContainer after
  // every card response, and the sweep can race; re-read the authoritative
  // status here so a Stop is final. getActiveSessions already filters the
  // sweep, but this guards the direct-wake paths too.
  const current = await getSession(session.id);
  if (current && current.status === 'closed') {
    log.debug('Skipping wake of closed session', { sessionId: session.id });
    return false;
  }
  // Operator kill switch. This is THE choke point every wake path funnels
  // through — router @mention fanout (via delivery), agent-to-agent /
  // host-direct delivery, the 60s host-sweep's due-message wake, scheduled-task
  // fires, and container-restart all call wakeContainer, and spawnContainer has
  // no other caller. A per-wiring pause was proven insufficient on
  // slang-coworkers prod (2026-08-13): the a2a and sweep paths never consult
  // wirings, so a wiring-paused approver kept spawning. Gating the spawn itself
  // is the only pause all four honour. Messages keep accumulating in the
  // session DB; unpausing (paused=0) lets the next sweep pick them up — no work
  // is lost, the group just stops burning tokens.
  const group = await getAgentGroup(session.agent_group_id);
  if (group?.paused) {
    log.info('Skipping wake — agent group is paused', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    return false;
  }
  try {
    await spawnContainer(session);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- wakeContainer's contract is never-throws
  } catch (err) {
    log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
    return false;
  }
}

async function spawnContainer(session: Session): Promise<void> {
  if (pendingAdoptions.has(session.id)) {
    // A running container is waiting to be re-fenced after a failed adoption
    // claim. Reclaim it rather than spawning a duplicate; its poll loop picks
    // up any pending mail the moment it is ours again.
    if (await retryPendingAdoption(session)) return;
  }
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Initialize per-group filesystem + container_configs row before any code
  // path that reads container config (composeCoworkerClaudeMd reads cli_scope;
  // resolveProviderContribution calls materializeContainerJson which throws
  // when the row is missing). initGroupFilesystem is documented idempotent
  // (group-init.ts:91) so this is a no-op for groups that have spawned
  // before. Running it here makes spawn self-healing for any creation path
  // that didn't pre-create the row (e.g. the dashboard create-coworker
  // handler) — without this, a brand-new coworker stays jammed in a
  // 1-per-minute "Container config not found" sweep retry until the next
  // host restart triggers backfillContainerConfigs from container.json.
  initGroupFilesystem(agentGroup);

  // Compose CLAUDE.md for typed coworkers (lego spine model). The result is
  // CONSUMED, not discarded: it is the only place a marker failure is knowable, and
  // the only place it can still be acted on.
  const projectDoc = await composeCoworkerClaudeMd(agentGroup);

  // Markers describe the enforcement the document claims — `.overlay-critique-gate`
  // gating deliveries, `.critique-required-stages` naming which stages must have
  // run. Starting anyway means an agent whose document says a gate applies while
  // the marker that arms it is missing: it ships without the gate and reports
  // success. So refuse, before any hash is recorded and before the container exists.
  //
  // Self-healing without new machinery: `wakeContainer` catches, logs, returns
  // false, and pending messages stay in `messages_in` for the sweep's due-message
  // wake. A persistent filesystem fault becomes a loud retry loop rather than a
  // silent wrong-enforcement start — the trade the design records.
  if (projectDoc.published && projectDoc.markersStale) {
    throw new Error(
      `Marker materialization failed for '${agentGroup.folder}' after CLAUDE.md publication; refusing to spawn`,
    );
  }

  // From the seam, not from a second read of the file. `published: true` gives the
  // digest of the exact bytes handed to `writeComposedDocument`; `published: false`
  // gives the digest of the exact retained document. Re-reading could only
  // disagree — and did, whenever the on-disk file predated this spawn.
  spawnedClaudeMdHash.set(session.id, projectDoc.hash);
  log.debug('CLAUDE.md hash stored at spawn', {
    sessionId: session.id,
    hash: projectDoc.hash.slice(0, 12),
    published: projectDoc.published,
  });

  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (await hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    await writeDestinations(agentGroup.id, session.id);
  }
  await writeSessionRouting(agentGroup.id, session.id);
  const mailboxKey = { agentGroupId: agentGroup.id, sessionId: session.id };
  const mailbox = getAgentMailbox();
  writeSessionContext(agentGroup.id, session.id, await mailbox.runnerContext(mailboxKey));

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = await materializeContainerJson(agentGroup.id);

  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  await initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = await buildMounts(agentGroup, session, containerConfig, provider, contribution);
  // Container name embeds the NanoClaw session id tail so the dashboard can
  // route shell-exec requests to the right container when a coworker has
  // multiple live sessions (root + thread sessions). Without the tail, every
  // container for a folder collapsed into one namespace and shell-exec landed
  // in an arbitrary session. Timestamp keeps rapid respawns unique.
  const containerName = `${CONTAINER_PREFIX}-${agentGroup.folder}-${containerSessionTail(session.id)}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const mailboxEnvironment = await mailbox.runnerEnvironment(mailboxKey);

  // Register an MCP proxy token so the container can access host MCP servers.
  // The token carries the resolved list; an empty one authorises nothing,
  // which is what an explicit `[]` (or an unresolvable policy) must mean.
  const mcpPolicy = resolveMcpPolicy(agentGroup);
  const proxyToken = registerContainerToken(agentGroup.folder, mcpPolicy.externalTools);

  // A fresh random nonce for THIS spawn (NanoClaw #1 "set ceiling v2" readiness
  // handshake — see getActiveContainerInstanceId's doc comment above).
  const instanceId = crypto.randomUUID();

  // Operator-visible, not a debug line. The policy is still correct — a
  // configuration fault never narrows a group, by design — but something the
  // resolver wanted to read was unreadable and somebody has to fix it.
  if (mcpPolicy.configurationError) {
    log.error('MCP allow-list resolved with a configuration fault — policy unchanged, fix the fault', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      coworkerType: agentGroup.coworker_type,
      state: mcpPolicy.state,
      configurationError: mcpPolicy.configurationError,
    });
  }

  const driver = getSessionDriver();
  // The gateway's per-session contribution — typed env and mounts (and, on a
  // driver that manages them, auxiliary containers), merged into the spec
  // BEFORE validation so admission sees the whole session. Fail-closed exactly
  // as the old wiring was: contribute() throwing aborts the spawn, the inbound
  // row stays pending, and the sweep retries. Network selection is NOT here —
  // topology is driver-private (see `drivers/index.ts`).
  const gateway = await getGatewayProvider().contribute({
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
    groupName: agentGroup.name,
    capabilities: driver.capabilities(),
  });
  if (gateway.containers?.length && !driver.capabilities().auxiliaryContainers) {
    // Named at composition, where the error can say which side to change —
    // not left for the driver's refusal backstop to discover.
    throw specInvalid(
      `gateway provider composed auxiliary containers, but driver '${driver.kind}' does not manage them ` +
        `(capabilities().auxiliaryContainers is false)`,
    );
  }

  const spec = await composeSessionSpec({
    agentGroup,
    session,
    containerName,
    mounts,
    containerConfig,
    contribution,
    gateway,
    mailboxEnvironment,
    provider,
    agentIdentifier,
    instanceId,
    mcpProxy: { proxyToken, policy: mcpPolicy },
  });

  log.info('Spawning session', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    containerName,
    mcpPolicyState: mcpPolicy.state,
    mcpExternalToolCount: mcpPolicy.externalTools.length,
    hasProxyToken: !!proxyToken,
  });

  // The claim is the cross-process spawn fence: winning it is what licenses
  // touching the session's runtime state (the heartbeat clear below included).
  // Losing it means another live claimant runs this session — abort; the wake
  // contract turns the throw into `false` and the sweep re-checks next tick.
  const claimIncarnation = await claimSessionRun(session.id, containerName);
  if (claimIncarnation === null) {
    throw new Error(`session ${session.id} is claimed by another live host process — not spawning a duplicate`);
  }

  // Clear any orphan heartbeat from a previous container instance — the sweep's
  // ceiling check treats a missing file as "fresh spawn, give grace". Without
  // this, the stale mtime can trigger an immediate kill before the new container
  // touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  let handle;
  try {
    handle = await driver.prepare(spec);
  } catch (err) {
    await releaseClaimQuietly(session.id, claimIncarnation);
    throw err;
  }

  const runtime = registerRuntime(session.id, handle, containerName, false, instanceId);
  runtime.claimIncarnation = claimIncarnation;

  // The per-group container log tee and the stderr tail both moved into the
  // driver: DockerHandle.start() runs `start --attach`, logs every stderr line
  // at debug, keeps the same 10-line tail, and surfaces it at warn on a
  // non-zero exit (docker-driver.ts). There is no ChildProcess here to pipe
  // any more, so re-teeing would mean a second attach on the same container.

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  // Fork bookkeeping the driver does not own: the MCP proxy token this spawn
  // registered, and the composed-CLAUDE.md hash the stale-check compares
  // against. Registered as an exit callback so it runs on every terminal path
  // (clean exit, boot failure, host-requested stop) exactly once — `finish`
  // drains exitCallbacks after marking the session stopped.
  runtime.exitCallbacks.push(() => {
    revokeContainerToken(proxyToken);
    spawnedClaudeMdHash.delete(session.id);
  });

  try {
    await armSessionLifecycle({
      handle,
      onTerminal: (failure) => {
        void finishAndResolve(session.id, runtime, failure);
      },
      afterStart: () => {
        return markContainerRunning(session.id);
      },
    });
  } catch (err) {
    if (activeContainers.get(session.id) === runtime && !runtime.finished) {
      activeContainers.delete(session.id);
      runtime.resolveFinished();
      await releaseClaimQuietly(session.id, claimIncarnation);
    } else {
      await runtime.finishedPromise;
    }
    throw err;
  }
}

/**
 * Wire a session's lifecycle in the one order that is safe, as executable code
 * rather than as a comment a refactor can silently invert.
 *
 * Terminal handling is armed before the session starts, so a failure that lands
 * during startup finds a runtime that already knows how to finalize. If
 * `start()` throws, the post-start bookkeeping never runs — there is nothing
 * running for it to record.
 */
export async function armSessionLifecycle(deps: {
  handle: Pick<SupervisedHandle, 'onTerminal' | 'start'>;
  onTerminal: (failure?: SessionFailure) => void;
  afterStart?: () => void | Promise<void>;
}): Promise<void> {
  deps.handle.onTerminal(deps.onTerminal);
  await deps.handle.start();
  await deps.afterStart?.();
}

function registerRuntime(
  sessionId: string,
  handle: SupervisedHandle,
  containerName: string,
  adopted: boolean,
  instanceId?: string,
): ActiveSessionRuntime {
  let resolveFinished!: () => void;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const runtime: ActiveSessionRuntime = {
    handle,
    containerName,
    instanceId,
    startedAtMs: Date.now(),
    adopted,
    exitCallbacks: [],
    finished: false,
    finishedPromise,
    resolveFinished,
  };
  activeContainers.set(sessionId, runtime);
  return runtime;
}

/**
 * Single-shot finalization: only the first terminal event resolves shutdown,
 * and only for the runtime the event belongs to. A terminal event is always
 * bound to the runtime that armed it — a late event from a runtime that a
 * fresh spawn has already replaced resolves its own waiters and touches
 * nothing else (the in-process half of the stale-finish fence).
 */
async function finishAndResolve(
  sessionId: string,
  runtime: ActiveSessionRuntime,
  failure?: SessionFailure,
): Promise<void> {
  if (runtime.finished) return;
  runtime.finished = true;
  if (activeContainers.get(sessionId) !== runtime) {
    log.warn('Ignoring stale session finish — a newer runtime is registered', {
      sessionId,
      containerName: runtime.containerName,
    });
    runtime.resolveFinished();
    return;
  }
  try {
    await finish(sessionId, runtime, failure);
  } finally {
    runtime.resolveFinished();
  }
}

// Fence-read schedule: brief in-line retries (~30s), then the whole
// finalization defers to the resync cadence. A store outage never forces a
// choice between clobbering a newer incarnation and leaking the runtime.
let fenceRetryDelaysMs = [5_000, 10_000, 15_000];
let deferredFinishDelayMs = 60_000;
export function _setFinishFenceScheduleForTesting(retryDelaysMs?: number[], deferDelayMs?: number): void {
  fenceRetryDelaysMs = retryDelaysMs ?? [5_000, 10_000, 15_000];
  deferredFinishDelayMs = deferDelayMs ?? 60_000;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Re-run finalization once the store may be back. One timer per runtime. */
function scheduleDeferredFinish(sessionId: string, runtime: ActiveSessionRuntime, failure?: SessionFailure): void {
  if (runtime.deferredFinishScheduled) return;
  runtime.deferredFinishScheduled = true;
  const timer = setTimeout(() => {
    runtime.deferredFinishScheduled = false;
    finish(sessionId, runtime, failure).catch((err: unknown) => {
      log.error('Deferred finalization failed', { sessionId, err });
    });
  }, deferredFinishDelayMs);
  timer.unref?.();
}

async function finish(sessionId: string, runtime: ActiveSessionRuntime, failure?: SessionFailure): Promise<void> {
  const { containerName } = runtime;

  // Durable fence: the claim row is the authority for which incarnation owns
  // this session. A finish racing a fresh spawn — possibly from another
  // process — must not stomp the fresh incarnation's bookkeeping (the status
  // write, the exit callbacks, the claim release are all skipped; only this
  // runtime's own registry entry is dropped).
  if (runtime.claimIncarnation !== undefined) {
    let fenced: boolean | 'unreadable' = 'unreadable';
    /* eslint-disable no-catch-all/no-catch-all -- an unreadable fence defers finalization; it never licenses unfenced writes */
    for (let attempt = 0; attempt <= fenceRetryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(fenceRetryDelaysMs[attempt - 1]);
      try {
        const claim = await getSessionClaim(sessionId);
        fenced = claim !== undefined && claim.incarnation !== runtime.claimIncarnation;
        break;
      } catch (err) {
        log.warn('Claim fence check failed', { sessionId, attempt: attempt + 1, err });
      }
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (fenced === 'unreadable') {
      // Fail closed: no status write, no claim release, no exit callbacks —
      // none of it may happen unfenced. The registry entry stays, so wakes
      // see the session as occupied and nothing double-spawns; an unref'd
      // timer re-runs finalization at the resync cadence until the store
      // answers. Exit callbacks are deferred, not dropped — and a pending
      // respawn is carried by its durable stop-intent row even if this
      // process dies first.
      log.warn('Claim fence unreadable — deferring finalization until the store answers', {
        sessionId,
        containerName,
        incarnation: runtime.claimIncarnation,
      });
      scheduleDeferredFinish(sessionId, runtime, failure);
      return;
    }
    if (fenced) {
      log.warn('Ignoring stale session finish — a newer incarnation holds the claim', {
        sessionId,
        containerName,
        staleIncarnation: runtime.claimIncarnation,
      });
      if (activeContainers.get(sessionId) === runtime) {
        activeContainers.delete(sessionId);
      }
      return;
    }
  }

  try {
    await markContainerStopped(sessionId);
  } catch (err) {
    log.error('Failed to record stopped container', { sessionId, containerName, err });
  }
  try {
    stopTypingRefresh(sessionId);
  } catch (err) {
    log.error('Failed to stop typing refresh', { sessionId, containerName, err });
  }

  if (failure && failure.kind !== 'started-then-died') {
    log.error('Session failed', { sessionId, containerName, kind: failure.kind, retryable: failure.retryable });
  } else {
    log.info('Session ended', {
      sessionId,
      containerName,
      exitCode: failure && failure.kind === 'started-then-died' ? failure.exitCode : undefined,
    });
  }

  if (activeContainers.get(sessionId) === runtime) {
    activeContainers.delete(sessionId);
  }
  if (runtime.claimIncarnation !== undefined) {
    await releaseClaimQuietly(sessionId, runtime.claimIncarnation);
  }
  for (const callback of runtime.exitCallbacks) {
    try {
      callback();
    } catch (err) {
      log.error('Container exit callback failed', { sessionId, containerName, err });
    }
  }
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  // Upstream's exitCallbacks array replaces the fork's
  // `entry.process.once('exit', ...)`: there is no ChildProcess here any more,
  // and `finish` drains these on EVERY terminal path with its own try/catch
  // per callback (so a throwing callback no longer loses the rest).
  if (onExit) {
    entry.exitCallbacks.push(onExit);
  }

  entry.stopReason = reason;
  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  void entry.handle.stop(reason).then(
    () => {
      // A handle whose supervision channel is gone (an adopted handle whose
      // attach process belonged to the previous host) would otherwise never
      // finalize, and the session would stay in the registry forever.
      if (!entry.finished) void finishAndResolve(sessionId, entry, undefined);
    },
    (err: unknown) => {
      log.error('Failed to stop session', { sessionId, reason, err });
      if (!entry.finished) void finishAndResolve(sessionId, entry, undefined);
    },
  );
}

/**
 * Startup reconciliation: adopt what is still alive, stop what is not ours.
 *
 * This replaces the old reap-everything `cleanupOrphans()`. A surviving session
 * used to be destroyed on every host restart and its work recovered only
 * through the DB; now the host re-registers it and delivery resumes. The OneCLI
 * gateway resolves credentials per request on the host side, so an adopted
 * session's egress keeps working without any per-process state to rebuild.
 */
export async function adoptRunningSessions(): Promise<{ adopted: number; stopped: number }> {
  const driver = getSessionDriver();
  let snapshots: SupervisedSnapshot[];
  try {
    snapshots = await driver.listSessions(INSTALL_SLUG);
  } catch (err) {
    log.warn('Failed to list existing sessions for adoption', { err });
    return { adopted: 0, stopped: 0 };
  }

  let adopted = 0;
  let stopped = 0;
  for (const { handle, phase } of snapshots) {
    const session = handle.key.sessionId ? await getSession(handle.key.sessionId) : undefined;
    // The snapshot's phase is the listing's own truth: a corpse arrives as
    // 'terminal' (or not at all), so telling adoptable sessions apart needs
    // no per-handle status() round trip. `stop()` on a corpse is still full
    // teardown — a self-exited runtime needs its residue cleaned up.
    if (!session || session.status !== 'active' || phase !== 'running') {
      await handle.stop('orphan-at-startup').catch(() => {});
      stopped += 1;
      continue;
    }
    // Claim before adopting: a lost CAS means another live process already
    // owns this session — leave its container strictly alone. A failed claim
    // WRITE also fails closed: an unfenced adoption could stomp a newer
    // claimant's session, while an unadopted-but-running container is safe to
    // leave — the spawn path is claim-first fail-closed too, so nothing can
    // start a duplicate while the store is down, and the wake path reclaims
    // the container (`retryPendingAdoption`) once the store answers.
    let claimIncarnation: number | null;
    /* eslint-disable no-catch-all/no-catch-all -- fail closed: leave the container unadopted and let the wake path retry, never adopt unfenced */
    try {
      claimIncarnation = await claimSessionRun(session.id, handle.name);
    } catch (err) {
      log.error('Session claim write failed during adoption — leaving the container unadopted for retry', {
        sessionId: session.id,
        err,
      });
      pendingAdoptions.add(session.id);
      continue;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (claimIncarnation === null) {
      log.warn('Session adoption skipped — another live host process holds the claim', { sessionId: session.id });
      continue;
    }
    pendingAdoptions.delete(session.id);
    const runtime = registerRuntime(session.id, handle, handle.name, true);
    runtime.claimIncarnation = claimIncarnation;
    runtime.stopReason = undefined;
    handle.onTerminal((failure) => {
      void finishAndResolve(session.id, runtime, failure);
    });
    await markContainerRunning(session.id);
    adopted += 1;
  }

  await driver.reapResidue?.(INSTALL_SLUG).catch?.(() => {});
  // Reconcile terminals the watch stream missed while no host was listening —
  // adoption is the one place a full re-list is already cheap, so the hub's
  // resync wires here rather than into new periodic machinery.
  if (isSessionEventsDriver(driver)) await driver.resync(INSTALL_SLUG).catch(() => {});

  if (adopted > 0 || stopped > 0) {
    log.info('Reconciled sessions at startup', { adopted, stopped });
  }

  await honorPendingStopIntents();

  return { adopted, stopped };
}

/**
 * Honor stop intents that outlived their process. A kill-with-respawn used to
 * live only in a volatile onExit callback: a host dying between the kill and
 * the respawn forgot the restart entirely ("rebuild applied" and nothing came
 * back). The durable `respawn_after_stop` row is consumed here at startup —
 * a session whose container is still up gets its kill re-issued with the
 * respawn re-armed; one without a container gets the respawn directly. The
 * intent clears only once the respawn wake actually succeeds, so a failed
 * wake is retried at the next startup while the sweep retries it sooner.
 */
export async function honorPendingStopIntents(
  wake: (session: Session) => Promise<boolean> = wakeContainer,
): Promise<void> {
  let intents: SessionClaimRow[];
  try {
    intents = await listSessionsWithStopIntent();
  } catch (err) {
    log.warn('Failed to read pending stop intents', { err });
    return;
  }
  for (const intent of intents) {
    if (intent.stop_intent !== 'respawn_after_stop') continue;
    if (pendingAdoptions.has(intent.session_id)) {
      // The session's container is alive but not yet re-fenced; acting on the
      // intent now could kill or respawn the wrong incarnation. The row stays
      // for the next recovery pass.
      log.warn('Deferring stop intent — session awaits claim-fenced adoption', { sessionId: intent.session_id });
      continue;
    }
    const session = await getSession(intent.session_id);
    if (!session || session.status !== 'active') {
      await shadowWrite('stop-intent-clear', () => setStopIntent(intent.session_id, null, new Date().toISOString()));
      continue;
    }
    const respawn = async (): Promise<void> => {
      const woke = await wake(session);
      if (woke) {
        await shadowWrite('stop-intent-clear', () => setStopIntent(session.id, null, new Date().toISOString()));
      }
    };
    if (activeContainers.has(session.id)) {
      // The kill never completed — the container outlived the host that
      // ordered it. Re-issue the kill with the respawn re-armed.
      log.info('Re-issuing interrupted restart', { sessionId: session.id });
      killContainer(session.id, 'restart-intent-recovery', () => void respawn());
    } else {
      await respawn();
    }
  }
}

/**
 * Resolve the provider name for a session using the precedence documented in
 * the provider-install skills:
 *
 *   sessions.agent_provider
 *     → agent_groups.agent_provider
 *     → container_configs.provider (container.json `provider`)
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider?: string | null | undefined,
): string {
  return (sessionProvider || agentGroupProvider || containerConfigProvider || 'claude').toLowerCase();
}

/**
 * What the sweep learned. It publishes nothing, so it cannot report a publication
 * result — only whether it got a hash worth restarting for.
 */
export type RecomposeOutcome =
  /** Got a hash. The only outcome that may kill + notify. */
  | { kind: 'restart-ready'; hash: string }
  /** Render threw. Nothing was published, so nothing to roll back. */
  | { kind: 'render-failed' }
  /** The session or group vanished mid-sweep. Absence is not a failure. */
  | { kind: 'skipped'; reason: 'session-gone' | 'group-gone' };

/**
 * Recompose CLAUDE.md's hash for a running container so the sweep can decide
 * whether to restart it. Renders only — see the body for why publishing here is
 * actively wrong.
 */
export async function recomposeAndUpdateHash(sessionId: string): Promise<RecomposeOutcome> {
  const session = await getSession(sessionId);
  if (!session) return { kind: 'skipped', reason: 'session-gone' };
  const ag = await getAgentGroup(session.agent_group_id);
  if (!ag) return { kind: 'skipped', reason: 'group-gone' };

  // Renders, does NOT publish. Rewriting the file cannot update a RUNNING
  // container anyway — the composed document is a file bind mount, so the
  // established mount keeps the old inode however the host replaces the path, and
  // the caller must kill the container for a recompose to take effect.
  //
  // Publishing here was worse than merely useless. Markers live in the group dir,
  // mounted READ-WRITE, and three hooks `-f` test them at hook time, so a
  // sweep-time write mutates live enforcement for a container still running its
  // OLD document. Worse, document and markers would be two separately-failing
  // writes: sweep publishes D1 and retains M0, then a transient failure in the
  // respawn's publication falls back onto D1 with M0 and records D1's hash — a
  // mismatch `detectStaleContainers` can never see, because the hash matches.
  //
  // So spawn is the sole writer: it publishes the document, then the markers, and
  // refuses that spawn if marker publication fails. NOT "together or not at all" —
  // with the marker receipt deferred, a marker failure still leaves D1 on disk with
  // M0 beside it. What the refusal buys is that no container starts on that pair,
  // and the divergence is reachable today (`:636-658`), not introduced here.
  //
  // The sweep only needs a hash to compare against, and the respawn three lines
  // later composes and publishes for itself.
  try {
    const { hash } = await renderComposedDocument(ag);
    // Recorded so a sweep tick landing inside the async shutdown window does not
    // re-detect the OLD hash and fire a second kill plus a second refresh message:
    // `killContainer` is fire-and-forget, so the session stays in
    // `activeContainers` until `finishAndResolve` removes it.
    spawnedClaudeMdHash.set(sessionId, hash);
    return { kind: 'restart-ready', hash };
  } catch (err) {
    // A render can still throw — an unresolvable coworker type, or a document
    // oversized on irreducible core. Nothing was published, so there is nothing to
    // roll back; the next tick retries.
    log.warn('Recompose failed — leaving the container on its current document', {
      sessionId,
      folder: ag.folder,
      err,
    });
    return { kind: 'render-failed' };
  }
}

/**
 * Detect containers whose CLAUDE.md has become stale (skills/overlays/
 * .instructions.md changed since spawn). Returns session IDs that need a
 * fresh context. Does NOT kill or send messages — the caller decides.
 */
export async function detectStaleContainers(): Promise<
  Array<{ sessionId: string; agentGroupId: string; folder: string }>
> {
  const stale: Array<{ sessionId: string; agentGroupId: string; folder: string }> = [];
  for (const [sessionId] of activeContainers) {
    const session = await getSession(sessionId);
    if (!session) continue;
    const ag = await getAgentGroup(session.agent_group_id);
    if (!ag) continue;

    const coworkerType = ag.coworker_type || 'default';
    // Compose the current document through the same seam spawn uses, and compare
    // against the running container's baseline. Sharing the seam is what keeps the
    // two digests comparable: they read `.instructions.md` through
    // `readStandingInstructions`, because spawn migrates the legacy file to the
    // canonical name and composes WITH the persona — a direct legacy read composed
    // WITHOUT it, and the digests could never agree.
    //
    // This can THROW when a coworker type references a skill/workflow/overlay that
    // isn't resolvable on disk (e.g. an external `skill-source` skill not yet
    // fetched into container/skills/). Guard it per-session: a single broken type
    // must not abort the whole stale scan.
    //
    // Before this guard, one unresolvable type (any live slang/slangpy container
    // while its external skills were absent) threw here, propagated to the sweep's
    // outer try/catch, and skipped the entire CLAUDE.md-stale respawn loop —
    // silently disabling instruction hot-reload FLEET-WIDE for every healthy
    // coworker. Mirror resolveTypeManifest's tolerance: log and skip just this
    // session. Its stale-check resumes once the type resolves.
    let currentHash: string;
    try {
      currentHash = (await renderComposedDocument(ag)).hash;
    } catch (err) {
      log.warn('Skipping stale-check — spine compose failed', { folder: ag.folder, coworkerType, err });
      continue;
    }

    // Resolve the baseline hash for the running container. The in-memory map
    // is populated when this host process spawned the container, but it
    // empties on host restart — without a fallback, every container that
    // outlived a host restart becomes permanently invisible to stale
    // detection (the bug that left slang-triage running with a 3-day-old
    // CLAUDE.md after multiple /update-nanoclaw-instance cycles).
    //
    // The on-disk CLAUDE.md is what the running container actually started
    // with (the container reads it at spawn time). Hashing it gives a
    // reliable baseline that survives host restarts. Seed the map so the
    // next sweep tick skips the disk read.
    let spawnHash = spawnedClaudeMdHash.get(sessionId);
    if (!spawnHash) {
      try {
        // Read as Buffer (no encoding) to match the spawn site at line ~404
        // exactly — eliminates any theoretical encoding-roundtrip drift.
        const onDisk = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'));
        spawnHash = crypto.createHash('sha256').update(onDisk).digest('hex');
        spawnedClaudeMdHash.set(sessionId, spawnHash);
      } catch {
        // No CLAUDE.md on disk — group hasn't been spawned by anyone yet.
        // Skip; the next real spawn will populate the map.
        continue;
      }
    }

    if (currentHash !== spawnHash) {
      stale.push({ sessionId, agentGroupId: ag.id, folder: ag.folder });
    }
  }
  return stale;
}

async function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): Promise<{ provider: string; contribution: ProviderContainerContribution }> {
  // Precedence: session provider > agent_group provider > container.json > default.
  // `agentGroup.agent_provider` is a real tier on this fork — upstream's call
  // passes only two arguments, which would make a group-level provider pick
  // silently lose to container.json. The config is now threaded in by the
  // caller (already materialized once per spawn) rather than re-read here.
  const provider = resolveProviderName(
    session.agent_provider,
    agentGroup.agent_provider,
    containerConfig.provider ?? null,
  );
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? await fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

/**
 * Locate the patched claude-trace build, or null if this install has none.
 *
 * Prefers the tracked copy at container/claude-trace. Falls back to the legacy
 * untracked data/claude-trace so a box provisioned before it was vendored keeps
 * tracing until its checkout catches up.
 *
 * Presence of dist/cli.js is the switch for the whole feature: no build means no
 * mount and no CLAUDE_CODE_EXECUTABLE, so the SDK runs the stock binary and
 * simply produces no traces. Both call sites gate on this, so they can never
 * disagree — an env var pointing at an unmounted wrapper would break every
 * Claude turn with ENOENT.
 */
export function resolveClaudeTraceDir(): string | null {
  for (const dir of [path.join(process.cwd(), 'container', 'claude-trace'), path.join(DATA_DIR, 'claude-trace')]) {
    if (fs.existsSync(path.join(dir, 'dist', 'cli.js'))) return dir;
  }
  return null;
}

export async function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): Promise<VolumeMount[]> {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider declares it provides its own — a capability,
  // never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    syncSkillSymlinks(claudeDir, containerConfig);
    // No project-doc composer here: this fork composes CLAUDE.md from the lego
    // spine (composeCoworkerClaudeMd, called in spawnContainer). Upstream's
    // composer is the same file this fork deleted (claude-md-compose.ts,
    // renamed project-doc-compose.ts upstream) — two writers of one file.
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const scope = agentGroup.id;

  // Convenience: drop a symlink at groups/<folder>/.workflow-state.json pointing
  // at the per-session state file. Lets the user inspect plan/critique state from
  // the visible group folder instead of digging into data/v2-sessions/.../sess-*/.claude/.
  // The symlink uses an absolute host path because it's only ever read host-side
  // (the container has the real file at /workspace/.claude/workflow-state.json).
  try {
    const linkPath = path.join(groupDir, '.workflow-state.json');
    const targetPath = path.join(sessDir, '.claude', 'workflow-state.json');
    if (fs.existsSync(linkPath) && !fs.lstatSync(linkPath).isSymbolicLink()) {
      // Stale regular file from a prior run — replace with symlink.
      fs.unlinkSync(linkPath);
    }
    if (!fs.existsSync(linkPath)) {
      fs.symlinkSync(targetPath, linkPath);
    }
  } catch (err) {
    log.debug('workflow-state symlink skipped', { folder: agentGroup.folder, err });
  }

  // Session workspace: mailbox-selected state plus outbox and heartbeat files.
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false, mountClass: 'group-state', scope });
  mounts.push({
    hostPath: sessionContextPath(agentGroup.id, session.id),
    containerPath: '/app/.nanoclaw-session.json',
    readonly: true,
    mountClass: 'group-state',
    scope,
  });

  // Agent group folder at /workspace/agent (RW for working files + shared memory)
  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace/agent',
    readonly: false,
    mountClass: 'group-state',
    scope,
  });

  // Shared directory (learnings + cross-group facts) — mounted read-only
  // for coworkers, read-write for Main. Main is the only agent allowed to
  // edit the shared bucket; coworkers write via mcp__nanoclaw__append_learning
  // which the host processes through the approval flow.
  //
  // 'allowlisted-extra', not 'group-state': the group-state rule admits only
  // `dataRoot/v2-sessions/<scope>` and the group's own subtree under
  // groupsRoot (mountAllowed in drivers/types.ts), and this path is neither —
  // it is deliberately cross-group. classRequiredByPath does not pin it, so
  // the class is ours to state.
  const sharedDir = path.join(DATA_DIR, 'shared');
  if (fs.existsSync(sharedDir)) {
    // Admin (Main) gets write access. Trust ONLY is_admin — not
    // coworker_type. A malicious import that set coworker_type='main'
    // on a non-admin group must not get write access.
    const isAdmin = agentGroup.is_admin === 1;
    mounts.push({
      hostPath: sharedDir,
      containerPath: '/workspace/shared',
      readonly: !isAdmin,
      mountClass: 'allowlisted-extra',
      scope,
    });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skills — initialized once at group creation, persistent thereafter).
  // `claudeDir` is declared at the top of this function, where
  // syncSkillSymlinks needs it.
  const settingsFile = path.join(claudeDir, 'settings.json');

  // Dashboard hook injection (port comes from config/.env). Gated on
  // defaultSurfaces: a surfaces-owning provider (e.g. codex) has no
  // .claude-shared/settings.json, so reading it here would ENOENT-crash the
  // spawn. Claude hooks are only meaningful when the agent runs on Claude
  // surfaces in the first place.
  const dashboardPort = DASHBOARD_PORT ? String(DASHBOARD_PORT) : '';
  if (defaultSurfaces && dashboardPort) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    const hookUrl = `http://host.docker.internal:${dashboardPort}/api/hook-event`;
    if (!settings.hooks) settings.hooks = {};
    // Dedupe + drop stale-ref pass over every hook event. Two failure modes
    // it heals:
    //   1. Old bug in the CLAUDE.md guard's includes() check (escape mismatch
    //      `CLAUDE\\\\.md` vs stored `CLAUDE\.md`) appended a duplicate every
    //      restart, accumulating to 11k+ entries on busy installs and burying
    //      gate-plan / gate-critique-on-deliver so they silently never fired.
    //   2. Hook scripts get renamed (plan-gate.sh → gate-plan.sh,
    //      critique-record-gate.sh → gate-critique-on-deliver.sh, etc.) and
    //      old `/app/hooks/<old>.sh` references get stranded in settings.json
    //      where they fail at runtime with no diagnostic.
    // Collapse by (matcher, ordered command tuple); drop any entry whose
    // command references a `/app/hooks/<X>.sh` that no longer exists in the
    // build's container/hooks/ directory.
    {
      const liveHooksDir = path.join(process.cwd(), 'container', 'hooks');
      const liveHookSet = new Set(
        fs.existsSync(liveHooksDir) ? fs.readdirSync(liveHooksDir).filter((f) => f.endsWith('.sh')) : [],
      );
      const isStaleRef = (cmd: string): boolean => {
        for (const m of cmd.matchAll(/\/app\/hooks\/([\w.-]+\.sh)\b/g)) {
          if (!liveHookSet.has(m[1])) return true;
        }
        return false;
      };
      for (const ev of Object.keys(settings.hooks)) {
        const entries: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> = settings.hooks[ev] ?? [];
        const seen = new Set<string>();
        const cleaned: typeof entries = [];
        for (const entry of entries) {
          const innerHooks = (entry.hooks ?? []).filter((h) => !isStaleRef(h.command ?? ''));
          if (innerHooks.length === 0) continue;
          const matcher = entry.matcher ?? '*';
          const sig = JSON.stringify([matcher, ...innerHooks.map((h) => h.command ?? '')]);
          if (seen.has(sig)) continue;
          seen.add(sig);
          cleaned.push({ ...entry, hooks: innerHooks });
        }
        settings.hooks[ev] = cleaned;
      }
    }
    // Use command-type hooks with curl --proxy '' to bypass OneCLI HTTPS_PROXY.
    // The Claude SDK pipes hook event JSON to stdin; curl reads it via $(cat).
    const hookConfig = {
      hooks: [
        {
          type: 'command',
          // X-NanoClaw-Session-Id / X-NanoClaw-Session-Thread-Id let the
          // dashboard stamp sdk_session_routes at intake without guessing.
          // The env vars are set per-container by spawnContainer, so each
          // concurrent session (root + threads) carries its own identity.
          command: `curl -sf --proxy '' -X POST ${hookUrl} -H 'Content-Type: application/json' -H 'X-Group-Folder: ${agentGroup.folder}' -H "X-NanoClaw-Session-Id: $NANOCLAW_SESSION_ID" -H "X-NanoClaw-Session-Thread-Id: $NANOCLAW_SESSION_THREAD_ID" -d @- > /dev/null 2>&1 || true`,
          timeout: 5,
        },
      ],
    };
    for (const event of [
      // Tool lifecycle
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'PermissionDenied',
      // Session lifecycle
      'SessionStart',
      'SessionEnd',
      'Stop',
      'StopFailure',
      // Turn lifecycle
      'UserPromptSubmit',
      'Notification',
      // Subagent lifecycle
      'SubagentStart',
      'SubagentStop',
      // Task lifecycle
      'TaskCreated',
      'TaskCompleted',
      // Context
      'PreCompact',
      'PostCompact',
      // Configuration
      'ConfigChange',
      'InstructionsLoaded',
      // File/directory
      'FileChanged',
      'CwdChanged',
      // Worktree
      'WorktreeCreate',
      'WorktreeRemove',
      // MCP
      'Elicitation',
      'ElicitationResult',
    ]) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      // Strip stale entries (old transport/http format)
      settings.hooks[event] = settings.hooks[event].filter(
        (h: { transport?: string; type?: string; url?: string }) =>
          !((h.transport || h.type === 'http') && h.url?.includes(hookUrl)),
      );
      // Drop ANY existing command hook for this URL, then push the current
      // hookConfig. Dedup MUST be content-aware: the previous version keyed
      // only on hookUrl presence, so when the command string changed (e.g.
      // the X-NanoClaw-Session-Id header was added) the stale command was
      // never replaced — it matched the URL and `!hasHook` stayed false
      // forever. Long-lived groups (e.g. `main`) were stranded on the old
      // headerless command, so the dashboard never stamped sdk_session_routes
      // for them and session attribution fell back to a stale heuristic.
      // Stripping + re-pushing keeps a single up-to-date hook per event and
      // self-heals any group whose settings.json predates a command change.
      settings.hooks[event] = settings.hooks[event].filter(
        (h: { hooks?: { command?: string }[] }) =>
          !h.hooks?.some((inner: { command?: string }) => inner.command?.includes(hookUrl)),
      );
      settings.hooks[event].push(hookConfig);
    }
    // Guard hook: block direct edits to CLAUDE.md — agents must edit .instructions.md instead.
    // CLAUDE.md is auto-composed from templates + .instructions.md on every container wake,
    // so direct edits are silently lost. This hook enforces the single source of truth.
    const guardCmd = `INPUT=$(cat); FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty'); if echo "$FILE" | grep -q 'CLAUDE\\.md$'; then echo "CLAUDE.md is auto-generated from templates + instructions.prepend.md on every container start. Your edits here will be overwritten. Edit instructions.prepend.md instead — it lives in the same directory and its contents are appended to the composed CLAUDE.md." >&2; exit 2; fi; exit 0`;
    const guardHookConfig = {
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: guardCmd, timeout: 5 }],
    };
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    const hasGuard = settings.hooks.PreToolUse.some(
      (h: { matcher?: string; hooks?: { command?: string }[] }) =>
        h.matcher === 'Edit|Write' &&
        // Stored command contains the literal substring `CLAUDE\.md` (the
        // shell regex anchor for the .md extension) — i.e. one backslash.
        // The previous check searched for two backslashes and never matched,
        // so the guard hook was re-appended on every restart, accumulating
        // tens of thousands of duplicates that buried gate-plan +
        // gate-critique-on-deliver. The dedup pass at the top is the
        // belt-and-braces; this is the suspenders.
        h.hooks?.some((inner: { command?: string }) => inner.command?.includes('CLAUDE\\.md')),
    );
    if (!hasGuard) {
      settings.hooks.PreToolUse.push(guardHookConfig);
    }

    // Guard hook: block git remote URLs that bake in the OneCLI proxy stub
    // ($GH_TOKEN / ROUTED_VIA_ONECLI_PROXY / "placeholder" — historical name).
    // Symptom this catches: `git remote set-url origin https://x-access-token:$GH_TOKEN@…`
    // hardcodes the stub into .git/config; the OneCLI proxy only rewrites
    // Authorization headers, not URL-embedded creds, so every push then
    // fails with "Invalid username or token". Witnessed on slang-fixer
    // 2026-06-01 — see [[project_szihs_pat_path_routing]] for context.
    // The fix is to drop the auth from the URL entirely and let the proxy
    // inject by host+path match: `https://github.com/<owner>/<repo>.git`.
    const stubGuardCmd = `INPUT=$(cat); CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty'); if echo "$CMD" | grep -qE '(git +(remote +set-url|config +remote\\.[^ ]+\\.url)).*(ROUTED_VIA_ONECLI_PROXY|placeholder|\\$GH_TOKEN|\\$\\{GH_TOKEN\\})'; then echo "Refusing to bake the OneCLI proxy stub into a git remote URL. The stub (\\$GH_TOKEN=ROUTED_VIA_ONECLI_PROXY) is not a real credential — the proxy injects auth on the wire by matching host+path, not URL-embedded creds. Drop the auth from the URL: \\\`git remote set-url origin https://github.com/<owner>/<repo>.git\\\` and retry. The proxy will inject the right token for that host+path automatically." >&2; exit 2; fi; exit 0`;
    const stubGuardHookConfig = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: stubGuardCmd, timeout: 5 }],
    };
    const hasStubGuard = settings.hooks.PreToolUse.some(
      (h: { matcher?: string; hooks?: { command?: string }[] }) =>
        h.matcher === 'Bash' &&
        h.hooks?.some((inner: { command?: string }) =>
          inner.command?.includes('Refusing to bake the OneCLI proxy stub'),
        ),
    );
    if (!hasStubGuard) {
      settings.hooks.PreToolUse.push(stubGuardHookConfig);
    }

    // Overlay hook injection: enforce plan/critique gates via runtime hooks.
    // Uses resolveOverlayHookFlags() so agent_groups.disable_overlays=1 skips
    // injection entirely — matches the compose-time contract in PR #97.
    const hooksDir = path.join(process.cwd(), 'container', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const { hasPlan, hasCritique } = resolveOverlayHookFlags(agentGroup);

      const hasCmd = (event: string, cmd: string): boolean =>
        (settings.hooks[event] ?? []).some((h: { hooks?: { command?: string }[] }) =>
          h.hooks?.some((i: { command?: string }) => i.command?.includes(cmd)),
        );

      if (hasPlan || hasCritique) {
        if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
        if (!hasCmd('UserPromptSubmit', 'workflow-state-reset.sh')) {
          settings.hooks.UserPromptSubmit.push({
            hooks: [{ type: 'command', command: 'bash /app/hooks/workflow-state-reset.sh', timeout: 5 }],
          });
        }
        // Intent router: LLM-based workflow classification on each user message.
        // Builds a routing table from the manifest's workflows and passes it as
        // an env var so the hook can present options to the classifier.
        const { workflows: wfList } = resolveTypeManifest(agentGroup);
        if (wfList.length > 0 && !hasCmd('UserPromptSubmit', 'intent-router.sh')) {
          const routingTable = wfList
            .map((w) => `${w.name}:${w.description.slice(0, 60).replace(/[;:]/g, ' ')}`)
            .join(';');
          settings.hooks.UserPromptSubmit.push({
            hooks: [
              {
                type: 'command',
                command: `OVERLAY_WORKFLOWS='${routingTable}' bash /app/hooks/intent-router.sh`,
                timeout: 8,
              },
            ],
          });
        }
      }
      // Buddy hooks — wired unconditionally. Each script first-line checks
      // /workspace/agent/.overlay-buddy-monitor (materialized by
      // materializeOverlayMarkers when the buddy-monitor overlay is active
      // for this group) and exits 0 if absent. Activation flows through
      // R1 (eligibility via applies-to) × R2 (operator selects in dashboard,
      // writes agent_groups.overlays) — gated by R3 (disable_overlays=1).
      // Host code stays generic; no overlay names baked in.
      if (!hasCmd('UserPromptSubmit', 'buddy-inject.sh')) {
        if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
        settings.hooks.UserPromptSubmit.push({
          hooks: [
            {
              type: 'command',
              command: 'bash /app/hooks/buddy-inject.sh',
              timeout: 3,
            },
          ],
        });
      }
      if (!hasCmd('PostToolUse', 'spawn-buddy.sh')) {
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          hooks: [
            {
              type: 'command',
              command: 'bash /app/hooks/spawn-buddy.sh',
              timeout: 3,
            },
          ],
        });
      }

      // PR auto-mapping: detect gh pr create / curl PR creation in Bash output
      // and auto-register the PR→session mapping. Fires for ALL agents.
      if (!hasCmd('PostToolUse', 'pr-auto-map.sh')) {
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'bash /app/hooks/pr-auto-map.sh', timeout: 5 }],
        });
      }

      // force-codex-sandbox: reject mcp__codex__codex calls with
      // sandbox != "danger-full-access". bwrap doesn't work inside Docker
      // containers, so read-only sandbox wastes a round-trip (30% of
      // codex-critique sessions hit this). Unconditional — any agent with
      // the codex MCP tool can trigger the failure.
      if (!hasCmd('PreToolUse', 'force-codex-sandbox.sh')) {
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'mcp__codex__codex',
          hooks: [{ type: 'command', command: 'bash /app/hooks/force-codex-sandbox.sh', timeout: 5 }],
        });
      }

      if (hasPlan || hasCritique) {
        // gate-plan.sh enforces plan-required (must have a plan before
        // editing). Subagents pass through (parent's plan covers them).
        // OVERLAY_HAS_PLAN=0 disables for one-off bring-up.
        if (!hasCmd('PreToolUse', 'gate-plan.sh')) {
          settings.hooks.PreToolUse.push({
            matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
            hooks: [
              {
                type: 'command',
                command: `OVERLAY_HAS_PLAN=${hasPlan ? '1' : '0'} bash /app/hooks/gate-plan.sh`,
                timeout: 5,
              },
            ],
          });
        }
        // gate-chain-routing.sh refuses marked handoff/delivery direct
        // send_message calls unless in_reply_to is set (thread_id is derived
        // from it by the runtime). Always on — the hook is self-scoping (only
        // acts on a chain delivery marker), so universal wiring is correct.
        if (!hasCmd('PreToolUse', 'gate-chain-routing.sh')) {
          settings.hooks.PreToolUse.push({
            matcher: 'mcp__nanoclaw__send_message',
            hooks: [{ type: 'command', command: 'bash /app/hooks/gate-chain-routing.sh', timeout: 5 }],
          });
        }
        // gate-critique-on-deliver.sh refuses delivery markers
        // ([Fix Report]/[Resolution]/[Triage Resolution]/[Review Verdict]/[handoff])
        // and PR-create commands until /codex-critique has run at least once.
        // Symmetric opt-in: the hook itself first-line checks
        // /workspace/agent/.overlay-critique-gate and exits 0 if absent, so
        // wiring it universally is safe — coworkers without the overlay
        // see no gating at all.
        if (!hasCmd('PreToolUse', 'gate-critique-on-deliver.sh')) {
          settings.hooks.PreToolUse.push({
            matcher: 'mcp__nanoclaw__send_message|Bash',
            hooks: [{ type: 'command', command: 'bash /app/hooks/gate-critique-on-deliver.sh', timeout: 5 }],
          });
        }
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        if (!hasCmd('PostToolUse', 'plan-tracker.sh')) {
          settings.hooks.PostToolUse.push({
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'bash /app/hooks/plan-tracker.sh', timeout: 5 }],
          });
        }
      }
      if (hasCritique) {
        // track-critique.sh — PostToolUse on every successful mcp__codex__codex
        // call increments critique_rounds. Filters out buddy invocations by
        // signature (the codex-CLI thread also used by buddy carries
        // "You are Buddy" or "BATCH n (" prompts).
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        if (!hasCmd('PostToolUse', 'track-critique.sh')) {
          settings.hooks.PostToolUse.push({
            matcher: 'mcp__codex__codex|mcp__codex__codex-reply',
            hooks: [{ type: 'command', command: 'bash /app/hooks/track-critique.sh', timeout: 5 }],
          });
        }
      }
      if (hasPlan || hasCritique) {
        // track-edits.sh — pure telemetry, bumps edits_since_plan and
        // edits_since_critique counters. No threshold logic; gate decisions
        // live in gate-plan.sh / gate-critique-on-deliver.sh.
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        if (!hasCmd('PostToolUse', 'track-edits.sh')) {
          settings.hooks.PostToolUse.push({
            matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'command', command: 'bash /app/hooks/track-edits.sh', timeout: 5 }],
          });
        }
        log.debug('Overlay hooks injected', { folder: agentGroup.folder, plan: hasPlan, critique: hasCritique });
      }
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  // Claude state dir — only for providers using the default Claude surfaces.
  // Under `dataRoot/v2-sessions/<group>`, so 'group-state' is what the policy
  // requires here.
  if (defaultSurfaces) {
    mounts.push({
      hostPath: claudeDir,
      containerPath: '/home/node/.claude',
      readonly: false,
      mountClass: 'group-state',
      scope,
    });
  }
  // container.json — nested RO mount on top of RW group dir so the agent can
  // read its config but cannot modify it. Composed per group, so 'group-state'
  // read-only rather than 'install-surface': the install-surface rule is an
  // enumerated release-surface allowlist, and this path is under the group.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({
      hostPath: containerJsonPath,
      containerPath: '/workspace/agent/container.json',
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }

  // Stamped plugin content is immutable at runtime (the Agent Plugins
  // contract: writes go to plugin-data/, which stays RW via the group mount).
  // Same nested-RO pattern as container.json; initGroupFilesystem creates the
  // dir before mounts are built, so the mount is unconditional.
  //
  // Classed 'install-surface' rather than 'group-state' because what is stamped
  // here is code the agent EXECUTES, and install-surface is the only class
  // whose read-only rule is enforced instead of chosen. It lives under the
  // group folder rather than an install root, so the mount policy pins it
  // through the group-folder label — see `stampedPluginsRoot`.
  mounts.push({
    hostPath: path.join(groupDir, 'plugins'),
    containerPath: CONTAINER_PLUGINS_DIR,
    readonly: true,
    mountClass: 'install-surface',
    scope,
  });

  // The composed CLAUDE.md — one nested RO mount on top of the RW group dir.
  // The spine regenerates it every spawn, so an agent-side write would be
  // clobbered; read-only makes that fail loudly instead. CLAUDE.local.md
  // (per-group memory) stays RW via the group-dir mount.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({
      hostPath: composedClaudeMd,
      containerPath: '/workspace/agent/CLAUDE.md',
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }

  // Per-session codex state at /home/node/.codex (sessions/, memories/, etc.).
  //
  // Mounted UNIVERSALLY — not just for the codex agent provider. Two reasons:
  //  1. Cost accounting: dashboard/server.ts:runCodexCcusage scans
  //     <sessDir>/codex/ to attribute codex usage to the producing coworker.
  //     Without the mount, container-side codex calls (mcp__codex__codex,
  //     codex-critique, buddy-call.sh) write to ephemeral /home/node/.codex
  //     which dies with the container — invisible to ccusage.
  //  2. Container-restart resilience: codex sessions persist across respawns,
  //     so `codex exec resume <id>` from buddy-call.sh works without falling
  //     back to a fresh init (PR #446's fallback stays as defense-in-depth).
  //
  // Auth.json is opportunistically copied from the host's ~/.codex (matches
  // the prior provider-only behavior). It's a per-session copy, not a host
  // mount — host's directory stays read-only from the container's view.
  //
  // Under `dataRoot/v2-sessions/<group>/<session>`, so 'group-state'.
  const codexDir = path.join(sessDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const hostHome = process.env.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    const localAuth = path.join(codexDir, 'auth.json');
    if (fs.existsSync(hostAuth) && !fs.existsSync(localAuth)) {
      try {
        fs.copyFileSync(hostAuth, localAuth);
      } catch (err) {
        log.debug('Codex auth.json copy skipped', { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  mounts.push({
    hostPath: codexDir,
    containerPath: '/home/node/.codex',
    readonly: false,
    mountClass: 'group-state',
    scope,
  });

  // Overlay hook scripts at /app/hooks (read-only — host-managed).
  //
  // 'allowlisted-extra', not 'install-surface': the install-surface class is
  // an ENUMERATED allowlist (mountPolicy().surfaceRoots names only
  // container/agent-runner/src, container/skills, container/CLAUDE.md), and
  // mountAllowed rejects an install-surface mount outside those roots. These
  // three host-managed paths are outside it, so widening surfaceRoots would be
  // the alternative — a change to upstream-owned policy for fork-only paths.
  // They stay read-only by their own `readonly: true` either way.
  const hooksMount = path.join(process.cwd(), 'container', 'hooks');
  if (fs.existsSync(hooksMount)) {
    mounts.push({
      hostPath: hooksMount,
      containerPath: '/app/hooks',
      readonly: true,
      mountClass: 'allowlisted-extra',
      scope,
    });
  }

  // Agent-runner scripts at /app/scripts — host-managed, read-only. Carries
  // buddy-call.sh and any other sibling-process helpers that hooks invoke.
  // Separate from /app/src (per-group agent-runner code, writable) because
  // these scripts are infrastructure, not agent workspace.
  const scriptsMount = path.join(process.cwd(), 'container', 'agent-runner', 'scripts');
  if (fs.existsSync(scriptsMount)) {
    mounts.push({
      hostPath: scriptsMount,
      containerPath: '/app/scripts',
      readonly: true,
      mountClass: 'allowlisted-extra',
      scope,
    });
  }

  // Buddy charter (read-only). buddy-call.sh reads this and prepends to
  // codex's first call. Separate mount because container/skills/buddy/
  // is otherwise a runtime skill bundle the agent could load.
  //
  // This one IS under container/skills, which classRequiredByPath pins to
  // 'install-surface' — stating anything else here is denied outright.
  const charterPath = path.join(process.cwd(), 'container', 'skills', 'buddy', 'CHARTER.md');
  if (fs.existsSync(charterPath)) {
    mounts.push({
      hostPath: charterPath,
      containerPath: '/app/skills/buddy/CHARTER.md',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    });
  }

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({
      hostPath: skillsSrc,
      containerPath: '/app/skills',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    });
  }

  // Shared agent-runner source — read-only, the same code for every group.
  //
  // Was a per-group WRITABLE copy under data/v2-sessions/<group>/agent-runner-src,
  // so that self-customize could edit a runner in place. Two reasons that went:
  //
  //   1. Security. This is the code the agent executes; a writable mount of it is
  //      a privilege escalation, which is why `install-surface` pins ro in the
  //      mount policy (src/mount-composition.test.ts states the invariant).
  //   2. Staleness. The copy was made once at group creation and never
  //      refreshed, so every merged agent-runner fix was inert on existing
  //      groups until someone ran a refresh — silently, with no check going red.
  //      A single shared mount cannot be stale.
  const agentRunnerSrc = path.join(process.cwd(), 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
    mountClass: 'install-surface',
    scope,
  });

  // Additional mounts from container config (groups/<folder>/container.json) —
  // threaded in via the param (materialized once in spawnContainer), already
  // vetted by the allowlist.
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated.map((m) => ({ ...m, mountClass: 'allowlisted-extra' as const, scope })));
  }

  // claude-trace: mount the patched reverse-proxy build read-only at
  // /opt/claude-trace. The wrapper (CLAUDE_CODE_EXECUTABLE, set below) runs the
  // native claude binary behind claude-trace's local reverse proxy and dumps
  // per-session request/response .jsonl + .html into the child cwd
  // (/workspace/agent/.claude-trace = groups/<folder>/.claude-trace on the host).
  // Claude provider only — Codex does not go through pathToClaudeCodeExecutable.
  //
  // Source lives in the repo at container/claude-trace (tracked). It used to be
  // an untracked data/claude-trace directory hand-placed on each box, which meant
  // the feature silently did not exist anywhere it had not been copied. The
  // DATA_DIR path is still honoured as a fallback so an existing box keeps
  // working until its checkout catches up.
  if (provider === 'claude') {
    const traceDir = resolveClaudeTraceDir();
    // 'allowlisted-extra': container/claude-trace is not one of the enumerated
    // surfaceRoots, so install-surface would be denied by mountAllowed.
    if (traceDir)
      mounts.push({
        hostPath: traceDir,
        containerPath: '/opt/claude-trace',
        readonly: true,
        mountClass: 'allowlisted-extra',
        scope,
      });
  }

  // Provider-contributed mounts (e.g. opencode-xdg). Vetted upstream by the
  // in-tree provider registration, which is exactly the 'allowlisted-extra'
  // contract — classing them group-state would deny any provider whose state
  // root sits outside the group subtree.
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts.map((m) => ({ ...m, mountClass: 'allowlisted-extra' as const, scope })));
  }

  return mounts;
}

/** VolumeMount (host vocabulary) → MountSpec (seam vocabulary). */
export function toMountSpecs(mounts: readonly VolumeMount[], defaultScope: string): MountSpec[] {
  return mounts.map((mount) => ({
    class: mount.mountClass ?? 'allowlisted-extra',
    hostPath: mount.hostPath,
    containerPath: mount.containerPath,
    mode: mount.readonly ? ('ro' as const) : ('rw' as const),
    groupScope: mount.scope ?? defaultScope,
  }));
}

export interface ComposeSessionSpecInput {
  agentGroup: AgentGroup;
  session: Session;
  containerName: string;
  mounts: VolumeMount[];
  containerConfig: import('./container-config.js').ContainerConfig;
  contribution: ProviderContainerContribution;
  /**
   * The gateway provider's typed per-session contribution. No argv-shaped
   * input reaches composition anymore: network selection is driver-private,
   * and everything the gateway used to append as raw flags arrives here as
   * env, mounts, and (capability-gated) auxiliary containers.
   */
  gateway: GatewayContribution;
  /** Non-secret configuration supplied by the selected mailbox implementation. */
  mailboxEnvironment: Record<string, string>;
  /** Resolved agent provider — selects the claude-trace wiring and AGENT_PROVIDER. */
  provider?: string;
  /** OneCLI agent identifier (the agent group id). */
  agentIdentifier?: string;
  /**
   * NanoClaw #1 "set ceiling v2" readiness handshake nonce for THIS spawn —
   * see `getActiveContainerInstanceId`'s doc comment. Always supplied by the
   * one real caller (`spawnContainer`); there is no adoption path through
   * `composeSessionSpec` (an adopted runtime re-attaches to an already-running
   * container instead, so it never composes a fresh spec).
   */
  instanceId: string;
  /**
   * MCP wiring for this spawn. The proxy token authorises the container to
   * reach host MCP servers; the policy decides which servers get handed over
   * at all (see `forkContainerEnv`).
   */
  mcpProxy?: { proxyToken: string; policy: McpAllowlistResolution };
}

/**
 * One source per target: contributed mounts shadow composed mounts on a
 * containerPath collision (a gateway-served stub landing inside a composed
 * tree replaces that path's source — the effect Docker's last-wins `-v` rule
 * used to produce, resolved here so the spec a driver sees is collision-free
 * and `validateSpec` can refuse ambiguity outright).
 */
export function mergeMounts(composed: MountSpec[], contributed: MountSpec[]): MountSpec[] {
  const contributedTargets = new Set(contributed.map((m) => m.containerPath));
  return [...composed.filter((m) => !contributedTargets.has(m.containerPath)), ...contributed];
}

/**
 * Compose the session spec. This is the tail of the old `buildContainerArgs`,
 * with argv assembly removed: the host says what a session *is*, the driver
 * says how it is realized.
 */
export async function composeSessionSpec(input: ComposeSessionSpecInput): Promise<SessionSpec> {
  const { agentGroup, session, containerName, mounts, containerConfig, contribution, gateway, mailboxEnvironment } =
    input;

  // `forkContainerEnv` sets TZ from the group's timezone override
  // (resolveGroupTimezone), which is the fork's stronger rule — the
  // containerConfig/install-global pair below is its fallback, so it is listed
  // FIRST and deliberately overridden.
  const env: Record<string, string> = {
    TZ: containerConfig.timezone ?? TIMEZONE,
    ...(await forkContainerEnv(input)),
    ...mailboxEnvironment,
  };
  // The contributed lane (ContainerSpec.contributedEnv): registry-sourced env,
  // exempt from the credential-NAME check and still refused credential VALUES.
  // The model provider's contribution fills first, the gateway's second — a
  // gateway wins a key collision, the override the old raw-argv append got
  // from Docker's last-wins rule.
  const contributedEnv: Record<string, string> = {
    ...(contribution.env ?? {}),
    ...(gateway.env ?? {}),
  };

  // Host-injected credential-NAMED envs must ride the `contributedEnv` lane,
  // not `env`. The spec guardrail (drivers/types.ts validateSpec/isSecretShaped)
  // name-checks `env` and denies ANY *_KEY/_TOKEN/_SECRET/PASSWORD key regardless
  // of value, but only VALUE-checks `contributedEnv` (the sanctioned lane for
  // host/gateway-injected env whose NAMES are credential-shaped by design — see
  // the 'gateway's ride contributedEnv' contract). Without this, wakeContainer
  // fails 'secret-shaped env' under 2.3.0's guardrail and flaps forever via the
  // host-sweep retry (0 agent containers ever start).
  //   - NVIDIA_API_KEY / GH_TOKEN: value is the non-secret sentinel
  //     ROUTED_VIA_ONECLI_PROXY; the proxy injects real auth on the wire.
  //   - MCP_PROXY_TOKEN: a real per-container bearer the agent-runner needs to
  //     reach host MCP servers. Blocked by NAME (_TOKEN), not value (64-hex
  //     matches no looksLikeCredential prefix). It is host-issued and scoped —
  //     the sanctioned lane is exactly for this.
  // Real credential VALUES are still refused in BOTH lanes (looksLikeCredential),
  // so moving name-shaped host env here does not weaken the no-secrets invariant.
  for (const k of ['NVIDIA_API_KEY', 'GH_TOKEN', 'MCP_PROXY_TOKEN'] as const) {
    if (k in env) {
      contributedEnv[k] = env[k];
      delete env[k];
    }
  }

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  // The spec contract (drivers/types.ts, `runAs`): the identity that must read
  // 0600 host-owned material is explicit in the spec for every non-root host,
  // never inherited from an image USER. uid 1000 matches the agent image's
  // node user, so the Docker realization is a no-op there — but a driver whose
  // auxiliary image runs as 65532 needs it said, or that container cannot open
  // its own 0600 session material. uid 0 stays excluded: the hardened posture pins
  // non-root, and Docker's root behavior is unchanged trunk behavior.
  // HOME travels with the mapping, exactly as it did in the old argv: a uid
  // the image has no passwd entry for resolves HOME to '/', and the provider
  // SDK's `mkdir ~/.claude` dies EACCES; /home/node is chmod 777 in the agent
  // image, so it is writable by any uid under both drivers.
  const runAs = hostUid != null && hostUid !== 0 ? { uid: hostUid, gid: hostGid ?? hostUid } : undefined;
  if (runAs) env.HOME = '/home/node';

  const agent: ContainerSpec = {
    role: 'agent',
    // Composition resolves the image; drivers never build and never resolve.
    image: containerConfig.imageTag || CONTAINER_IMAGE,
    env,
    // Run the v2 entry point directly (no tsc, no stdin). The driver maps the
    // 'standard' posture's PID-1 requirement onto this: Docker adds `--init`.
    command: ['bash', '-c'],
    // Writes ~/.codex/config.toml from container env, then execs the runner.
    // See agentEntrypointScript for why the TOML cannot be `-c` overrides.
    args: [agentEntrypointScript()],
    mounts: mergeMounts(toMountSpecs(mounts, agentGroup.id), gateway.mounts ?? []),
    contributedEnv,
  };

  // The folder label (D9) rides the spec so an admission-side check can pin
  // the `groups/<folder>` mount subtree to the session that carries it — the
  // id→folder mapping lives only in the central DB, which no admission-side
  // check can read. It is VERBATIM by contract, deliberately the opposite of
  // the projection lineage labels get: the policy pins hostPaths by
  // concatenating this label into the required prefix
  // (`path.startsWith(GROUPS + '/' + label + '/')` shape), and no
  // admission-side check can invert a hash-suffix projection — a projected
  // value would have the policy compare the real folder against a truncated
  // stand-in and deny every session of the group while naming the wrong
  // culprit. So a folder no driver can carry verbatim refuses HERE, loudly
  // and non-retryably, where the error can say what is actually wrong.
  if (!labelValueLegal(agentGroup.folder)) {
    throw specInvalid(
      `group folder '${agentGroup.folder}' cannot be carried verbatim as the ${GROUP_FOLDER_LABEL} label ` +
        `(label values: <=63 bytes of [A-Za-z0-9._-], alphanumeric at both ends); admission joins ` +
        `on this label verbatim so it is never projected — rename the group folder ` +
        `(\`bun scripts/detect-driver-migration.ts\` enumerates affected groups and the fix)`,
    );
  }

  return {
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
    labels: { 'nanoclaw-container-name': containerName, [GROUP_FOLDER_LABEL]: agentGroup.folder },
    // The gateway's auxiliary containers ride beside the agent; capability-
    // gated in the spawn path before composition ever runs.
    containers: [agent, ...(gateway.containers ?? [])],
    network: 'shared-private',
    hardening: 'standard',
    resources: {
      cpus: CONTAINER_CPU_LIMIT || undefined,
      memoryMb: parseMemoryMb(CONTAINER_MEMORY_LIMIT),
      pidsLimit: parsePidsLimit(CONTAINER_PIDS_LIMIT),
      shmSizeMb: SHM_SIZE_MB,
    },
    // The group's configured tier; the driver refuses one it cannot realize
    // (validateSpec, against capabilities().isolationTiers).
    runtimeTier: containerConfig.runtimeTier ?? 'container',
    runAs,
    stopGraceSeconds: STOP_GRACE_SECONDS,
  };
}

/**
 * `CONTAINER_MEMORY_LIMIT` is an operator-facing docker size string ("8g",
 * "512m"). Empty stays undefined — no cap, today's behavior.
 *
 * A bare number is bytes, which is Docker's own rule and therefore what an
 * operator's existing value already means. It is preserved rather than
 * reinterpreted as megabytes: guessing the friendlier meaning would quietly
 * multiply a limit by a million.
 */
export function parseMemoryMb(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg]?)b?$/i.exec(value.trim());
  if (!match) {
    // Fail-closed, like the raw pass-through this replaced: an invalid value
    // used to make Docker reject the spawn, and returning undefined here would
    // silently REMOVE the operator's cap instead — the one wrong direction for
    // a resource limit to fail in.
    throw specInvalid(`CONTAINER_MEMORY_LIMIT '${value}' is not a docker size string ("8g", "512m", "1073741824")`);
  }
  const size = Number(match[1]);
  if (!Number.isFinite(size)) {
    throw specInvalid(`CONTAINER_MEMORY_LIMIT '${value}' is not a docker size string ("8g", "512m", "1073741824")`);
  }
  if (size === 0) return undefined; // Docker's own meaning for 0: no cap.
  switch (match[2].toLowerCase()) {
    case 'g':
      return Math.floor(size * 1024);
    case 'k':
      return Math.max(1, Math.floor(size / 1024));
    case 'b':
    case '':
      return Math.max(1, Math.floor(size / (1024 * 1024)));
    default:
      return Math.floor(size);
  }
}

/** cgroups v2 rejects a pids limit of 0 with EINVAL, so blank/0/garbage means no cap. */
export function parsePidsLimit(value: string): number | undefined {
  const pids = Number(value);
  return Number.isFinite(pids) && pids > 0 ? Math.floor(pids) : undefined;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>) so
 * it's dangling on the host but valid inside the container.
 *
 * Not the mechanism the composer stopped using: skill discovery is a directory
 * scan that follows a link wherever it lands, and only `@` imports are gated on
 * resolving inside the project directory.
 */
export function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink()) {
      // A real entry here is either a template overlay (intentional; see
      // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
      // the shared skill (#3001). No marker distinguishes them yet, so
      // surface the skip instead of staying silent.
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        {
          skill,
          path: linkPath,
        },
      );
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

/**
 * Every env var this fork's agent-runner, hooks, and overlay scripts read.
 *
 * These used to be `-e KEY=VALUE` pushes inside `buildContainerArgs`, which the
 * driver seam removed: `ContainerSpec` forbids raw runtime flags, but env is a
 * typed lane, so the whole set survives as a plain record. Composed literals
 * only — registry-sourced lanes (the model provider's contribution, the
 * gateway's) ride `contributedEnv` and override these on a key collision.
 */
async function forkContainerEnv(input: ComposeSessionSpecInput): Promise<Record<string, string>> {
  const { agentGroup, session, containerName, containerConfig, contribution, provider, mcpProxy, instanceId } = input;
  const env: Record<string, string> = {};

  // Only vars read by code we don't own. Everything NanoClaw-specific is in
  // container.json (read by the runner at startup). Per-group timezone override
  // (migration 020) → falls back to the install global; resolveGroupTimezone
  // validates a hand-edited DB value.
  env.TZ = await resolveGroupTimezone(agentGroup.id);
  if (provider) env.AGENT_PROVIDER = provider;

  // claude-trace: point the SDK's executable at the wrapper mounted by
  // buildMounts. Unlike stock claude-trace (a require-hook, JS-only), this
  // build stands up a local reverse proxy, points the child's
  // ANTHROPIC_BASE_URL at it, and forwards upstream via the OneCLI proxy — so
  // it works with the NATIVE ELF binary and captures NVIDIA (/llm/) and
  // Bedrock (/model/) traffic, not just anthropic.com. Gated on the same
  // directory check as the mount: no build, no env, no trace.
  if (provider === 'claude' && resolveClaudeTraceDir()) {
    env.CLAUDE_CODE_EXECUTABLE = '/opt/claude-trace/claude-trace-wrapper.sh';
    env.CLAUDE_TRACE_DIR = '/opt/claude-trace';
    // NANOCLAW_SESSION_ID (below, for dashboard routing) is also read by the
    // wrapper for per-session --log names.
  }

  // Two-DB split: container reads inbound.db, writes outbound.db. The runner
  // defaults to these same paths, but state them so a mailbox implementation
  // that relocates them only has to change one place.
  env.SESSION_INBOUND_DB_PATH = '/workspace/inbound.db';
  env.SESSION_OUTBOUND_DB_PATH = '/workspace/outbound.db';
  env.SESSION_HEARTBEAT_PATH = '/workspace/.heartbeat';

  // Intent router needs the same OVERLAY_WORKFLOWS string the SDK hook gets,
  // so the agent-runner's poll-loop can run the router on follow-up pushes
  // (the SDK fires UserPromptSubmit only on the initial query; mid-query
  // query.push() does not, so the agent-runner has to invoke the hook itself).
  // Skipped when disable_overlays=1: with no intent-router hook registered
  // in settings.json, the env var would be dead weight at best and would
  // still drive intent-router-bridge.ts on follow-up pushes at worst.
  {
    const { hasPlan, hasCritique } = resolveOverlayHookFlags(agentGroup);
    if (hasPlan || hasCritique) {
      const { workflows: wfList } = resolveTypeManifest(agentGroup);
      if (wfList.length > 0) {
        env.OVERLAY_WORKFLOWS = wfList
          .map((w) => `${w.name}:${w.description.slice(0, 60).replace(/[;:]/g, ' ')}`)
          .join(';');
      }
    }
    // Tamper-resistant critique-gate activation: the composer already
    // materialized .overlay-critique-gate / .critique-required-stages into
    // groupDir (composeCoworkerClaudeMd). Read them here — before the
    // container (and the agent) exists — and pass them as env. The gate hook
    // and poll-loop treat the env as authoritative when present, so an agent
    // can no longer disable the gate by `rm .overlay-critique-gate` or weaken
    // it by rewriting .critique-required-stages: a child process cannot mutate
    // the harness's inherited environment. (workflow-state.json verdicts stay
    // agent-writable — host-side receipts are the deeper fix, tracked
    // separately.) When disable_overlays=1, hasCritique is false and no env is
    // emitted, so the gate stays off.
    if (hasCritique) {
      const gateGroupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
      const active = fs.existsSync(path.join(gateGroupDir, '.overlay-critique-gate'));
      env.CRITIQUE_GATE_ACTIVE = active ? '1' : '0';
      if (active) {
        try {
          const stages = fs.readFileSync(path.join(gateGroupDir, '.critique-required-stages'), 'utf-8').trim();
          if (stages) env.CRITIQUE_REQUIRED_STAGES = stages;
        } catch {
          /* no required-stages file → legacy any-1-round mode, gate still active */
        }
      }
    }
  }

  // Model + API routing + SDK tuning — forward host .env vars so the Claude
  // SDK inside the container talks to the right endpoint with the right model.
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ENABLE_PROMPT_CACHING_1H',
    // Separate Bedrock-specific toggle read by the Claude Code SDK when
    // requests route through an aws/anthropic/bedrock-* model. All three
    // instances (lego/prod/dev) use the NVIDIA inference-api proxy with
    // bedrock models, so `ENABLE_PROMPT_CACHING_1H_BEDROCK` is the one that
    // actually takes effect; `ENABLE_PROMPT_CACHING_1H` alone is ignored on
    // the Bedrock path.
    'ENABLE_PROMPT_CACHING_1H_BEDROCK',
    'FORCE_PROMPT_CACHING_5M',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    'CLAUDE_CODE_FORK_SUBAGENT',
    'CODEX_HOME',
    'CODEX_BASE_URL',
    'CODEX_MODEL',
    'CODEX_MODEL_PROVIDER',
    'CODEX_REASONING_EFFORT',
    'PI_MODEL',
    'PI_PROVIDER',
    'PI_THINKING_LEVEL',
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  // Stub credentials — load-bearing for SDKs that refuse to send a request
  // without an env var, but the actual auth is injected by the OneCLI MITM
  // proxy on the wire (host-pattern-matched secrets). Naming chosen so any
  // agent inspecting the value sees "this is not a real token, do NOT bake
  // me into URLs / config / logs". Never use $GH_TOKEN as a Basic-auth
  // password — the proxy replaces the Authorization header by host+path,
  // not by URL-embedded creds. The git-remote-url-guard hook (PreToolUse on
  // Bash) catches the `git remote set-url ...$GH_TOKEN...` footgun.
  env.NVIDIA_API_KEY = 'ROUTED_VIA_ONECLI_PROXY';
  env.GH_TOKEN = 'ROUTED_VIA_ONECLI_PROXY';
  // git doesn't honor SSL_CERT_FILE — needs GIT_SSL_CAINFO to trust
  // the OneCLI MITM CA so `git clone/push` work through the proxy.
  env.GIT_SSL_CAINFO = '/tmp/onecli-combined-ca.pem';
  // pip uses REQUESTS_CA_BUNDLE / PIP_CERT rather than SSL_CERT_FILE.
  // Without these, pip inside a venv fails SSL verification through the proxy.
  env.REQUESTS_CA_BUNDLE = '/tmp/onecli-combined-ca.pem';
  env.PIP_CERT = '/tmp/onecli-combined-ca.pem';

  if (agentGroup.name) env.NANOCLAW_ASSISTANT_NAME = agentGroup.name;
  env.NANOCLAW_AGENT_GROUP_ID = agentGroup.id;
  env.NANOCLAW_AGENT_GROUP_NAME = agentGroup.name;
  // Per-session identity — the dashboard uses these to attribute hook
  // events to the NanoClaw session that emitted them (via the
  // sdk_session_routes mapping table). Empty thread_id is fine; the
  // dashboard treats the empty string as "root session".
  env.NANOCLAW_SESSION_ID = session.id;
  env.NANOCLAW_SESSION_THREAD_ID = session.thread_id ?? '';
  // NanoClaw #1 "set ceiling v2" readiness handshake nonce — see
  // getActiveContainerInstanceId's doc comment in container-runner.ts.
  env.NANOCLAW_RUNNER_INSTANCE_ID = instanceId;
  // Dashboard hook URL — exposed to in-container overlay scripts (buddy-
  // call.sh, dispatchResultText) so they can post overlay-emitted events
  // alongside the SDK's universal PostToolUse stream. Same URL shape the
  // universal curl hook uses; empty when DASHBOARD_PORT isn't configured
  // so call sites can no-op cleanly.
  env.NANOCLAW_HOOK_URL = DASHBOARD_PORT ? `http://host.docker.internal:${DASHBOARD_PORT}/api/hook-event` : '';
  env.NANOCLAW_GROUP_FOLDER = agentGroup.folder;
  // Cap on how many pending messages reach one prompt. Accumulated context
  // (trigger=0 rows) rides along with wake-eligible rows up to this cap.
  env.NANOCLAW_MAX_MESSAGES_PER_PROMPT = String(MAX_MESSAGES_PER_PROMPT);

  // Idle-end timeout override. Agents that run long builds (e.g. CMake debug
  // builds = 15-25 min) need a higher ceiling than the 600s default so the
  // poll loop doesn't kill the query mid-build. Set NANOCLAW_IDLE_END_MS in
  // the host .env to widen the window for all containers, or pass it through
  // per-agent-group config. The poll-loop clamps to a 60s floor.
  if (process.env.NANOCLAW_IDLE_END_MS) env.NANOCLAW_IDLE_END_MS = process.env.NANOCLAW_IDLE_END_MS;

  // Disable the age-based transcript-rotation trigger by default. Past this
  // age, maybeRotateContinuation() renames the live .jsonl to
  // `.rotated-<ts>` — invisible to cost accounting (dashboard + fleet
  // reporting only glob *.jsonl), so a "safe" rotation was silently deleting
  // history from cost's point of view. Size-based rotation (12MB default)
  // still governs, so a genuinely runaway transcript still rotates.
  // Operator-overridable via CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS in host env.
  // See issue #1327.
  //
  // NORMALIZE, do not forward raw: the container-side reader
  // (`transcriptRotateAgeMs` in providers/claude.ts) treats a blank / non-
  // numeric value as the 14-day DEFAULT, not as "disabled". A bare
  // `CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS=` in host env (`??` only guards
  // `undefined`, not '') would therefore silently reactivate the exact loss
  // this line exists to stop. Forward a finite numeric string as-is, else '0'.
  env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = normalizeRotateAgeDays(process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS);

  // Bypass proxy for host-local traffic (dashboard hooks, MCP proxy) only.
  // NOTE: discord.com must NOT be bypassed. The container-side slang-mcp
  // Discord tools never receive DISCORD_BOT_TOKEN via env (it's not in the
  // slang-mcp envInherit allowlist), so they authenticate exclusively via
  // the REST-over-OneCLI-proxy path, which depends on the proxy injecting
  // `Authorization: Bot {token}` on the wire (host-pattern discord.com).
  // Listing discord.com here routes that traffic around the proxy → no
  // token is injected → Discord returns 401 credential_not_found. The
  // host-side Discord channel adapter is unaffected (it runs on the host
  // with the token from .env, not through this container env).
  env.NO_PROXY = 'host.docker.internal,localhost,127.0.0.1';
  env.no_proxy = 'host.docker.internal,localhost,127.0.0.1';

  // MCP servers: type-level (from coworker registry) + per-instance (from
  // container.json). Per-instance overrides type-level per server name.
  //
  // BOTH lanes are load-bearing and must stay: `NANOCLAW_MCP_SERVERS` is the
  // SOLE transport for type-level coworker-registry servers (they have no
  // other way in), while container.json's `mcpServers` is per-instance only.
  // Proxy auto-discovery in the agent-runner runs LAST so its
  // `if (mcpServers[serverName]) continue` guard lets explicit config win.
  const typeMcpServers = resolveTypeManifest(agentGroup).mcpServers;
  const mergedMcpServers = { ...typeMcpServers, ...containerConfig.mcpServers };
  // Withhold the wiring for any server the policy allows no tool on. These
  // entries are direct (stdio/http) servers that never traverse the host MCP
  // proxy, so the proxy's ACL cannot restrict them — the only host-side
  // control is not handing them over. It is also the strongest one: a server
  // that was never wired needs no deny list to be complete, and its `env`
  // block (which can carry credentials) never enters the container at all.
  // This withholding step runs AFTER the merge above, never before it.
  const wiredMcpServers = mcpProxy
    ? Object.fromEntries(
        Object.entries(mergedMcpServers).filter(([name]) => serverHasAllowedTools(mcpProxy.policy, name)),
      )
    : mergedMcpServers;
  const withheld = Object.keys(mergedMcpServers).filter((n) => !(n in wiredMcpServers));
  if (withheld.length > 0) {
    log.info('Withholding MCP servers with no allowed tools', {
      containerName,
      withheld,
      restricts: mcpProxy?.policy.restricts,
    });
  }
  if (Object.keys(wiredMcpServers).length > 0) {
    env.NANOCLAW_MCP_SERVERS = JSON.stringify(wiredMcpServers);
  }

  // MCP proxy token + URL + allowed tools — enables containers to reach host MCP servers
  if (mcpProxy) {
    env.MCP_PROXY_TOKEN = mcpProxy.proxyToken;
    env.MCP_PROXY_URL = `http://host.docker.internal:${MCP_PROXY_PORT}`;

    // ALWAYS passed, whatever the list length. This is the whole fix for the
    // empty-list hole: the container decides what to wire and what to allow
    // from the policy STATE, and it reads a missing variable as `unresolved`
    // (deny all configurable MCP). Previously both variables below were
    // omitted when the list was empty, which the container read as "no
    // restrictions requested" — so `--tools '[]'` handed over the full direct
    // tool surface (`mcp__nanoclaw__*`, `mcp__codex__*`), none of which
    // traverses the proxy that was doing the actual restricting.
    env.NANOCLAW_MCP_POLICY = JSON.stringify(toMcpPolicyWire(mcpProxy.policy));

    // Legacy variables, still emitted for the SDK disallowedTools backstop and
    // for the proxy-server auto-discovery path in the agent-runner. They are
    // no longer the policy — `NANOCLAW_MCP_POLICY` is.
    env.NANOCLAW_ALLOWED_MCP_TOOLS = JSON.stringify(mcpProxy.policy.externalTools);
    // claude.ts::computeBlockedTools builds the disallowedTools list as
    // (inventory − allowed). Pass the discovered inventory so the SDK-level
    // block covers proxied servers by name as well as by policy.
    const inventory = getDiscoveredToolInventory();
    if (Object.keys(inventory).length > 0) {
      env.NANOCLAW_MCP_TOOL_INVENTORY = JSON.stringify(inventory);
    }
  }

  if (DASHBOARD_PORT) env.DASHBOARD_URL = `http://host.docker.internal:${DASHBOARD_PORT}`;

  // Provider-contributed env (e.g. XDG_DATA_HOME, OPENCODE_*) is NOT merged
  // here: it rides `contributedEnv` on the spec, which is the registry-sourced
  // lane and wins a key collision with these composed literals.
  void contribution;

  return env;
}

/**
 * PID 1's argument for the agent container.
 *
 * Codex CLI needs the full [model_providers.<provider>] block in a real
 * config.toml — `-c` overrides reliably modify existing fields but don't
 * always *define* new TOML sections. Generate a minimal config from
 * container env vars at start, then exec the agent-runner. Auth still flows
 * through the OneCLI MITM proxy via env_key=NVIDIA_API_KEY.
 *
 * Note: the heredoc delimiter is UNquoted (TOML_EOF, not 'TOML_EOF') so bash
 * expands the ${VAR:-default} references at container start, not here.
 */
function agentEntrypointScript(): string {
  return `git config --global "url.https://x-access-token:placeholder@github.com/.insteadOf" "https://github.com/" 2>/dev/null || true
mkdir -p ~/.codex && cat > ~/.codex/config.toml <<TOML_EOF
model_provider = "\${CODEX_MODEL_PROVIDER:-nvinference}"
model = "\${CODEX_MODEL:-openai/openai/gpt-5.5}"
model_reasoning_effort = "\${CODEX_REASONING_EFFORT:-xhigh}"
# Docker is the sandbox; codex's bwrap wrapper is redundant nesting and fails
# with "No permissions to create a new namespace" because Docker's default
# seccomp profile blocks unshare(CLONE_NEWUSER). Skip codex's sandbox and
# rely on the container boundary.
sandbox_mode = "danger-full-access"

[features]
use_linux_sandbox_bwrap = false
hooks = true

[model_providers.\${CODEX_MODEL_PROVIDER:-nvinference}]
name = "\${CODEX_MODEL_PROVIDER:-nvinference}"
wire_api = "\${CODEX_WIRE_API:-responses}"
base_url = "\${CODEX_BASE_URL:-https://inference-api.nvidia.com/v1}"
env_key = "NVIDIA_API_KEY"

[projects."/workspace/agent"]
trust_level = "trusted"
TOML_EOF
# NOTE: hooks are deliberately NOT written here any more. They used to be
# emitted as ~/.codex/hooks.json, which lands in Codex's USER config layer —
# where every command hook needs per-hook, content-hash trust before it may
# fire, and an untrusted one is skipped SILENTLY. Containers are --rm, so that
# trust never exists and the hooks were a permanent no-op: the dashboard simply
# showed no events for Codex groups. They now ship in the MANAGED layer as
# /etc/codex/requirements.toml, baked into the image from container/
# codex-hooks.toml, which reports trustStatus "managed". Do not reintroduce a
# hooks.json here — with allow_managed_hooks_only it is ignored, and without it
# it reappears as a duplicate hooks/list entry per event.
exec bun run /app/src/index.ts`;
}
const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = await getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = await getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  // Image building is not on the runtime path (drivers never build) and shells
  // the local Docker daemon. Both call sites gate on the `imageBuild`
  // capability; this is the backstop for any future caller that forgets.
  if (!getSessionDriver().capabilities().imageBuild) {
    throw new Error('Per-agent-group image builds are unavailable on this runtime driver');
  }

  // Which bytes this is built on. Recorded on the derived image so an operator
  // can tell which base a group's packages were layered onto — the image id
  // rather than a RepoDigest, because a locally built base has no RepoDigest at
  // all and an id is unambiguous either way.
  let baseId = '';
  try {
    const { stdout } = await execAsync(`${CONTAINER_RUNTIME_BIN} image inspect --format '{{.Id}}' ${CONTAINER_IMAGE}`);
    baseId = stdout.trim();
  } catch {
    // Non-fatal: the build below fails on its own if the base is really absent.
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  // Overwrite the provenance label rather than letting it be inherited.
  //
  // `dev.nanoclaw.image-source` is documented as the one claim a retag cannot
  // forge, and --status treats it as the trustworthy answer. But a derived
  // build inherits the base's labels, so without this a group that has just
  // added arbitrary apt/npm packages would keep asserting `hardened` — the
  // vendor's claim, over bytes the vendor never saw. `derived` is the honest
  // answer, and `derived-from` says what it was layered onto.
  dockerfile += 'LABEL dev.nanoclaw.image-source="derived"\n';
  if (baseId) dockerfile += `LABEL dev.nanoclaw.derived-from="${baseId}"\n`;

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync. exec buffers
    // stdout/stderr (matching the old stdio: 'pipe') and rejects on a non-zero
    // exit, so error propagation is unchanged.
    // --pull=false: the FROM tag is a local-only base image (built by
    // ./container/build.sh, never pushed to a registry). Without this flag,
    // buildkit may attempt a registry pull and fail with "pull access
    // denied". Observed in slang#11004 fixer's install_packages call.
    // Note: --pull is a boolean flag in docker buildx — `--pull=never` is
    // INVALID and fails with "strconv.ParseBool: parsing 'never'". Use
    // `--pull=false` (or omit; default is false).
    await execAsync(`${CONTAINER_RUNTIME_BIN} build --pull=false -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB — container.json is re-materialized from it
  // at the next spawn, so writing the file here would be redundant.
  await updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
