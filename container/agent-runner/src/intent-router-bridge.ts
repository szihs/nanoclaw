/**
 * Intent-router bridge for follow-up prompts.
 *
 * The Claude Agent SDK fires `UserPromptSubmit` only for the initial prompt
 * passed to `provider.query({prompt})`. Subsequent `query.push(prompt)` calls
 * (used by poll-loop for follow-up messages) bypass the hook entirely.
 *
 * To keep router classification working on every user message, this bridge
 * runs the same `intent-router.sh` hook script the SDK would run, parses its
 * `additionalContext` output, and returns a routed prompt the caller can
 * push to the SDK in place of the raw prompt.
 *
 * Silent on failure: if the hook errors, times out, or returns nothing,
 * the original prompt is returned unchanged.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const HOOK_PATH = '/app/hooks/intent-router.sh';
const TIMEOUT_MS = 4000;

function log(msg: string): void {
  console.error(`[intent-router-bridge] ${msg}`);
}

export async function classifyAndPrepend(prompt: string): Promise<string> {
  if (!existsSync(HOOK_PATH)) return prompt;
  if (!process.env.OVERLAY_WORKFLOWS) return prompt;

  const additionalContext = await runHook(prompt).catch((err) => {
    log(`hook failed: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  });
  if (!additionalContext) return prompt;
  return `${additionalContext}\n\n${prompt}`;
}

function runHook(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [HOOK_PATH], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      child.kill('SIGTERM');
      reject(new Error(`hook timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
      try {
        const out = stdout.trim();
        if (!out) return resolve('');
        const parsed = JSON.parse(out);
        const ac = parsed?.hookSpecificOutput?.additionalContext;
        resolve(typeof ac === 'string' ? ac : '');
      } catch {
        resolve('');
      }
    });

    child.stdin.write(JSON.stringify({ prompt }));
    child.stdin.end();
  });
}
