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
