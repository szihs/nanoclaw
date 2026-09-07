/**
 * `container/CLAUDE.md` tells every agent, unconditionally, that its memory
 * index and system definition arrive in the session-start context. That was
 * only true under Claude: the section is delivered by a Claude Code SessionStart
 * hook, and `registerMemorySessionHook` was a silent no-op in `codex.ts`,
 * `opencode.ts` and `pi.ts` — three of the four registered providers.
 *
 * Same shape of bug as the `conversations/` one fixed in #1326, and the same
 * shape of fix: deliver at a provider-independent point instead of behind a
 * per-provider hook. Here the provider reports whether it wired the hook, and
 * the runner falls back to the system prompt when it did not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendMemorySection, memoryContextForSystemPrompt, renderMemorySection } from './context.js';
import { MEMORY_SESSION_HOOK } from './session-hook.js';
import { ensureMemoryScaffold } from './scaffold.js';
import { buildSystemPromptAddendum } from '../destinations.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { runPollLoop } from '../poll-loop.js';
// Only claude's own registrations — importing the whole barrels pulls in every
// provider, and some need an agent mailbox at import time (this suite has none).
import '../providers/claude.js';
import '../provider-contracts/claude.js';
import { createProvider } from '../providers/factory.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import { CodexProvider } from '../providers/codex.js';
import { MockProvider } from '../providers/mock.js';
import { PiProvider } from '../providers/pi.js';
import type { QueryInput } from '../providers/types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-neutral-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('every provider without a session-start hook says so', () => {
  // The boolean is what makes the fallback reachable. A provider that adds a
  // hook returns true here and stops paying for the system-prompt copy.
  it.each([
    ['codex', () => new CodexProvider()],
    ['pi', () => new PiProvider()],
  ])('%s returns false from registerMemorySessionHook', (_name, make) => {
    expect(make().registerMemorySessionHook(MEMORY_SESSION_HOOK)).toBe(false);
  });

  // The other side of the branch: Claude has a hook, so it must report true or
  // it would start paying for a redundant system-prompt copy.
  it('claude returns true, and wires the hook it claims to have', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
    try {
      // Through the contract helper, as index.ts does: the settings.json WRITE is
      // the contract's `lifecycle.memorySessionHookRegistration`, so calling the
      // provider method directly registers the hook but writes no file.
      const provider = createProvider('claude', {});
      expect(registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8'));
      expect(JSON.stringify(settings.hooks.SessionStart)).toContain(MEMORY_SESSION_HOOK.command);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('memoryContextForSystemPrompt', () => {
  it('carries both always-loaded files once the tree is scaffolded', () => {
    ensureMemoryScaffold(tmp);
    fs.writeFileSync(path.join(tmp, 'memory', 'index.md'), '# Memory Index\n\nCore fact: the sky is blue.\n');

    const section = memoryContextForSystemPrompt(tmp);

    expect(section).toContain('## Memory');
    expect(section).toContain('Core fact: the sky is blue.');
    expect(section).toContain('Open Knowledge Format');
  });

  // A heading promising two files that do not exist is worse than no heading.
  it('returns undefined when no memory tree exists', () => {
    expect(memoryContextForSystemPrompt(tmp)).toBeUndefined();
  });

  // The hook re-reads the files for every new context window. The system-prompt
  // copy is rebuilt per fresh query but reused by follow-ups pushed into an open
  // one, so it must not repeat the hook's refresh promise — it tells the agent to
  // re-read from disk instead.
  it('does not claim the hook refresh schedule it cannot keep', () => {
    ensureMemoryScaffold(tmp);

    // The delivery line is the section's own prose, above the `- path` list. The
    // quoted definition body further down discusses the schedule too, and that
    // text belongs to the template, not to this section.
    const deliveryLine = (section: string) => section.split('\n- `')[0];

    expect(deliveryLine(memoryContextForSystemPrompt(tmp)!)).toContain('re-read it from disk');
    expect(deliveryLine(memoryContextForSystemPrompt(tmp)!)).not.toContain('after compaction');
    expect(deliveryLine(renderMemorySection(tmp))).toContain('loaded at startup, after clear, and after compaction');
  });
});

describe('appendMemorySection', () => {
  it('appends the section to the addendum', () => {
    expect(appendMemorySection('## Sending messages', '## Memory')).toBe('## Sending messages\n\n## Memory');
  });

  it('leaves the addendum untouched when there is no section (the Claude path)', () => {
    expect(appendMemorySection('## Sending messages', undefined)).toBe('## Sending messages');
  });
});

/**
 * What the provider actually receives. `makeDestinationsRefresher` runs once
 * before the very first query, so anything it drops is never sent at all — these
 * assert on the string that reaches `query()`, not on how the runner spells it.
 */
describe('what reaches the provider', () => {
  class CapturingProvider extends MockProvider {
    received: (string | undefined)[] = [];
    query(input: QueryInput) {
      this.received.push(input.systemContext?.instructions);
      return super.query(input);
    }
  }

  function seedDestination(): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('peer', 'Peer', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();
  }

  function insertMessage(id: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 't1', ?)`,
      )
      .run(id, JSON.stringify({ sender: 'Alice', text: 'hi' }));
  }

  async function runOnce(provider: CapturingProvider, rebuild: () => string): Promise<void> {
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
      activePollIntervalMs: 10,
      systemContext: { instructions: rebuild(), rebuild },
    });
    loop.catch(() => {});
    const deadline = Date.now() + 2000;
    while (provider.received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    controller.abort();
    await loop.catch(() => {});
  }

  beforeEach(() => {
    initTestSessionDb();
    seedDestination();
    ensureMemoryScaffold(tmp);
    fs.writeFileSync(path.join(tmp, 'memory', 'index.md'), '# Memory Index\n\nCore fact: the sky is blue.\n');
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('carries memory into the first query for a hookless provider', async () => {
    const provider = new CapturingProvider();
    insertMessage('m1');

    await runOnce(provider, () =>
      appendMemorySection(buildSystemPromptAddendum('Pixel'), memoryContextForSystemPrompt(tmp)),
    );

    expect(provider.received[0]).toContain('Core fact: the sky is blue.');
  });

  // The refresher used to rebuild with a bare buildSystemPromptAddendum(), which
  // silently dropped the assistant name, the task-vs-chat rules, and memory.
  it('keeps the assistant name and task rules the runner passed in', async () => {
    const provider = new CapturingProvider();
    insertMessage('m1');

    await runOnce(provider, () => buildSystemPromptAddendum('Pixel', { kind: 'task', taskId: 'daily-brief' }));

    expect(provider.received[0]).toContain('You are Pixel');
    expect(provider.received[0]).toContain('isolated task run');
  });

  // A boot-time snapshot would pin the agent's memory for the container's whole
  // life. The rebuild re-reads, so an edit lands in the next fresh query.
  it('re-reads memory rather than serving a boot-time copy', async () => {
    const rebuild = () => appendMemorySection(buildSystemPromptAddendum(), memoryContextForSystemPrompt(tmp));
    const first = rebuild();

    fs.writeFileSync(path.join(tmp, 'memory', 'index.md'), '# Memory Index\n\nCore fact: the sky is green.\n');

    const provider = new CapturingProvider();
    insertMessage('m1');
    await runOnce(provider, rebuild);

    expect(first).toContain('sky is blue');
    expect(provider.received[0]).toContain('sky is green');
    expect(provider.received[0]).not.toContain('sky is blue');
  });
});
