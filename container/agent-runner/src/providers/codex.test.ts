import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import type { ProviderEvent } from './types.js';

// ── Fake Codex SDK ──────────────────────────────────────────────────
// We mock the SDK module so tests don't need an API key or real backend.
// Each test wires up a sequence of ThreadEvents the fake thread will yield.

interface FakeThreadEvent {
  type: string;
  thread_id?: string;
  item?: Record<string, unknown>;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  error?: { message: string };
  message?: string;
}

let threadEventSequences: FakeThreadEvent[][] = [];
let startThreadCalls: Array<Record<string, unknown>> = [];
let resumeThreadCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];

class FakeThread {
  _id: string | null;
  constructor(id: string | null) {
    this._id = id;
  }
  get id() {
    return this._id;
  }
  async runStreamed(input: string, _opts?: Record<string, unknown>) {
    const seq = threadEventSequences.shift() ?? [];
    return {
      events: (async function* () {
        for (const e of seq) yield e;
      })(),
    };
  }
}

class FakeCodex {
  opts: Record<string, unknown>;
  constructor(opts?: Record<string, unknown>) {
    this.opts = opts ?? {};
  }
  startThread(opts?: Record<string, unknown>) {
    startThreadCalls.push(opts ?? {});
    return new FakeThread(null);
  }
  resumeThread(id: string, opts?: Record<string, unknown>) {
    resumeThreadCalls.push({ id, opts: opts ?? {} });
    return new FakeThread(id);
  }
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: FakeCodex,
}));

// Import AFTER mock is installed
const { CodexProvider } = await import('./codex.js');

// ── Helpers ─────────────────────────────────────────────────────────

// Use a temp directory for config.toml so tests never clobber the host's
// personal ~/.codex/config.toml.
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
afterAll(() => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

async function collectEvents(provider: InstanceType<typeof CodexProvider>, prompt: string, opts?: {
  continuation?: string;
  pushMessages?: Array<{ text: string; delayMs: number }>;
  endDelayMs?: number;
  systemContext?: { instructions?: string };
}): Promise<ProviderEvent[]> {
  const query = provider.query({
    prompt,
    cwd: '/workspace',
    continuation: opts?.continuation,
    systemContext: opts?.systemContext,
  });

  const events: ProviderEvent[] = [];

  // Schedule push messages
  for (const pm of opts?.pushMessages ?? []) {
    setTimeout(() => query.push(pm.text), pm.delayMs);
  }
  // Schedule end
  setTimeout(() => query.end(), opts?.endDelayMs ?? 50);

  for await (const event of query.events) {
    events.push(event);
  }
  return events;
}

function makeProvider(env?: Record<string, string | undefined>) {
  return new CodexProvider({ env, configDir: tmpConfigDir } as any);
}

// ── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  initTestSessionDb();
  threadEventSequences = [];
  startThreadCalls = [];
  resumeThreadCalls = [];
});

afterEach(() => {
  closeSessionDb();
});

