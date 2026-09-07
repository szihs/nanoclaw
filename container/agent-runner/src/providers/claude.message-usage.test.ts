/**
 * ClaudeProvider must surface each assistant message's OWN usage as a
 * `message_usage` event (issue #1327).
 *
 * The cost cap's accounting basis is per assistant message deduplicated by wire
 * `message.id`, because the SDK emits one assistant message per content block and
 * every block repeats one id and one usage. If this provider stops emitting
 * `message_usage`, the poll-loop silently falls back to the end-of-turn aggregate
 * — the 1.7x–2.8x over-count this issue fixed — so deleting the emission below
 * goes red here.
 *
 * It also pins the delivery-door invariant that makes `forwardSubagentText: true`
 * safe: a subagent message (`parent_tool_use_id` set) contributes COST but never
 * a `text` event, so a nested agent's prose can never be delivered to a user.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];
let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args?.options;
    return (async function* () {
      for (const m of sdkMessages) yield m;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-msgusage-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  lastOptions = undefined;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const USAGE = {
  input_tokens: 2,
  output_tokens: 700,
  cache_creation_input_tokens: 55_000,
  cache_read_input_tokens: 60_000,
  cache_creation: { ephemeral_1h_input_tokens: 55_000, ephemeral_5m_input_tokens: 0 },
};

function provider() {
  const p = createProvider('claude', {});
  p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return p;
}

async function collect(): Promise<Array<Record<string, unknown>>> {
  const q = provider().query({ prompt: 'hi', cwd: tmp });
  const out: Array<Record<string, unknown>> = [];
  for await (const e of q.events) out.push(e as unknown as Record<string, unknown>);
  return out;
}

describe('message_usage emission', () => {
  it('emits one per assistant message, carrying its id, model and token split', async () => {
    sdkMessages.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg_abc', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hello' }], usage: USAGE },
    });
    const events = await collect();
    const mu = events.filter((e) => e.type === 'message_usage');
    expect(mu).toHaveLength(1);
    expect(mu[0]).toMatchObject({
      messageId: 'msg_abc',
      model: 'claude-opus-4-8',
      inputTokens: 2,
      outputTokens: 700,
      cacheCreationInputTokens: 55_000,
      cacheReadInputTokens: 60_000,
      ephemeral1hInputTokens: 55_000,
      ephemeral5mInputTokens: 0,
      isSubagent: false,
    });
  });

  it('emits one per BLOCK-message, repeating the id — the shape the consumer dedupes', async () => {
    // Exactly what the SDK does: thinking / text / tool_use arrive as three
    // assistant messages sharing one message.id and one usage object.
    for (const block of [{ type: 'thinking' }, { type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }]) {
      sdkMessages.push({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'msg_same', model: 'claude-opus-4-8', content: [block], usage: USAGE },
      });
    }
    const mu = (await collect()).filter((e) => e.type === 'message_usage');
    expect(mu).toHaveLength(3);
    expect(new Set(mu.map((m) => m.messageId))).toEqual(new Set(['msg_same']));
  });

  it('emits nothing when the assistant message carries no usage', async () => {
    sdkMessages.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'hi' }] } });
    expect((await collect()).filter((e) => e.type === 'message_usage')).toHaveLength(0);
  });

  it('reports a null messageId rather than inventing one', async () => {
    sdkMessages.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: USAGE } });
    const mu = (await collect()).filter((e) => e.type === 'message_usage');
    expect(mu).toHaveLength(1);
    expect(mu[0].messageId).toBeNull();
  });
});

describe('subagent forwarding: cost yes, delivery no', () => {
  it('requests subagent text forwarding from the SDK', async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'done' });
    await collect();
    expect(lastOptions?.forwardSubagentText).toBe(true);
  });

  it('charges a subagent message but never opens the delivery door with it', async () => {
    sdkMessages.push({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: {
        id: 'msg_sub',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: '<message to="user">nested agent scratchpad</message>' }],
        usage: USAGE,
      },
    });
    const events = await collect();
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
    const mu = events.filter((e) => e.type === 'message_usage');
    expect(mu).toHaveLength(1);
    expect(mu[0].isSubagent).toBe(true);
    expect(mu[0].messageId).toBe('msg_sub');
  });

  it('still emits text for the MAIN agent alongside its usage', async () => {
    sdkMessages.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg_main',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: '<message to="user">real answer</message>' }],
        usage: USAGE,
      },
    });
    const events = await collect();
    const text = events.filter((e) => e.type === 'text');
    expect(text).toHaveLength(1);
    expect(text[0].text).toContain('real answer');
    expect(events.filter((e) => e.type === 'message_usage')).toHaveLength(1);
    // Order matters for the poll-loop: text (delivery) is emitted before the
    // cost event for the same message, so a ceiling crossing can never suppress
    // content the agent already produced.
    expect(events.findIndex((e) => e.type === 'text')).toBeLessThan(
      events.findIndex((e) => e.type === 'message_usage'),
    );
  });
});

describe('the aggregate usage event is unchanged', () => {
  it('still emits one usage event from the result message', async () => {
    sdkMessages.push({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 's1',
      duration_ms: 10,
      total_cost_usd: 1.5,
      num_turns: 2,
      usage: USAGE,
    });
    const events = await collect();
    const u = events.filter((e) => e.type === 'usage');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ totalCostUsd: 1.5, numTurns: 2, sessionId: 's1' });
  });
});
