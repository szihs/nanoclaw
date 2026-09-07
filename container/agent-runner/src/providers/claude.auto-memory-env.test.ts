import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// NanoClaw runs its own OKF memory (memory/index.md + the session-start hook),
// so Claude Code's native auto-memory must stay off: two memory systems writing
// the same workspace produce contradictory recall. `group-init.ts` writes
// `autoMemoryEnabled: false` into each group's settings.json, and the provider
// env reinforces it for the SDK child — belt and braces, because settings.json
// only covers groups scaffolded after the flag existed.
//
// The env half went missing on nv-main during the lego squash (b3a5bb12) and
// nothing caught it: nv-main's provider-surfaces.test.ts dropped upstream's
// three assertions on this key, so the fork shipped one belt for months. This
// file is the guard that makes a second silent loss impossible.

let capturedEnv: Record<string, string | undefined> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: { env?: Record<string, string | undefined> } }) => {
    capturedEnv = args?.options?.env;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-automem-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  capturedEnv = undefined;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drain(provider: InstanceType<typeof ClaudeProvider>) {
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
}

describe('ClaudeProvider env — native auto-memory stays disabled', () => {
  it('passes CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 to the SDK', async () => {
    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    await drain(provider);

    expect(capturedEnv?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  // A caller-supplied env must not be able to switch native memory back on:
  // the provider's own entries are spread last precisely so they win.
  it('is not overridable by caller-supplied env', async () => {
    const provider = createProvider('claude', { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    await drain(provider);

    expect(capturedEnv?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  // Guards against a "fix" that hardcodes the map and drops the sibling key.
  it('still passes the auto-compact window alongside it', async () => {
    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    await drain(provider);

    expect(capturedEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeTruthy();
  });
});
