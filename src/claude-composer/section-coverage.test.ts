/**
 * The sections byte-parity cannot see.
 *
 * `parity.test.ts` covers every coworker type that exists in-tree, and that is
 * still not enough: measured, all three emit ZERO `## Workflows` and ZERO
 * `## Gate Protocol` sections, because no in-tree coworker-types.yaml declares
 * `workflows:`. So the two sections whose ORDER matters most — a gate that must
 * precede the workflow bodies it guards — had no coverage at all, and a
 * regression in either would have shipped with a fully green suite.
 *
 * These fixtures are synthetic for exactly that reason. They are not a
 * belt-and-braces duplicate of parity; they are the only coverage these paths
 * have.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { composeCoworkerSpine } from '../claude-composer.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sections-'));
  tempDirs.push(dir);
  return dir;
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function writeSkill(root: string, dir: string, frontmatter: Record<string, unknown>, body = ''): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (typeof v === 'string') lines.push(`${k}: ${v}`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    else if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${sk}: ${JSON.stringify(sv)}`);
      }
    }
  }
  lines.push('---', '', body);
  write(path.join(root, 'container', 'skills', dir, 'SKILL.md'), lines.join('\n') + '\n');
}

/** A project with two workflows, so `## Workflows` is actually emitted. */
function twoWorkflowProject(): string {
  const root = scratch();
  write(path.join(root, 'base', 'identity.md'), '### Identity\n\nA test coworker.');
  for (const name of ['alpha-flow', 'beta-flow']) {
    writeSkill(
      root,
      name,
      { name, type: 'workflow', description: `Do the ${name} thing.`, uses: { skills: [], workflows: [] } },
      // `## Steps` heading plus `N. **Title** {#id}` is what the registry parses
      // as an anchorable step — without both, `steps` is empty and no overlay
      // anchor can ever match, which silently costs the gate coverage below.
      `## Steps\n\n1. **Step** {#step} — run the ${name} step.\n`,
    );
  }
  write(
    path.join(root, 'container', 'skills', 'spine', 'coworker-types.yaml'),
    [
      'twoflow:',
      '  description: "two workflows"',
      '  identity: base/identity.md',
      '  workflows:',
      '    - alpha-flow',
      '    - beta-flow',
      '',
    ].join('\n'),
  );
  return root;
}

describe('sections with no in-tree coverage', () => {
  it('emits Workflows for a type that declares them', () => {
    const out = composeCoworkerSpine({ coworkerType: 'twoflow', projectRoot: twoWorkflowProject() });

    expect(out).toContain('\n## Workflows\n');
    expect(out).toContain('alpha-flow');
    expect(out).toContain('beta-flow');
  });

  it('orders both workflows under the single Workflows heading', () => {
    const out = composeCoworkerSpine({ coworkerType: 'twoflow', projectRoot: twoWorkflowProject() });

    expect(out.match(/^## Workflows$/gm)).toHaveLength(1);
    expect(out.indexOf('alpha-flow')).toBeLessThan(out.lastIndexOf('beta-flow'));
  });

  // A gate emitted AFTER the bodies it guards is worse than no gate: the reader
  // has already been given the procedure. The ordering is the invariant, not the
  // presence.
  it('emits Gate Protocol before Workflows when a staged overlay applies', () => {
    const root = twoWorkflowProject();
    writeSkill(
      root,
      'stage-overlay',
      {
        name: 'stage-overlay',
        type: 'overlay',
        description: 'Gate before shipping.',
        'applies-to': { workflows: ['alpha-flow'], traits: [] },
        'insert-after': ['step'],
        marker: 'stage-overlay',
      },
      // Staged form: a `STAGE (after `step`)` heading makes this a staged
      // overlay, and a second, non-anchor `##` section is the SHARED body — that
      // shared part is what gets deduped out of the inline sites and promoted to
      // the trailing `## Gate Protocol` block. Without a shared section there is
      // no promoted heading at all, and the ordering assertion below would be
      // vacuous.
      '## REVIEW (after `step`)\n\nBlock until reviewed.\n\n## Shared Rules\n\nAlways record the verdict.',
    );

    const out = composeCoworkerSpine({
      coworkerType: 'twoflow',
      projectRoot: root,
      overlays: ['stage-overlay'],
    });

    const gate = out.indexOf('\n## Gate Protocol\n');
    const workflows = out.indexOf('\n## Workflows\n');

    // Assert PRESENCE first, unconditionally. An earlier version of this test
    // guarded the ordering with `if (gate !== -1)`, which passed while no gate
    // section was emitted at all — the fixture's step format was wrong, so the
    // overlay anchor never matched and the one assertion that mattered was
    // skipped every run.
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(workflows);
    // The shared body is what gets promoted out of the inline sites.
    expect(out).toContain('Always record the verdict');
    // An overlay that swallowed the workflow bodies would otherwise satisfy the
    // ordering check.
    expect(out).toContain('alpha-flow');
  });

  it('keeps a blank flat fragment from shifting separators', () => {
    const root = scratch();
    write(path.join(root, 'base', 'flat-body.md'), '# Flat\n\nBody text.');
    write(path.join(root, 'base', 'empty.md'), '   \n\n  \n');
    write(
      path.join(root, 'container', 'skills', 'spine', 'coworker-types.yaml'),
      [
        'flatty:',
        '  description: "flat with an empty fragment"',
        '  flat: true',
        '  identity: base/flat-body.md',
        '  context:',
        '    - base/empty.md',
        '',
      ].join('\n'),
    );

    const out = composeCoworkerSpine({ coworkerType: 'flatty', projectRoot: root });

    // The blank fragment is dropped by `.filter(Boolean)`, so no run of three
    // newlines appears where it would have been.
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toContain('Body text.');
  });

  it('emits no MCP wrapper when no servers are configured', () => {
    const out = composeCoworkerSpine({ coworkerType: 'twoflow', projectRoot: twoWorkflowProject() });

    expect(out).not.toContain('## MCP Servers');
  });

  it('emits one wrapper and one sub-heading per configured server, sorted', () => {
    const out = composeCoworkerSpine({
      coworkerType: 'twoflow',
      projectRoot: twoWorkflowProject(),
      mcpInstructions: { zeta: 'Use zeta.', alpha: 'Use alpha.' },
    });

    expect(out.match(/^## MCP Servers$/gm)).toHaveLength(1);
    // Sorted, not insertion order: the composed text feeds a sha256 staleness
    // comparison, so key order would make an unrelated config edit look like a
    // content change and respawn the container.
    expect(out.indexOf('### alpha')).toBeLessThan(out.indexOf('### zeta'));
  });
});
