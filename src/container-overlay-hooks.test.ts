// R20: runtime-hook counterpart to R19 (compose-time).
//
// PR #97 added the per-coworker `agent_groups.disable_overlays` flag and wired
// it through `claude-composer/spine.ts` so the composed CLAUDE.md no longer
// renders overlay gates when the flag is set. But container-runner's runtime
// hook injection (plan-gate.sh, critique-tracker.sh, intent-router.sh,
// edit-counter.sh, workflow-state-reset.sh) was still keyed purely off
// `overlayNames.includes('critique-overlay')` — so coworkers with the flag
// set got a clean spine but still had writes blocked by the plan/critique
// gate at runtime.
//
// `resolveOverlayHookFlags()` is the single choke-point both the settings.json
// hook injection (container-runner.ts ~L695) and the `OVERLAY_WORKFLOWS` env
// var injection (container-runner.ts ~L850) now go through, so these tests
// guard the full surface.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetCoworkerTypesCacheForTests, resolveOverlayHookFlags } from './container-runner.js';
import type { AgentGroup } from './types.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  resetCoworkerTypesCacheForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeAgentGroup(overrides: Partial<AgentGroup> = {}): AgentGroup {
  return {
    id: 'ag-test',
    name: 'Test',
    folder: 'test',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    routing: 'direct',
    disable_overlays: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/**
 * Minimal lego fixture with a coworker type that binds `critique-overlay` and
 * an `implement` workflow — enough for resolveCoworkerManifest to emit the
 * overlay in the customizations list. We don't care about the rendered body,
 * only that `overlayNames` and workflow names flow through correctly.
 */
function makeFixtureWithCritiqueOverlay(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-r20-'));
  tempDirs.push(root);

  write(path.join(root, 'container', 'spines', 'base', 'invariants', 'safety.md'), '- Be safe.');
  write(
    path.join(root, 'container', 'spines', 'base', 'coworker-types.yaml'),
    ['base-common:', '  description: "Base."', '  invariants: []', ''].join('\n'),
  );

  // Implement workflow — the plan gate only engages when an implement-family
  // workflow is bound (see resolveOverlayHookFlags doc).
  write(
    path.join(root, 'container', 'workflows', 'implement', 'WORKFLOW.md'),
    [
      '---',
      'name: implement',
      'type: workflow',
      'description: "Implement a change."',
      'requires: []',
      'uses:',
      '  skills: []',
      '  workflows: []',
      '---',
      '',
      '# Implement',
      '',
      '## Steps',
      '',
      '1. **Patch** {#patch} — apply the change.',
      '',
    ].join('\n'),
  );

  // Overlay named critique-overlay, bound to the implement workflow at the
  // `patch` anchor — matches the real prod contract.
  write(
    path.join(root, 'container', 'overlays', 'critique-overlay', 'OVERLAY.md'),
    [
      '---',
      'name: critique-overlay',
      'type: overlay',
      'description: "Critique gate for implement."',
      'applies-to:',
      '  workflows: [implement]',
      '  traits: []',
      'insert-after: []',
      'insert-before: [patch]',
      'uses:',
      '  skills: []',
      '---',
      '',
      'Critique gate body.',
    ].join('\n'),
  );

  write(
    path.join(root, 'container', 'spines', 'project', 'coworker-types.yaml'),
    [
      'test-writer:',
      '  extends: base-common',
      '  description: "Writer."',
      '  workflows: [implement]',
      '  overlays: [critique-overlay]',
      '',
      'test-reader:',
      '  extends: base-common',
      '  description: "Reader (no overlays)."',
      '  workflows: [implement]',
      '',
    ].join('\n'),
  );

  return root;
}

describe('R20: resolveOverlayHookFlags honors disable_overlays at runtime', () => {
  it('disable_overlays=1 short-circuits to {false, false} regardless of coworker_type', () => {
    // Doesn't even touch the registry — the flag is a hard short-circuit.
    const ag = makeAgentGroup({ coworker_type: 'test-writer', disable_overlays: 1 });
    expect(resolveOverlayHookFlags(ag)).toEqual({ hasPlan: false, hasCritique: false });
  });

  it('untyped coworker (coworker_type=null) yields {false, false}', () => {
    expect(resolveOverlayHookFlags(makeAgentGroup({ coworker_type: null }))).toEqual({
      hasPlan: false,
      hasCritique: false,
    });
  });

  it('typed coworker with critique-overlay + implement workflow, flag OFF → hooks engage', () => {
    const root = makeFixtureWithCritiqueOverlay();
    process.chdir(root);
    resetCoworkerTypesCacheForTests();

    const ag = makeAgentGroup({ coworker_type: 'test-writer', disable_overlays: 0 });
    expect(resolveOverlayHookFlags(ag)).toEqual({ hasPlan: true, hasCritique: true });
  });

  it('same typed coworker with flag ON → hooks suppressed (R19 parity at runtime)', () => {
    const root = makeFixtureWithCritiqueOverlay();
    process.chdir(root);
    resetCoworkerTypesCacheForTests();

    const ag = makeAgentGroup({ coworker_type: 'test-writer', disable_overlays: 1 });
    expect(resolveOverlayHookFlags(ag)).toEqual({ hasPlan: false, hasCritique: false });
  });

  it('typed coworker with no overlay binding → neither flag fires even when enabled', () => {
    const root = makeFixtureWithCritiqueOverlay();
    process.chdir(root);
    resetCoworkerTypesCacheForTests();

    const ag = makeAgentGroup({ coworker_type: 'test-reader', disable_overlays: 0 });
    expect(resolveOverlayHookFlags(ag)).toEqual({ hasPlan: false, hasCritique: false });
  });
});
