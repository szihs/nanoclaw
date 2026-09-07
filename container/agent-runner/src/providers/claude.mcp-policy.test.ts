/**
 * End-to-end enforcement of the EXTERNAL MCP allow-list inside the container.
 *
 * These assert against the options the provider actually hands the SDK and
 * against the PreToolUse hook it actually installs — not against the resolver
 * that computes the list.
 *
 * Two properties are under test and they pull in opposite directions:
 *
 *   1. An empty/unresolved policy must still deny every EXTERNAL tool. That is
 *      the F03 fail-open, and it stays fixed. (Was failing before #1157.)
 *   2. It must NOT touch `mcp__nanoclaw__*`. NanoClaw's own tools are outside
 *      this policy — each answers to its own host-side gate — and #1157 wrongly
 *      denied all but three of them. (Was failing after #1157.)
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface SdkOptions {
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, unknown>;
  hooks: { PreToolUse: { hooks: ((input: unknown) => Promise<unknown>)[] }[] };
}

let lastOptions: SdkOptions | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: SdkOptions }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const SERVERS = {
  // Built-in, direct stdio — never traverses the host MCP proxy.
  nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} },
  // Direct stdio child — likewise invisible to the proxy.
  codex: { command: 'codex', args: ['mcp-server'], env: {} },
  // Proxy-routed.
  deepwiki: { command: 'node', args: ['deepwiki'], env: {} },
};

/** A representative slice of the built-in surface, transport and privileged alike. */
const BUILTINS = [
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__send_file',
  'mcp__nanoclaw__add_reaction',
  'mcp__nanoclaw__ask_user_question',
  'mcp__nanoclaw__send_card',
  'mcp__nanoclaw__install_packages',
  'mcp__nanoclaw__create_agent',
  'mcp__nanoclaw__record_decision',
  'mcp__nanoclaw__report_pr_created',
  'mcp__nanoclaw__append_learning',
];

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-policy-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a provider under `env` and drain one query so the SDK options are captured. */
async function optionsUnder(env: Record<string, string>): Promise<SdkOptions> {
  const provider = createProvider('claude', { mcpServers: SERVERS, env });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
  if (!lastOptions) throw new Error('SDK query was never called');
  return lastOptions;
}

async function hookBlocks(options: SdkOptions, toolName: string): Promise<string | null> {
  const hook = options.hooks.PreToolUse[0]!.hooks[0]!;
  const decision = (await hook({ tool_name: toolName, tool_input: {} })) as {
    decision?: string;
    stopReason?: string;
  };
  return decision?.decision === 'block' ? (decision.stopReason ?? '') : null;
}

describe('an explicit empty allow-list denies every EXTERNAL surface', () => {
  const env = {
    NANOCLAW_MCP_POLICY: JSON.stringify({ restrict: true, tools: [], origin: 'explicit allow-list' }),
    // The legacy variable the pre-#1157 tree read. Present and empty, exactly
    // as an operator running `--tools '[]'` would produce.
    NANOCLAW_ALLOWED_MCP_TOOLS: '[]',
  };

  it('drops the external namespace wildcards but keeps the built-in one', async () => {
    const options = await optionsUnder(env);
    expect(options.allowedTools).not.toContain('mcp__codex__*');
    expect(options.allowedTools).not.toContain('mcp__deepwiki__*');
    // The built-in namespace is not this policy's business; enumerating it
    // here would mean tracking every tool registerTools ever adds.
    expect(options.allowedTools).toContain('mcp__nanoclaw__*');
  });

  it('withholds every external direct MCP server, and only those', async () => {
    const options = await optionsUnder(env);
    expect(Object.keys(options.mcpServers).sort()).toEqual(['nanoclaw']);
  });

  it('blocks a Codex direct tool', async () => {
    const options = await optionsUnder(env);
    expect(await hookBlocks(options, 'mcp__codex__codex')).toContain('allow-list');
  });

  it('blocks a host-proxy tool', async () => {
    const options = await optionsUnder(env);
    expect(await hookBlocks(options, 'mcp__deepwiki__ask_question')).toContain('allow-list');
  });

  it('permits the ENTIRE built-in surface — not just a transport floor', async () => {
    const options = await optionsUnder(env);
    for (const tool of BUILTINS) {
      expect(await hookBlocks(options, tool), tool).toBeNull();
    }
    // Including built-ins this file has never heard of.
    expect(await hookBlocks(options, 'mcp__nanoclaw__some_future_tool')).toBeNull();
  });

  it('leaves ordinary non-MCP tools alone', async () => {
    const options = await optionsUnder(env);
    expect(await hookBlocks(options, 'Bash')).toBeNull();
    expect(await hookBlocks(options, 'Read')).toBeNull();
  });
});

