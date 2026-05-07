import type { Migration } from './index.js';

/**
 * Add coworker fields to agent_groups:
 *   - is_admin (INTEGER, 0|1) — privilege flag for admin agent groups
 *   - container_config (TEXT, JSON) — per-agent container overrides
 *   - coworker_type (TEXT) — manifest-driven CLAUDE.md composition + role templates
 *   - allowed_mcp_tools (TEXT, JSON) — per-agent MCP tool filtering
 */
export const migration006: Migration = {
  version: 6,
  name: 'coworker-fields',
  up(db) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_groups ADD COLUMN container_config TEXT;
      ALTER TABLE agent_groups ADD COLUMN coworker_type TEXT;
      ALTER TABLE agent_groups ADD COLUMN allowed_mcp_tools TEXT;
    `);
  },
};
