import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'agent-routing',
  up(db) {
    const hasCol = (db.prepare("SELECT count(*) as c FROM pragma_table_info('agent_groups') WHERE name = 'routing'").get() as { c: number }).c;
    if (!hasCol) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN routing TEXT NOT NULL DEFAULT 'direct'`);
    }

    // Backfill: agents with no messaging_group_agents row are internal-only
    db.exec(`
      UPDATE agent_groups SET routing = 'internal'
      WHERE id NOT IN (
        SELECT DISTINCT agent_group_id FROM messaging_group_agents mga
        JOIN messaging_groups mg ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type || ':' || mg.platform_id LIKE 'dashboard:' || agent_groups.folder || '%'
          OR mg.platform_id LIKE '%' || agent_groups.folder
      ) AND is_admin = 0
    `);
  },
};
