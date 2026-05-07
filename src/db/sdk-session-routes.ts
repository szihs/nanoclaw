/**
 * Read/write helpers for the sdk_session_routes mapping table.
 *
 * See src/db/migrations/018-sdk-session-routes.ts for schema + rationale.
 */
import type Database from 'better-sqlite3';

export interface SdkSessionRoute {
  sdk_session_id: string;
  nanoclaw_session_id: string;
  agent_group_id: string;
  group_folder: string;
  first_seen_at: number;
  last_seen_at: number;
  source: 'live' | 'backfill';
}

/**
 * Stamp a route on first-seen; never overwrite an existing row. Returns
 * true if a new row was inserted, false if one already existed.
 *
 * Callers should follow up with `touchRouteLastSeen` on subsequent events
 * for the same SDK UUID so the last_seen_at column stays fresh (used by
 * the Timeline UI's sorting + the backfill script's conflict heuristic).
 */
export function recordLiveRoute(
  db: Database.Database,
  params: {
    sdkSessionId: string;
    nanoclawSessionId: string;
    agentGroupId: string;
    groupFolder: string;
    now: number;
  },
): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO sdk_session_routes
         (sdk_session_id, nanoclaw_session_id, agent_group_id, group_folder,
          first_seen_at, last_seen_at, source)
       VALUES (?, ?, ?, ?, ?, ?, 'live')`,
    )
    .run(
      params.sdkSessionId,
      params.nanoclawSessionId,
      params.agentGroupId,
      params.groupFolder,
      params.now,
      params.now,
    );
  return res.changes > 0;
}

/**
 * Live-intake entry point for the dashboard hook endpoint. Validates that
 * the claimed `nanoclawSessionId` actually exists AND belongs to an agent
 * group whose folder matches `groupFolder`, then stamps the route. Returns
 * the outcome so the caller can log or increment metrics; errors are
 * swallowed (never crash the hook path on a bad claim).
 *
 * Without this validation a malicious or misconfigured container could
 * write sdk_session_routes rows pointing at sessions it doesn't own,
 * corrupting Timeline attribution on the victim side.
 */
export type LiveStampResult =
  | { status: 'routed'; inserted: boolean }
  | { status: 'unknown_session' }
  | { status: 'folder_mismatch' }
  | { status: 'error'; error: string };

export function stampLiveRouteValidated(
  db: Database.Database,
  params: { sdkSessionId: string; nanoclawSessionId: string; groupFolder: string; now: number },
): LiveStampResult {
  try {
    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.agent_group_id AS agent_group_id, ag.folder AS folder
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
          WHERE s.id = ?
          LIMIT 1`,
      )
      .get(params.nanoclawSessionId) as { session_id: string; agent_group_id: string; folder: string } | undefined;
    if (!row) return { status: 'unknown_session' };
    if (row.folder !== params.groupFolder) return { status: 'folder_mismatch' };

    const inserted = recordLiveRoute(db, {
      sdkSessionId: params.sdkSessionId,
      nanoclawSessionId: row.session_id,
      agentGroupId: row.agent_group_id,
      groupFolder: row.folder,
      now: params.now,
    });
    touchRouteLastSeen(db, params.sdkSessionId, params.now);
    return { status: 'routed', inserted };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

export function touchRouteLastSeen(
  db: Database.Database,
  sdkSessionId: string,
  now: number,
): void {
  db.prepare('UPDATE sdk_session_routes SET last_seen_at = ? WHERE sdk_session_id = ?').run(now, sdkSessionId);
}

export function getRoute(db: Database.Database, sdkSessionId: string): SdkSessionRoute | null {
  return (
    (db.prepare('SELECT * FROM sdk_session_routes WHERE sdk_session_id = ?').get(sdkSessionId) as SdkSessionRoute | undefined) ??
    null
  );
}

/** List all routes for a given NanoClaw session — used by the flow query. */
export function getRoutesForNanoSession(db: Database.Database, nanoclawSessionId: string): SdkSessionRoute[] {
  return db
    .prepare('SELECT * FROM sdk_session_routes WHERE nanoclaw_session_id = ? ORDER BY first_seen_at')
    .all(nanoclawSessionId) as SdkSessionRoute[];
}

/** Backfill path: insert a route without overwriting any live row. */
export function recordBackfillRoute(
  db: Database.Database,
  params: {
    sdkSessionId: string;
    nanoclawSessionId: string;
    agentGroupId: string;
    groupFolder: string;
    firstSeenAt: number;
    lastSeenAt: number;
  },
): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO sdk_session_routes
         (sdk_session_id, nanoclaw_session_id, agent_group_id, group_folder,
          first_seen_at, last_seen_at, source)
       VALUES (?, ?, ?, ?, ?, ?, 'backfill')`,
    )
    .run(
      params.sdkSessionId,
      params.nanoclawSessionId,
      params.agentGroupId,
      params.groupFolder,
      params.firstSeenAt,
      params.lastSeenAt,
    );
  return res.changes > 0;
}