describe('CodexProvider', () => {
  describe('basic lifecycle', () => {
    it('should emit init and result for a simple turn', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-123' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Hello back' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Hello');

      const typed = events.filter((e) => e.type !== 'activity');
      expect(typed[0]).toEqual({ type: 'init', continuation: 'th-123' });
      expect(typed[1]).toEqual({ type: 'progress', message: 'Codex turn started' });
      expect(typed[2]).toEqual({ type: 'result', text: 'Hello back' });
    });

    it('should yield null result when no agent_message in turn', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-456' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { type: 'command_execution', id: 'c1', command: 'echo hi', exit_code: 0, status: 'completed', aggregated_output: 'hi' },
        },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Run something');

      const results = events.filter((e) => e.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ type: 'result', text: null });
    });

    it('should use last agent_message when multiple items complete', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-789' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'First thought' } },
        {
          type: 'item.completed',
          item: { type: 'command_execution', id: 'c1', command: 'ls', exit_code: 0, status: 'completed', aggregated_output: '' },
        },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i2', text: 'Final answer' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Think and answer');

      const results = events.filter((e) => e.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ type: 'result', text: 'Final answer' });
    });
  });

  describe('error handling', () => {
    it('should emit error on turn.failed', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-err' },
        { type: 'turn.started' },
        { type: 'turn.failed', error: { message: 'Rate limit exceeded' } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Bad request');

      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({ type: 'error', message: 'Rate limit exceeded', retryable: false });
    });

    it('should emit error on stream-level error event', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-err2' },
        { type: 'error', message: 'Connection lost' },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Test');

      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({ type: 'error', message: 'Connection lost', retryable: true });
    });
  });

  describe('session resume', () => {
    it('should retry inline with a fresh thread when continuation is stale', async () => {
      const originalResumeThread = FakeCodex.prototype.resumeThread;
      FakeCodex.prototype.resumeThread = function(id: string, opts?: Record<string, unknown>) {
        resumeThreadCalls.push({ id, opts: opts ?? {} });
        return {
          async runStreamed() {
            throw new Error('no rollout found for thread id stale-thread');
          },
        } as any;
      };

      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-recovered' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Recovered' } },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 } },
      ]);

      try {
        const provider = makeProvider();
        const events = await collectEvents(provider, 'Continue', { continuation: 'th-stale' });

        expect(resumeThreadCalls).toHaveLength(1);
        expect(startThreadCalls).toHaveLength(1);
        expect(events).toContainEqual({ type: 'progress', message: 'Codex session expired; starting fresh thread' });
        expect(events).toContainEqual({ type: 'init', continuation: 'th-recovered' });
        expect(events).toContainEqual({ type: 'result', text: 'Recovered' });
      } finally {
        FakeCodex.prototype.resumeThread = originalResumeThread;
      }
    });

    it('should call resumeThread when continuation is provided', async () => {
      threadEventSequences.push([
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Resumed' } },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 } },
      ]);

      const provider = makeProvider();
      await collectEvents(provider, 'Continue', { continuation: 'th-existing' });

      expect(startThreadCalls).toHaveLength(0);
      expect(resumeThreadCalls).toHaveLength(1);
      expect(resumeThreadCalls[0].id).toBe('th-existing');
      expect(resumeThreadCalls[0].opts).toMatchObject({
        workingDirectory: '/workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      });
    });

    it('should call startThread when no continuation', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-new' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 } },
      ]);

      const provider = makeProvider();
      await collectEvents(provider, 'Fresh start');

      expect(startThreadCalls).toHaveLength(1);
      expect(resumeThreadCalls).toHaveLength(0);
      expect(startThreadCalls[0]).toMatchObject({
        workingDirectory: '/workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      });
    });
  });

  describe('isSessionInvalid', () => {
    it('should detect stale session errors', () => {
      const provider = makeProvider();
      expect(provider.isSessionInvalid(new Error('session not found'))).toBe(true);
      expect(provider.isSessionInvalid(new Error('no such session xyz'))).toBe(true);
      expect(provider.isSessionInvalid(new Error('thread not found'))).toBe(true);
      expect(provider.isSessionInvalid('invalid session')).toBe(true);
      expect(provider.isSessionInvalid(new Error('no rollout found for thread id abc'))).toBe(true);
    });

    it('should not flag normal errors as session invalid', () => {
      const provider = makeProvider();
      expect(provider.isSessionInvalid(new Error('rate limit'))).toBe(false);
      expect(provider.isSessionInvalid(new Error('connection refused'))).toBe(false);
    });
  });

  describe('push() and follow-up messages', () => {
    it('should process follow-up messages as new turns on the same thread', async () => {
      // Initial turn
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-multi' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'First response' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);
      // Follow-up turn
      threadEventSequences.push([
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i2', text: 'Second response' } },
        { type: 'turn.completed', usage: { input_tokens: 15, cached_input_tokens: 5, output_tokens: 8 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Hello', {
        pushMessages: [{ text: 'Follow-up', delayMs: 30 }],
        endDelayMs: 80,
      });

      const results = events.filter((e) => e.type === 'result');
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ type: 'result', text: 'First response' });
      expect(results[1]).toEqual({ type: 'result', text: 'Second response' });
    });
  });

  describe('progress events', () => {
    it('should emit progress for command execution', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-cmd' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: { type: 'command_execution', id: 'c1', command: 'npm test', status: 'running', aggregated_output: '' },
        },
        {
          type: 'item.completed',
          item: { type: 'command_execution', id: 'c1', command: 'npm test', exit_code: 0, status: 'completed', aggregated_output: 'ok' },
        },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Tests passed' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Run tests');

      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toContainEqual({ type: 'progress', message: 'Running: npm test' });
      expect(progress).toContainEqual({ type: 'progress', message: 'npm test (exit 0)' });
    });

    it('should emit progress for MCP tool calls', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-mcp' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: { type: 'mcp_tool_call', id: 'mt1', server: 'nanoclaw', tool: 'create_agent', arguments: {}, status: 'running' },
        },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Create agent');

      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toContainEqual({ type: 'progress', message: 'MCP: nanoclaw/create_agent' });
    });

    it('should emit progress for web search', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-ws' },
        { type: 'turn.started' },
        { type: 'item.started', item: { type: 'web_search', id: 'ws1', query: 'slang compiler SPIR-V' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Search');

      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toContainEqual({ type: 'progress', message: 'Search: slang compiler SPIR-V' });
    });
  });

  describe('abort', () => {
    it('should stop event iteration when aborted', async () => {
      // A turn that will never complete naturally
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-abort' },
        { type: 'turn.started' },
      ]);

      const provider = makeProvider();
      const query = provider.query({ prompt: 'Hang', cwd: '/workspace' });

      const events: ProviderEvent[] = [];
      setTimeout(() => query.abort(), 30);
      setTimeout(() => query.end(), 50);

      for await (const event of query.events) {
        events.push(event);
      }

      // Should have gotten activity + init + progress at most, then stopped
      expect(events.length).toBeLessThan(10);
    });
  });

  describe('activity events', () => {
    it('should yield activity for every SDK event', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-act' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Done' } },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } },
      ]);

      const provider = makeProvider();
      const events = await collectEvents(provider, 'Test');

      const activities = events.filter((e) => e.type === 'activity');
      // One activity per SDK event (4 events)
      expect(activities).toHaveLength(4);
    });
  });

  describe('developer_instructions', () => {
    it('should write developer_instructions to config.toml when systemContext has instructions', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-di' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Acknowledged' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const provider = makeProvider();
      await collectEvents(provider, 'Hello', {
        systemContext: { instructions: 'You are a helpful coding assistant.' },
      });

      const config = fs.readFileSync(path.join(tmpConfigDir, 'config.toml'), 'utf-8');
      expect(config).toContain("developer_instructions = '''");
      expect(config).toContain('You are a helpful coding assistant.');
    });

    it('should not include developer_instructions when no systemContext', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-nodi' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } },
      ]);

      const provider = makeProvider();
      await collectEvents(provider, 'Hello');

      const config = fs.readFileSync(path.join(tmpConfigDir, 'config.toml'), 'utf-8');
      expect(config).not.toContain('developer_instructions');
    });
  });

  describe('MCP proxy bearer token', () => {
    it('should write bearer_token_env_var for HTTP MCP servers with auth headers', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-mcp' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } },
      ]);

      const provider = new CodexProvider({
        env: { MCP_PROXY_TOKEN: 'test-token-123' },
        configDir: tmpConfigDir,
        mcpServers: {
          'slang-mcp': {
            type: 'http',
            url: 'http://host.docker.internal:8809/mcp/slang-mcp',
            headers: { Authorization: 'Bearer test-token-123' },
          } as any,
        },
      } as any);
      await collectEvents(provider, 'Test');

      const config = fs.readFileSync(path.join(tmpConfigDir, 'config.toml'), 'utf-8');
      expect(config).toContain('[mcp_servers.slang-mcp]');
      expect(config).toContain('url = "http://host.docker.internal:8809/mcp/slang-mcp"');
      expect(config).toContain('bearer_token_env_var = "MCP_PROXY_TOKEN"');
    });
  });

  describe('config isolation', () => {
    it('should write config.toml to the specified configDir, not ~/.codex', async () => {
      threadEventSequences.push([
        { type: 'thread.started', thread_id: 'th-iso' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } },
      ]);

      const provider = makeProvider();
      await collectEvents(provider, 'Test');

      expect(fs.existsSync(path.join(tmpConfigDir, 'config.toml'))).toBe(true);
    });
  });

  describe('supportsNativeSlashCommands', () => {
    it('should be false', () => {
      const provider = makeProvider();
      expect(provider.supportsNativeSlashCommands).toBe(false);
    });
  });
});
