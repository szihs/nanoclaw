/**
 * Scenario coverage for the lego composer at the infrastructure layer.
 *
 * Post-refactor shape (no upstream/v2 drift pinning):
 *   - Main is a flat manager body + per-project fragments auto-discovered
 *     from spine metadata. The shipped body is slim and project-agnostic.
 *   - `default` is a typed leaf (extends base-common) used for untyped
 *     agent groups. Renders the bare spine.
 *   - `global` is retired as a coworker type — the data/shared/ directory
 *     replaces its memory-mount role; the flat global body is gone.
 *
 * These are build-time guardrails that read the real repo layout
 * (container/skills/*, container/spines/*) rather than synthesizing
 * tempdirs — a careless edit to any real skill trips the right assertion.
 *
 * Project-specific scenarios (typed slang/slangpy/nanoclaw worker
 * composition, overlays, workflow embedding) live in project-owned tests
 * that ship alongside those skills.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { composeCoworkerSpine, readCoworkerTypes } from './claude-composer.js';

const REPO_ROOT = process.cwd();

function readFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('Scenario: main coworker type (flat, slim manager body)', () => {
  it('main is flat with identity pointing at nanoclaw-base/prompts/main-body.md', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types.main?.flat).toBe(true);
    expect(types.main?.identity).toBe('container/spines/base/identity/main-body.md');
  });

  it('main body contains manager-role identity and admin-only tools', () => {
    const body = readFile('container/spines/base/identity/main-body.md');
    // Identity
    expect(body).toMatch(/# Main\b/);
    expect(body).toMatch(/admin orchestrator/);
    // Admin-only tools (the three truly unique ones)
    expect(body).toMatch(/mcp__nanoclaw__create_agent/);
    expect(body).toMatch(/mcp__nanoclaw__wire_agents/);
    expect(body).toMatch(/\/workspace\/shared/);
  });

  it('main body does NOT carry retired @./.claude-global.md import or /workspace/global refs', () => {
    const body = readFile('container/spines/base/identity/main-body.md');
    expect(body, 'flat-global @-import directive should be gone').not.toMatch(/^@\.\/\.claude-global\.md$/m);
    expect(body, '/workspace/global should be renamed to /workspace/shared').not.toMatch(/\/workspace\/global/);
  });

  it('main composition emits project fragments automatically from spine metadata', () => {
    const composed = composeCoworkerSpine({ coworkerType: 'main', projectRoot: REPO_ROOT });
    // This install ships slang + slangpy + nanoclaw spines with project: metadata.
    // Their fragments auto-appear via emitDiscoveredProjectFragments() — not
    // from any hand-written *-project-base skill.
    expect(composed).toMatch(/## Projects available/);
    // Each discovered project produces a ### <project> section. Don't assert
    // exact project names here — if someone removes slangpy this test should
    // still pass. Just assert the scaffolding.
    expect(composed.split('### ').length, 'at least one ### <project> block').toBeGreaterThan(1);
  });
});

describe('Scenario: default coworker type (untyped fallback, base spine only)', () => {
  it('default type is registered and extends base-common', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types.default).toBeDefined();
    expect(types.default?.extends).toBe('base-common');
    expect(types.default?.flat, 'default is typed, not flat').not.toBe(true);
  });

  it('default composes from the base-common spine without errors', () => {
    const composed = composeCoworkerSpine({ coworkerType: 'default', projectRoot: REPO_ROOT });
    expect(composed.length).toBeGreaterThan(0);
    // Base spine's combined invariants file ships safety/truthfulness/scope.
    // Output-wrapping rule is carried by the runtime system prompt, not by
    // the spine.
    expect(composed).toMatch(/### Safety/);
    expect(composed).toMatch(/### Truthfulness/);
    expect(composed).toMatch(/### Scope/);
  });

  it("default's heading uses the custom title 'Coworker', not 'Default'", () => {
    const composed = composeCoworkerSpine({ coworkerType: 'default', projectRoot: REPO_ROOT });
    expect(composed).toMatch(/^# Coworker$/m);
    expect(composed).not.toMatch(/^# Default$/m);
  });
});

describe('Scenario: retired global coworker type', () => {
  it('global is no longer a registered coworker type', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types.global, "'global' coworker type should be retired").toBeUndefined();
  });

  it('global-body.md file no longer exists', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'container/spines/base/identity/global-body.md'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'container/skills/nanoclaw-base/prompts/global-body.md'))).toBe(false);
  });

  it('groups/global/ directory is no longer tracked', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'groups/global'))).toBe(false);
  });
});

describe('Scenario: main composes without error for the current skill set', () => {
  // No pinning — just assert the composer runs and produces sane output.
  // groups/main/CLAUDE.md is regenerated by `pnpm run rebuild:claude`;
  // we don't lock composer output to it, because that causes spurious
  // failures every time a skill is added or a fragment is edited.
  it('composeCoworkerSpine({ coworkerType: main }) produces non-empty output', () => {
    const composed = composeCoworkerSpine({ coworkerType: 'main', projectRoot: REPO_ROOT });
    expect(composed.length).toBeGreaterThan(100);
    expect(composed).toMatch(/# Main/);
  });
});
