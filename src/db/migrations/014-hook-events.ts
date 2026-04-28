import type { Migration } from './index.js';

/**
 * `hook_events` — stores real-time hook events from agent containers
 * for the Pixel Office dashboard. Events arrive via POST /api/hook-event
 * and are persisted here for history, analytics, and session flow views.
 */
export const migration014: Migration = {
  version: 14,
  name: 'hook-events',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hook_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        group_folder    TEXT NOT NULL,
        event           TEXT NOT NULL,
        tool            TEXT,
        tool_use_id     TEXT,
        message         TEXT,
        tool_input      TEXT,
        tool_response   TEXT,
        session_id      TEXT,
        agent_id        TEXT,
        agent_type      TEXT,
        transcript_path TEXT,
        cwd             TEXT,
        extra           TEXT,
        timestamp       INTEGER NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_he_group     ON hook_events(group_folder);
      CREATE INDEX IF NOT EXISTS idx_he_session   ON hook_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_he_tool_use  ON hook_events(tool_use_id);
      CREATE INDEX IF NOT EXISTS idx_he_ts        ON hook_events(timestamp);
    `);
  },
};
