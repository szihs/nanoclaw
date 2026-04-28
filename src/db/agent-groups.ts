import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(
  group: Partial<AgentGroup> & Pick<AgentGroup, 'id' | 'name' | 'folder' | 'created_at'>,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, is_admin, agent_provider, container_config, coworker_type, allowed_mcp_tools, routing, created_at)
       VALUES (@id, @name, @folder, @is_admin, @agent_provider, @container_config, @coworker_type, @allowed_mcp_tools, @routing, @created_at)`,
    )
    .run({
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      coworker_type: null,
      allowed_mcp_tools: null,
      routing: 'direct',
      ...group,
    });
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function getAdminAgentGroup(): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE is_admin = 1 LIMIT 1').get() as AgentGroup | undefined;
}

export function updateAgentGroup(
  id: string,
  updates: Partial<
    Pick<AgentGroup, 'name' | 'agent_provider' | 'container_config' | 'coworker_type' | 'allowed_mcp_tools'>
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
