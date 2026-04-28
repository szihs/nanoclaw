import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('v2 architecture alignment — dashboard', () => {
  it('legacy dashboard project template is gone', () => {
    const templatesDir = path.join(process.cwd(), 'groups', 'templates');
    const gone = [path.join(templatesDir, 'projects', 'dashboard', 'formatting.yaml')];
    for (const p of gone) {
      expect(fs.existsSync(p), `${p} should be removed in favor of container/skills/*`).toBe(false);
    }
  });

  it('dashboard bootstrap skill points at the lego-spine layout', () => {
    const dashboardSkill = fs.readFileSync(
      path.join(process.cwd(), '.claude', 'skills', 'add-dashboard', 'SKILL.md'),
      'utf-8',
    );

    expect(dashboardSkill).toContain('git fetch origin nv-dashboard');
    expect(dashboardSkill).toContain('git merge origin/nv-dashboard');
    expect(dashboardSkill).toContain('container/skills/dashboard-base');
    expect(dashboardSkill).toContain('npm run rebuild:claude');
    expect(dashboardSkill).not.toContain('groups/templates/projects/dashboard/formatting.yaml');
  });
});
