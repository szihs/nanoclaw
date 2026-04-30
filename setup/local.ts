/**
 * Step: local — prereq checks for AGENT_RUNTIME=local.
 *
 * Validates that the host can spawn the agent-runner directly:
 *   - Node.js >= 20 on PATH
 *   - git on PATH
 *   - bun on PATH (agent-runner uses `bun:sqlite`)
 *   - claude CLI on PATH (or via CLAUDE_CODE_EXECPATH)
 *   - the current project root is a git repository with at least one commit
 *
 * Emits a NANOCLAW_SETUP: LOCAL status block and exits 1 on any failure.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';

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

function checkGitRepo(): string {
  const root = process.cwd();
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf-8' }).trim();
    return `HEAD=${out.slice(0, 8)}`;
  } catch {
    throw new Error(`${root} is not a git repository with at least one commit`);
  }
}

export async function run(_args: string[]): Promise<void> {
  const checks: CheckResult[] = [
    runCheck('node >= 20', checkNode),
    runCheck('git', () => checkCmd('git')),
    runCheck('bun', () => checkCmd('bun')),
    runCheck('claude CLI', checkClaudeCli),
    runCheck('project root is a git repo', checkGitRepo),
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
