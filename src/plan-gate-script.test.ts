// Integration tests for container/hooks/plan-gate.sh.
//
// PR-1 adds a third branch to the script for MCP tools: when the incoming
// tool_name is `mcp__*` and is listed in CRITIQUE_GATED_TOOLS, the script
// falls through to the same plan/critique checks as Edit/Write. Tests here
// shell out with JSON-on-stdin to verify:
//   - no-op behavior when no gate state file exists
//   - no-op behavior for MCP tools not in CRITIQUE_GATED_TOOLS
//   - deny behavior when critique_required=true
//   - Edit/Write paths stay byte-equivalent (regression check)
//
// The script honors WORKFLOW_STATE_FILE / DENIAL_COUNT_FILE env overrides
// so tests don't need /workspace/.claude/ — the container defaults still
// apply in prod.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(process.cwd(), 'container', 'hooks', 'plan-gate.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPlanGate(payload: object, env: Record<string, string> = {}): RunResult {
  const proc = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify(payload),
    env: {
      PATH: process.env.PATH || '',
      ...env,
    },
    encoding: 'utf-8',
  });
  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

let tmpDir: string;
let stateFile: string;
let denialFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-test-'));
  stateFile = path.join(tmpDir, 'workflow-state.json');
  denialFile = path.join(tmpDir, 'denial-counts.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function envOverride(extra: Record<string, string> = {}): Record<string, string> {
  return {
    WORKFLOW_STATE_FILE: stateFile,
    DENIAL_COUNT_FILE: denialFile,
    ...extra,
  };
}

describe('plan-gate.sh — MCP tool gating (PR-1)', () => {
  it('exits 0 when CRITIQUE_GATED_TOOLS is empty (no gate configured)', () => {
    const result = runPlanGate(
      { tool_name: 'mcp__slang-mcp__discord_send_message', tool_input: {} },
      envOverride(), // CRITIQUE_GATED_TOOLS unset
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 when the MCP tool is not listed in CRITIQUE_GATED_TOOLS', () => {
    const result = runPlanGate(
      { tool_name: 'mcp__slang-mcp__search', tool_input: {} },
      envOverride({
        CRITIQUE_GATED_TOOLS: 'mcp__slang-mcp__discord_send_message',
      }),
    );
    expect(result.status).toBe(0);
  });

  it('exits 0 for gated MCP tool when workflow-state.json has no active conditions', () => {
    // An empty state file is the post-reset prod state — workflow-state-reset.sh
    // zeroes the JSON before the container runs any user input. No plan
    // requirement active AND no critique requirement set → no block.
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        plan_written: true,
        plan_stale: false,
        critique_required: false,
      }),
    );
    const result = runPlanGate(
      { tool_name: 'mcp__slang-mcp__discord_send_message', tool_input: {} },
      envOverride({
        CRITIQUE_GATED_TOOLS: 'mcp__slang-mcp__discord_send_message',
      }),
    );
    expect(result.status).toBe(0);
  });

  it('blocks gated MCP tool with EXTERNAL POST BLOCKED when critique_required=true', () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        plan_written: true,
        critique_required: true,
        critique_rounds: 0,
        critique_round_at_flag: 0,
        edits_since_critique: 7,
      }),
    );
    const result = runPlanGate(
      { tool_name: 'mcp__slang-mcp__discord_send_message', tool_input: {} },
      envOverride({
        CRITIQUE_GATED_TOOLS: 'mcp__slang-mcp__discord_send_message,mcp__slang-mcp__github_post_issue_comment',
      }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('EXTERNAL POST BLOCKED');
    expect(result.stderr).toContain('mcp__slang-mcp__discord_send_message');
  });

  it('blocks gated MCP tool when plan_written is missing and OVERLAY_HAS_PLAN=1', () => {
    // No state file at all — this is the "fresh container, no plan" case.
    const result = runPlanGate(
      { tool_name: 'mcp__slang-mcp__github_post_issue_comment', tool_input: {} },
      envOverride({
        CRITIQUE_GATED_TOOLS: 'mcp__slang-mcp__github_post_issue_comment',
        OVERLAY_HAS_PLAN: '1',
      }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('EXTERNAL POST BLOCKED');
  });

  it('membership check is exact (substring match must not accidentally gate similar tool names)', () => {
    // If the script did substring membership, `mcp__slang-mcp__search`
    // would "match" because it shares a prefix with the gated name. Exact
    // equality is required.
    fs.writeFileSync(stateFile, JSON.stringify({ critique_required: true }));
    const result = runPlanGate(
      { tool_name: 'mcp__slang-mcp__search', tool_input: {} },
      envOverride({
        CRITIQUE_GATED_TOOLS: 'mcp__slang-mcp__search_extended,mcp__slang-mcp__discord_send_message',
      }),
    );
    expect(result.status).toBe(0);
  });
});

describe('plan-gate.sh — regression: Edit/Write/Bash unchanged', () => {
  it('exits 0 for Edit on an allowlisted workspace path', () => {
    const result = runPlanGate(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/workspace/agent/plans/foo.md' },
      },
      envOverride(),
    );
    expect(result.status).toBe(0);
  });

  it('blocks Edit on source when plan_written is false', () => {
    fs.writeFileSync(stateFile, JSON.stringify({ plan_written: false }));
    const result = runPlanGate(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/workspace/src/foo.ts' },
      },
      envOverride({ OVERLAY_HAS_PLAN: '1' }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PLAN REQUIRED');
    // MCP wording must NOT leak into the Edit branch.
    expect(result.stderr).not.toContain('EXTERNAL POST BLOCKED');
  });

  it('blocks Edit with CRITIQUE REQUIRED wording when critique_required=true', () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        plan_written: true,
        critique_required: true,
        critique_rounds: 0,
        critique_round_at_flag: 0,
        edits_since_critique: 5,
      }),
    );
    const result = runPlanGate(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/workspace/src/foo.ts' },
      },
      envOverride(),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CRITIQUE REQUIRED');
    expect(result.stderr).not.toContain('EXTERNAL POST BLOCKED');
  });

  it('exits 0 for a plain read-style Bash command', () => {
    const result = runPlanGate({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, envOverride());
    expect(result.status).toBe(0);
  });

  it('blocks Bash with write redirect when plan_written is false', () => {
    fs.writeFileSync(stateFile, JSON.stringify({ plan_written: false }));
    const result = runPlanGate(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo hi > /workspace/src/foo.txt' },
      },
      envOverride({ OVERLAY_HAS_PLAN: '1' }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PLAN REQUIRED');
  });
});
