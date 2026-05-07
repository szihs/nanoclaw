import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/**
 * Map NanoClaw v2 MCP definitions into OpenCode config `mcp` field.
 *
 * Handles both stdio (`command`) and http (`url`) variants of the now-widened
 * `McpServerConfig` union. OpenCode's `remote` shape accepts static headers
 * directly; codex-only fields (`bearerTokenEnvVar`, `envHttpHeaders`,
 * `httpHeaders`) are translated into `headers` at best-effort.
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if ('url' in cfg) {
      // http / remote
      const headers: Record<string, string> = {
        ...(cfg.headers ?? {}),
        ...(cfg.httpHeaders ?? {}),
      };
      out[name] = {
        type: 'remote',
        url: cfg.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        enabled: true,
      };
    } else {
      // stdio / local
      out[name] = {
        type: 'local',
        command: [cfg.command, ...cfg.args],
        ...(Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
        enabled: true,
      };
    }
  }
  return out;
}
