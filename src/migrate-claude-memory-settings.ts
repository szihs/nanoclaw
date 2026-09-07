import { randomUUID } from 'crypto';
import fs from 'fs';

import { log } from './log.js';
import type { ProviderFileDiagnostic, ProviderFileTransformer } from './provider-contracts/registry.js';

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
const LEGACY_MEMORY_SESSION_START_COMMAND = 'bun /app/src/memory-hook.ts';

// Effectively "never" — Claude Code's own cleanupPeriodDays setting prunes
// ~/.claude/projects/*.jsonl at CLI startup (default 30 when unset). Every
// active group was silently losing its own transcript history to this on a
// rolling 30-day window — the file NanoClaw's own cost accounting (dashboard
// + fleet ccusage reporting) reads as its source of truth. Proven on prod:
// oldest-surviving-transcript date tracked (today - 30d) exactly, across
// every busy group; idle groups (whose `claude` never restarts to run the
// sweep) kept full history back to April. See issue #1327.
export const CLEANUP_PERIOD_DAYS_NEVER = 3650;

export const CLAUDE_DEFAULT_SETTINGS =
  JSON.stringify(
    {
      cleanupPeriodDays: CLEANUP_PERIOD_DAYS_NEVER,
      sandbox: {
        enabled: false,
      },
      preferences: {
        reasoningEffort: 'max',
      },
      // Strip Claude Code's native Workflow tool — the single largest tool
      // schema on every turn (~26KB) — because NanoClaw orchestrates its own
      // sessions (a2a messaging + host-side orchestration), so it is dead
      // weight. Matches merged upstream #3031 ("lean harness defaults").
      // NEW groups only; existing groups keep their settings.json (never
      // regenerated) — re-enable per group by editing that group's
      // .claude-shared/settings.json and restarting.
      disableWorkflows: true,
      autoMemoryEnabled: false,
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: PRE_COMPACT_COMMAND,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/** Reconcile existing Claude settings with NanoClaw's shared memory system. */
export function migrateClaudeMemorySettings(settingsFile: string): boolean {
  try {
    const result = claudeSettingsTransformer.transform(fs.readFileSync(settingsFile, 'utf-8'), settingsFile);
    emitDiagnostics(result.diagnostics);
    if (result.kind === 'unchanged') return false;
    writeAtomic(settingsFile, result.content);
    return true;
  } catch (err) {
    emitDiagnostic(claudeSettingsTransformer.mapIoFailure(err, settingsFile));
    return false;
  }
}

export const claudeSettingsTransformer: ProviderFileTransformer = {
  transform(current, settingsFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch (err) {
      return {
        kind: 'unchanged',
        diagnostics: [failedDiagnostic(err, settingsFile)],
      };
    }
    if (!isRecord(parsed)) {
      return {
        kind: 'unchanged',
        diagnostics: [
          {
            level: 'warn',
            message: 'Claude settings root is not an object; leaving it unchanged',
            fields: { settingsFile },
          },
        ],
      };
    }

    let changed = false;
    if (parsed.autoMemoryEnabled !== false) {
      parsed.autoMemoryEnabled = false;
      changed = true;
    }

    const env = isRecord(parsed.env) ? parsed.env : {};
    if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') {
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      changed = true;
    }
    if (parsed.env !== env) {
      parsed.env = env;
      changed = true;
    }

    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
    const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const nextSessionStart = existingSessionStart
      .map(removeLegacyNanoClawMemoryHook)
      .filter((entry) => entry !== undefined);
    if (JSON.stringify(nextSessionStart) !== JSON.stringify(existingSessionStart)) {
      if (nextSessionStart.length > 0) hooks.SessionStart = nextSessionStart;
      else delete hooks.SessionStart;
      changed = true;
    }

    const preCompact = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
    if (!JSON.stringify(preCompact).includes(PRE_COMPACT_COMMAND)) {
      preCompact.push({ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] });
      hooks.PreCompact = preCompact;
      changed = true;
    }
    if (parsed.hooks !== hooks) {
      parsed.hooks = hooks;
      changed = true;
    }

    return changed ? { kind: 'replace', content: JSON.stringify(parsed, null, 2) + '\n' } : { kind: 'unchanged' };
  },
  mapIoFailure: failedDiagnostic,
};

function failedDiagnostic(err: unknown, settingsFile: string): ProviderFileDiagnostic {
  return {
    level: 'warn',
    message: 'Failed to reconcile Claude settings; leaving them unchanged',
    fields: {
      settingsFile,
      error: err instanceof Error ? err.message : String(err),
    },
  };
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
}

function removeLegacyNanoClawMemoryHook(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const remaining = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return hook.command !== LEGACY_MEMORY_SESSION_START_COMMAND;
  });
  return remaining.length > 0 ? { ...value, hooks: remaining } : undefined;
}

/**
 * Same shape as `writeComposedDocument` in group-persona.ts, and for the same
 * reason: `.claude-shared/` is mounted writable into the container, so a
 * reconstructible temp path (`pid` + `Date.now()`) can be pre-created as a
 * symlink pointing at anything the host can write. `randomUUID()` makes the name
 * unguessable and `wx` fails closed rather than following a planted link.
 *
 * Exported because the provider-contract realizer rewrites reconciled provider
 * settings files through it; upstream's export carries the weaker
 * `pid`+`Date.now()` name, so the hardened body is the one that must win.
 */
export function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  let created = false;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    created = true;
    fs.renameSync(tmp, filePath);
  } finally {
    // Only clean up an entry this call created: on a `wx` failure the path was
    // someone else's file, and unlinking it would turn a refusal to overwrite
    // into a deletion.
    if (created) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Expected: the rename consumed it.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
