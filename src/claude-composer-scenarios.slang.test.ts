/**
 * Slang-owned half of the lego composer scenario coverage (Scenarios 3 & 4).
 * Architectural framing + Scenario 1 + upstream drift checks live in
 * claude-composer-scenarios.test.ts on the neutral spine.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { composeCoworkerSpine, readCoworkerTypes, readSkillCatalog } from './claude-composer.js';

const REPO_ROOT = process.cwd();

function readFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

describe('Scenario 3: + spine-slang', () => {
  it('spine-slang does not inject addons into main/global (project content stays in project types)', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    const mainContext = types.main?.context || [];
    const globalContext = types.global?.context || [];
    for (const ctx of [...mainContext, ...globalContext]) {
      expect(ctx).not.toContain('spine-slang');
    }
  });

  it('registers the slang coworker types from spine-slang/coworker-types.yaml', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types['slang-common']).toBeDefined();
    expect(types['slang-reader']).toBeDefined();
    expect(types['slang-writer']).toBeDefined();
  });

  it('every slang type uses project=slang so cross-project extends is constrained', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    for (const name of ['slang-common', 'slang-reader', 'slang-writer']) {
      expect(types[name]?.project).toBe('slang');
    }
  });
});

describe('Scenario 4: typed coworker (slang-reader)', () => {
  it('renders a structured spine with ## Identity / Invariants / Workflows', () => {
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-reader',
    });

    expect(spine).toMatch(/^# Slang Reader\n/);
    expect(spine).toContain('## Identity');
    expect(spine).toContain('## Invariants');
    expect(spine).toContain('## Workflows');
    expect(spine).toContain('`/slang-investigate`');
  });

  it('resolves all workflow and skill references through the catalog', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    const catalog = readSkillCatalog(REPO_ROOT);
    const entry = types['slang-reader']!;
    for (const ref of [...(entry.workflows ?? []), ...(entry.skills ?? [])]) {
      expect(catalog[ref], `slang-reader references unknown ref "${ref}"`).toBeDefined();
    }
  });

  it('appends verbatim extra instructions under ## Additional Instructions', () => {
    const extra = '# Local override\n\nFocus only on graphics-pipeline issues for this instance.';
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-reader',
      extraInstructions: extra,
    });
    expect(spine).toContain('## Additional Instructions');
    expect(spine).toContain('Focus only on graphics-pipeline issues for this instance.');

    // The body has not snuck into the spine above the extra tail — the
    // procedural workflow content lives in SKILL.md, not the spine.
    const splitIdx = spine.indexOf('## Additional Instructions');
    const spinePortion = spine.slice(0, splitIdx);
    expect(spinePortion).not.toContain('## Capabilities');
    expect(spinePortion).not.toContain('## Resources');
  });

  it('produces a spine small enough to live always-in-context', () => {
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-reader',
    });
    // The upper bound is generous — workflow bodies are excluded, only the
    // index lines appear in the spine. If this fails, something procedural
    // has leaked into the spine from a SKILL.md body.
    expect(spine.length).toBeLessThan(40000);
  });

  it('groups the Workflows and Skills Available lists by category', () => {
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-reader',
    });

    // Extract each section by slicing between its heading and the next `##`.
    function section(title: string): string {
      const start = spine.indexOf(`## ${title}`);
      expect(start, `missing ## ${title}`).toBeGreaterThan(-1);
      const rest = spine.slice(start + title.length + 3);
      const nextIdx = rest.indexOf('\n## ');
      return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
    }

    const workflows = section('Workflows');
    // slang-reader workflows (investigate, review, slang-investigate) all fall
    // into similar categories, so sub-headers may be suppressed. Check content.
    expect(workflows).toContain('/slang-investigate');
    expect(workflows).toContain('/slang-review');

    const skills = section('Skills Available');
    expect(skills).toContain('**Repo**');
    expect(skills).toContain('**Other**'); // base-nanoclaw has no categorizable trait.
    expect(skills.indexOf('**Repo**')).toBeLessThan(skills.indexOf('**Other**'));
  });
});
