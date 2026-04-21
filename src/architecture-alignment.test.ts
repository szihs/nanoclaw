import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('v2 architecture alignment', () => {
  it('legacy 6-section manifests and base templates for main/global are gone', () => {
    const templatesDir = path.join(process.cwd(), 'groups', 'templates');
    const gone = [
      path.join(templatesDir, 'manifests', 'main.yaml'),
      path.join(templatesDir, 'manifests', 'global.yaml'),
      path.join(templatesDir, 'manifests', 'coworker.yaml'),
      path.join(templatesDir, 'base', 'main.yaml'),
      path.join(templatesDir, 'base', 'main.md'),
      path.join(templatesDir, 'base', 'global.yaml'),
      path.join(templatesDir, 'base', 'global.md'),
    ];
    for (const p of gone) {
      expect(fs.existsSync(p), `${p} should be removed in favor of container/skills/*`).toBe(false);
    }
  });

  it('nanoclaw-base skill provides the main + global bodies', () => {
    const skillDir = path.join(process.cwd(), 'container', 'skills', 'nanoclaw-base');
    for (const rel of ['coworker-types.yaml', 'prompts/main-body.md', 'prompts/global-body.md']) {
      expect(fs.existsSync(path.join(skillDir, rel)), `missing ${rel} in nanoclaw-base`).toBe(true);
    }
  });
});
