import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('v2 architecture alignment — slang', () => {
  it('legacy slang project overlays and base are gone', () => {
    const templatesDir = path.join(process.cwd(), 'groups', 'templates');
    const gone = [
      path.join(templatesDir, 'projects', 'slang', 'main-overlay.yaml'),
      path.join(templatesDir, 'projects', 'slang', 'global-overlay.yaml'),
      path.join(templatesDir, 'projects', 'slang', 'coworker-base.yaml'),
    ];
    for (const p of gone) {
      expect(fs.existsSync(p), `${p} should be removed in favor of container/skills/*`).toBe(false);
    }
  });

  it('slang bootstrap skill points at the lego-spine layout', () => {
    const slangSkill = fs.readFileSync(path.join(process.cwd(), '.claude', 'skills', 'add-slang', 'SKILL.md'), 'utf-8');

    expect(slangSkill).toContain('git fetch slang skill/v2_slang');
    expect(slangSkill).toContain('git merge slang/skill/v2_slang');
    expect(slangSkill).toContain('container/skills/slang-spine');
    expect(slangSkill).toContain('npm run rebuild:claude');
    expect(slangSkill).not.toContain('groups/templates/projects/slang/main-overlay.yaml');
    expect(slangSkill).not.toContain('groups/templates/projects/slang/global-overlay.yaml');
    expect(slangSkill).not.toContain('groups/templates/projects/slang/coworker-base.yaml');
  });
});