describe('a group with no explicit list is not restricted at all', () => {
  // This is the whole "no behaviour change" requirement. A group nobody has
  // run `mcp-tools set` against keeps every tool it has today, whatever its
  // coworker type happens to enumerate.
  const env = {
    NANOCLAW_MCP_POLICY: JSON.stringify({
      restrict: false,
      tools: [],
      origin: 'no explicit allow-list — unrestricted by default',
    }),
  };

  it('wires every server and blocks no MCP tool', async () => {
    const options = await optionsUnder(env);
    expect(Object.keys(options.mcpServers).sort()).toEqual(['codex', 'deepwiki', 'nanoclaw']);
    expect(options.allowedTools).toContain('mcp__codex__*');
    expect(options.allowedTools).toContain('mcp__deepwiki__*');
    expect(await hookBlocks(options, 'mcp__codex__codex-reply')).toBeNull();
    expect(await hookBlocks(options, 'mcp__deepwiki__ask_question')).toBeNull();
    expect(await hookBlocks(options, 'mcp__nanoclaw__add_mcp_server')).toBeNull();
  });
});

describe('a policy the container cannot read restricts nothing', () => {
  // Reading silence as a denial would let a host bug — or a host simply older
  // than this file — narrow a live coworker. Only `mcp-tools set` narrows.
  // This is safe because the host already scoped the proxy token and withheld
  // the disallowed servers before the container started; these checks are
  // blast-radius control, not the enforcement point.
  it('restricts nothing when the host sent no policy at all', async () => {
    const options = await optionsUnder({
      NANOCLAW_ALLOWED_MCP_TOOLS: JSON.stringify(['mcp__deepwiki__ask_question']),
    });
    expect(Object.keys(options.mcpServers).sort()).toEqual(['codex', 'deepwiki', 'nanoclaw']);
    expect(await hookBlocks(options, 'mcp__deepwiki__ask_question')).toBeNull();
    expect(await hookBlocks(options, 'mcp__codex__codex')).toBeNull();
    expect(await hookBlocks(options, 'mcp__nanoclaw__install_packages')).toBeNull();
  });

  it('restricts nothing when the policy is corrupt', async () => {
    const options = await optionsUnder({ NANOCLAW_MCP_POLICY: '{not json' });
    expect(await hookBlocks(options, 'mcp__deepwiki__ask_question')).toBeNull();
    expect(await hookBlocks(options, 'mcp__nanoclaw__send_message')).toBeNull();
  });

  it('restricts nothing when the policy has no `restrict` field', async () => {
    const options = await optionsUnder({
      NANOCLAW_MCP_POLICY: JSON.stringify({ state: 'whatever', tools: ['mcp__deepwiki__ask_question'] }),
    });
    expect(await hookBlocks(options, 'mcp__deepwiki__ask_question')).toBeNull();
  });
});

describe('a partial allow-list keeps exactly what it names', () => {
  it('wires only the servers it can use and blocks the rest of their namespaces', async () => {
    const options = await optionsUnder({
      NANOCLAW_MCP_POLICY: JSON.stringify({
        restrict: true,
        tools: ['mcp__deepwiki__ask_question'],
        origin: 'explicit allow-list',
      }),
    });
    expect(Object.keys(options.mcpServers).sort()).toEqual(['deepwiki', 'nanoclaw']);
    expect(await hookBlocks(options, 'mcp__deepwiki__ask_question')).toBeNull();
    // Same server, a tool the list does not name.
    expect(await hookBlocks(options, 'mcp__deepwiki__read_wiki_contents')).toBeTruthy();
    expect(await hookBlocks(options, 'mcp__codex__codex')).toBeTruthy();
  });
});

describe('unrestricted stays unrestricted', () => {
  it('keeps the per-server wildcards and blocks nothing', async () => {
    const options = await optionsUnder({
      NANOCLAW_MCP_POLICY: JSON.stringify({
        restrict: false,
        tools: ['mcp__deepwiki__ask_question'],
        origin: 'admin default',
      }),
    });
    expect(Object.keys(options.mcpServers).sort()).toEqual(['codex', 'deepwiki', 'nanoclaw']);
    expect(options.allowedTools).toContain('mcp__nanoclaw__*');
    expect(options.allowedTools).toContain('mcp__codex__*');
    expect(await hookBlocks(options, 'mcp__nanoclaw__install_packages')).toBeNull();
    expect(await hookBlocks(options, 'mcp__codex__codex')).toBeNull();
    // Tools the SDK never offers are still blocked — this is a different gate.
    expect(await hookBlocks(options, 'CronCreate')).toBeTruthy();
  });
});
