import type { Migration } from './index.js';

/**
 * Upgrade pre-existing agent-channel (a2a) wirings to session_mode='per-thread'.
 *
 * Context: before the thread-aware a2a delegation work, the agent channel
 * used `agent-shared` session mode exclusively — every inbound a2a message
 * for a given recipient coworker funnelled into a single shared session,
 * regardless of which sender-side thread it originated from. That worked
 * fine when each coworker handled one thing at a time, but broke for the
 * multi-PR-parallel-review workflow where one coworker delegates N
 * independent tasks to another.
 *
 * Most installs won't have any `channel_type='agent'` messaging_group_agents
 * rows (the a2a path is agent-shared today, so it doesn't create mga rows
 * at all). This migration is a no-op there. It's here for the rare case
 * where an operator has hand-wired an explicit a2a row — upgrading those
 * rows in-place to the new per-thread default matches how migration 017
 * handles pre-existing dashboard wirings.
 *
 * Other channels (dashboard, slack, discord, telegram, etc.) are untouched.
 */
export const migration019: Migration = {
  version: 19,
  name: 'a2a-session-mode-per-thread',
  up(db) {
    const hasTable = (name: string) =>
      (db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { c: number })
        .c > 0;
    if (!hasTable('messaging_group_agents') || !hasTable('messaging_groups')) return;

    db.prepare(
      `UPDATE messaging_group_agents
          SET session_mode = 'per-thread'
        WHERE session_mode = 'shared'
          AND messaging_group_id IN (
            SELECT id FROM messaging_groups WHERE channel_type = 'agent'
          )`,
    ).run();
  },
};
