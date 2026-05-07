import { describe, it, expect } from 'bun:test';

import { STALE_THREAD_RE, tomlBasicString } from './codex-app-server.js';

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe('"/usr/local/bin/node"');
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe('"C:\\\\path\\\\to\\\\bin"');
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeCodexMcpConfigToml } from './codex-app-server.js';

function withTmpHome<T>(fn: () => T): T {
  const oldHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-test-'));
  process.env.HOME = tmp;
  try {
    return fn();
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('writeCodexMcpConfigToml', () => {
  it('emits url for http MCP (not command) with no type= line', () => {
    withTmpHome(() => {
      writeCodexMcpConfigToml({
        deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('[mcp_servers.deepwiki]');
      expect(toml).toContain('url = "https://mcp.deepwiki.com/mcp"');
      expect(toml).not.toContain('type = "stdio"');
      expect(toml).not.toContain('command = ');
      expect(toml).not.toContain('undefined');
    });
  });

  it('translates Claude-native headers → [http_headers] block', () => {
    withTmpHome(() => {
      writeCodexMcpConfigToml({
        pxy: {
          type: 'http',
          url: 'http://localhost:8820/mcp/thing',
          headers: { Accept: 'application/json', 'X-Custom': 'v' },
        },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('[mcp_servers.pxy.http_headers]');
      expect(toml).toContain('Accept = "application/json"');
      expect(toml).toContain('X-Custom = "v"');
    });
  });

  it('bearer_token_env_var wins: strips Authorization from both headers and httpHeaders', () => {
    withTmpHome(() => {
      writeCodexMcpConfigToml({
        a: {
          type: 'http',
          url: 'http://h/mcp/a',
          headers: { Authorization: 'Bearer FROM-HEADERS', Accept: 'json' },
          bearerTokenEnvVar: 'MCP_PROXY_TOKEN',
        },
        b: {
          type: 'http',
          url: 'http://h/mcp/b',
          httpHeaders: { authorization: 'Bearer FROM-HTTP', 'X-Ok': 'yes' },
          bearerTokenEnvVar: 'MCP_PROXY_TOKEN',
        },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('bearer_token_env_var = "MCP_PROXY_TOKEN"');
      expect(toml).not.toContain('FROM-HEADERS');
      expect(toml).not.toContain('FROM-HTTP');
      // Non-Authorization headers should still be present
      expect(toml).toContain('Accept = "json"');
      expect(toml).toContain('X-Ok = "yes"');
    });
  });

  it('skips malformed servers without emitting broken TOML', () => {
    withTmpHome(() => {
      writeCodexMcpConfigToml({
        // @ts-expect-error intentional malformed
        noUrl: { type: 'http' },
        // @ts-expect-error intentional malformed
        noCmd: { args: [], env: {} },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      expect(toml).not.toContain('command = "undefined"');
      expect(toml).not.toContain('url = "undefined"');
      expect(toml).not.toContain('[mcp_servers.noUrl]');
      expect(toml).not.toContain('[mcp_servers.noCmd]');
    });
  });

  it('emits stdio entries without type= line', () => {
    withTmpHome(() => {
      writeCodexMcpConfigToml({
        nanoclaw: { command: 'bun', args: ['run', 'server'], env: { X: 'y' } },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('command = "bun"');
      expect(toml).toContain('args = ["run", "server"]');
      expect(toml).toContain('X = "y"');
      expect(toml).not.toContain('type = "stdio"');
    });
  });

  it('chmods config.toml to 0600 on re-write of existing file', () => {
    withTmpHome(() => {
      const cfg = path.join(process.env.HOME!, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, 'pre-existing\n', { mode: 0o644 });
      fs.chmodSync(cfg, 0o644);
      writeCodexMcpConfigToml({ a: { command: 'true' } });
      const mode = fs.statSync(cfg).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
