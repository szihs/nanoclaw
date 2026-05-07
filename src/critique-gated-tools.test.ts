// PR-1 (critique-gate-external-posts): resolveCritiqueGatedTools picks the
// subset of a coworker's allowed MCP tools that have openWorldHint=true, so
// plan-gate.sh can block external-posting tools under the same plan/critique
// conditions as Edit/Write. Ships as no-op until PR-2 lands annotations on
// slang-mcp tools — the "no tools annotated" case is the prod state.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the annotations source so we can drive the test inputs without
// running a real MCP server. The other exports from mcp-auth-proxy are left
// untouched — container-runner only needs getDiscoveredToolAnnotations here.
vi.mock('./mcp-auth-proxy.js', async () => {
  const actual = await vi.importActual<typeof import('./mcp-auth-proxy.js')>('./mcp-auth-proxy.js');
  return {
    ...actual,
    getDiscoveredToolAnnotations: vi.fn(() => ({})),
  };
});

import { getDiscoveredToolAnnotations } from './mcp-auth-proxy.js';
import { resetCoworkerTypesCacheForTests, resolveCritiqueGatedTools } from './container-runner.js';
import type { AgentGroup } from './types.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

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
 * Reuse the same fixture shape as container-overlay-hooks.test.ts (R20).
 * The coworker-types.yaml defines two types:
 *   - `gated-writer` — has critique-overlay + implement workflow (gates ON)
 *   - `gated-reader` — has implement workflow but no overlay (gates OFF)
 */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-critique-gated-'));
  tempDirs.push(root);

  write(path.join(root, 'container', 'spines', 'base', 'invariants', 'safety.md'), '- Be safe.');
  write(
    path.join(root, 'container', 'spines', 'base', 'coworker-types.yaml'),
    ['base-common:', '  description: "Base."', '  invariants: []', ''].join('\n'),
  );

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
      '1. **Patch** {#patch} — apply.',
      '',
    ].join('\n'),
  );

  write(
    path.join(root, 'container', 'overlays', 'critique-overlay', 'OVERLAY.md'),
    [
      '---',
      'name: critique-overlay',
      'type: overlay',
      'description: "Critique gate."',
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
      'gated-writer:',
      '  extends: base-common',
      '  description: "Writer with critique gate."',
      '  workflows: [implement]',
      '  overlays: [critique-overlay]',
      '',
      'gated-reader:',
      '  extends: base-common',
      '  description: "Reader, no overlay."',
      '  workflows: [implement]',
      '',
    ].join('\n'),
  );

  return root;
}

beforeEach(() => {
  vi.mocked(getDiscoveredToolAnnotations).mockReset();
  vi.mocked(getDiscoveredToolAnnotations).mockReturnValue({});
});

afterEach(() => {
  process.chdir(originalCwd);
  resetCoworkerTypesCacheForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveCritiqueGatedTools', () => {
  it('returns [] when disable_overlays=1 — no gate, nothing to gate', () => {
    vi.mocked(getDiscoveredToolAnnotations).mockReturnValue({
      'mcp__slang-mcp__discord_send_message': { openWorldHint: true },
    });
    const ag = makeAgentGroup({
      coworker_type: 'gated-writer',
      disable_overlays: 1,
      allowed_mcp_tools: JSON.stringify(['mcp__slang-mcp__discord_send_message']),
    });
    expect(resolveCritiqueGatedTools(ag)).toEqual([]);
  });

  it('returns [] when the coworker type has no critique-overlay bound', () => {
    process.chdir(makeFixture());
    resetCoworkerTypesCacheForTests();

    vi.mocked(getDiscoveredToolAnnotations).mockReturnValue({
      'mcp__slang-mcp__discord_send_message': { openWorldHint: true },
    });
    const ag = makeAgentGroup({
      coworker_type: 'gated-reader',
      allowed_mcp_tools: JSON.stringify(['mcp__slang-mcp__discord_send_message']),
    });
    expect(resolveCritiqueGatedTools(ag)).toEqual([]);
  });

  it('returns [] when no tools are annotated (PR-1 ships as no-op)', () => {
    process.chdir(makeFixture());
    resetCoworkerTypesCacheForTests();

    // Default mock already returns {} — this is the prod state until PR-2.
    const ag = makeAgentGroup({
      coworker_type: 'gated-writer',
      allowed_mcp_tools: JSON.stringify([
        'mcp__slang-mcp__discord_send_message',
        'mcp__slang-mcp__github_post_issue_comment',
      ]),
    });
    expect(resolveCritiqueGatedTools(ag)).toEqual([]);
  });

  it('returns the subset with openWorldHint=true when the gate is active and tools are annotated', () => {
    process.chdir(makeFixture());
    resetCoworkerTypesCacheForTests();

    vi.mocked(getDiscoveredToolAnnotations).mockReturnValue({
      'mcp__slang-mcp__discord_send_message': { openWorldHint: true },
      'mcp__slang-mcp__github_post_issue_comment': {
        openWorldHint: true,
        destructiveHint: true,
      },
      // readOnly tool — should NOT be gated.
      'mcp__slang-mcp__search': { openWorldHint: false, readOnlyHint: true },
    });

    const ag = makeAgentGroup({
      coworker_type: 'gated-writer',
      allowed_mcp_tools: JSON.stringify([
        'mcp__slang-mcp__discord_send_message',
        'mcp__slang-mcp__github_post_issue_comment',
        'mcp__slang-mcp__search',
      ]),
    });
    expect(resolveCritiqueGatedTools(ag).sort()).toEqual([
      'mcp__slang-mcp__discord_send_message',
      'mcp__slang-mcp__github_post_issue_comment',
    ]);
  });

  it('respects allowed_mcp_tools — annotated tools not allowed for this coworker are excluded', () => {
    process.chdir(makeFixture());
    resetCoworkerTypesCacheForTests();

    vi.mocked(getDiscoveredToolAnnotations).mockReturnValue({
      'mcp__slang-mcp__discord_send_message': { openWorldHint: true },
      'mcp__slang-mcp__github_post_issue_comment': { openWorldHint: true },
    });

    // Only discord is allowed — github must not show up even though
    // it is annotated as openWorld.
    const ag = makeAgentGroup({
      coworker_type: 'gated-writer',
      allowed_mcp_tools: JSON.stringify(['mcp__slang-mcp__discord_send_message']),
    });
    expect(resolveCritiqueGatedTools(ag)).toEqual(['mcp__slang-mcp__discord_send_message']);
  });

  it('ignores annotations where openWorldHint is not explicitly true (false, missing, other)', () => {
    process.chdir(makeFixture());
    resetCoworkerTypesCacheForTests();

    vi.mocked(getDiscoveredToolAnnotations).mockReturnValue({
      'mcp__slang-mcp__foo': { openWorldHint: false },
      'mcp__slang-mcp__bar': { readOnlyHint: true }, // no openWorldHint
      'mcp__slang-mcp__baz': { destructiveHint: true }, // no openWorldHint
    });

    const ag = makeAgentGroup({
      coworker_type: 'gated-writer',
      allowed_mcp_tools: JSON.stringify(['mcp__slang-mcp__foo', 'mcp__slang-mcp__bar', 'mcp__slang-mcp__baz']),
    });
    expect(resolveCritiqueGatedTools(ag)).toEqual([]);
  });
});
