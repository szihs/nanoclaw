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

describe('Scenario 3: + slang-spine', () => {
  it('slang-spine contributes main/global addons by duplicate-type merge', () => {
    expect(exists('container/skills/slang-spine/prompts/main-addon.md')).toBe(true);
    expect(exists('container/skills/slang-spine/prompts/global-addon.md')).toBe(true);

    const types = readCoworkerTypes(REPO_ROOT);
    expect(types.main?.context).toContain('container/skills/slang-spine/prompts/main-addon.md');
    expect(types.global?.context).toContain('container/skills/slang-spine/prompts/global-addon.md');
  });

  it('main spine contains the slang orchestration addon body', () => {
    const spine = composeCoworkerSpine({ projectRoot: REPO_ROOT, coworkerType: 'main' });
    const slangAddon = readFile('container/skills/slang-spine/prompts/main-addon.md').trim();
    expect(spine).toContain(slangAddon);
  });

  it('registers the slang coworker types from slang-spine/coworker-types.yaml', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types['slang-common']).toBeDefined();
    expect(types['slang-triage']).toBeDefined();
    expect(types['slang-fix']).toBeDefined();
    expect(types['slang-maintainer']).toBeDefined();
    expect(types['slang-ci-health']).toBeDefined();
  });

  it('every slang type uses project=slang so cross-project extends is constrained', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    for (const name of ['slang-common', 'slang-triage', 'slang-fix', 'slang-maintainer', 'slang-ci-health']) {
      expect(types[name]?.project).toBe('slang');
    }
  });
});

describe('Scenario 4: typed coworker (slang-triage)', () => {
  it('renders a structured spine with ## Identity / Invariants / Workflows Available', () => {
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-triage',
    });

    expect(spine).toMatch(/^# Slang Triage\n/);
    expect(spine).toContain('## Identity');
    expect(spine).toContain('## Invariants');
    expect(spine).toContain('## Workflows Available');
    expect(spine).toContain('- `/slang-triage`');
  });

  it('resolves all workflow and skill references through the catalog', () => {
    const types = readCoworkerTypes(REPO_ROOT);
    const catalog = readSkillCatalog(REPO_ROOT);
    const entry = types['slang-triage']!;
    for (const ref of [...(entry.workflows ?? []), ...(entry.skills ?? [])]) {
      expect(catalog[ref], `slang-triage references unknown ref "${ref}"`).toBeDefined();
    }
  });

  it('appends verbatim extra instructions under ## Additional Instructions', () => {
    const extra = '# Local override\n\nFocus only on graphics-pipeline issues for this instance.';
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-triage',
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
      coworkerType: 'slang-triage',
    });
    // The upper bound is generous — workflow bodies are excluded, only the
    // index lines appear in the spine. If this fails, something procedural
    // has leaked into the spine from a SKILL.md body.
    expect(spine.length).toBeLessThan(20000);
  });

  it('groups the Workflows Available and Skills Available lists by category', () => {
    const spine = composeCoworkerSpine({
      projectRoot: REPO_ROOT,
      coworkerType: 'slang-triage',
    });

    // Extract each section by slicing between its heading and the next `##`.
    function section(title: string): string {
      const start = spine.indexOf(`## ${title}`);
      expect(start, `missing ## ${title}`).toBeGreaterThan(-1);
      const rest = spine.slice(start + title.length + 3);
      const nextIdx = rest.indexOf('\n## ');
      return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
    }

    const workflows = section('Workflows Available');
    expect(workflows).toContain('**VCS**');
    expect(workflows).toContain('**Code**');
    expect(workflows).toContain('**CI**');
    expect(workflows).toContain('**Research**');
    // Category order: VCS before Code before CI before Research.
    expect(workflows.indexOf('**VCS**')).toBeLessThan(workflows.indexOf('**Code**'));
    expect(workflows.indexOf('**Code**')).toBeLessThan(workflows.indexOf('**CI**'));
    expect(workflows.indexOf('**CI**')).toBeLessThan(workflows.indexOf('**Research**'));

    const skills = section('Skills Available');
    expect(skills).toContain('**VCS**');
    expect(skills).toContain('**Other**'); // base-nanoclaw has no categorizable trait.
    expect(skills.indexOf('**VCS**')).toBeLessThan(skills.indexOf('**Other**'));
  });
});
