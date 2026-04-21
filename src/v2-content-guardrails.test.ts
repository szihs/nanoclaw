import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('v2 content guardrails', () => {
  it('onboard-coworker skill should use v2 primitives', () => {
    const skillPath = path.join(process.cwd(), '.claude', 'skills', 'onboard-coworker', 'SKILL.md');

    expect(fs.existsSync(skillPath)).toBe(true);

    const source = fs.readFileSync(skillPath, 'utf-8');
    expect(source).toContain('coworkers/*.yaml');
    expect(source).toContain('mcp__nanoclaw__create_agent');
    expect(source).toContain('mcp__nanoclaw__wire_agents');
    expect(source).not.toContain('register_group');
    expect(source).not.toContain('claudeMdAppend');
    expect(source).not.toContain('/workspace/ipc');
  });

  it('slang-spine main addon teaches v2 coworker orchestration primitives', () => {
    // Orchestration content used to live in groups/templates/base/main.yaml.
    // It now lives in container/skills/slang-spine/prompts/main-addon.md,
    // contributed to the `main` flat type via duplicate-type merging.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'container', 'skills', 'slang-spine', 'prompts', 'main-addon.md'),
      'utf-8',
    );

    expect(source).toContain('mcp__nanoclaw__create_agent');
    expect(source).toContain('mcp__nanoclaw__wire_agents');
    expect(source).toContain('container/skills/*/coworker-types.yaml');
  });

  it('instruction overlay templates should exist and contain substantive guidance', () => {
    const expectedTemplates = ['ci-focused.md', 'code-reviewer.md', 'terse-reporter.md', 'thorough-analyst.md'];

    for (const template of expectedTemplates) {
      const templatePath = path.join(process.cwd(), 'groups', 'templates', 'instructions', template);
      expect(fs.existsSync(templatePath), `missing instruction template ${template}`).toBe(true);

      const source = fs.readFileSync(templatePath, 'utf-8').trim();
      expect(source.length, `instruction template ${template} should not be empty`).toBeGreaterThan(40);
      expect(source.startsWith('## '), `instruction template ${template} should start with a heading`).toBe(true);
    }
  });

  it('onboard-coworker documents the instruction overlay templates', () => {
    // Instruction overlays are a coworker-creation concept (not an admin-
    // prompt concept anymore), so the onboard skill is where they should
    // be surfaced.
    const source = fs.readFileSync(
      path.join(process.cwd(), '.claude', 'skills', 'onboard-coworker', 'SKILL.md'),
      'utf-8',
    );
    expect(source).toContain('groups/templates/instructions/');
  });
});
