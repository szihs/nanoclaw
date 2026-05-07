import type { Migration } from './index.js';

/**
 * Per-a2a-recipient → source-session mapping.
 *
 * When agent A (in session sess-A, thread T) delegates to agent B via
 * `send_message(to="B")`, routeAgentMessage creates a per-thread recipient
 * session sess-B under a synthetic messaging group. Historically the
 * mapping stopped there — B's reply re-entered routeAgentMessage and got
 * resolved by (targetAg, synthetic-mg, thread_id) again, which created a
 * NEW session on A's side instead of delivering back to sess-A.
 *
 * This table carries the route-back hint: one row per recipient session
 * recording which source session (+ its agent group + its thread id)
 * spawned it. On B's reply, routeAgentMessage looks up the row and
 * delivers the reply into `source_session_id` directly, bypassing mg +
 * thread resolution.
 *
 * Cardinality:
 *   - One row per a2a recipient session (PK on recipient_session_id).
 *   - A given source session may spawn many recipient sessions (one per
 *     recipient per thread) — the idx on source_session_id supports that
 *     lookup for inspector/UX use.
 *
 * Non-a2a sessions (dashboard/slack/telegram/…) never get a row, so the
 * table is empty on installs that don't use agent-to-agent.
 */
export const migration020: Migration = {
  version: 20,
  name: 'a2a-session-sources',
  up(db) {
    const hasTable = (name: string) =>
      (db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { c: number })
        .c > 0;
    if (hasTable('a2a_session_sources')) return;

    // recipient_agent_group_id and recipient_thread_id are denormalised from
    // the `sessions` row for operability (inspector queries, log correlation,
    // debug UIs). source_* is the route-back hint — that's load-bearing.
    db.exec(`
      CREATE TABLE a2a_session_sources (
        recipient_session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        recipient_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        recipient_thread_id     TEXT,
        source_session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        source_thread_id        TEXT,
        created_at              TEXT NOT NULL
      );
      CREATE INDEX idx_a2a_src_session       ON a2a_session_sources(source_session_id);
      CREATE INDEX idx_a2a_recipient_ag      ON a2a_session_sources(recipient_agent_group_id);
      CREATE INDEX idx_a2a_src_ag_recipient  ON a2a_session_sources(source_agent_group_id, recipient_agent_group_id);
    `);
  },
};
