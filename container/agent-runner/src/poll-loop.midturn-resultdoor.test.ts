import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery, __costCapTestHooks as H } from './poll-loop.js';
import { __resetCodexCostMemo } from './codex-cost.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// Adversarial verification of the one-door contract for mid-turn delivery
// providers: mid-turn streaming is the SINGLE content door. The result door
// NEVER writes content to messages_out (error results excepted) — its only
// other job is the nudge decision: a turn that delivered nothing (no door
// delivery, no DB-visible send like MCP send_message) whose result still
// carries content gets the wrap-nudge, so the model re-sends and the retry
// streams through the mid-turn door. Streaming-door misses (SDK drift, a
// destination appearing only after streaming) therefore degrade to
// nudge-and-retry — deliberately, never to a direct result-door send.
//
// The result text is an independent SDK field the provider cannot prove
// equal to streamed content (see providers/claude.ts result branch), which
// is why these divergence shapes are constructed and pinned here.

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function seedDest(name = 'discord-main', channelType = 'discord', platformId = 'chan-1'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function removeDest(name: string): void {
  getInboundDb().prepare('DELETE FROM destinations WHERE name = ?').run(name);
}

function makeStubQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events,
      abort: () => {},
    },
  };
}

function deliveredTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
}

function nudges(pushes: string[]): string[] {
  return pushes.filter((p) => p.includes('was not delivered'));
}

// ── The result door never delivers: streaming-door misses degrade to the nudge ──

describe('result door never delivers content — undelivered turns get the nudge', () => {
  it('SDK drift (capability=true, ZERO text events): the result block is NOT written, the nudge fires', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // The capability says text streams, but this turn emitted none — the
      // result is the only carrier of the reply. The result door still does
      // not send; the wrap-nudge asks the model to re-send, and the retry's
      // text events go through the mid-turn door.
      yield { type: 'result', text: '<message to="discord-main">Only exists in the result.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('streamed text WITHOUT deliverable blocks + result WITH a block: nothing written, nudge fires', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'thinking out loud, nothing wrapped yet' };
      yield { type: 'result', text: '<message to="discord-main">The reply.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('a nudged retry that re-streams the block delivers it through the mid-turn door (the recovery loop)', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1: drift — block only in the result. Nudge fires.
      yield { type: 'result', text: '<message to="discord-main">Lost in the drift.</message>' };
      // The retry turn streams properly — mid-turn door delivers.
      yield { type: 'text', text: '<message to="discord-main">Lost in the drift.</message>' };
      yield { type: 'result', text: '<message to="discord-main">Lost in the drift.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Lost in the drift.']);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('the nudge decision resets per turn: a later drift turn nudges after an earlier delivered turn', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      // Turn 1: normal streaming — one delivery, no nudge.
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">turn one</message>' };
      yield { type: 'result', text: '<message to="discord-main">turn one</message>' };
      // Turn 2: drift — no text events. The per-turn state was reset at the
      // boundary, so this undelivered turn must nudge (and not deliver).
      yield { type: 'result', text: '<message to="discord-main">turn two</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['turn one']);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('a repeat of the mid-turn delivery in the result is inert: no second write, no nudge', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['The answer is 4.']);
    expect(pushes).toHaveLength(0);
  });
});

// ── Multi-segment turns: repeats in the result stay inert ──

describe('multi-segment turns: result overlap never re-delivers', () => {
  it('result repeating ALL segments blocks: each delivered once at the door, result inert', async () => {
    seedDest();
    const a = '<message to="discord-main">segment A</message>';
    const b = '<message to="discord-main">segment B</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: a };
      yield { type: 'text', text: b };
      yield { type: 'result', text: `${a}\n${b}` };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['segment A', 'segment B']);
    expect(pushes).toHaveLength(0);
  });

  it('result carrying only the LAST segment: earlier deliveries stand, the repeat is inert', async () => {
    seedDest();
    const a = '<message to="discord-main">segment A</message>';
    const b = '<message to="discord-main">segment B</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: a };
      yield { type: 'text', text: b };
      yield { type: 'result', text: b };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['segment A', 'segment B']);
    expect(pushes).toHaveLength(0);
  });
});

