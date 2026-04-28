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

import { composeCoworkerSpine, readCoworkerTypes } from './claude-composer.js';

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

  // v2 bodies intentionally diverged from upstream — skip parity checks.
  // Re-enable after upstream adopts the v2 lego bodies.
  const runUpstream = it.skip;

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

describe('spine-base context fragment coverage', () => {
  // The operational content from global-body.md is extracted into spine-base
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

  it.skip('capabilities.md + operations.md cover all non-identity content from global-body.md — skipped: v2 flat body diverged from typed spine fragments intentionally', () => {
    const globalBody = readFile('container/skills/nanoclaw-base/prompts/global-body.md');
    const capabilities = readFile('container/skills/spine-base/context/capabilities.md');
    const operations = readFile('container/skills/spine-base/context/operations.md');

    // Skip identity preamble (lines before "## What You Can Do")
    const afterIdentity = globalBody.replace(/^.*?(?=## What You Can Do)/s, '');
    const expected = contentLines(afterIdentity);
    const actual = contentLines(capabilities + '\n' + operations);

    const missing = expected.filter((line) => !actual.includes(line));
    expect(missing, `Content from global-body.md missing in spine-base fragments:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('groups/*/CLAUDE.md drift detection', () => {
  // groups/main/CLAUDE.md and groups/global/CLAUDE.md must match what the
  // lego composer produces for the current set of installed skills. On
  // lego-main alone they equal the neutral body; after merging a skill branch
  // (e.g. dashboard-base) they include the addon fragments. rebuild:claude
  // regenerates them — so the test composes dynamically and compares.
  it('groups/main/CLAUDE.md matches the composed output for the current skill set', () => {
    const tracked = readFile('groups/main/CLAUDE.md');
    const composed = composeCoworkerSpine({ coworkerType: 'main', projectRoot: REPO_ROOT });
    expect(tracked).toBe(composed);
  });

  it('groups/global/CLAUDE.md matches the composed output for the current skill set', () => {
    const tracked = readFile('groups/global/CLAUDE.md');
    const composed = composeCoworkerSpine({ coworkerType: 'global', projectRoot: REPO_ROOT });
    expect(tracked).toBe(composed);
  });
});
