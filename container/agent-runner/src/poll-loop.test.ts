import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import {
  checkCritiqueGate,
  checkRoutingGate,
  classifyThrownBounce,
  dispatchResultText,
  isCorruptionError,
  isNewSessionBatch,
  processQuery,
  resolveInReplyToOverride,
  taskOptsOutOfNewSession,
} from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('resolveInReplyToOverride (D2: seq-as-id in the <message> fan-out path)', () => {
  function seedInbound(seq: number, id: string) {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content)
         VALUES (?, ?, 'chat', datetime('now'), 'pending', 'agent', ?)`,
      )
      .run(id, seq, JSON.stringify({ text: 'hi' }));
  }

  it('resolves a quoted seq to the canonical inbound id (the D2 fix)', () => {
    seedInbound(101, 'a2a-1780819905710-m1ompa');
    // Formatter shows id="101"; the agent quotes 101 in <message in_reply_to="101">.
    expect(resolveInReplyToOverride('101')).toBe('a2a-1780819905710-m1ompa');
  });

  it('returns undefined for a numeric seq with no matching inbound row (fall back to routing value, never a bare seq)', () => {
    expect(resolveInReplyToOverride('999999')).toBeUndefined();
  });

  it('returns undefined when there is no override (caller ?? chain falls through)', () => {
    expect(resolveInReplyToOverride(undefined)).toBeUndefined();
  });

  it('passes a non-numeric canonical id through unchanged', () => {
    expect(resolveInReplyToOverride('a2a-1783491341639-1zzezh')).toBe('a2a-1783491341639-1zzezh');
  });

  it('numeric-but-invalid seqs (<=0) fall back rather than persist a bad value', () => {
    expect(resolveInReplyToOverride('0')).toBeUndefined();
    expect(resolveInReplyToOverride('-5')).toBeUndefined();
  });
});

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('sidecar correlation rows never starve the poll window (seq-starvation regression)', () => {
  // Seed a row with an explicit seq so we can reproduce the burial ordering.
  function insertSeq(
    seq: number,
    id: string,
    kind: string,
    content: object,
    opts?: { processAfter?: string; trigger?: 0 | 1 },
  ) {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, trigger, on_wake, content)
         VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, 0, ?)`,
      )
      .run(id, seq, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, JSON.stringify(content));
  }

  it('a low-seq task is returned despite many higher-seq orphaned cli_response rows', () => {
    // The bug: getPendingMessages did `ORDER BY seq DESC LIMIT 10` BEFORE the
    // caller filtered kind==='system'. Orphaned cli_response rows (process_after
    // NULL = always due) piled up at high seq and filled the 10-row window, so a
    // real scheduled task at a lower seq was never fetched → never fired → its
    // recurrence froze. Here: 1 task at seq 1, then 20 sidecar rows at seq 100+.
    insertSeq(1, 'task-buried', 'task', { prompt: 'daily wiki synth' }, { processAfter: '2000-01-01T00:00:00.000Z' });
    for (let i = 0; i < 20; i++) {
      insertSeq(100 + i, `cli-resp-${i}`, 'system', { type: 'cli_response', requestId: `cli-${i}`, frame: {} });
    }
    const messages = getPendingMessages();
    const ids = messages.map((m) => m.id);
    // The task must be present even though 20 higher-seq sidecar rows exist.
    expect(ids).toContain('task-buried');
    // And no sidecar rows leak into the poll result at all.
    expect(ids.some((id) => id.startsWith('cli-resp-'))).toBe(false);
  });

  it('question_response sidecar rows are also excluded from the window', () => {
    insertSeq(1, 'task-buried', 'task', { prompt: 'x' }, { processAfter: '2000-01-01T00:00:00.000Z' });
    for (let i = 0; i < 20; i++) {
      insertSeq(100 + i, `qr-${i}`, 'system', { type: 'question_response', questionId: `q-${i}`, selectedOption: 'a' });
    }
    const ids = getPendingMessages().map((m) => m.id);
    expect(ids).toContain('task-buried');
    expect(ids.some((id) => id.startsWith('qr-'))).toBe(false);
  });

  it('agent-facing system rows (action=*, e.g. register_group) are STILL returned', () => {
    // Only the sidecar `type` handshakes are excluded; system rows the agent is
    // meant to see (create_agent / register_group results, keyed on `action`)
    // must keep flowing to the formatter as <system_response>.
    insertSeq(1, 'sys-facing', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const ids = getPendingMessages().map((m) => m.id);
    expect(ids).toContain('sys-facing');
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('dispatchResultText auto-route gate', () => {
  // L1's job is to feed L2 a well-formed outbound row. These pin that
  // contract: agent channel emits with platformId=source-group; system
  // channel emits nothing. Same-session protection is exercised in the
  // host agent-route tests.

  it('agent channel: plain text auto-routes back to source platformId', async () => {
    await dispatchResultText('Verdict: approve_with_nits.', {
      platformId: 'ag-nanoclaw',
      channelType: 'agent',
      threadId: 'review-thread-1',
      inReplyTo: 'in-msg-1',
    });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-nanoclaw');
    expect(out[0].thread_id).toBe('review-thread-1');
    expect(out[0].in_reply_to).toBe('in-msg-1');
    expect(JSON.parse(out[0].content).text).toBe('Verdict: approve_with_nits.');
  });

  it('system channel: plain text is NOT auto-routed (scratchpad only)', async () => {
    await dispatchResultText('Saved learning.', {
      platformId: null,
      channelType: 'system',
      threadId: null,
      inReplyTo: 'sys-msg-1',
    });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(0);
  });
});

describe('dispatchResultText <message> attribute parsing', () => {
  // The chain primitive lets agents emit <message to="X" thread_id="Y"
  // in_reply_to="Z">...</message> blocks. Earlier the regex only accepted
  // exactly `to=`, so any extra attribute pushed the entire markup to the
  // scratchpad path and the agent's output got dumped on the source
  // channel as raw text. These tests pin the new behavior:
  //   1. Bare `to=` keeps working (backward compat)
  //   2. thread_id / in_reply_to overrides win over destRouting fallback
  //   3. Unknown attributes are tolerated and ignored
  function addDestination(name: string) {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'agent', NULL, NULL, ?)`,
      )
      .run(name, name, `ag-${name}`);
  }

  const sourceRouting = {
    platformId: 'ag-source',
    channelType: 'agent',
    threadId: 'src-thread',
    inReplyTo: 'src-msg',
  };

  it('bare <message to="X">…</message> still routes (backward compat)', async () => {
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer">hello</message>', sourceRouting);
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('ag-peer');
    expect(out[0].thread_id).toBe(null); // no agent-supplied thread_id, no destRouting history
    expect(JSON.parse(out[0].content).text).toBe('hello');
  });

  it('thread_id="X" overrides destRouting fallback', async () => {
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer" thread_id="branch-A">hello</message>', sourceRouting);
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out[0].thread_id).toBe('branch-A');
  });

  it('in_reply_to="X" overrides destRouting fallback', async () => {
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" in_reply_to="parent-msg-42">hello</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out[0].in_reply_to).toBe('parent-msg-42');
  });

  it('thread_id + in_reply_to + body all work together', async () => {
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" thread_id="thr-1" in_reply_to="m-7">payload</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out[0].thread_id).toBe('thr-1');
    expect(out[0].in_reply_to).toBe('m-7');
    expect(JSON.parse(out[0].content).text).toBe('payload');
  });

  it('unknown attributes are tolerated and ignored', async () => {
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" thread_id="T" foo="bar" priority="high">body</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out[0].thread_id).toBe('T'); // known attr still applied
    expect(JSON.parse(out[0].content).text).toBe('body');
  });

  it('two <message> blocks with different thread_ids route independently', async () => {
    addDestination('peer-a');
    addDestination('peer-b');
    const result = await dispatchResultText(
      '<message to="peer-a" thread_id="ta">A</message>\n<message to="peer-b" thread_id="tb">B</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(2);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const byDest = Object.fromEntries(out.map((r) => [r.platform_id, r]));
    expect(byDest['ag-peer-a'].thread_id).toBe('ta');
    expect(byDest['ag-peer-b'].thread_id).toBe('tb');
  });

  it('dangling <message to="X"> with no closing tag refuses delivery (triggers nudge)', async () => {
    // A May 2026 incident: slang-fixer emitted `<message to="slang-reviewer">[Review Resume]…`
    // but never wrote `</message>`. The MESSAGE_RE skipped the block, the
    // single-destination/auto-route fallback dumped the entire half-finished
    // markup onto the inbound dashboard channel, and the intended peer
    // (slang-reviewer) never saw it. The fix: treat dangling-open as
    // undelivered so the existing nudge fires and the agent re-sends.
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer">half a message with no close tag and lots of body text',
      sourceRouting,
    );
    expect(result.sent).toBe(0);
    expect(result.hasUnwrapped).toBe(true);
    expect(result.danglingOpen).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('dangling open does NOT trip when block is properly closed', async () => {
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer">complete block</message>', sourceRouting);
    expect(result.sent).toBe(1);
    expect(result.danglingOpen).toBeFalsy();
  });

  it('dangling open with thread_id attribute still refuses', async () => {
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer" thread_id="T">unfinished', sourceRouting);
    expect(result.sent).toBe(0);
    expect(result.danglingOpen).toBe(true);
  });

  it('one closed + one dangling: closed dispatches; nudge does NOT fire (would double-deliver)', async () => {
    // If we nudged here, the agent would re-emit the full response and the
    // already-delivered first block would land twice. Better: log the
    // dangling tail, let the workflow's "close every chain" rule recover.
    addDestination('peer-a');
    addDestination('peer-b');
    const result = await dispatchResultText(
      '<message to="peer-a">first</message>\n<message to="peer-b">second, never closed',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    expect(result.danglingOpen).toBe(true);
    expect(result.hasUnwrapped).toBe(false); // sent>0 — nudge gated off
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('ag-peer-a');
    expect(JSON.parse(out[0].content).text).toBe('first');
  });

  it('unknown destination drops the block, preserves attribute parsing path', async () => {
    // Unknown name → block goes to scratchpad. With agent-channel source
    // routing, the scratchpad-fallback then auto-routes the dropped text
    // back to the source. We verify the chain-attribute parser didn't
    // crash on the unknown name (regression: the old code didn't even
    // recognize the block as a <message> tag because of the regex bug).
    const result = await dispatchResultText('<message to="nonexistent" thread_id="T">body</message>', sourceRouting);
    // sent=1 from the scratchpad auto-route fallback (existing behavior),
    // not from a successful dispatch. The dropped block's body is in
    // the scratchpad payload routed back to source.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('ag-source');
    expect(JSON.parse(out[0].content).text).toContain('[dropped: unknown destination "nonexistent"]');
    expect(result.sent).toBe(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(3);
    expect(typed[0].type).toBe('init');
    // The mock streams text before the result repeats it.
    expect(typed[1].type).toBe('text');
    expect(typed[2].type).toBe('result');
    expect((typed[2] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        await writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('a2a transient bounce (Part a — do not ack a bounced handoff)', () => {
  // A hand-rolled query that yields a single isError result with the given
  // text, then ends — the minimal driver for processQuery's result branch.
  function erroringQuery(text: string): AgentQuery {
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 'mock-session-err' } as ProviderEvent;
        yield { type: 'result', text, isError: true } as ProviderEvent;
      },
    };
    return { push() {}, end() {}, abort() {}, events };
  }

  const a2aRouting = {
    platformId: 'ag-source-group',
    channelType: 'agent' as const,
    threadId: 'gh-issue-o/r-12097',
    inReplyTo: undefined,
  };

  function ackStatus(id: string): string | undefined {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status;
  }

  it('marks a transient-auth a2a error bounced-transient, NOT completed', async () => {
    insertMessage('h1', 'chat', { text: '[Triage handoff] …' });
    const result = await processQuery(erroringQuery('Not logged in · Please run /login'), a2aRouting, ['h1'], 'mock');
    expect(ackStatus('h1')).toBe('bounced-transient');
    expect(result.bouncedIds).toContain('h1');
    // The trigger row is still visible as pending work (not consumed) …
    // getPendingMessages filters out ANY acked id, so the redrive path relies on
    // the HOST clearing the bounce ack — here we just assert the ack value.
    // And no auth-error notice was delivered to the peer.
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('marks a novel a2a error bounced-unknown', async () => {
    insertMessage('h2', 'chat', { text: '[handoff]' });
    const result = await processQuery(
      erroringQuery('Error: something totally novel happened'),
      a2aRouting,
      ['h2'],
      'mock',
    );
    expect(ackStatus('h2')).toBe('bounced-unknown');
    expect(result.bouncedIds).toContain('h2');
  });

  it('does NOT bounce a permanent (403 billing) a2a error — delivers as today', async () => {
    insertMessage('h3', 'chat', { text: '[handoff]' });
    const result = await processQuery(
      erroringQuery('Error: 403 billing_error: credit balance too low'),
      a2aRouting,
      ['h3'],
      'mock',
    );
    expect(ackStatus('h3')).toBe('completed');
    expect(result.bouncedIds ?? []).not.toContain('h3');
    // Permanent error IS surfaced to the peer (unchanged deliverErrorResult path).
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('does NOT bounce a transient error on a NON-a2a channel', async () => {
    insertMessage('h4', 'chat', { text: 'user asked something' });
    const result = await processQuery(
      erroringQuery('Not logged in · Please run /login'),
      { platformId: 'chan-1', channelType: 'discord', threadId: 't', inReplyTo: undefined },
      ['h4'],
      'mock',
    );
    expect(ackStatus('h4')).toBe('completed');
    expect(result.bouncedIds ?? []).not.toContain('h4');
    expect(getUndeliveredMessages()).toHaveLength(1); // error delivered to user
  });

  it('a successful a2a turn still completes normally', async () => {
    insertMessage('h5', 'chat', { text: '[handoff]' });
    const okQuery: AgentQuery = {
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'init', continuation: 'ok' } as ProviderEvent;
          yield { type: 'result', text: '<message to="peer">done</message>' } as ProviderEvent;
        },
      },
    };
    const result = await processQuery(okQuery, a2aRouting, ['h5'], 'mock');
    expect(ackStatus('h5')).toBe('completed');
    expect(result.bouncedIds ?? []).toHaveLength(0);
  });
});

describe('a2a transient bounce (Part a2 — THROWN error path, #12108)', () => {
  // The structured-isError bounce above only fires when a result event is
  // YIELDED. A transport death (stream errors mid-read) is THROWN and lands in
  // runPollLoop's outer catch instead. classifyThrownBounce is the pure
  // decision that catch uses, so it carries the same guarantees, unit-tested
  // here without driving the full loop.

  it('bounces the #12108 connection-closed transport death as transient', () => {
    // The exact string from the Jul-16 slang-12108 drop.
    expect(
      classifyThrownBounce(
        'agent',
        'Error: Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete.',
      ),
    ).toBe('bounced-transient');
  });

  it('bounces ECONNRESET / socket-closed transport deaths as transient', () => {
    expect(classifyThrownBounce('agent', 'Error: API Error: Unable to connect to API (ECONNRESET)')).toBe(
      'bounced-transient',
    );
    expect(classifyThrownBounce('agent', 'Error: API Error: The socket connection was closed unexpectedly')).toBe(
      'bounced-transient',
    );
  });

  it('bounces a known auth transient (parity with the structured path) as transient', () => {
    expect(classifyThrownBounce('agent', 'Error: Not logged in · Please run /login')).toBe('bounced-transient');
  });

  it('does NOT bounce a novel/unknown thrown error — may be a local post-delivery throw', () => {
    // Unlike the structured-isError branch (gated on event.isError === true,
    // which proves a provider turn failure), a thrown error has no proof it
    // came from the provider vs. a local runner exception AFTER partial
    // delivery. Bouncing an unknown throw could redrive + duplicate already-
    // sent peer messages, so the thrown path only bounces POSITIVELY-recognized
    // transient shapes. A novel throw falls through to relay + complete.
    expect(classifyThrownBounce('agent', 'Error: something totally novel happened')).toBeNull();
  });

  it('does NOT bounce a permanent (403 billing) thrown error — relay + complete as today', () => {
    expect(classifyThrownBounce('agent', 'Error: 403 billing_error: credit balance too low')).toBeNull();
  });

  it('does NOT bounce a transient thrown error on a NON-a2a channel', () => {
    expect(classifyThrownBounce('discord', 'Error: API Error: Connection closed mid-response.')).toBeNull();
    expect(classifyThrownBounce('dashboard', 'Error: Not logged in · Please run /login')).toBeNull();
  });
});

describe('new_session predicate (default-on: opt-out via new_session:false)', () => {
  // Post-default-on (PR #107): fresh session is the default for recurring
  // task batches. Only explicit `new_session: false` opts out. The shared
  // predicates (used by both the initial-batch gate and the mid-query
  // follow-up guard) pin the inverted semantics.

  const task = (content: object) => ({ kind: 'task', content: JSON.stringify(content) });
  const chat = (content: object) => ({ kind: 'chat', content: JSON.stringify(content) });

  it('taskOptsOutOfNewSession — true only for task kind with explicit new_session:false', () => {
    expect(taskOptsOutOfNewSession(task({ prompt: 'x', new_session: false }))).toBe(true);
    expect(taskOptsOutOfNewSession(task({ prompt: 'x' }))).toBe(false); // absent = default (not opt-out)
    expect(taskOptsOutOfNewSession(task({ prompt: 'x', new_session: true }))).toBe(false);
    expect(taskOptsOutOfNewSession(chat({ text: 'hi', new_session: false }))).toBe(false); // chat never participates
  });

  it('taskOptsOutOfNewSession — swallows malformed JSON instead of throwing', () => {
    expect(taskOptsOutOfNewSession({ kind: 'task', content: 'not-json' })).toBe(false);
    expect(taskOptsOutOfNewSession({ kind: 'task', content: '' })).toBe(false);
  });

  it('isNewSessionBatch — TRUE when every message is a task and none opts out (default-on)', () => {
    expect(isNewSessionBatch([task({ prompt: 'a' })])).toBe(true); // absent = default on
    expect(isNewSessionBatch([task({ prompt: 'a', new_session: true })])).toBe(true); // explicit true
    expect(isNewSessionBatch([task({ prompt: 'a' }), task({ prompt: 'b', new_session: true })])).toBe(true);
  });

  it('isNewSessionBatch — FALSE when any task opts out', () => {
    expect(isNewSessionBatch([task({ prompt: 'a', new_session: false })])).toBe(false);
    expect(isNewSessionBatch([task({ prompt: 'a' }), task({ prompt: 'b', new_session: false })])).toBe(false); // one opt-out blocks whole batch
  });

  it('isNewSessionBatch — FALSE on mixed batches (chat present preserves history)', () => {
    expect(isNewSessionBatch([chat({ text: 'hi' }), task({ prompt: 'a' })])).toBe(false);
    expect(isNewSessionBatch([chat({ text: 'hi' }), task({ prompt: 'a', new_session: true })])).toBe(false);
  });

  it('isNewSessionBatch — FALSE on empty batch (defensive: no spurious fresh sessions)', () => {
    expect(isNewSessionBatch([])).toBe(false);
  });
});

describe('checkCritiqueGate — text-output delivery-marker enforcement (#67)', () => {
  // The bash hook (gate-critique-on-deliver.sh) catches send_message and
  // gh-pr-create paths. This in-process check covers the text-output
  // <message to=>...</message> path that bypasses the bash hook entirely.
  // Logic must mirror the hook: same MARKER file, same workflow-state.json,
  // same delivery-marker regex.

  let tmp: string;
  let markerPath: string;
  let statePath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'critique-gate-test-'));
    markerPath = path.join(tmp, 'overlay-critique-gate');
    statePath = path.join(tmp, 'workflow-state.json');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('marker absent → not blocked (overlay opt-out)', () => {
    const r = checkCritiqueGate('[Resolution] something', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(false);
  });

  it('CRITIQUE_GATE_ACTIVE env gates without a marker file (default path mode)', () => {
    const saved = process.env.CRITIQUE_GATE_ACTIVE;
    const savedOverlay = process.env.CRITIQUE_GATE_OVERLAY_PATH;
    const savedState = process.env.CRITIQUE_GATE_STATE_PATH;
    process.env.CRITIQUE_GATE_ACTIVE = '1';
    // Point defaults at a nonexistent marker + empty state so only env drives it.
    process.env.CRITIQUE_GATE_OVERLAY_PATH = path.join(tmp, 'nonexistent-marker');
    process.env.CRITIQUE_GATE_STATE_PATH = path.join(tmp, 'nostate.json');
    try {
      // No opts → env-authoritative activation path.
      const r = checkCritiqueGate('[Resolution] x');
      expect(r.blocked).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CRITIQUE_GATE_ACTIVE;
      else process.env.CRITIQUE_GATE_ACTIVE = saved;
      if (savedOverlay === undefined) delete process.env.CRITIQUE_GATE_OVERLAY_PATH;
      else process.env.CRITIQUE_GATE_OVERLAY_PATH = savedOverlay;
      if (savedState === undefined) delete process.env.CRITIQUE_GATE_STATE_PATH;
      else process.env.CRITIQUE_GATE_STATE_PATH = savedState;
    }
  });

  it('marker present + no delivery marker in body → not blocked', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    const r = checkCritiqueGate('Just a chat response, no delivery marker.', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(false);
  });

  it('mid-sentence MENTION of a marker is not a delivery (anchored match)', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const r = checkCritiqueGate('I will send the [Resolution] once codex approves.', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(false);
  });

  it('marker at the start of a later line still gates', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const r = checkCritiqueGate('Summary first.\n[Resolution] PR #9 fixed', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(true);
  });

  it('a configured extra marker (.critique-delivery-markers) gates like a built-in', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const vocabPath = path.join(tmp, 'delivery-markers.json');
    fs.writeFileSync(vocabPath, JSON.stringify({ message_markers: ['Weekly Report'] }));
    const r = checkCritiqueGate('[Weekly Report] all green', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
      deliveryMarkersPath: vocabPath,
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('Weekly Report');
  });

  it('sanitizes regex metacharacters out of configured markers', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const vocabPath = path.join(tmp, 'delivery-markers.json');
    fs.writeFileSync(vocabPath, JSON.stringify({ message_markers: ['.*'] }));
    const r = checkCritiqueGate('[anything] not a marker', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
      deliveryMarkersPath: vocabPath,
    });
    expect(r.blocked).toBe(false);
  });

  it('marker present + [Resolution] + critique_rounds=0 → BLOCKED', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const r = checkCritiqueGate('[Resolution] all done', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('critique_rounds=0');
    expect(r.reason).toContain('Resolution');
  });

  it('marker present + [Resolution] + missing state file → BLOCKED (treats as 0)', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    const r = checkCritiqueGate('[Resolution] all done', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(true);
  });

  it('marker present + [Resolution] + critique_rounds=1 → not blocked', () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 1 }));
    const r = checkCritiqueGate('[Resolution] all done', {
      overlayMarkerPath: markerPath,
      workflowStatePath: statePath,
    });
    expect(r.blocked).toBe(false);
  });

  it.each(['Resolution', 'handoff'])('recognizes [%s] as a delivery marker', (marker) => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const r = checkCritiqueGate(`[${marker}] body`, { overlayMarkerPath: markerPath, workflowStatePath: statePath });
    expect(r.blocked).toBe(true);
  });
});

describe('checkCritiqueGate — required stages + verdict parity with the bash hook', () => {
  // Before this parity the text-output path enforced only critique_rounds>=1,
  // so a must-fix OUTPUT_REVIEW could ship via plain <message> emission while
  // the tool path (gate-critique-on-deliver.sh) denied it.
  let tmp: string;
  let markerPath: string;
  let statePath: string;
  let requiredPath: string;
  let savedStrict: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'critique-parity-test-'));
    markerPath = path.join(tmp, '.overlay-critique-gate');
    statePath = path.join(tmp, 'workflow-state.json');
    requiredPath = path.join(tmp, '.critique-required-stages');
    fs.writeFileSync(markerPath, 'critique-gate\n');
    savedStrict = process.env.CRITIQUE_VERDICT_STRICT;
    delete process.env.CRITIQUE_VERDICT_STRICT;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedStrict === undefined) delete process.env.CRITIQUE_VERDICT_STRICT;
    else process.env.CRITIQUE_VERDICT_STRICT = savedStrict;
  });

  function gate(body = '[Resolution] done') {
    return checkCritiqueGate(body, { overlayMarkerPath: markerPath, workflowStatePath: statePath });
  }

  it('denies when a required stage has not run (rounds alone are not enough)', () => {
    fs.writeFileSync(requiredPath, JSON.stringify(['PLAN_REVIEW', 'CODE_REVIEW', 'OUTPUT_REVIEW']));
    fs.writeFileSync(
      statePath,
      JSON.stringify({ critique_rounds: 2, critique_stages: { PLAN_REVIEW: 1, CODE_REVIEW: 1 } }),
    );
    const r = gate();
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('OUTPUT_REVIEW');
    expect(r.reason).toContain('missing');
  });

  it('denies when OUTPUT_REVIEW last verdict is must-fix', () => {
    fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        critique_rounds: 1,
        critique_stages: { OUTPUT_REVIEW: 1 },
        critique_verdicts: { OUTPUT_REVIEW: 'must-fix' },
      }),
    );
    const r = gate();
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('must-fix');
  });

  it('passes when all stages ran and OUTPUT_REVIEW verdict is approve', () => {
    fs.writeFileSync(requiredPath, JSON.stringify(['PLAN_REVIEW', 'CODE_REVIEW', 'OUTPUT_REVIEW']));
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        critique_rounds: 3,
        critique_stages: { PLAN_REVIEW: 1, CODE_REVIEW: 1, OUTPUT_REVIEW: 1 },
        critique_verdicts: { PLAN_REVIEW: 'approve', CODE_REVIEW: 'approve', OUTPUT_REVIEW: 'approve' },
      }),
    );
    expect(gate().blocked).toBe(false);
  });

  it('fails closed when OUTPUT_REVIEW is required but no verdict was recorded', () => {
    fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 1, critique_stages: { OUTPUT_REVIEW: 1 } }));
    const r = gate();
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('no verdict was recorded');
  });

  it('blocks delivery when edits happened after the last critique (stale approve)', () => {
    fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        critique_rounds: 1,
        critique_stages: { OUTPUT_REVIEW: 1 },
        critique_verdicts: { OUTPUT_REVIEW: 'approve' },
        edits_since_critique: 3,
      }),
    );
    const r = gate();
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('edit(s) recorded since the last critique');
  });

  it('CRITIQUE_FRESHNESS=0 disables the staleness check', () => {
    const saved = process.env.CRITIQUE_FRESHNESS;
    process.env.CRITIQUE_FRESHNESS = '0';
    try {
      fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          critique_rounds: 1,
          critique_stages: { OUTPUT_REVIEW: 1 },
          critique_verdicts: { OUTPUT_REVIEW: 'approve' },
          edits_since_critique: 3,
        }),
      );
      expect(gate().blocked).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CRITIQUE_FRESHNESS;
      else process.env.CRITIQUE_FRESHNESS = saved;
    }
  });

  it('blocks delivery when an attested artifact changed after the approve', () => {
    const savedRoot = process.env.CRITIQUE_ATTEST_ROOT;
    process.env.CRITIQUE_ATTEST_ROOT = tmp;
    try {
      const crypto = require('crypto') as typeof import('crypto');
      const artifact = path.join(tmp, 'report.md');
      fs.writeFileSync(artifact, 'reviewed content\n');
      const goodHash = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
      fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          critique_rounds: 1,
          critique_stages: { OUTPUT_REVIEW: 1 },
          critique_verdicts: { OUTPUT_REVIEW: 'approve' },
          critique_attested: { OUTPUT_REVIEW: { [artifact]: goodHash } },
        }),
      );
      expect(gate().blocked).toBe(false); // matching hash → ships
      fs.appendFileSync(artifact, 'sneaky post-review edit\n');
      const blocked = gate();
      expect(blocked.blocked).toBe(true);
      expect(blocked.reason).toContain('reviewed artifacts changed');
    } finally {
      if (savedRoot === undefined) delete process.env.CRITIQUE_ATTEST_ROOT;
      else process.env.CRITIQUE_ATTEST_ROOT = savedRoot;
    }
  });

  it('CRITIQUE_VERDICT_STRICT=0 restores the count-only fallthrough', () => {
    process.env.CRITIQUE_VERDICT_STRICT = '0';
    fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 1, critique_stages: { OUTPUT_REVIEW: 1 } }));
    expect(gate().blocked).toBe(false);
  });

  it('keeps the legacy any-1-round check when no required-stages file exists', () => {
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 1 }));
    expect(gate().blocked).toBe(false);
  });

  it('empty required-stages list falls back to the legacy round check', () => {
    fs.writeFileSync(requiredPath, JSON.stringify([]));
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    const r = gate();
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('critique_rounds=0');
  });

  it('at the denial cap, escalates to human approval instead of failing open', () => {
    fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        critique_rounds: 1,
        critique_stages: { OUTPUT_REVIEW: 1 },
        critique_verdicts: { OUTPUT_REVIEW: 'must-fix' },
      }),
    );
    expect(gate().blocked).toBe(true);
    expect(gate().blocked).toBe(true);
    expect(gate().blocked).toBe(true);
    const fourth = gate(); // cap: graduated escalation, still denied
    expect(fourth.blocked).toBe(true);
    expect(fourth.reason).toContain('bypass request has been sent');
    const esc = JSON.parse(fs.readFileSync(path.join(tmp, 'critique-escalation.json'), 'utf-8')) as {
      requested_at: number;
      reason: string;
    };
    expect(esc.requested_at).toBeGreaterThan(0);
    expect(esc.reason).toContain('must-fix');
  });

  // Parity with the bash hook. Until this change, THIS path — the one the
  // comment at the top of the describe calls out as bypassing the bash hook —
  // still honoured a bare `bypass_approved: true` with no expiry and no
  // consumption, and still failed open on a timeout, long after the hook had
  // both removed.
  const readState = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
  const readEsc = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(tmp, 'critique-escalation.json'), 'utf-8')) as Record<string, unknown>;
  const cappedState = (extra: Record<string, unknown> = {}): void => {
    fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        critique_rounds: 1,
        critique_stages: { OUTPUT_REVIEW: 1 },
        critique_verdicts: { OUTPUT_REVIEW: 'must-fix' },
        critique_gate_denials: 3,
        ...extra,
      }),
    );
  };

  it('a bypass with NO expiry is not an unlimited bypass — it is refused', () => {
    // Treating a missing expiry as "no expiry" would let a forged flag with no
    // expiry at all defeat the TTL entirely.
    cappedState({ critique_gate_bypass_approved: true });
    expect(gate().blocked).toBe(true);
    expect(readState().critique_gate_bypass_approved).toBe(false);
  });

  it('admin-approved bypass allows delivery ONCE, then consumes itself', () => {
    cappedState({
      critique_gate_bypass_approved: true,
      critique_gate_bypass_grant_id: 'appr-1',
      critique_gate_bypass_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(gate().blocked).toBe(false);
    // Spent: flag cleared, consumption attributed to the granting approval.
    expect(readState().critique_gate_bypass_approved).toBe(false);
    expect(readState().critique_gate_bypass_consumed_grant_id).toBe('appr-1');
    expect(readState().critique_gate_bypass_consumed_at).toBeGreaterThan(0);
    // The release is recorded where the host can see it (container is --rm'd).
    // No escalation file exists on this path, and the gate must not invent one
    // with `requested_at: 0` — that fabrication is read by the host as a
    // brand-new escalation and carded, while the real release goes unrecorded.
    // The append-only journal is the sink that survives the file being gone.
    expect(fs.existsSync(path.join(tmp, 'critique-escalation.json'))).toBe(false);
    const journal = fs
      .readFileSync(path.join(tmp, 'critique-releases.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(journal[0].grant_id).toBe('appr-1');
    expect(journal[0].why).toBe('admin bypass consumed (one-shot)');
    // A second delivery is denied — it is not a standing grant.
    expect(gate().blocked).toBe(true);
  });

  it('an EXPIRED bypass does not allow delivery', () => {
    cappedState({
      critique_gate_bypass_approved: true,
      critique_gate_bypass_expires_at: Math.floor(Date.now() / 1000) - 60,
    });
    expect(gate().blocked).toBe(true);
    expect(readState().critique_gate_bypass_approved).toBe(false);
  });

  it('admin-rejected bypass keeps denying the request it answered', () => {
    fs.writeFileSync(path.join(tmp, 'critique-escalation.json'), JSON.stringify({ requested_at: 5000, reason: 'x' }));
    cappedState({ critique_gate_bypass_rejected: true, critique_gate_bypass_rejected_request: 5000 });
    const r = gate();
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('REJECTED');
  });

  it('a rejection from an EARLIER escalation does not answer a new one', () => {
    fs.writeFileSync(path.join(tmp, 'critique-escalation.json'), JSON.stringify({ requested_at: 9999, reason: 'x' }));
    cappedState({ critique_gate_bypass_rejected: true, critique_gate_bypass_rejected_request: 5000 });
    const r = gate();
    expect(r.blocked).toBe(true); // enforcement still holds
    expect(r.reason).not.toContain('REJECTED'); // but as a live escalation
  });

  it('NEVER times out to fail-open — an old, undecided escalation stays denied', () => {
    // The enforcement regression test for this path: it previously allowed the
    // delivery once CRITIQUE_ESCALATION_TIMEOUT_SECS elapsed, so an agent could
    // satisfy the requirement by waiting.
    cappedState();
    fs.writeFileSync(
      path.join(tmp, 'critique-escalation.json'),
      JSON.stringify({ requested_at: Math.floor(Date.now() / 1000) - 86_400, reason: 'x' }),
    );
    expect(gate().blocked).toBe(true);
    expect(readEsc().failed_open_at).toBeUndefined();
  });

  it('CRITIQUE_ESCALATION=0 restores the legacy fail-open cap', () => {
    const saved = process.env.CRITIQUE_ESCALATION;
    process.env.CRITIQUE_ESCALATION = '0';
    try {
      fs.writeFileSync(requiredPath, JSON.stringify(['OUTPUT_REVIEW']));
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          critique_rounds: 1,
          critique_stages: { OUTPUT_REVIEW: 1 },
          critique_verdicts: { OUTPUT_REVIEW: 'must-fix' },
          critique_gate_denials: 3,
        }),
      );
      expect(gate().blocked).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CRITIQUE_ESCALATION;
      else process.env.CRITIQUE_ESCALATION = saved;
    }
  });
});

describe('dispatchResultText — chain-routing check (always on, not an overlay)', () => {
  let tmp: string;
  let statePath: string;
  let originalRoutingGateStatePath: string | undefined;

  function addDestination(name: string) {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'agent', NULL, NULL, ?)`,
      )
      .run(name, name, `ag-${name}`);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-dispatch-test-'));
    // Isolate the denial-counter state per test so the soft-cap doesn't leak
    // across cases (and so we never touch the real /workspace default).
    statePath = path.join(tmp, 'workflow-state.json');
    originalRoutingGateStatePath = process.env.ROUTING_GATE_STATE_PATH;
    process.env.ROUTING_GATE_STATE_PATH = statePath;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (originalRoutingGateStatePath === undefined) delete process.env.ROUTING_GATE_STATE_PATH;
    else process.env.ROUTING_GATE_STATE_PATH = originalRoutingGateStatePath;
  });

  const sourceRouting = {
    platformId: 'ag-source',
    channelType: 'agent',
    threadId: 'src-thread',
    inReplyTo: 'src-msg',
  };

  it('non-marker message passes through unchanged (self-scoping on the marker)', async () => {
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer">just a status update</message>', sourceRouting);
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(JSON.parse(out[0].content).text).toBe('just a status update');
  });

  it('marked handoff without in_reply_to is refused to the SENDER, not delivered to the peer', async () => {
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer">[Resolution] done</message>', sourceRouting);
    // Nothing reaches the peer — the gated body is withheld.
    expect(result.sent).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
    // The refusal is surfaced to the sender via gateRefusals.
    expect(result.gateRefusals).toHaveLength(1);
    const refusal = result.gateRefusals![0];
    expect(refusal).toContain('[chain-routing-gate] REFUSED');
    expect(refusal).toContain('in_reply_to');
    expect(refusal).not.toContain('[Resolution] done');
  });

  // The agent quotes the integer id the formatter showed (id="<seq>"). The
  // fan-out path resolves that seq to the canonical inbound id before it is
  // persisted (the D2 fix) — so seed the inbound row seq 42 points at.
  function seedQuotedInbound() {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content)
         VALUES ('a2a-parent-42', 42, 'chat', datetime('now'), 'pending', 'agent', '{}')`,
      )
      .run();
  }

  it('marked handoff with in_reply_to alone passes (thread_id derived)', async () => {
    // Canonical upstream report form from the workflows:
    // send_message(to="parent", in_reply_to=<id>, ...). thread_id is derived
    // by the runtime, so the check must NOT demand it.
    addDestination('peer');
    seedQuotedInbound();
    const result = await dispatchResultText(
      '<message to="peer" in_reply_to="42">[Resolution] done</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    // Persisted as the canonical id resolved from seq 42, never the raw seq.
    expect(out[0].in_reply_to).toBe('a2a-parent-42');
    expect(JSON.parse(out[0].content).text).toBe('[Resolution] done');
  });

  it('marked handoff with thread_id and in_reply_to passes', async () => {
    addDestination('peer');
    seedQuotedInbound();
    const result = await dispatchResultText(
      '<message to="peer" thread_id="t1" in_reply_to="42">[handoff] approved</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out[0].thread_id).toBe('t1');
    expect(out[0].in_reply_to).toBe('a2a-parent-42');
    expect(JSON.parse(out[0].content).text).toBe('[handoff] approved');
  });

  it('D2×D1 handoff: a seq-quoted cross-thread handoff persists the RESOLVED id with the stamped thread', async () => {
    // The container half of the D1/D2 interaction. The agent quotes id="88" (a
    // seq — D2) on a handoff stamped for thread "B" while the quoted inbound
    // lives on thread "C". The fan-out must (D2) resolve the seq to the
    // canonical id AND preserve the stamped thread — producing exactly the
    // (resolvable canonical id, divergent thread) tuple the host-side D1 guard
    // (resolveExplicitReplyTarget) is built to reject. Without D2 the raw seq
    // "88" would be persisted and the host's id lookup would miss entirely, so
    // D1 could never even evaluate it.
    addDestination('peer');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, thread_id, content)
         VALUES ('a2a-xthread-88', 88, 'chat', datetime('now'), 'pending', 'agent', 'C', '{}')`,
      )
      .run();
    const result = await dispatchResultText(
      '<message to="peer" thread_id="B" in_reply_to="88">[handoff] cross-thread</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out[0].in_reply_to).toBe('a2a-xthread-88'); // D2: seq → canonical id
    expect(out[0].thread_id).toBe('B'); // D1 input: stamped thread preserved (≠ inbound's "C")
  });

  it('checkRoutingGate enforces in_reply_to regardless of any marker file', () => {
    // No in_reply_to → blocked.
    expect(checkRoutingGate('[Resolution] x', {}, { workflowStatePath: statePath }).blocked).toBe(true);
    // in_reply_to alone → allowed (thread_id optional).
    expect(
      checkRoutingGate('[Resolution] x', { inReplyToOverride: '1' }, { workflowStatePath: statePath }).blocked,
    ).toBe(false);
    // thread_id alone (no in_reply_to) → still blocked: in_reply_to is the primitive.
    expect(
      checkRoutingGate('[Resolution] x', { threadIdOverride: 't1' }, { workflowStatePath: statePath }).blocked,
    ).toBe(true);
  });

  it('soft-cap re-arms after a properly-linked handoff (D4)', () => {
    const body = '[Resolution] done';
    const unlinked = () => checkRoutingGate(body, {}, { workflowStatePath: statePath }).blocked;
    // 3 unlinked handoffs are denied; the 4th yields (soft-cap reached).
    expect(unlinked()).toBe(true);
    expect(unlinked()).toBe(true);
    expect(unlinked()).toBe(true);
    expect(unlinked()).toBe(false); // capped → yields

    // A properly-linked handoff re-arms the cap.
    expect(checkRoutingGate(body, { inReplyToOverride: '42' }, { workflowStatePath: statePath }).blocked).toBe(false);

    // The gate enforces again — the next unlinked handoff is blocked, not yielded.
    expect(unlinked()).toBe(true);
  });

  it('checkRoutingGate unions a per-role delivery_markers extension', () => {
    // Step-2 part-1: routing must recognize the same per-role vocabulary the
    // critique gate does (via deliveryMarkerRe), so moving a marker to YAML
    // later won't regress routing.
    const vocab = path.join(tmp, 'routing-markers.json');
    fs.writeFileSync(vocab, JSON.stringify({ message_markers: ['Weekly Report'] }));
    // Extra marker, no in_reply_to → blocked.
    expect(
      checkRoutingGate('[Weekly Report] all green', {}, { workflowStatePath: statePath, deliveryMarkersPath: vocab })
        .blocked,
    ).toBe(true);
    // Same marker with in_reply_to → allowed.
    expect(
      checkRoutingGate(
        '[Weekly Report] all green',
        { inReplyToOverride: '9' },
        { workflowStatePath: statePath, deliveryMarkersPath: vocab },
      ).blocked,
    ).toBe(false);
    // A built-in marker still gates with the extension file present.
    expect(
      checkRoutingGate('[Resolution] x', {}, { workflowStatePath: statePath, deliveryMarkersPath: vocab }).blocked,
    ).toBe(true);
  });

  it('routing check soft-caps after 3 denials so it cannot thrash', () => {
    const call = () => checkRoutingGate('[Resolution] x', {}, { workflowStatePath: statePath }).blocked;
    expect(call()).toBe(true); // denial 1
    expect(call()).toBe(true); // denial 2
    expect(call()).toBe(true); // denial 3
    expect(call()).toBe(false); // soft-cap: yields
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { routing_gate_denials?: number };
    expect(persisted.routing_gate_denials).toBe(3);
  });
});

