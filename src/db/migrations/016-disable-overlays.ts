import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'disable-overlays',
  up(db) {
    const hasCol = (
      db.prepare("SELECT count(*) as c FROM pragma_table_info('agent_groups') WHERE name = 'disable_overlays'").get() as {
        c: number;
      }
    ).c;
    if (!hasCol) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN disable_overlays INTEGER NOT NULL DEFAULT 0`);
    }
  },
};
