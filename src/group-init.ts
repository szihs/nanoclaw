import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      preferences: {
        reasoningEffort: 'max',
      },
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    },
    null,
    2,
  ) + '\n';

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
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const projectRoot = process.cwd();
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.md is composed by composeCoworkerClaudeMd in
  // container-runner.ts on every wake — for both 'main' (flat body +
  // additive fragments) and typed coworkers (full spine). The host never
  // hand-writes the file here. The pre-lego '.claude-global.md' symlink
  // and '@./.claude-global.md' @-import are retired; if any install still
  // has them, scripts/migrate-global-to-shared.ts cleans them up.

  // groups/<folder>/.instructions.md — user-owned instructions.
  // CLAUDE.md is system-composed from templates + .instructions.md on every wake.
  const instructionsFile = path.join(groupDir, '.instructions.md');
  if (!fs.existsSync(instructionsFile) && opts?.instructions) {
    fs.writeFileSync(instructionsFile, opts.instructions + '\n');
    initialized.push('.instructions.md');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  }

  // mtime-based mirror: re-copy any skill whose source tree is newer than
  // the destination. This fixes silent skill-mirror staleness — prior
  // copy-once-at-init left existing groups stuck on old skill versions
  // indefinitely after upstream changes.
  const skillsDst = path.join(claudeDir, 'skills');
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const skill of fs.readdirSync(skillsSrc)) {
      const src = path.join(skillsSrc, skill);
      const dst = path.join(skillsDst, skill);
      const existed = fs.existsSync(dst);
      if (refreshMirror(src, dst)) {
        initialized.push(existed ? `skills/${skill} (refreshed)` : `skills/${skill}`);
      }
    }
  }

  // 2b. data/v2-sessions/<id>/.claude-shared/agents/ — subagent definitions.
  // A sibling `agent.md` inside any skill or overlay dir is copied as a
  // subagent definition. Overlays like `codex-critique` ship both an
  // OVERLAY.md (compose-time body) and an agent.md (runtime subagent).
  // mtime-refreshed on each wake for the same reason as skills/.
  const agentsDst = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDst, { recursive: true });
  for (const subdir of ['skills', 'overlays']) {
    const srcRoot = path.join(projectRoot, 'container', subdir);
    if (!fs.existsSync(srcRoot)) continue;
    for (const entry of fs.readdirSync(srcRoot)) {
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

  // 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', group.id, 'agent-runner-src');
  if (!fs.existsSync(groupRunnerDir)) {
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
      initialized.push('agent-runner-src/');
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
