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

  it('base spine provides the main body + default identity + types', () => {
    const spineDir = path.join(process.cwd(), 'container', 'spines', 'base');
    for (const rel of ['coworker-types.yaml', 'identity/main-body.md', 'identity/default-identity.md']) {
      expect(fs.existsSync(path.join(spineDir, rel)), `missing ${rel} in spines/base`).toBe(true);
    }
    // global-body.md was retired in favor of /workspace/shared/. And the
    // old container/skills/nanoclaw-base/ directory has been folded into
    // container/spines/base/ — assert nothing lives at the old location.
    expect(
      fs.existsSync(path.join(process.cwd(), 'container/skills/nanoclaw-base')),
      'container/skills/nanoclaw-base/ should be gone — moved to container/spines/base/',
    ).toBe(false);
  });
});
