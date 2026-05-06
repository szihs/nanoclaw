/**
 * Test coverage for the post-global-demotion architecture:
 *
 *   - Exactly 2 views: orchestrator (main, flat) + coworker (typed or
 *     untyped via 'default', both spine-composed).
 *   - `global` is retired as a flat coworker type; its memory-bucket role
 *     moves to data/shared/.
 *   - Per-project Main fragments are auto-discovered from spine metadata
 *     (`project:` field), not hardcoded anywhere.
 *   - Migration is idempotent and safe on empty installs.
 *
 * These tests use tempdir fixtures (not the real repo) so they validate
 * composer behavior in isolation across a range of configurations —
 * including ones the real repo doesn't exercise today (e.g. a future
 * `nv-graphics` project).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import { composeCoworkerSpine, readCoworkerTypes } from './claude-composer.js';
import { runGlobalToSharedMigration } from './migrations/global-to-shared.js';

/** Build a minimal valid lego layout under `root` — base spine + nanoclaw-base skill. */
function scaffoldBase(root: string): void {
  fs.mkdirSync(path.join(root, 'container/spines/base/context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'container/spines/base/invariants'), { recursive: true });
  fs.mkdirSync(path.join(root, 'container/skills/nanoclaw-base/prompts'), { recursive: true });

  // Base spine registry — base-common abstract type (no identity, no workflows).
  fs.writeFileSync(
    path.join(root, 'container/spines/base/coworker-types.yaml'),
    yaml.dump({
      'base-common': {
        description: 'Abstract base for all typed coworkers.',
        invariants: ['container/spines/base/invariants/safety.md'],
        context: ['container/spines/base/context/workspace.md'],
      },
    }),
  );
  fs.writeFileSync(path.join(root, 'container/spines/base/invariants/safety.md'), '### Safety\nBe careful.');
  fs.writeFileSync(path.join(root, 'container/spines/base/context/workspace.md'), '### Workspace\n/workspace/agent/.');

  // nanoclaw-base: 'main' flat + 'default' leaf.
  fs.writeFileSync(
    path.join(root, 'container/skills/nanoclaw-base/coworker-types.yaml'),
    yaml.dump({
      main: {
        flat: true,
        description: 'Orchestrator.',
        identity: 'container/skills/nanoclaw-base/prompts/main-body.md',
      },
      default: {
        description: 'Untyped coworker — base spine only.',
        extends: 'base-common',
      },
    }),
  );
  fs.writeFileSync(path.join(root, 'container/skills/nanoclaw-base/prompts/main-body.md'), '# Main\n\nYou are Main.\n');
}

/** Register a project spine with the given name and coworker types. */
function scaffoldProjectSpine(
  root: string,
  project: string,
  leaves: string[],
  opts: { identityLine?: string; workflows?: string[] } = {},
): void {
  const spineDir = path.join(root, 'container/spines', project);
  fs.mkdirSync(spineDir, { recursive: true });
  let identity: string | undefined;
  if (opts.identityLine) {
    fs.mkdirSync(path.join(spineDir, 'identity'), { recursive: true });
    identity = `container/spines/${project}/identity/role.md`;
    fs.writeFileSync(path.join(root, identity), opts.identityLine + '\n');
  }
  const entries: Record<string, unknown> = {
    [`${project}-common`]: {
      description: `${project} project spine — identity, invariants, layout.`,
      project,
      extends: 'base-common',
      ...(identity ? { identity } : {}),
    },
  };
  for (const leaf of leaves) {
    entries[leaf] = {
      project,
      extends: `${project}-common`,
      ...(opts.workflows ? { workflows: opts.workflows } : {}),
    };
  }
  fs.writeFileSync(path.join(spineDir, 'coworker-types.yaml'), yaml.dump(entries));
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-2view-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('2-view model: Main (orchestrator) and Coworker (typed+untyped)', () => {
  it('main (flat) emits the body alone when no projects or addon skills are installed', () => {
    scaffoldBase(tmpRoot);
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    expect(out).toBe('# Main\n\nYou are Main.\n');
    // No "Projects available" block until a project spine is present.
    expect(out).not.toMatch(/## Projects available/);
  });

  it('default (typed, extends base-common) renders the base spine without errors', () => {
    scaffoldBase(tmpRoot);
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'default' });
    expect(out).toMatch(/### Safety/);
    expect(out).toMatch(/### Workspace/);
  });

  it('global is not a registered coworker type — attempting to compose it throws', () => {
    scaffoldBase(tmpRoot);
    expect(() => composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'global' })).toThrow();
  });
});

describe('Auto-discovered project fragments on Main', () => {
  it('emits a ### <project> block for each spine with a project: field', () => {
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'slang', ['slang-reader', 'slang-writer']);
    scaffoldProjectSpine(tmpRoot, 'slangpy', ['slangpy-reader', 'slangpy-writer']);

    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    expect(out).toMatch(/## Projects available/);
    expect(out).toMatch(/### slang\b/);
    expect(out).toMatch(/### slangpy\b/);
    expect(out).toMatch(/`slang-reader`, `slang-writer`/);
    expect(out).toMatch(/`slangpy-reader`, `slangpy-writer`/);
  });

  it('a future project (e.g. nv-graphics) auto-appears with no code change', () => {
    // This is the critical "nothing hardcoded" test. The composer must
    // discover any new project purely from its spine's project: field.
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'graphics', ['graphics-reader', 'graphics-writer']);

    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    expect(out).toMatch(/### graphics\b/);
    expect(out).toMatch(/`graphics-reader`, `graphics-writer`/);
  });

  it('omits the Projects block entirely when no project spines are installed', () => {
    scaffoldBase(tmpRoot);
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    expect(out).not.toMatch(/## Projects available/);
  });

  it('does NOT emit fragments for flat types (like main itself) or base-common', () => {
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'slang', ['slang-reader']);
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    // Main itself shouldn't be listed as a coworker type under a project.
    expect(out).not.toMatch(/`main`/);
    // The *-common entry is the description source, not a leaf — it
    // shouldn't appear in the Coworker types line.
    expect(out).not.toMatch(/`slang-common`/);
  });

  it("uses the spine's identity file first paragraph when present (richer than description)", () => {
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'slang', ['slang-writer'], {
      identityLine:
        'You are a Slang compiler engineer working on a shader compiler for GPU programming with C++ and a custom IR.',
    });
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    // The block should show the identity lead-in, not the fallback description.
    expect(out).toMatch(/You are a Slang compiler engineer/);
    expect(out).not.toMatch(/slang project spine — identity/);
  });

  it('falls back to description when the spine has no identity file', () => {
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'acme', ['acme-writer']);
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    // description is in yaml; no identity file — the fallback is used.
    expect(out).toMatch(/acme project spine — identity, invariants, layout\./);
  });

  it('emits the union of workflow names across leaf types for each project', () => {
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'slang', ['slang-reader', 'slang-writer'], {
      workflows: ['slang-investigate', 'slang-implement'],
    });
    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    expect(out).toMatch(/Workflows: `slang-implement`, `slang-investigate`/);
  });

  it('sorts projects alphabetically for deterministic output', () => {
    scaffoldBase(tmpRoot);
    scaffoldProjectSpine(tmpRoot, 'zeta', ['zeta-worker']);
    scaffoldProjectSpine(tmpRoot, 'alpha', ['alpha-worker']);
    scaffoldProjectSpine(tmpRoot, 'middle', ['middle-worker']);

    const out = composeCoworkerSpine({ projectRoot: tmpRoot, coworkerType: 'main' });
    const alphaIdx = out.indexOf('### alpha');
    const middleIdx = out.indexOf('### middle');
    const zetaIdx = out.indexOf('### zeta');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zetaIdx);
  });
});

