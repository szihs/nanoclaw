import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetCoworkerTypesCacheForTests, resolveAllowedMcpTools } from './container-runner.js';
import { shouldRetainOutboxFiles } from './delivery.js';
import type { AgentGroup } from './types.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

interface SkillFrontmatter {
  name: string;
  type?: 'capability' | 'workflow';
  description?: string;
  allowedTools?: string[];
  usesSkills?: string[];
  usesWorkflows?: string[];
}

/**
 * Build a temp project with the lego layout the registry expects:
 *   container/skills/<dir>/coworker-types.yaml — type registry
 *   container/skills/<dir>/SKILL.md            — capability/workflow skills
 *
 * Tool derivation walks skill + workflow frontmatter, so the MCP allowlists
 * that used to live in coworker-types.json now live in SKILL.md `allowed-tools`.
 */
function makeTempProject(types: Record<string, unknown>, skills: SkillFrontmatter[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-guardrails-'));
  tempDirs.push(dir);
  const skillsRoot = path.join(dir, 'container', 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });

  // One registry file per project to keep the fixture simple.
  const registryDir = path.join(skillsRoot, 'test-registry');
  fs.mkdirSync(registryDir, { recursive: true });
  const typeLines: string[] = [];
  for (const [name, entry] of Object.entries(types)) {
    typeLines.push(`${name}:`);
    const e = entry as Record<string, unknown>;
    if (e.extends !== undefined) {
      typeLines.push(`  extends: ${JSON.stringify(e.extends)}`);
    }
    if (Array.isArray(e.skills)) {
      typeLines.push(`  skills: ${JSON.stringify(e.skills)}`);
    }
    if (Array.isArray(e.workflows)) {
      typeLines.push(`  workflows: ${JSON.stringify(e.workflows)}`);
    }
  }
  fs.writeFileSync(path.join(registryDir, 'coworker-types.yaml'), typeLines.join('\n') + '\n');

  // Each skill gets its own directory under container/skills/<name>/SKILL.md.
  for (const skill of skills) {
    const skillDir = path.join(skillsRoot, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    const fm: string[] = ['---', `name: ${skill.name}`];
    if (skill.type) fm.push(`type: ${skill.type}`);
    fm.push(`description: ${JSON.stringify(skill.description ?? skill.name)}`);
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      fm.push(`allowed-tools: ${JSON.stringify(skill.allowedTools.join(', '))}`);
    }
    if ((skill.usesSkills && skill.usesSkills.length > 0) || (skill.usesWorkflows && skill.usesWorkflows.length > 0)) {
      fm.push('uses:');
      fm.push(`  skills: ${JSON.stringify(skill.usesSkills ?? [])}`);
      fm.push(`  workflows: ${JSON.stringify(skill.usesWorkflows ?? [])}`);
    }
    fm.push('---', '', `# ${skill.name}`, '');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), fm.join('\n'));
  }

  return dir;
}

function makeAgentGroup(coworkerType: string | null): AgentGroup {
  return {
    id: 'ag-test',
    name: 'Test',
    folder: 'test',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: coworkerType,
    allowed_mcp_tools: null,
    routing: 'direct',
    created_at: new Date().toISOString(),
  };
}

afterEach(() => {
  process.chdir(originalCwd);
  resetCoworkerTypesCacheForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime guardrails', () => {
  it('derives MCP allowlists from skill frontmatter across an extends chain', () => {
    const projectRoot = makeTempProject(
      {
        'slang-build': {
          skills: ['cap-deepwiki', 'cap-github-issue'],
        },
        'slang-compiler': {
          extends: 'slang-build',
          skills: ['cap-github-pr'],
        },
      },
      [
        { name: 'cap-deepwiki', allowedTools: ['mcp__deepwiki__ask_question'] },
        { name: 'cap-github-issue', allowedTools: ['mcp__slang-mcp__github_get_issue'] },
        { name: 'cap-github-pr', allowedTools: ['mcp__slang-mcp__github_get_pull_request'] },
      ],
    );

    process.chdir(projectRoot);
    resetCoworkerTypesCacheForTests();

    const tools = resolveAllowedMcpTools(makeAgentGroup('slang-compiler'));
    expect(tools).toEqual([
      'mcp__deepwiki__ask_question',
      'mcp__slang-mcp__github_get_issue',
      'mcp__slang-mcp__github_get_pull_request',
    ]);
  });

  it('keeps dashboard outbox files so the web UI can render message attachments', () => {
    const files = [{ filename: 'report.txt', data: Buffer.from('hello') }];
    expect(shouldRetainOutboxFiles('dashboard', files)).toBe(true);
    expect(shouldRetainOutboxFiles('dashboard')).toBe(false);
    expect(shouldRetainOutboxFiles('discord', files)).toBe(false);
  });

  it('merges tools across diamond-shaped extends and transitively through workflow uses', () => {
    const projectRoot = makeTempProject(
      {
        'slang-build': {
          skills: ['cap-deepwiki'],
        },
        'slang-quality': {
          extends: 'slang-build',
        },
        'slang-fix': {
          extends: ['slang-build', 'slang-quality'],
          skills: ['cap-send-message'],
        },
        'slang-reader': {
          extends: ['slang-build', 'slang-quality'],
          workflows: ['wf-maintain'],
        },
      },
      [
        { name: 'cap-deepwiki', allowedTools: ['mcp__deepwiki__ask_question'] },
        { name: 'cap-send-message', allowedTools: ['mcp__nanoclaw__send_message'] },
        { name: 'cap-schedule', allowedTools: ['mcp__nanoclaw__schedule_task'] },
        {
          name: 'wf-maintain',
          type: 'workflow',
          usesSkills: ['cap-send-message', 'cap-schedule'],
        },
      ],
    );

    process.chdir(projectRoot);
    resetCoworkerTypesCacheForTests();

    expect(resolveAllowedMcpTools(makeAgentGroup('slang-fix'))).toEqual([
      'mcp__deepwiki__ask_question',
      'mcp__nanoclaw__send_message',
    ]);
    expect(resolveAllowedMcpTools(makeAgentGroup('slang-reader'))).toEqual([
      'mcp__deepwiki__ask_question',
      'mcp__nanoclaw__schedule_task',
      'mcp__nanoclaw__send_message',
    ]);
  });
});