describe('dispatchResultText — critique-gate text-output integration (#67)', () => {
  let tmp: string;
  let markerPath: string;
  let statePath: string;
  let originalOverlayCheck: string | undefined;

  function addDestination(name: string) {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'agent', NULL, NULL, ?)`,
      )
      .run(name, name, `ag-${name}`);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'critique-dispatch-test-'));
    markerPath = path.join(tmp, '.overlay-critique-gate');
    statePath = path.join(tmp, 'workflow-state.json');
    // Override default paths via env so the in-process gate uses the
    // test temp dir instead of /workspace/agent and /workspace/.claude
    process.env.CRITIQUE_GATE_OVERLAY_PATH = markerPath;
    process.env.CRITIQUE_GATE_STATE_PATH = statePath;
    // These cases drive the gate through its MARKER-FILE mode. CRITIQUE_GATE_ACTIVE
    // is authoritative over the marker when set (checkCritiqueGate in poll-loop.ts),
    // so a value inherited from the surrounding agent container — which really does
    // export CRITIQUE_GATE_ACTIVE=0 — would short-circuit the gate to "not blocked"
    // and quietly turn every assertion here green-by-absence. Drop it for the
    // duration of the describe and restore it after.
    originalOverlayCheck = process.env.CRITIQUE_GATE_ACTIVE;
    delete process.env.CRITIQUE_GATE_ACTIVE;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CRITIQUE_GATE_OVERLAY_PATH;
    delete process.env.CRITIQUE_GATE_STATE_PATH;
    if (originalOverlayCheck === undefined) delete process.env.CRITIQUE_GATE_ACTIVE;
    else process.env.CRITIQUE_GATE_ACTIVE = originalOverlayCheck;
  });

  const sourceRouting = {
    platformId: 'ag-source',
    channelType: 'agent',
    threadId: 'src-thread',
    inReplyTo: 'src-msg',
  };

  it('marker absent → [Resolution] passes through unchanged (R1: no opt-in, no gating)', async () => {
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" in_reply_to="1">[Resolution] hello</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('[Resolution] hello');
  });

  it('marker present + critique_rounds=0 → [Resolution] refused to the SENDER, not delivered to the peer', async () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" in_reply_to="1">[Resolution] all done — please ship</message>',
      sourceRouting,
    );
    // Nothing reaches the peer.
    expect(result.sent).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
    // The refusal goes back to the sender.
    expect(result.gateRefusals).toHaveLength(1);
    const refusal = result.gateRefusals![0];
    expect(refusal).toContain('[critique-gate] REFUSED');
    expect(refusal).toContain('Resolution');
    expect(refusal).toContain('/codex-critique');
    expect(refusal).not.toContain('please ship'); // original body NOT delivered
  });

  it('marker present + critique_rounds=1 → original [Resolution] passes through (gate satisfied)', async () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 1 }));
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" in_reply_to="1">[Resolution] shipped</message>',
      sourceRouting,
    );
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(JSON.parse(out[0].content).text).toBe('[Resolution] shipped');
  });

  it('marker present + non-delivery body → passes through (only delivery markers are gated)', async () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    addDestination('peer');
    const result = await dispatchResultText('<message to="peer">just a regular reply</message>', sourceRouting);
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(JSON.parse(out[0].content).text).toBe('just a regular reply');
  });

  it('mixed batch: gated [Resolution] block is withheld + refused to sender, normal block still delivered', async () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    addDestination('peer-a');
    addDestination('peer-b');
    const result = await dispatchResultText(
      '<message to="peer-a" in_reply_to="1">[Resolution] blocked</message>\n<message to="peer-b">passes through</message>',
      sourceRouting,
    );
    // Only the non-gated block is delivered; peer-a receives nothing.
    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('ag-peer-b');
    expect(JSON.parse(out[0].content).text).toBe('passes through');
    // The gated block's refusal goes back to the sender.
    expect(result.gateRefusals).toHaveLength(1);
    expect(result.gateRefusals![0]).toContain('[critique-gate] REFUSED');
  });

  it('gated block (with thread_id/in_reply_to overrides) delivers nothing to the peer', async () => {
    fs.writeFileSync(markerPath, 'critique-gate\n');
    fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
    addDestination('peer');
    const result = await dispatchResultText(
      '<message to="peer" thread_id="branch-A" in_reply_to="1">[Resolution] body</message>',
      sourceRouting,
    );
    // No peer delivery regardless of the agent's chosen thread/reply overrides;
    // the refusal is sender-directed.
    expect(result.sent).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(result.gateRefusals).toHaveLength(1);
    expect(result.gateRefusals![0]).toContain('[critique-gate] REFUSED');
  });

  it('critique gate legacy soft-cap (CRITIQUE_ESCALATION=0) yields after 3 denials', () => {
    const saved = process.env.CRITIQUE_ESCALATION;
    process.env.CRITIQUE_ESCALATION = '0';
    try {
      fs.writeFileSync(markerPath, 'critique-gate\n');
      fs.writeFileSync(statePath, JSON.stringify({ critique_rounds: 0 }));
      const call = () =>
        checkCritiqueGate('[Resolution] x', { overlayMarkerPath: markerPath, workflowStatePath: statePath }).blocked;
      expect(call()).toBe(true); // denial 1
      expect(call()).toBe(true); // denial 2
      expect(call()).toBe(true); // denial 3
      expect(call()).toBe(false); // legacy soft-cap: yields instead of thrashing
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { critique_gate_denials?: number };
      expect(persisted.critique_gate_denials).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.CRITIQUE_ESCALATION;
      else process.env.CRITIQUE_ESCALATION = saved;
    }
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

it('does not push accumulated-only follow-ups into an active query', async () => {
  const pushes: string[] = [];

  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    insertMessage('m1', 'chat', { sender: 'A', text: 'context only' }, { trigger: 0 });
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  await processQuery(
    {
      push: (message) => pushes.push(message),
      end: () => {},
      events: events(),
      abort: () => {},
    },
    ERR_ROUTING,
    [],
    'claude',
    undefined,
    'prompt',
    undefined,
  );

  expect(pushes).toHaveLength(0);
  expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
});

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('auto-routes a plain unwrapped result to the triggering channel (fork keeps the auto-route gate)', async () => {
    // Fork divergence from upstream: a PLAIN unwrapped result (no <message>
    // markup at all) with a known routing channel is auto-routed there by the
    // dispatchResultText auto-route gate — it is NOT withheld+nudged. Upstream
    // nudges every unwrapped result; the fork delivers plain text and reserves
    // the nudge for dangling-open <message> tags (covered below + in the
    // exchange-hook integration test).
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('bare text, no envelope');
    expect(pushes).toHaveLength(0);
  });

  it('nudges (and does not deliver) a dangling-open <message> result', async () => {
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: '<message to="discord-test">half a message with no closing tag',
    });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

// --- Task-run turn wiring: the REAL processQuery path (one-door) ---
// These drive the actual call sites (autoAppendTaskLog at result-handling,
// shouldNudgeTaskBlocks gating, and follow-up turn reset). Deleting the wiring
// — not just the helpers — goes red here.

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq").all() as Array<{
      content: string;
    }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}

describe('task-run turn wiring (real processQuery)', () => {
  it('auto-appends the final text as a task_log row', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'checked feeds — nothing new' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const logs = taskLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe('checked feeds — nothing new');
    // and nothing was delivered as chat
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });

  it('logs and conditionally nudges a second task run in the same open query', async () => {
    const pushes: string[] = [];

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1 uses the legacy wrong door and consumes its one correction.
      yield { type: 'result', text: '<message to="local-cli">fire one result</message>' };
      yield { type: 'result', text: 'first delivery decision handled' };

      // A SECOND task run lands while the query is open — the follow-up poller
      // pushes it and must reset the per-turn correction state.
      // new_session:false so it's PUSHED into the open query (the path under
      // test). Without the opt-out, nv-main's default-fresh-session rule ends
      // the query to route it through the fresh-session path instead — a
      // separate, also-correct behavior covered by the 'new_session predicate'
      // suite.
      insertMessage('t2', 'task', { prompt: 'fire two', new_session: false });
      // The poller ticks every ACTIVE_POLL_INTERVAL_MS (500ms), so this
      // normally resolves in well under a second. The generous deadline is
      // for slow shared CI runners — and it must stay well below the test's
      // own timeout (set below), so exhaustion fails on the diagnostic throw
      // rather than a mute test timeout.
      const deadline = Date.now() + 15_000;
      while (!pushes.some((p) => p.includes('fire two')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pushes.some((p) => p.includes('fire two'))) {
        throw new Error(
          `follow-up poller never pushed the second task run within 15s; ` +
            `pushes seen (${pushes.length}): ${JSON.stringify(pushes.map((p) => p.slice(0, 80)))}`,
        );
      }

      // Turn 2 repeats the mistake. This receives a second independent nudge
      // only if the follow-up path reset taskBlockNudged.
      yield { type: 'result', text: '<message to="local-cli">fire two result</message>' };
      yield { type: 'result', text: 'second delivery decision handled' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('If and only if'));
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain('fire one result');
    expect(nudges[1]).toContain('fire two result');

    const logs = taskLogRows().map((l) => l.text);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('[undelivered → local-cli] fire one result');
    expect(logs[1]).toContain('[undelivered → local-cli] fire two result');
    expect(logs).not.toContain('first delivery decision handled');
    expect(logs).not.toContain('second delivery decision handled');
    // Explicit budget: the default 5s equalled the old inner deadline, so on
    // slow runners the test died as a mute timeout instead of reaching the
    // diagnostic throw above (observed consistently on CI-hosted runners).
  }, 20_000);
});

describe('silent turn — a result that delivers nothing is never acked completed', () => {
  // The Codex `last_agent_message: null` shape: turn/completed, zero output,
  // isError never set. Before this suite the batch was acked 'completed' and
  // the thread simply stopped.

  function ackStatus(id: string): string | undefined {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status;
  }

  /**
   * A query whose first result is the silent turn. When `retry` is given, the
   * query waits for the loop's re-send nudge and answers it with that event;
   * when it is null the stream just ends (provider never came back).
   */
  function makeSilentQuery(retry: ProviderEvent | null): { query: AgentQuery; pushes: string[] } {
    const pushes: string[] = [];
    let onPush: (() => void) | null = null;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-silent' };
      yield { type: 'result', text: null };
      if (!retry) return;
      if (pushes.length === 0) {
        await new Promise<void>((resolve) => {
          onPush = resolve;
        });
      }
      yield retry;
    }
    return {
      pushes,
      query: {
        push: (m: string) => {
          pushes.push(m);
          onPush?.();
          onPush = null;
        },
        end: () => {},
        events: events(),
        abort: () => {},
      },
    };
  }

  it('nudges once, then acks FAILED (not completed) and delivers a notice', async () => {
    const { query, pushes } = makeSilentQuery(null);

    const result = await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    // The batch is NOT consumed as a success.
    expect(ackStatus('m1')).not.toBe('completed');
    expect(ackStatus('m1')).toBe('failed');
    expect(result.undeliveredIds).toEqual(['m1']);

    // Recovery was attempted in the poll loop itself — not via the optional
    // provider hook, which no production provider implements.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('produced NO output');

    // …and the silence is durable: the channel gets a notice instead of nothing.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('without producing any output');
    expect(out[0].platform_id).toBe('chan-1');
  });

  it('acks completed when the nudged re-send actually delivers', async () => {
    // Plain text auto-routes to the triggering channel (the fork's auto-route
    // gate) — the delivery path a real re-send would take.
    const { query, pushes } = makeSilentQuery({ type: 'result', text: 'here it is, sorry' });

    const result = await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('m1')).toBe('completed');
    expect(result.undeliveredIds ?? []).toHaveLength(0);
    expect(pushes).toHaveLength(1);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('here it is, sorry');
  });

  it('nudges at most once — a second silent result finalizes instead of looping', async () => {
    const { query, pushes } = makeSilentQuery({ type: 'result', text: null });

    const result = await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('m1')).toBe('failed');
    expect(result.undeliveredIds).toEqual(['m1']);
    expect(pushes).toHaveLength(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('does NOT fire for a turn that answered through the send_message tool', async () => {
    // send_message runs in the MCP stdio process: it writes an outbound row
    // while the final text stays empty. The watermark sees that write; a
    // `sent === 0` check never could.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-tool' };
      writeMessageOut({
        id: 'tool-send-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answered via the tool' }),
      });
      yield { type: 'result', text: null };
    }
    const query: AgentQuery = {
      push: (m: string) => pushes.push(m),
      end: () => {},
      events: events(),
      abort: () => {},
    };

    const result = await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('m1')).toBe('completed');
    expect(result.undeliveredIds ?? []).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(getUndeliveredMessages()).toHaveLength(1); // only the tool's own message
  });

  it('does NOT fire for a task run (no chat message is the normal ending)', async () => {
    const { query, pushes } = makeSilentQuery(null);

    const result = await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('t1')).toBe('completed');
    expect(result.undeliveredIds ?? []).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('skips the re-send nudge when the empty turn is already flagged isError', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: '', isError: true });

    const result = await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(ackStatus('m1')).toBe('failed');
    expect(result.undeliveredIds).toEqual(['m1']);
    expect(pushes).toHaveLength(0); // re-asking a failed turn just re-hammers it
    expect(getUndeliveredMessages()).toHaveLength(1);
  });
});