describe('Shared dir mount permissions (is_admin drives read-write)', () => {
  // Unit test the mount logic directly — we can't easily run the full
  // buildMounts() path without a full agent group fixture, so we test
  // the exact boolean the branch at container-runner.ts ~L641 computes.
  interface AgentGroupLike {
    is_admin: number;
    coworker_type: string | null;
  }
  function isAdminForMount(ag: AgentGroupLike): boolean {
    return ag.is_admin === 1 || ag.coworker_type === 'main';
  }

  it('admin rows (is_admin=1) with coworker_type=main get read-write', () => {
    expect(isAdminForMount({ is_admin: 1, coworker_type: 'main' })).toBe(true);
  });

  it('legacy admin rows with is_admin=1 but coworker_type=null still get read-write', () => {
    expect(isAdminForMount({ is_admin: 1, coworker_type: null })).toBe(true);
  });

  it('non-admin typed coworkers get read-only', () => {
    expect(isAdminForMount({ is_admin: 0, coworker_type: 'slang-writer' })).toBe(false);
    expect(isAdminForMount({ is_admin: 0, coworker_type: 'default' })).toBe(false);
  });

  it('non-admin untyped rows with coworker_type=null get read-only', () => {
    expect(isAdminForMount({ is_admin: 0, coworker_type: null })).toBe(false);
  });
});

