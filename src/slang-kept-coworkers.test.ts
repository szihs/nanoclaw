import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { composeClaudeMd } from './claude-composer.js';

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

  it('preserves each kept coworker instruction body verbatim in the composed output', () => {
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

      const instructions = typeof bundle.instructions === 'string' ? bundle.instructions.trim() : '';
      const generated = composeClaudeMd({
        projectRoot: process.cwd(),
        manifestName: 'coworker',
        coworkerType: bundle.agent?.coworkerType,
        extraInstructions: instructions,
      });

      expect(generated).toContain('### Additional Instructions');
      expect(generated).toContain(instructions);
      for (const marker of expectation.markers) {
        expect(generated).toContain(marker);
      }
    }
  });
});
