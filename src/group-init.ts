import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Container path where groups/global is mounted. The symlink we drop
// into each group's dir resolves to this target inside the container.
// It's a dangling symlink on the host — that's fine, host tools don't
// follow it and the container mount makes it valid at read time.
const GLOBAL_MEMORY_CONTAINER_PATH = '/workspace/global/CLAUDE.md';

const FLAT_COWORKER_TYPES = new Set(['main', 'global']);

// Symlink name inside the group's dir. Claude Code's @-import only
// follows paths inside cwd, so we can't reference /workspace/global
// directly — we symlink into the group dir and import the symlink.
export const GLOBAL_MEMORY_LINK_NAME = '.claude-global.md';
export const GLOBAL_CLAUDE_IMPORT = `@./${GLOBAL_MEMORY_LINK_NAME}`;

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

  // groups/<folder>/.claude-global.md — symlink so Claude Code's @-import
  // can follow it. Only flat types (main/global) use the @import line in
  // their CLAUDE.md. Typed coworkers get operational content through
  // base-common context fragments instead, so skip the symlink for them.
  const needsFlatSetup = !group.coworker_type || FLAT_COWORKER_TYPES.has(group.coworker_type);
  if (needsFlatSetup) {
    const globalLinkPath = path.join(groupDir, GLOBAL_MEMORY_LINK_NAME);
    let linkExists = false;
    try {
      fs.lstatSync(globalLinkPath);
      linkExists = true;
    } catch {
      /* missing — recreate */
    }
    if (!linkExists) {
      fs.symlinkSync(GLOBAL_MEMORY_CONTAINER_PATH, globalLinkPath);
      initialized.push('.claude-global.md');
    }
  }

  // groups/<folder>/CLAUDE.md — for flat (untyped) groups, write the @import
  // directive that pulls in the global body. Typed coworkers get their CLAUDE.md
  // composed by composeCoworkerClaudeMd in container-runner.ts on every wake.
  if (needsFlatSetup) {
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, '@./.claude-global.md\n');
      initialized.push('CLAUDE.md');
    }
  }

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

  // 2b. data/v2-sessions/<id>/.claude-shared/agents/ — subagent definitions
  const agentsDst = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    for (const skill of fs.readdirSync(skillsSrc)) {
      const agentFile = path.join(skillsSrc, skill, 'agent.md');
      if (fs.existsSync(agentFile)) {
        const dst = path.join(agentsDst, `${skill}.md`);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(agentFile, dst);
          initialized.push(`agents/${skill}.md`);
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