// ── Error and interrupted turns ──

describe('error and interrupted turns', () => {
  it('error result whose block never streamed (errors[] shape), nothing sent mid-turn: no write, nudge fires', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'partial progress narration, unwrapped' };
      // The claude provider builds error-result text from the SDK's errors[]
      // field — content that NEVER streamed. The result door still does not
      // send it as a block; with nothing delivered this turn the nudge asks
      // for a proper re-send instead.
      yield { type: 'result', text: '<message to="discord-main">Run aborted: quota.</message>', isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('a bare (blockless) error result still surfaces via deliverErrorResult — the errors exception', async () => {
    seedDest();
    const errText = 'Spending limit reached. Add your own key at https://example.com/keys';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: errText, isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([errText]);
    expect(pushes).toHaveLength(0);
  });

  it('a stream that throws after a mid-turn delivery: the delivered row survives, processQuery rejects', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Sent before the crash.</message>' };
      throw new Error('SDK stream died');
    }
    const { query } = makeStubQuery(events());

    await expect(
      processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow('SDK stream died');

    // The mid-turn write is durable — an interrupted turn cannot claw it back.
    expect(deliveredTexts()).toEqual(['Sent before the crash.']);
  });
});

// ── Destinations changing between stream time and result time ──

describe('destination set changes between stream time and result time', () => {
  it('dest unknown at stream time but present at result time, nothing else delivered: no write, nudge fires', async () => {
    // Destinations are live-queried from inbound.db (the host writes the
    // table on demand, mid-session). The result door does not deliver even
    // once the destination exists — the nudge coaxes a re-send, and the
    // retry's mid-turn scan sees the now-known destination.
    const block = '<message to="discord-main">Hello, new channel.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // door: unknown dest → skipped
      seedDest(); // host wires the destination mid-turn
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('KNOWN RESIDUAL (pinned): dest appears late while ANOTHER block already delivered — no delivery, no nudge', async () => {
    // Accepted bound of the one-door contract: the turn DID deliver, so the
    // nudge stays quiet, and the result door never sends — the late block is
    // lost for this turn. Reaching this shape requires a destination write
    // landing inside the sub-second window between the last streamed segment
    // and the result, in a turn that also delivered another block.
    seedDest('discord-main');
    const known = '<message to="discord-main">to the known channel</message>';
    const late = '<message to="late-dest">to the late channel</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: `${known}\n${late}` }; // known delivers; late skipped (unknown)
      seedDest('late-dest', 'discord', 'chan-2'); // appears inside the window
      yield { type: 'result', text: `${known}\n${late}` };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['to the known channel']);
    expect(nudges(pushes)).toHaveLength(0);
  });

  it('dest removed between stream and result: the delivered block is not re-sent and no nudge fires', async () => {
    seedDest();
    const block = '<message to="discord-main">delivered before removal</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // delivers
      removeDest('discord-main');
      yield { type: 'result', text: block }; // result-door: unknown dest → dropped-note; turn delivered → no nudge
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['delivered before removal']);
    expect(nudges(pushes)).toHaveLength(0);
  });
});

// ── Half-messages: never-closed fragments are the nudge's job ──
//
// Blocks split across text events are ASSEMBLED and delivered mid-turn (see
// poll-loop.midturn-assembly.test.ts). What assembly does NOT cover — a block
// that never closes anywhere — stays undeliverable, and the wrap-nudge is
// the recovery path when the turn delivered nothing.

