/**
 * Scenario coverage for the lego composer at the infrastructure layer:
 * a plain install (only `nanoclaw-base` present) plus upstream-drift
 * guardrails that keep the shipped main/global bodies in sync with
 * `upstream/v2`. Project-specific scenarios (typed coworker types,
 * addon skills that contribute `context:` to `main`/`global`) are
 * exercised in project-owned tests that ship alongside those skills.
 *
 * These are build-time guardrails for the lego model; they read the real
 * repo layout (container/skills/*) rather than synthesizing tempdirs so a
 * careless edit to any of the real skill files trips the right assertion.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { readCoworkerTypes } from './claude-composer.js';

const REPO_ROOT = process.cwd();

function readFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('Scenario 1: plain install (nanoclaw-base only)', () => {
  it('main = upstream/v2 main body, verbatim', () => {
    const mainBody = readFile('container/skills/nanoclaw-base/prompts/main-body.md');
    const fixture = readFile('test-fixtures/upstream-v2/main.md');
    expect(mainBody).toBe(fixture);
  });

  it('global = upstream/v2 global body, verbatim', () => {
    const globalBody = readFile('container/skills/nanoclaw-base/prompts/global-body.md');
    const fixture = readFile('test-fixtures/upstream-v2/global.md');
    expect(globalBody).toBe(fixture);
  });

  it('main/global types are declared flat in the nanoclaw-base registry', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types.main?.flat).toBe(true);
    expect(types.global?.flat).toBe(true);
    expect(types.main?.identity).toBe('container/skills/nanoclaw-base/prompts/main-body.md');
    expect(types.global?.identity).toBe('container/skills/nanoclaw-base/prompts/global-body.md');
  });
});

describe('Upstream drift detection', () => {
  it('shipped main body matches the upstream/v2 fixture byte-for-byte', () => {
    // The fixture captures upstream/v2:groups/main/CLAUDE.md at the point
    // we last synced. If this assertion fails, either (a) a developer
    // edited the body without updating the fixture (or vice versa) — fix
    // the local edit, or (b) we intentionally absorbed upstream changes
    // — re-run scripts/rebuild-claude-md or recapture both files.
    const fixture = readFile('test-fixtures/upstream-v2/main.md');
    const body = readFile('container/skills/nanoclaw-base/prompts/main-body.md');
    expect(body).toBe(fixture);
  });

  it('shipped global body matches the upstream/v2 fixture byte-for-byte', () => {
    const fixture = readFile('test-fixtures/upstream-v2/global.md');
    const body = readFile('container/skills/nanoclaw-base/prompts/global-body.md');
    expect(body).toBe(fixture);
  });

  // The following two checks only run when the upstream remote is present
  // in the local clone (developer machines typically; CI may not configure
  // the remote). They compare our captured fixtures to the current content
  // on `upstream/v2:groups/main/CLAUDE.md` and flag drift so we know to
  // resync before the eventual v2 → upstream/main merge.
  const hasUpstreamRef = (() => {
    try {
      execFileSync('git', ['rev-parse', '--verify', 'upstream/v2'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  })();

  const runUpstream = hasUpstreamRef ? it : it.skip;

  runUpstream('fixture is in sync with upstream/v2:groups/main/CLAUDE.md', () => {
    const upstream = execFileSync('git', ['show', 'upstream/v2:groups/main/CLAUDE.md'], {
      encoding: 'utf-8',
    });
    const fixture = readFile('test-fixtures/upstream-v2/main.md');
    expect(fixture).toBe(upstream);
  });

  runUpstream('fixture is in sync with upstream/v2:groups/global/CLAUDE.md', () => {
    const upstream = execFileSync('git', ['show', 'upstream/v2:groups/global/CLAUDE.md'], {
      encoding: 'utf-8',
    });
    const fixture = readFile('test-fixtures/upstream-v2/global.md');
    expect(fixture).toBe(upstream);
  });
});

describe('base-spine context fragment coverage', () => {
  // The operational content from global-body.md is extracted into base-spine
  // context fragments (capabilities.md + operations.md) so typed coworkers
  // inherit NanoClaw operational guidance. When upstream changes global-body.md,
  // this test fails until the fragments are updated to match.
  //
  // Lines 1–3 are excluded (identity preamble: "# Main" + persona sentence).
  // The "## What You Can Do" list maps to capabilities.md.
  // Everything else maps to operations.md.

  function contentLines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.replace(/^#{1,6}\s+/, '').trim())
      .filter((l) => l.length > 0 && l !== '---');
  }

  it('capabilities.md + operations.md cover all non-identity content from global-body.md', () => {
    const globalBody = readFile('container/skills/nanoclaw-base/prompts/global-body.md');
    const capabilities = readFile('container/skills/base-spine/context/capabilities.md');
    const operations = readFile('container/skills/base-spine/context/operations.md');

    // Skip identity preamble (lines before "## What You Can Do")
    const afterIdentity = globalBody.replace(/^.*?(?=## What You Can Do)/s, '');
    const expected = contentLines(afterIdentity);
    const actual = contentLines(capabilities + '\n' + operations);

    const missing = expected.filter((line) => !actual.includes(line));
    expect(missing, `Content from global-body.md missing in base-spine fragments:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('groups/*/CLAUDE.md drift detection', () => {
  // The committed groups/main/CLAUDE.md and groups/global/CLAUDE.md are the
  // NEUTRAL snapshot — they equal the nanoclaw-base body verbatim. Project
  // skills ship their additions as separate context fragments (e.g.
  // dashboard-base/prompts/formatting.md, slang-spine/prompts/main-addon.md);
  // the composer merges at runtime. Project branches therefore commit the
  // SAME neutral snapshot — not a regenerated, addon-merged version — so
  // two project branches never produce conflicting edits to these files.
  //
  // If this assertion fails: either (a) someone hand-edited groups/*/CLAUDE.md
  // instead of going through nanoclaw-base/prompts/*-body.md + rebuild:claude,
  // or (b) a project branch regenerated groups/*/CLAUDE.md with its addons
  // merged in and committed the result — revert and keep the neutral snapshot.
  it('groups/main/CLAUDE.md equals the neutral base body byte-for-byte', () => {
    const tracked = readFile('groups/main/CLAUDE.md');
    const neutralBody = readFile('container/skills/nanoclaw-base/prompts/main-body.md');
    expect(tracked).toBe(neutralBody);
  });

  it('groups/global/CLAUDE.md equals the neutral base body byte-for-byte', () => {
    const tracked = readFile('groups/global/CLAUDE.md');
    const neutralBody = readFile('container/skills/nanoclaw-base/prompts/global-body.md');
    expect(tracked).toBe(neutralBody);
  });
});
