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

  // ── envInherit / env_vars allowlist (OneCLI secret containment) ──────────
  // These tests enforce the invariant that no secret VALUE is ever serialized
  // to ~/.codex/config.toml. Names-only indirection via `env_vars = [...]` is
  // the only permitted way to thread a secret through to a subprocess.

  it('emits env_vars = [...] for envInherit names, no literal values', () => {
    withTmpHome(() => {
      writeCodexMcpConfigToml({
        codex: {
          command: 'codex',
          args: ['mcp-server'],
          env: { HOME: '/home/node', PATH: '/usr/bin' },
          envInherit: ['HTTPS_PROXY', 'NVIDIA_API_KEY'],
        },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      // Positive controls — prove the writer was exercised.
      expect(toml).toContain('[mcp_servers.codex]');
      expect(toml).toContain('command = "codex"');
      expect(toml).toContain('env_vars = ["HTTPS_PROXY", "NVIDIA_API_KEY"]');
      expect(toml).toContain('HOME = "/home/node"');
      // Negative — names but not values for envInherit keys.
      expect(toml).not.toMatch(/^HTTPS_PROXY\s*=/m);
      expect(toml).not.toMatch(/^NVIDIA_API_KEY\s*=/m);
    });
  });

  it('throws if a name appears in both env and envInherit (caller bug guard)', () => {
    withTmpHome(() => {
      expect(() =>
        writeCodexMcpConfigToml({
          codex: {
            command: 'codex',
            env: { HTTPS_PROXY: 'http://u:SENTINEL_LITERAL_TOKEN_A@h:1' },
            envInherit: ['HTTPS_PROXY'],
          },
        }),
      ).toThrow(/HTTPS_PROXY.*both env and envInherit/);
      // File must remain untouched — no partial write that could leak.
      const cfg = path.join(process.env.HOME!, '.codex', 'config.toml');
      const exists = fs.existsSync(cfg);
      if (exists) {
        const toml = fs.readFileSync(cfg, 'utf-8');
        expect(toml).not.toContain('SENTINEL_LITERAL_TOKEN_A');
      }
    });
  });

  it('sentinel-scan: real-shaped call never serializes secret values to TOML', () => {
    withTmpHome(() => {
      const URL_SENTINEL = 'SENTINEL_TOKEN_XYZ_DO_NOT_LEAK';
      const PROXY_SENTINEL = 'SENTINEL_PROXY_TOKEN_ABC';
      // URL-encoded variant of the URL sentinel — guards against percent-encoding escape.
      const URL_SENTINEL_ENCODED = encodeURIComponent(URL_SENTINEL);

      writeCodexMcpConfigToml({
        codex: {
          command: 'codex',
          args: ['mcp-server'],
          env: { HOME: '/home/node', PATH: '/usr/bin' },
          envInherit: ['HTTPS_PROXY', 'NVIDIA_API_KEY', 'SSL_CERT_FILE'],
        },
        proxymcp: {
          type: 'http',
          url: 'https://proxy.example/mcp/svc',
          headers: { Authorization: `Bearer ${PROXY_SENTINEL}` },
          bearerTokenEnvVar: 'MCP_PROXY_TOKEN',
        },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');

      // Positive controls — prove both writers (stdio + http) ran.
      expect(toml).toContain('[mcp_servers.codex]');
      expect(toml).toContain('env_vars = ["HTTPS_PROXY", "NVIDIA_API_KEY", "SSL_CERT_FILE"]');
      expect(toml).toContain('[mcp_servers.proxymcp]');
      expect(toml).toContain('url = "https://proxy.example/mcp/svc"');
      expect(toml).toContain('bearer_token_env_var = "MCP_PROXY_TOKEN"');

      // Negative — sentinel secret values must NEVER appear anywhere.
      // Note: the writer itself does not see URL_SENTINEL (it's not passed
      // in this test), but the assertion is intentional — if a future
      // regression routes HTTPS_PROXY's plaintext value into TOML, it
      // would trip this guard.
      expect(toml).not.toContain(URL_SENTINEL);
      expect(toml).not.toContain(URL_SENTINEL_ENCODED);
      expect(toml).not.toContain(PROXY_SENTINEL);

      // Parsed-TOML secondary scan: walk every line and verify no value
      // string contains either sentinel (catches escape/encoding tricks).
      for (const line of toml.split('\n')) {
        expect(line).not.toContain(URL_SENTINEL);
        expect(line).not.toContain(URL_SENTINEL_ENCODED);
        expect(line).not.toContain(PROXY_SENTINEL);
      }
    });
  });

  it('strips plaintext Authorization from http_headers when bearerTokenEnvVar is set', () => {
    withTmpHome(() => {
      const PROXY_SENTINEL = 'SENTINEL_PROXY_TOKEN_DEF';
      writeCodexMcpConfigToml({
        gh: {
          type: 'http',
          url: 'https://mcp.example/gh',
          headers: {
            Authorization: `Bearer ${PROXY_SENTINEL}`,
            'X-Trace': 'keep-me',
          },
          bearerTokenEnvVar: 'MCP_PROXY_TOKEN',
        },
      });
      const toml = fs.readFileSync(path.join(process.env.HOME!, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('bearer_token_env_var = "MCP_PROXY_TOKEN"');
      // Non-secret header passes through.
      expect(toml).toContain('X-Trace = "keep-me"');
      // Authorization must NOT be serialized with its plaintext value.
      expect(toml).not.toContain(PROXY_SENTINEL);
      expect(toml).not.toMatch(/^Authorization\s*=/m);
    });
  });

  it('stale-config migration: prior plaintext mcp_servers block is overwritten', () => {
    withTmpHome(() => {
      const cfg = path.join(process.env.HOME!, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      // Simulate a pre-fix config with a plaintext secret under the old
      // [mcp_servers.codex.env] shape.
      const STALE_SENTINEL = 'SENTINEL_STALE_TOKEN_GHI';
      fs.writeFileSync(
        cfg,
        [
          '[projects."/workspace/agent"]',
          'trust_level = "trusted"',
          '',
          '[mcp_servers.codex]',
          'command = "codex"',
          '[mcp_servers.codex.env]',
          `HTTPS_PROXY = "http://u:${STALE_SENTINEL}@h:1"`,
          '',
        ].join('\n'),
      );

      writeCodexMcpConfigToml({
        codex: {
          command: 'codex',
          args: ['mcp-server'],
          env: { HOME: '/home/node', PATH: '/usr/bin' },
          envInherit: ['HTTPS_PROXY'],
        },
      });

      const toml = fs.readFileSync(cfg, 'utf-8');
      // Stale secret must be gone.
      expect(toml).not.toContain(STALE_SENTINEL);
      // New shape in place.
      expect(toml).toContain('env_vars = ["HTTPS_PROXY"]');
      expect(toml).toContain('HOME = "/home/node"');
      // Old [mcp_servers.codex.env] block with HTTPS_PROXY literal must be gone.
      expect(toml).not.toMatch(/HTTPS_PROXY\s*=\s*"http:\/\//);
    });
  });
});
