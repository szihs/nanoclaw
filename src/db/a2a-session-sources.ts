/**
 * Read/write helpers for the a2a_session_sources mapping table.
 *
 * See src/db/migrations/020-a2a-session-sources.ts for schema + rationale.
 */
import { getDb } from './connection.js';

export interface A2aSessionSource {
  recipient_session_id: string;
  recipient_agent_group_id: string;
  recipient_thread_id: string | null;
  source_session_id: string;
  source_agent_group_id: string;
  source_thread_id: string | null;
  created_at: string;
}

/**
 * Upsert the source-session hint for a recipient session. Called right
 * after `resolveSession` creates/finds the recipient in `routeAgentMessage`.
 * INSERT OR REPLACE: repeated delegations into the same recipient session
 * from the same source refresh the mapping; a different source replacing
 * another indicates a misuse we surface in logs rather than silently merge.
 */
export function recordSource(params: {
  recipientSessionId: string;
  recipientAgentGroupId: string;
  recipientThreadId: string | null;
  sourceSessionId: string;
  sourceAgentGroupId: string;
  sourceThreadId: string | null;
  now?: string;
}): void {
  const now = params.now ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO a2a_session_sources
         (recipient_session_id, recipient_agent_group_id, recipient_thread_id,
          source_session_id, source_agent_group_id, source_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recipient_session_id) DO UPDATE SET
         recipient_agent_group_id = excluded.recipient_agent_group_id,
         recipient_thread_id      = excluded.recipient_thread_id,
         source_session_id        = excluded.source_session_id,
         source_agent_group_id    = excluded.source_agent_group_id,
         source_thread_id         = excluded.source_thread_id`,
    )
    .run(
      params.recipientSessionId,
      params.recipientAgentGroupId,
      params.recipientThreadId,
      params.sourceSessionId,
      params.sourceAgentGroupId,
      params.sourceThreadId,
      now,
    );
}

export function getSourceFor(recipientSessionId: string): A2aSessionSource | undefined {
  return getDb()
    .prepare('SELECT * FROM a2a_session_sources WHERE recipient_session_id = ?')
    .get(recipientSessionId) as A2aSessionSource | undefined;
}
