import type { Migration } from './index.js';

/**
 * SDK-session-UUID → NanoClaw-session mapping table.
 *
 * The dashboard's Timeline + session-flow endpoints need to know which
 * Claude Agent SDK UUID belongs to which NanoClaw session so per-thread
 * sessions can be bucketed correctly. Without this table the grouping
 * collapses to one-parent-per-folder (the pre-threaded assumption) and
 * root-session activity silently disappears once a thread session is
 * created.
 *
 * Cardinality:
 *   - One SDK session belongs to exactly one NanoClaw session
 *     (enforced by PRIMARY KEY on sdk_session_id).
 *   - One NanoClaw session can have many SDK sessions (N rows).
 *     This is required even on old shared installs because scheduled
 *     tasks invoked with `newSession: true` routinely spawn fresh SDK
 *     UUIDs that continue to belong to the same NanoClaw session.
 *
 * Routes are written at hook intake (source='live'). A one-shot repair
 * script can fill historical rows with source='backfill'; query-time
 * fallback handles ambiguous cases so data is never silently dropped.
 */
export const migration018: Migration = {
  version: 18,
  name: 'sdk-session-routes',
  up(db) {
    const hasTable = (name: string) =>
      (db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { c: number })
        .c > 0;
    if (hasTable('sdk_session_routes')) return;

    db.exec(`
      CREATE TABLE sdk_session_routes (
        sdk_session_id       TEXT PRIMARY KEY,
        nanoclaw_session_id  TEXT NOT NULL,
        agent_group_id       TEXT NOT NULL,
        group_folder         TEXT NOT NULL,
        first_seen_at        INTEGER NOT NULL,
        last_seen_at         INTEGER NOT NULL,
        source               TEXT NOT NULL DEFAULT 'live'
      );
      CREATE INDEX idx_sdk_session_routes_nano  ON sdk_session_routes(nanoclaw_session_id);
      CREATE INDEX idx_sdk_session_routes_group ON sdk_session_routes(group_folder, last_seen_at);
    `);
  },
};
