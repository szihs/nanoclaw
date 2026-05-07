/**
 * Step: local — prereq checks + dep install for AGENT_RUNTIME=local.
 *
 * Validates that the host can spawn the agent-runner directly:
 *   - Node.js >= 20 on PATH
 *   - git on PATH (not strictly required at runtime, but setup tools use it)
 *   - bun on PATH (agent-runner imports `bun:sqlite`)
 *   - claude CLI on PATH (or via CLAUDE_CODE_EXECPATH)
 *   - `container/agent-runner/` dependencies installed (runs `pnpm install`
 *     if `node_modules/@anthropic-ai/claude-agent-sdk` is missing)
 *
 * Emits a NANOCLAW_SETUP: LOCAL status block and exits 1 on any failure.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

type CheckResult = { name: string; ok: boolean; detail: string };

function runCheck(name: string, fn: () => string): CheckResult {
  try {
    const detail = fn();
    log.info(`[setup:local] ${name}: ok (${detail})`);
    return { name, ok: true, detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`[setup:local] ${name}: failed (${detail})`);
    return { name, ok: false, detail };
  }
}

function checkNode(): string {
  const m = process.version.match(/^v(\d+)\./);
  const major = m ? parseInt(m[1], 10) : 0;
  if (major < 20) throw new Error(`Node ${process.version} < v20 required`);
  return process.version;
}

function checkCmd(cmd: string, arg = '--version'): string {
  const res = spawnSync(cmd, [arg], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`${cmd} ${arg} exited ${res.status}`);
  return (res.stdout || res.stderr).trim().split('\n')[0];
}

function checkClaudeCli(): string {
  const fromEnv = process.env.CLAUDE_CODE_EXECPATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`CLAUDE_CODE_EXECPATH points at missing file: ${fromEnv}`);
    return `${fromEnv} (via CLAUDE_CODE_EXECPATH)`;
  }
  return checkCmd('claude', '--version');
}

/**
 * Agent-runner has its own package.json (bun:sqlite + provider SDKs) that
 * isn't installed by the root `pnpm install`. In Docker mode the image bakes
 * them; in local mode we spawn against the source tree, so the deps must
 * live on disk.
 */
function ensureAgentRunnerDeps(): string {
  const runnerDir = path.join(process.cwd(), 'container', 'agent-runner');
  const probe = path.join(runnerDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  if (fs.existsSync(probe)) {
    return `already installed (${probe})`;
  }
  log.info('[setup:local] installing agent-runner deps…', { dir: runnerDir });
  try {
    execFileSync('pnpm', ['install'], { cwd: runnerDir, stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      `pnpm install failed in ${runnerDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!fs.existsSync(probe)) {
    throw new Error(`pnpm install completed but ${probe} is still missing`);
  }
  return `installed (${probe})`;
}

export async function run(_args: string[]): Promise<void> {
  const checks: CheckResult[] = [
    runCheck('node >= 20', checkNode),
    runCheck('git', () => checkCmd('git')),
    runCheck('bun', () => checkCmd('bun')),
    runCheck('claude CLI', checkClaudeCli),
    runCheck('agent-runner deps', ensureAgentRunnerDeps),
  ];

  const failed = checks.filter((c) => !c.ok);
  const summary: Record<string, string> = { STATUS: failed.length === 0 ? 'ok' : 'failed' };
  for (const c of checks) summary[c.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')] = c.detail;
  emitStatus('LOCAL', summary);

  if (failed.length > 0) {
    console.error(`\n${failed.length} prerequisite check(s) failed. Install the missing tool(s) and re-run.`);
    process.exit(1);
  }
}