describe('half-messages: never-closed fragments', () => {
  it('a block that NEVER closes anywhere: nothing delivered, the wrap-nudge fires (nudge owns this case)', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">this stays open forever' };
      // SDK premise: result = last assistant text = the same unclosed fragment.
      yield { type: 'result', text: '<message to="discord-main">this stays open forever' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('never-completed fragment alongside a delivered block: fragment dropped at turn end, no nudge, no loss of anything complete', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">complete reply</message>' };
      yield { type: 'text', text: '<message to="discord-main">opened but never closed…' };
      yield { type: 'result', text: '' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['complete reply']);
    expect(nudges(pushes)).toHaveLength(0);
  });
});

// ── Cross-segment echo guard (live-captured: SDK battery s03) ──
//
// The model, after a trailing tool call, often re-emits the ALREADY-SENT
// block verbatim as its final text — which streams as its own text event.
// The door consults the outbound DB over the frame-local seq window
// (turnStartSeq, segStartSeq] to recognize the repeat; no in-process content
// ledger. Intra-segment doubles and cross-turn repeats stay deliverable.

describe('cross-segment echo guard', () => {
  it('a later segment re-emitting the identical block delivers once (s03 recording shape)', async () => {
    seedDest();
    const block = '<message to="discord-main">✅ Deploy is done.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // composed + delivered before the tool call
      yield { type: 'text', text: block }; // final text: verbatim echo after the tool call
      yield { type: 'result', text: block }; // result === last segment (live invariant)
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['✅ Deploy is done.']);
    expect(pushes).toHaveLength(0);
  });

  it('two identical blocks in ONE segment are an explicit double-send and both deliver (s09 shape)', async () => {
    seedDest();
    const twice =
      '<message to="discord-main">backup finished</message>\n\n<message to="discord-main">backup finished</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: twice };
      yield { type: 'result', text: twice };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['backup finished', 'backup finished']);
  });

  it('the same body to a DIFFERENT destination is not an echo', async () => {
    seedDest('discord-main');
    seedDest('ops-log', 'slack', 'chan-ops');
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">capture test</message>' };
      yield { type: 'text', text: '<message to="ops-log">capture test</message>' };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['capture test', 'capture test']);
  });

  it('the window closes at the turn boundary: the next turn may genuinely repeat the body', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
      // Turn 2: same body again, on purpose. Must deliver.
      yield { type: 'text', text: block };
      yield { type: 'result', text: 'sent above' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['The answer is 4.', 'The answer is 4.']);
  });
});

// ── MCP sends count as same-turn deliveries for the nudge decision ──

describe('DB-visible sends gate the nudge', () => {
  it('a chat row written this turn outside the door (MCP send_message shape) suppresses the nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Simulate an MCP send_message call landing mid-turn: a chat row
      // appears in outbound.db without going through the mid-turn door.
      const { writeMessageOut } = await import('./db/messages-out.js');
      writeMessageOut({
        id: 'mcp-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        thread_id: null,
        content: JSON.stringify({ text: 'sent via tool' }),
      });
      // Final text is an unwrapped self-summary — with a DB-visible send
      // this turn, nudging would coax a redundant repeat.
      yield { type: 'result', text: 'Told them via the tool.' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['sent via tool']);
    expect(nudges(pushes)).toHaveLength(0);
  });
});

// ── Failure ordering — mid-turn outbound write fails ──

describe('mid-turn delivery write failure', () => {
  it('fails the turn loudly: processQuery rejects, the stream never reaches its result, nothing is silently dropped', async () => {
    seedDest();
    let reachedResult = false;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Break the outbound DB before the delivery attempt — the next
      // writeMessageOut throws (fresh prepare per call, so the rename bites).
      getOutboundDb().exec('ALTER TABLE messages_out RENAME TO messages_out_broken');
      yield { type: 'text', text: '<message to="discord-main">will fail to write</message>' };
      reachedResult = true;
      yield { type: 'result', text: '<message to="discord-main">will fail to write</message>' };
    }
    const { query } = makeStubQuery(events());

    await expect(
      processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow();

    // The turn died at the failed write: the result was never processed, and
    // the caller's error path (runPollLoop) surfaces the failure to the user.
    expect(reachedResult).toBe(false);
    getOutboundDb().exec('ALTER TABLE messages_out_broken RENAME TO messages_out');
    expect(deliveredTexts()).toEqual([]);
  });
});

// ── Door-skipped blocks keep base result-door handling ──

