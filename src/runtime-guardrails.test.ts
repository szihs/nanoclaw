import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetCoworkerTypesCacheForTests, resolveAllowedMcpTools } from './container-runner.js';
import { shouldRetainOutboxFiles } from './delivery.js';
import type { AgentGroup } from './types.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempProject(coworkerTypes: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-guardrails-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'groups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'groups', 'coworker-types.json'), JSON.stringify(coworkerTypes, null, 2));
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
  it('inherits MCP allowlists through coworker type extends chains', () => {
    const projectRoot = makeTempProject({
      'slang-build': {
        allowedMcpTools: ['mcp__deepwiki__ask_question', 'mcp__slang-mcp__github_get_issue'],
      },
      'slang-compiler': {
        extends: 'slang-build',
        allowedMcpTools: ['mcp__slang-mcp__github_get_pull_request'],
      },
    });

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

  it('merges explicit allowlists from derived issue and reporting roles', () => {
    const projectRoot = makeTempProject({
      'slang-build': {
        allowedMcpTools: ['mcp__deepwiki__ask_question'],
      },
      'slang-quality': {
        extends: 'slang-build',
      },
      'slang-fix': {
        extends: ['slang-build', 'slang-quality'],
        allowedMcpTools: ['mcp__nanoclaw__send_message'],
      },
      'slang-maintainer': {
        extends: ['slang-build', 'slang-quality'],
        allowedMcpTools: ['mcp__nanoclaw__send_message', 'mcp__nanoclaw__schedule_task'],
      },
    });

    process.chdir(projectRoot);
    resetCoworkerTypesCacheForTests();

    expect(resolveAllowedMcpTools(makeAgentGroup('slang-fix'))).toEqual([
      'mcp__deepwiki__ask_question',
      'mcp__nanoclaw__send_message',
    ]);
    expect(resolveAllowedMcpTools(makeAgentGroup('slang-maintainer'))).toEqual([
      'mcp__deepwiki__ask_question',
      'mcp__nanoclaw__send_message',
      'mcp__nanoclaw__schedule_task',
    ]);
  });
});