describe('Tool-instructions files are loaded into composed bodies', () => {
  // These tests use the REAL repo layout so they trip whenever the five
  // tool-instructions files or their yaml wiring drift out of sync.
  const REPO_ROOT = process.cwd();

  it('Main composes with all 5 tool-instructions sections inlined', () => {
    const out = composeCoworkerSpine({ coworkerType: 'main', projectRoot: REPO_ROOT });
    // Headings unique to each instructions file.
    expect(out).toMatch(/## Companion and collaborator agents/); // agents.md
    expect(out).toMatch(/## Interactive prompts/); // interactive.md
    expect(out).toMatch(/## Installing packages/); // self-mod.md
    expect(out).toMatch(/## Sending messages/); // core.md
    expect(out).toMatch(/## Task scheduling/); // scheduling.md
  });

  it("default (typed, base-common only) doesn't carry core/scheduling bodies or admin guidance — those live in /base-nanoclaw skill (loaded on demand)", () => {
    const out = composeCoworkerSpine({ coworkerType: 'default', projectRoot: REPO_ROOT });
    // core.md + scheduling.md are retired from base-common; their nuance
    // lives in the base-nanoclaw skill body, loaded on-demand via
    // /base-nanoclaw. The always-loaded body stays slim.
    expect(out).not.toMatch(/## Sending messages/); // core — no longer always-loaded
    expect(out).not.toMatch(/## Task scheduling/); // scheduling — no longer always-loaded
    // /base-nanoclaw is declared in base-common skills but not trait-bound,
    // so the composer filters it out of Skills Available. Claude Code's
    // progressive skill discovery surfaces it on-demand.
    // Admin-only guidance must NOT leak into typed coworkers.
    expect(out).not.toMatch(/## Companion and collaborator agents/);
    expect(out).not.toMatch(/## Installing packages/);
  });
});

describe("'default' coworker type (untyped fallback)", () => {
  it('is registered under nanoclaw-base', () => {
    scaffoldBase(tmpRoot);
    const types = readCoworkerTypes(tmpRoot);
    expect(types.default).toBeDefined();
    expect(types.default?.extends).toBe('base-common');
    // Not flat — untyped groups go through the typed spine path.
    expect(types.default?.flat).not.toBe(true);
  });
});

describe('Migration: groups/global → data/shared', () => {
  it('is a no-op when nothing to migrate (clean install)', () => {
    scaffoldBase(tmpRoot);
    const ran = runGlobalToSharedMigration(tmpRoot);
    expect(ran).toBe(true);
    // Marker is written even on no-op so subsequent runs skip.
    expect(fs.existsSync(path.join(tmpRoot, 'data/.migrations/global-to-shared.done'))).toBe(true);
  });

  it('is idempotent — second run skips', () => {
    scaffoldBase(tmpRoot);
    expect(runGlobalToSharedMigration(tmpRoot)).toBe(true);
    expect(runGlobalToSharedMigration(tmpRoot)).toBe(false);
  });

  it('moves groups/global/learnings/ → data/shared/learnings/ and preserves content', () => {
    scaffoldBase(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'groups/global/learnings'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'groups/global/learnings/lesson-1.md'), '# Lesson 1\nContent.');
    fs.writeFileSync(path.join(tmpRoot, 'groups/global/learnings/INDEX.md'), '# Index\n- lesson-1.md');

    runGlobalToSharedMigration(tmpRoot);

    expect(fs.existsSync(path.join(tmpRoot, 'data/shared/learnings/lesson-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'data/shared/learnings/INDEX.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpRoot, 'data/shared/learnings/lesson-1.md'), 'utf-8')).toContain('Content.');
    // Source should be gone.
    expect(fs.existsSync(path.join(tmpRoot, 'groups/global/learnings'))).toBe(false);
  });

  it('preserves groups/global/CLAUDE.md at data/shared/_legacy/v1-global.md before deleting it', () => {
    scaffoldBase(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'groups/global'), { recursive: true });
    const original = '# Global\n\nOld body.';
    fs.writeFileSync(path.join(tmpRoot, 'groups/global/CLAUDE.md'), original);

    runGlobalToSharedMigration(tmpRoot);

    expect(fs.existsSync(path.join(tmpRoot, 'groups/global/CLAUDE.md'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpRoot, 'data/shared/_legacy/v1-global.md'), 'utf-8')).toBe(original);
  });

  it('unlinks .claude-global.md symlinks in any group folder', () => {
    scaffoldBase(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'groups/orchestrator'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'groups/main'), { recursive: true });
    fs.symlinkSync('/workspace/global/CLAUDE.md', path.join(tmpRoot, 'groups/orchestrator/.claude-global.md'));
    fs.symlinkSync('/workspace/global/CLAUDE.md', path.join(tmpRoot, 'groups/main/.claude-global.md'));

    runGlobalToSharedMigration(tmpRoot);

    expect(fs.existsSync(path.join(tmpRoot, 'groups/orchestrator/.claude-global.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'groups/main/.claude-global.md'))).toBe(false);
    // Group directories themselves remain.
    expect(fs.existsSync(path.join(tmpRoot, 'groups/orchestrator'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'groups/main'))).toBe(true);
  });

  it('updates agent_groups DB rows: coworker_type=global → default, deletes folder=global', async () => {
    scaffoldBase(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(tmpRoot, 'data/v2.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, coworker_type TEXT, is_admin INTEGER)');
    db.prepare('INSERT INTO agent_groups VALUES (?,?,?,?)').run('ag-1', 'slang', 'global', 0);
    db.prepare('INSERT INTO agent_groups VALUES (?,?,?,?)').run('ag-2', 'global', 'global', 0);
    db.prepare('INSERT INTO agent_groups VALUES (?,?,?,?)').run('ag-3', 'main', 'main', 1);
    db.close();

    runGlobalToSharedMigration(tmpRoot);

    const db2 = new Database(dbPath);
    const rows = db2.prepare('SELECT id, folder, coworker_type FROM agent_groups ORDER BY id').all();
    db2.close();
    expect(rows).toEqual([
      { id: 'ag-1', folder: 'slang', coworker_type: 'default' }, // relabeled
      // ag-2 (folder=global) deleted
      { id: 'ag-3', folder: 'main', coworker_type: 'main' }, // untouched
    ]);
  });

  it('preserves existing data/shared/learnings/ entries when merging from groups/global/learnings/', () => {
    scaffoldBase(tmpRoot);
    // destination has an existing entry — must NOT be overwritten
    fs.mkdirSync(path.join(tmpRoot, 'data/shared/learnings'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'data/shared/learnings/existing.md'), 'EXISTING\n');
    // source has a different entry — should be moved over
    fs.mkdirSync(path.join(tmpRoot, 'groups/global/learnings'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'groups/global/learnings/new.md'), 'NEW\n');

    runGlobalToSharedMigration(tmpRoot);

    expect(fs.readFileSync(path.join(tmpRoot, 'data/shared/learnings/existing.md'), 'utf-8')).toBe('EXISTING\n');
    expect(fs.readFileSync(path.join(tmpRoot, 'data/shared/learnings/new.md'), 'utf-8')).toBe('NEW\n');
  });

  it('leaves groups/global/ in place when other unmigrated content remains (non-destructive)', () => {
    scaffoldBase(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'groups/global'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'groups/global/SOMETHING_ELSE.md'), 'user file we should not delete');

    runGlobalToSharedMigration(tmpRoot);

    // We don't know what SOMETHING_ELSE.md is — keep the dir so the user
    // can investigate. Only CLAUDE.md, learnings/, and symlinks are touched.
    expect(fs.existsSync(path.join(tmpRoot, 'groups/global/SOMETHING_ELSE.md'))).toBe(true);
  });
});
