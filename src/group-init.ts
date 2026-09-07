import fs from 'fs';
import path from 'path';

import { resolveMirroredSkillScope } from './claude-composer.js';
import { DATA_DIR, DEFAULT_AGENT_PROVIDER, GROUPS_DIR } from './config.js';
import { getDb } from './db/connection.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { PERSONA_PREPEND_FILE, stageGroupPersona } from './group-persona.js';
import { log } from './log.js';
import {
  CLAUDE_DEFAULT_SETTINGS,
  CLEANUP_PERIOD_DAYS_NEVER,
  migrateClaudeMemorySettings,
} from './migrate-claude-memory-settings.js';
import { getProviderHostContract } from './provider-contracts/registry.js';
import { initializeProviderGroupSurfaces } from './provider-contracts/realize.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import type { AgentGroup } from './types.js';

/**
 * Deepest mtime under `p` (file or directory, recursive). Returns 0 on
 * missing path. Used to decide whether a source tree is newer than its
 * mirrored destination.
 */
function latestMtimeMs(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  let entries: string[];
  try {
    entries = fs.readdirSync(p);
  } catch {
    return max;
  }
  for (const entry of entries) {
    const child = latestMtimeMs(path.join(p, entry));
    if (child > max) max = child;
  }
  return max;
}

/**
 * Refresh a source→destination mirror when the source is newer than the
 * mirror (or the mirror does not exist). Removes the destination first so
 * files deleted upstream are not left behind. Returns true if a copy ran.
 */
export function refreshMirror(src: string, dst: string): boolean {
  const srcMtime = latestMtimeMs(src);
  const dstMtime = latestMtimeMs(dst);
  if (dstMtime >= srcMtime) return false;
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  return true;
}

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * re-running on an already-initialized group only refreshes mirrored
 * source trees (skills, subagent definitions) when their sources are newer.
 *
 * Called on every wake via `buildMounts()`. Agent-owned paths (groupDir,
 * .instructions.md, settings.json) are created once and then left alone;
 * host-owned mirrors of `container/skills/` and `container/overlays/`
 * agent.md siblings are kept current automatically so upstream skill
 * changes propagate without a manual refresh tool.
 */
