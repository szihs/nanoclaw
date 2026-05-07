import type { Migration } from './index.js';

/**
 * Upgrade pre-existing dashboard wirings to session_mode='per-thread'.
 *
 * Context: dashboard's Slack-style thread UI (introduced alongside this
 * migration) only renders correctly when each thread has its own agent
 * session. New dashboard wirings default to 'per-thread' at registration
 * time (setup/register.ts), and `ensureDashboardChatWiring` self-heals on
 * every /api/chat/send, but neither path runs for installs that were
 * upgraded in-place and never send a dashboard message before the first
 * thread-tagged inbound arrives. This migration closes that gap by
 * bulk-updating existing rows on service boot.
 *
 * Other channels are intentionally untouched — 'shared' remains correct
 * for non-threaded adapters (Telegram, WhatsApp, iMessage) and is the
 * explicit default for new non-dashboard wirings.
 */
export const migration017: Migration = {
  version: 17,
  name: 'dashboard-session-mode-per-thread',
  up(db) {
    // Guard: the columns and tables must exist. On a completely fresh
    // install the earlier migrations have already created both.
    const hasTable = (name: string) =>
      (db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { c: number })
        .c > 0;
    if (!hasTable('messaging_group_agents') || !hasTable('messaging_groups')) return;

    const res = db
      .prepare(
        `UPDATE messaging_group_agents
            SET session_mode = 'per-thread'
          WHERE session_mode = 'shared'
            AND messaging_group_id IN (
              SELECT id FROM messaging_groups WHERE channel_type = 'dashboard'
            )`,
      )
      .run();
    if (res.changes > 0) {
      // The caller logs at INFO level per-migration; no extra log here.
    }
  },
};
