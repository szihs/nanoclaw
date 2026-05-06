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
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime: at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path. After init, the
 * host never overwrites any of these paths automatically — agents own them.
 * To pull in upstream changes, use the host-mediated reset/refresh tools.
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

  const skillsDst = path.join(claudeDir, 'skills');
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const skill of fs.readdirSync(skillsSrc)) {
      const dst = path.join(skillsDst, skill);
      if (!fs.existsSync(dst)) {
        fs.cpSync(path.join(skillsSrc, skill), dst, { recursive: true });
        initialized.push(`skills/${skill}`);
      }
    }
  }

  // 2b. data/v2-sessions/<id>/.claude-shared/agents/ — subagent definitions.
  // A sibling `agent.md` inside any skill or overlay dir is copied as a
  // subagent definition. Overlays like `codex-critique` ship both an
  // OVERLAY.md (compose-time body) and an agent.md (runtime subagent).
  const agentsDst = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDst, { recursive: true });
  for (const subdir of ['skills', 'overlays']) {
    const srcRoot = path.join(projectRoot, 'container', subdir);
    if (!fs.existsSync(srcRoot)) continue;
    for (const entry of fs.readdirSync(srcRoot)) {
      const agentFile = path.join(srcRoot, entry, 'agent.md');
      if (fs.existsSync(agentFile)) {
        const dst = path.join(agentsDst, `${entry}.md`);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(agentFile, dst);
          initialized.push(`agents/${entry}.md`);
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