describe('capability=true keeps base result-door handling for door-skipped blocks', () => {
  it('unknown destination at both doors: dropped with the wrap-nudge, never silently swallowed', async () => {
    // No destination seeded at all.
    const block = '<message to="nobody-home">is anyone there?</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });
});

// ── #1360 MAJOR #3: a native-codex turn ending in ERROR must settle at the ──────
// result boundary, not bypass it.
//
// Pre-fix, providers/codex.ts yielded `{type:'error'}` on turn/failed. The
// poll-loop streaming chain handles usage/text/result but NOT error, so a failed
// codex turn was only logged and dropped — it never reached the `result` branch,
// so foldCodexCost() + the ceiling hard-stop never ran, costStopRequested stayed
// false, and the poller could admit another turn past the ceiling. Post-fix the
// provider yields a structured error-RESULT (isError:true) so the turn flows
// through delivery + the codex result-boundary settle. This drives that exact
// path through processQuery with a ceiling-crossing rollout on disk.
describe('#1360 — native-codex cost settle + one-shot hard-stop deferral at the result boundary', () => {
  const D_TODAY = new Date().toISOString().slice(0, 10);
  let home: string;
  let prevHome: string | undefined;

  // Full pristine cost state: setState only writes the keys present, and the
  // module globals are process-wide (they leak across sibling test files), so
  // seeding every field keeps this test independent of run order. afterEach
  // disables tracking again so nothing leaks out.
  function seedCost(over: Parameters<typeof H.setState>[0] = {}): void {
    H.setState({
      costEnabled: true,
      costImmortal: false,
      costWindow: 'lifetime',
      costDayKey: undefined,
      costAllotmentUsd: 1000,
      costCapUsd: 1000,
      costSpentUsd: 0,
      costEscalatedAt: undefined,
      costDecision: undefined,
      costDecidedAt: undefined,
      costStopRequested: false,
      costCeilingUsd: 0,
      costCeilingAllotmentUsd: 0,
      costCeilingEscalated: false,
      costCeilingHardStop: false,
      costBudgetGen: 0,
      costEpisodeId: undefined,
      pendingCostNudge: undefined,
      codexLedger: {},
      codexUsdCharged: 0,
      codexLedgerBaselinePending: false,
      seenMessageIds: [],
      turnSawMessageUsage: false,
      turnMessageCostUsd: 0,
      turnUnpricedCount: 0,
      turnMissingIdCount: 0,
      turnNoUsageCount: 0,
      codexEventOwners: {},
      ...over,
    });
  }

  function writeRollout(day: string, inputTokens: number): void {
    const [y, m, d] = day.split('-');
    const dir = path.join(home, 'sessions', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    const u = {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: inputTokens,
    };
    const lines = [
      JSON.stringify({
        timestamp: `${day}T00:00:00.000Z`,
        type: 'turn_context',
        payload: { cwd: '/workspace/agent', model: 'gpt-5.6-sol' },
      }),
      JSON.stringify({
        timestamp: `${day}T10:00:00.000Z`,
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u } },
      }),
    ];
    fs.writeFileSync(path.join(dir, `rollout-${day}T10-00-00-err.jsonl`), lines.join('\n'));
  }

  beforeEach(() => {
    prevHome = process.env.CODEX_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-err-'));
    process.env.CODEX_HOME = home;
    __resetCodexCostMemo();
    seedDest();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    __resetCodexCostMemo();
    // Disable tracking so the enabled state can't bleed into sibling files.
    H.setState({ costEnabled: false, costStopRequested: false, costCeilingHardStop: false, codexLedger: {}, codexEventOwners: {} });
  });

  it('folds rollout spend, crosses the ceiling, hard-stops, and delivers the error notice', async () => {
    // 1M non-cached input @ $5/M = $5 of chargeable codex spend on disk, ceiling $3.
    seedCost({ costCeilingUsd: 3, costCeilingAllotmentUsd: 3 });
    writeRollout(D_TODAY, 1_000_000);

    let ended = false;
    let pulled = 0;
    async function* events(): AsyncGenerator<ProviderEvent> {
      pulled++;
      // What codex.ts now yields on turn/failed.
      yield { type: 'result', text: 'Turn timed out after 300000ms', isError: true };
      // A second turn must NOT be admitted after the ceiling hard-stop — pulling
      // it is exactly the "admit another turn past the ceiling" regression #3 fixes.
      pulled++;
      yield { type: 'result', text: '<message to="discord-main">second turn</message>' };
    }
    const query: AgentQuery = {
      push: () => {},
      end: () => {
        ended = true;
      },
      abort: () => {},
      events: events(),
    };

    await processQuery(query, CHAT_ROUTING, ['m1'], 'codex', undefined, 'prompt', undefined, false);

    const s = H.getState();
    expect(s.costSpentUsd).toBeCloseTo(5, 6); // the FAILED turn's rollout was folded — the bug was it wasn't
    expect(s.costStopRequested).toBe(true); // …and the crossing quiesced the session
    expect(s.costCeilingHardStop).toBe(true);
    expect(ended).toBe(true); // the settle hard-stopped the stream
    expect(pulled).toBe(1); // the second turn was never admitted
    // The error text reached the channel instead of being silently dropped.
    expect(deliveredTexts().some((t) => t.includes('Turn timed out'))).toBe(true);
  });

  it('one-shot deferral: a queued correction defers the codex hard-stop exactly ONCE, then it fires', async () => {
    // The re-review BLOCKER: the deferral flag was per-result, so EVERY
    // gate-refused result past the ceiling earned a fresh deferral — codex could
    // spend past the hard ceiling without bound (a delivery gate keeps denying
    // while awaiting the fix). The fix hoists a ONE-SHOT allowance to processQuery
    // scope. Here the ceiling is ALREADY crossed and BOTH results are refused by
    // the chain-routing gate (each queues a corrective retry): result 1 must
    // DEFER (no query.end → the stream reaches result 2), result 2 must HARD-STOP
    // (query.end), and result 3 must never be pulled.
    seedCost({ costCeilingUsd: 3, costSpentUsd: 5, costStopRequested: true, costCeilingHardStop: true });

    // Each result body carries a `[Resolution]` delivery marker but the <message>
    // tag omits `in_reply_to`, so checkRoutingGate refuses it and returns a
    // sender-directed correction. Point the gate's denial-count state at an
    // absent file (denials read as 0 → the soft-cap never yields), so BOTH
    // results are refused deterministically regardless of the CWD's writability.
    const savedRoutingState = process.env.ROUTING_GATE_STATE_PATH;
    process.env.ROUTING_GATE_STATE_PATH = path.join(home, 'no-routing-state.json');
    try {
      let ended = false;
      let pulled = 0;
      const pushed: string[] = [];
      async function* events(): AsyncGenerator<ProviderEvent> {
        pulled++;
        yield { type: 'result', text: '<message to="discord-main">[Resolution] first — deferred</message>' };
        pulled++;
        yield { type: 'result', text: '<message to="discord-main">[Resolution] second — hard-stops</message>' };
        pulled++;
        yield { type: 'result', text: '<message to="discord-main">[Resolution] third — must never run</message>' };
      }
      const query: AgentQuery = {
        push: (m) => {
          pushed.push(m);
        },
        end: () => {
          ended = true;
        },
        abort: () => {},
        events: events(),
      };

      const qr = await processQuery(query, CHAT_ROUTING, ['m1'], 'codex', undefined, 'prompt', undefined, false);

      // Result 1's gate-refusal correction was pushed (deferred → ran as result 2);
      // result 2's correction is WITHHELD, not pushed, because the hard-stop would
      // tear it down before it could run (#1360 re-review terminal MAJOR).
      expect(pushed.length).toBe(1);
      expect(pulled).toBe(2); // result 1 DEFERRED (reached result 2); result 3 was never pulled
      expect(ended).toBe(true); // result 2 HARD-STOPPED the stream — the deferral did not re-arm
      // The terminal result must NOT be silently completed: it is acked FAILED
      // (reclaimable after a cost-cap continuation) and returned in undeliveredIds
      // so the outer fallback markCompleted skips it…
      expect(qr.undeliveredIds).toContain('m1');
      // …and a durable "answer withheld — cost ceiling" notice reached the user.
      expect(deliveredTexts().some((t) => t.toLowerCase().includes('withheld'))).toBe(true);
      expect(H.getState().costCeilingHardStop).toBe(true);
    } finally {
      if (savedRoutingState === undefined) delete process.env.ROUTING_GATE_STATE_PATH;
      else process.env.ROUTING_GATE_STATE_PATH = savedRoutingState;
    }
  });
});