export async function initGroupFilesystem(
  group: AgentGroup,
  opts?: { instructions?: string; provider?: string | null },
): Promise<void> {
  const projectRoot = process.cwd();
  const initialized: string[] = [];

  // `opts.provider` absent means "caller has no provider opinion" — for a
  // brand-new group that resolves to the instance default, so the scaffold and
  // the stamped config row both match it. A caller that knows the provider
  // (subagent → parent's, spawn → resolved, setup → operator's pick) passes it
  // explicitly — including `claude` — which pins the group and skips the
  // default. ensureContainerConfig is INSERT OR IGNORE, so this only stamps a
  // genuinely new group; existing rows are never touched.
  const providerHint = (opts?.provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();

  // Default agent surfaces apply unless the provider declares (at registration)
  // that it provides its own.
  //
  // NOT gated on `contract`, unlike upstream. Claude declares a host contract,
  // and this fork's group surfaces are the lego mirrors below — scoped skills/,
  // agents/, overlays/ selected by coworker_type — which the contract's
  // group-init operations do not reproduce. Gating on the contract here would
  // silently stop mirroring skills for every claude coworker while every test
  // that checks the contract path stayed green.
  const contract = getProviderHostContract(providerHint);
  const defaultSurfaces = !providerProvidesAgentSurfaces(providerHint);

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // plugins/ always exists (even for plugin-less groups) so the read-only
  // plugins mount in container-runner.ts is unconditional.
  const pluginsDir = path.join(groupDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    initialized.push('plugins/');
  }

  // groups/<folder>/memory/ — agent-writable per-group notes (triage memos,
  // fix reports, learnings). Workflows write to /workspace/agent/memory/<file>
  // assuming the dir exists; without scaffolding the first turn fails with
  // `ls: cannot access /workspace/agent/memory/: No such file or directory`.
  const memoryDir = path.join(groupDir, 'memory');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
    initialized.push('memory');
  }

  // groups/<folder>/CLAUDE.md is composed by composeCoworkerClaudeMd in
  // container-runner.ts on every wake — for both 'main' (flat body +
  // additive fragments) and typed coworkers (full spine). The host never
  // hand-writes the file here.

  // Seed/instructions. Standing instructions live in `instructions.prepend.md`,
  // composed into CLAUDE.md on every wake. A creator may instead drop a
  // provider-agnostic neutral `.seed.md`; consume it here (placement deferred to
  // first spawn, where the DB-resolved provider is known). `opts.instructions`
  // wins if passed inline. For a surfaces-owning (non-default, e.g. codex)
  // provider, ALSO land the seed in the memory scaffold's conventional file so
  // that agent reads it on its first turn (it composes no persona file).
  const neutralSeedFile = path.join(groupDir, '.seed.md');
  const seed =
    opts?.instructions ??
    (fs.existsSync(neutralSeedFile) ? fs.readFileSync(neutralSeedFile, 'utf-8').trimEnd() : undefined);

  // Canonical name, not the legacy `.instructions.md`: seeding the legacy file
  // handed every fresh group a surface that the first spawn immediately
  // migrated away. `stageGroupPersona` is no-clobber, so an existing persona
  // (or a re-run) is never overwritten.
  if (seed && stageGroupPersona(groupDir, seed)) {
    initialized.push(PERSONA_PREPEND_FILE);
  }

  if (!defaultSurfaces && seed) {
    const seedFile = path.join(groupDir, 'memory', 'memories', 'imported-agent-memory.md');
    if (!fs.existsSync(seedFile)) {
      fs.mkdirSync(path.dirname(seedFile), { recursive: true });
      fs.writeFileSync(seedFile, seed + '\n');
      initialized.push('memory/memories/imported-agent-memory.md');
    }
  }

  // The neutral seed is single-use — drop it once placed.
  if (fs.existsSync(neutralSeedFile)) {
    fs.rmSync(neutralSeedFile);
    initialized.push('.seed.md consumed');
  }

  // Ensure container_configs row exists in the DB. Idempotent — no-op if
  // the row already exists (e.g. created by backfill or group creation). On a
  // fresh row, stamp the resolved provider hint so a new group is created on
  // the instance default (or the caller's explicit pick).
  await ensureContainerConfig(group.id, providerHint);
  initialized.push('container_configs');

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  // A contract realizes the surfaces only for a provider that owns them; when
  // this fork owns them (defaultSurfaces) the legacy branch below is the one.
  if (contract && !defaultSurfaces) {
    initialized.push(...initializeProviderGroupSurfaces(providerHint, contract, group.id, groupDir));
  } else if (defaultSurfaces) {
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      initialized.push('.claude-shared');
    }

    const settingsFile = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, CLAUDE_DEFAULT_SETTINGS);
      initialized.push('settings.json');
    } else {
      ensurePreCompactHook(settingsFile, initialized);
      ensureCleanupPeriodDays(settingsFile, initialized);
    }

    // mtime-based mirror: re-copy any skill whose source tree is newer than
    // the destination. This fixes silent skill-mirror staleness — prior
    // copy-once-at-init left existing groups stuck on old skill versions
    // indefinitely after upstream changes.
    //
    // SCOPED (Tier 2): only the coworker type's own resolved skills plus the
    // always-on floor are mirrored. Claude Code lists every mirrored skill's
    // name + description in the per-turn preamble, so an unscoped mirror makes
    // e.g. a slang coworker pay for every `nanoclaw-*` skill on every turn.
    // `resolveMirroredSkillScope` fails open — an untyped group, a flat type
    // (`main`), or any resolution error yields `dirs: null` = mirror all.
    //
    // The resolved scope is held here (null = unscoped) because the
    // subagent-definition mirror below reuses it: `agents/` must never
    // advertise a subagent whose skill dir was scoped out.
    let mirroredSkillDirs: Set<string> | null = null;
    const skillsDst = path.join(claudeDir, 'skills');
    const skillsSrc = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(skillsSrc)) {
      fs.mkdirSync(skillsDst, { recursive: true });
      const scope = resolveMirroredSkillScope(projectRoot, group.coworker_type);
      if (scope.degraded) {
        log.warn('Skills mirror falling back to mirror-all', {
          group: group.name,
          id: group.id,
          coworker_type: group.coworker_type,
          reason: scope.reason,
        });
      }
      for (const skill of fs.readdirSync(skillsSrc)) {
        if (scope.dirs && !scope.dirs.has(skill)) continue;
        const src = path.join(skillsSrc, skill);
        const dst = path.join(skillsDst, skill);
        const existed = fs.existsSync(dst);
        if (refreshMirror(src, dst)) {
          initialized.push(existed ? `skills/${skill} (refreshed)` : `skills/${skill}`);
        }
      }
      // Prune skills that are no longer in scope. Without this, a group that
      // was mirrored before scoping (or whose coworker_type changed) keeps
      // paying for skills it can't invoke — the mirror is copy-forward only.
      if (scope.dirs) {
        for (const existing of fs.readdirSync(skillsDst)) {
          if (scope.dirs.has(existing)) continue;
          fs.rmSync(path.join(skillsDst, existing), { recursive: true, force: true });
          initialized.push(`skills/${existing} (pruned — out of type scope)`);
        }
      }
      mirroredSkillDirs = scope.dirs;
    }

    // 2b. data/v2-sessions/<id>/.claude-shared/agents/ — subagent definitions.
    // A sibling `agent.md` inside any skill or overlay dir is copied as a
    // subagent definition. Overlays like `codex-critique` ship both an
    // OVERLAY.md (compose-time body) and an agent.md (runtime subagent).
    // mtime-refreshed on each wake for the same reason as skills/.
    //
    // Scoped in lockstep with skills/: a skill dir the type doesn't get can't
    // contribute a subagent either. `overlays/` stays unscoped — overlays are
    // selected per agent-group (agent_groups.overlays), not by coworker type.
    const agentSourceAllowed = (subdir: string, entry: string): boolean =>
      subdir !== 'skills' || mirroredSkillDirs === null || mirroredSkillDirs.has(entry);
    const agentsDst = path.join(claudeDir, 'agents');
    fs.mkdirSync(agentsDst, { recursive: true });
    for (const subdir of ['skills', 'overlays']) {
      const srcRoot = path.join(projectRoot, 'container', subdir);
      if (!fs.existsSync(srcRoot)) continue;
      for (const entry of fs.readdirSync(srcRoot)) {
        if (!agentSourceAllowed(subdir, entry)) continue;
        const agentFile = path.join(srcRoot, entry, 'agent.md');
        if (fs.existsSync(agentFile)) {
          const dst = path.join(agentsDst, `${entry}.md`);
          const existed = fs.existsSync(dst);
          const srcMtime = latestMtimeMs(agentFile);
          const dstMtime = latestMtimeMs(dst);
          if (dstMtime < srcMtime) {
            fs.copyFileSync(agentFile, dst);
            initialized.push(existed ? `agents/${entry}.md (refreshed)` : `agents/${entry}.md`);
          }
        }
      }
    }

    // Prune mirrors for agent.md files removed upstream so stale definitions
    // (e.g. sandbox:'read-only' from an old codex-critique) can't persist.
    // Also prunes definitions whose skill dir went out of type scope.
    for (const existing of fs.readdirSync(agentsDst)) {
      const name = existing.replace(/\.md$/, '');
      const stillExists = ['skills', 'overlays'].some(
        (sub) =>
          agentSourceAllowed(sub, name) && fs.existsSync(path.join(projectRoot, 'container', sub, name, 'agent.md')),
      );
      if (!stillExists) {
        fs.rmSync(path.join(agentsDst, existing));
        initialized.push(`agents/${existing} (pruned orphan)`);
      }
    }
  } // end if (defaultSurfaces) — claude-shared skill/agent mirrors

  // No per-group agent-runner copy. `container-runner.ts` bind-mounts
  // `container/agent-runner/src` itself at /app/src, read-only, for every group.
  // Existing `data/v2-sessions/<id>/agent-runner-src/` dirs are left in place
  // (they are simply no longer mounted) so a rollback needs no restore, and
  // deleting an agent's files is not this function's call to make.

  // 4. Codex provider: symlinks + disable overlays (hooks not supported)
  // Codex CLI doesn't execute settings.json hooks, so overlay enforcement
  // (plan-gate, critique-gate, edit-counter) is completely inoperative.
  // Set disable_overlays=1 so the composer doesn't render gate markers that
  // the agent can't enforce, and create symlinks for native discovery.
  if (group.agent_provider === 'codex') {
    if (group.disable_overlays !== 1) {
      try {
        // Goes through the async central-DB driver rather than a private
        // better-sqlite3 handle: `updateAgentGroup` does not expose this column.
        await getDb().run('UPDATE agent_groups SET disable_overlays = 1 WHERE id = ?', group.id);
        initialized.push('disable_overlays=1 (codex: hooks unsupported)');
      } catch {
        /* non-critical — overlays just render uselessly */
      }
    }
    const agentsMdLink = path.join(groupDir, 'AGENTS.md');
    if (!fs.existsSync(agentsMdLink)) {
      try {
        fs.symlinkSync('CLAUDE.md', agentsMdLink);
        initialized.push('AGENTS.md → CLAUDE.md');
      } catch {
        /* ignore if already exists */
      }
    }
    // .agents → the .claude-shared dir (mounted as /home/node/.claude/ in container)
    // In the container, CWD is /workspace/agent/ and .claude is at /home/node/.claude/
    // The symlink target must be relative to CWD inside the container
    const agentsLink = path.join(groupDir, '.agents');
    if (!fs.existsSync(agentsLink)) {
      try {
        fs.symlinkSync('/home/node/.claude', agentsLink);
        initialized.push('.agents → /home/node/.claude');
      } catch {
        /* ignore */
      }
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';

/**
 * Patch an existing settings.json to add the PreCompact hook if missing.
 * Runs on every group init so pre-existing groups pick up the hook.
 */
function ensurePreCompactHook(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);

    // Check if there's already a PreCompact hook with our command.
    const existing = settings.hooks?.PreCompact as unknown[] | undefined;
    if (existing && JSON.stringify(existing).includes(PRE_COMPACT_COMMAND)) return;

    // Add the hook, preserving existing hooks.
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
    settings.hooks.PreCompact.push({
      hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }],
    });

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push('settings.json (added PreCompact hook)');
  } catch {
    // Don't break init if settings.json is malformed — it'll use whatever's there.
  }
}

/**
 * Patch an existing settings.json to raise cleanupPeriodDays if it's absent
 * or still at a value that lets Claude Code's own startup sweep prune
 * transcript history (default 30 days when unset). Runs on every group init
 * (every wake) so pre-existing groups self-heal without a restart-only
 * migration. See issue #1327 — this is the fix for the fleet-wide
 * transcript-loss bug, not a preference.
 */
export function ensureCleanupPeriodDays(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);

    // Only a JSON object can carry a cleanupPeriodDays key. A non-object root
    // (array, null, primitive) is not a valid Claude settings.json anyway, and
    // assigning a property to it either throws (null/primitive) or is dropped
    // by stringify (array) — which would rewrite the file yet record a bogus
    // success. Leave it untouched instead.
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return;

    const current = settings.cleanupPeriodDays;
    if (typeof current === 'number' && current >= CLEANUP_PERIOD_DAYS_NEVER) return;

    settings.cleanupPeriodDays = CLEANUP_PERIOD_DAYS_NEVER;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push(`settings.json (cleanupPeriodDays -> ${CLEANUP_PERIOD_DAYS_NEVER})`);
  } catch {
    // Don't break init if settings.json is malformed — it'll use whatever's there.
  }
}
