import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { composeClaudeMd, readCoworkerTypes, readSkillCatalog } from './claude-composer.js';

function loadYaml(relativePath: string): any {
  return yaml.load(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8'));
}

describe('kept slang coworker exports', () => {
  it('keeps only the selected four coworker exports', () => {
    const files = fs
      .readdirSync(path.join(process.cwd(), 'coworkers'))
      .filter((name) => name.endsWith('.yaml'))
      .sort();

    expect(files).toEqual([
      'dashboard_slang-fixer.yaml',
      'dashboard_slang-triage.yaml',
      'slang_ci-babysitter.yaml',
      'slang_maintainer.yaml',
    ]);
  });

  it('composes a spine CLAUDE.md for each kept coworker with the export instructions appended verbatim', () => {
    const types = readCoworkerTypes(process.cwd());
    const catalog = readSkillCatalog(process.cwd());

    const expectations: Record<string, { coworkerType: string; markers: string[] }> = {
      'coworkers/dashboard_slang-triage.yaml': {
        coworkerType: 'slang-triage',
        markers: ['# Stetson', '## Your Workflow'],
      },
      'coworkers/dashboard_slang-fixer.yaml': {
        coworkerType: 'slang-fix',
        markers: ['# Trelby — Slang Fixer Agent', '### 3. Create a Reproduction Test'],
      },
      'coworkers/slang_maintainer.yaml': {
        coworkerType: 'slang-maintainer',
        markers: ['# Slang Maintainer Workflow', '## Report Structure'],
      },
      'coworkers/slang_ci-babysitter.yaml': {
        coworkerType: 'slang-ci-babysitter',
        markers: ['# Slang CI Babysitter', '## Merge Queue Recovery'],
      },
    };

    for (const [relativePath, expectation] of Object.entries(expectations)) {
      const bundle = loadYaml(relativePath);
      expect(bundle.agent?.coworkerType).toBe(expectation.coworkerType);
      expect(bundle.requires?.coworkerTypes).toEqual([expectation.coworkerType]);

      // Every kept export resolves to a registered lego type.
      expect(types[expectation.coworkerType]).toBeDefined();

      const instructions = typeof bundle.instructions === 'string' ? bundle.instructions.trim() : '';
      const generated = composeClaudeMd({
        projectRoot: process.cwd(),
        manifestName: 'coworker',
        coworkerType: bundle.agent.coworkerType,
        extraInstructions: instructions,
      });

      // Spine headings.
      expect(generated).toMatch(/^# [\w -]+\n/);
      expect(generated).toContain('## Identity');
      expect(generated).toContain('## Additional Instructions');

      // The export's instruction body is preserved verbatim and its markers are reachable.
      expect(generated).toContain(instructions);
      for (const marker of expectation.markers) {
        expect(generated).toContain(marker);
      }

      // Procedural content from the legacy 6-section templates must NOT be pinned
      // in context — it moves to progressively-disclosed workflow SKILL.md bodies.
      // The spine portion is everything above the Additional Instructions tail
      // (export prose is user-authored and may legitimately re-use any heading).
      const additionalIdx = generated.indexOf('## Additional Instructions');
      const spinePortion = additionalIdx >= 0 ? generated.slice(0, additionalIdx) : generated;
      expect(spinePortion).not.toContain('## Capabilities');
      expect(spinePortion).not.toContain('## Resources');
      expect(spinePortion).not.toContain('## Workflow\n');

      // Tool derivation links the spine to its workflow+skill catalog.
      const manifestRefs = [
        ...(types[expectation.coworkerType].workflows ?? []),
        ...(types[expectation.coworkerType].skills ?? []),
      ];
      for (const ref of manifestRefs) {
        expect(catalog[ref]).toBeDefined();
      }
    }
  });
});
