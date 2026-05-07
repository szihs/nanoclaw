import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRoute,
  getRoutesForNanoSession,
  recordBackfillRoute,
  recordLiveRoute,
  touchRouteLastSeen,
} from './sdk-session-routes.js';
import { migration018 } from './migrations/018-sdk-session-routes.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migration018.up(db);
  return db;
}

describe('sdk-session-routes helpers', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('recordLiveRoute inserts on first-seen and returns true', () => {
    const inserted = recordLiveRoute(db, {
      sdkSessionId: 'sdk-1',
      nanoclawSessionId: 'sess-root',
      agentGroupId: 'ag-1',
      groupFolder: 'orchestrator',
      now: 1000,
    });
    expect(inserted).toBe(true);

    const r = getRoute(db, 'sdk-1');
    expect(r).toMatchObject({
      sdk_session_id: 'sdk-1',
      nanoclaw_session_id: 'sess-root',
      source: 'live',
      first_seen_at: 1000,
      last_seen_at: 1000,
    });
  });

  it('recordLiveRoute does not overwrite an existing row', () => {
    recordLiveRoute(db, {
      sdkSessionId: 'sdk-1',
      nanoclawSessionId: 'sess-root',
      agentGroupId: 'ag-1',
      groupFolder: 'orchestrator',
      now: 1000,
    });
    const second = recordLiveRoute(db, {
      sdkSessionId: 'sdk-1',
      nanoclawSessionId: 'sess-other', // would-be reassignment
      agentGroupId: 'ag-1',
      groupFolder: 'orchestrator',
      now: 2000,
    });
    expect(second).toBe(false);
    expect(getRoute(db, 'sdk-1')!.nanoclaw_session_id).toBe('sess-root');
  });

  it('touchRouteLastSeen updates last_seen_at only', () => {
    recordLiveRoute(db, {
      sdkSessionId: 'sdk-1',
      nanoclawSessionId: 'sess-root',
      agentGroupId: 'ag-1',
      groupFolder: 'orchestrator',
      now: 1000,
    });
    touchRouteLastSeen(db, 'sdk-1', 5000);
    const r = getRoute(db, 'sdk-1')!;
    expect(r.first_seen_at).toBe(1000);
    expect(r.last_seen_at).toBe(5000);
  });

  it('recordBackfillRoute never overwrites a source=live row', () => {
    recordLiveRoute(db, {
      sdkSessionId: 'sdk-1',
      nanoclawSessionId: 'sess-root',
      agentGroupId: 'ag-1',
      groupFolder: 'orchestrator',
      now: 1000,
    });
    const inserted = recordBackfillRoute(db, {
      sdkSessionId: 'sdk-1',
      nanoclawSessionId: 'sess-other',
      agentGroupId: 'ag-1',
      groupFolder: 'orchestrator',
      firstSeenAt: 500,
      lastSeenAt: 1500,
    });
    expect(inserted).toBe(false);
    expect(getRoute(db, 'sdk-1')!.source).toBe('live');
    expect(getRoute(db, 'sdk-1')!.nanoclaw_session_id).toBe('sess-root');
  });

  it('getRoutesForNanoSession returns only that nano session\'s routes, first_seen order', () => {
    recordLiveRoute(db, { sdkSessionId: 'sdk-a', nanoclawSessionId: 'sess-root', agentGroupId: 'ag-1', groupFolder: 'f', now: 3000 });
    recordLiveRoute(db, { sdkSessionId: 'sdk-b', nanoclawSessionId: 'sess-root', agentGroupId: 'ag-1', groupFolder: 'f', now: 1000 });
    recordLiveRoute(db, { sdkSessionId: 'sdk-c', nanoclawSessionId: 'sess-thread', agentGroupId: 'ag-1', groupFolder: 'f', now: 2000 });
    const rs = getRoutesForNanoSession(db, 'sess-root').map((r) => r.sdk_session_id);
    expect(rs).toEqual(['sdk-b', 'sdk-a']); // ordered by first_seen_at asc
  });

  it('migration018 is idempotent', () => {
    expect(() => migration018.up(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(sdk_session_routes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['agent_group_id', 'first_seen_at', 'group_folder', 'last_seen_at', 'nanoclaw_session_id', 'sdk_session_id', 'source'].sort(),
    );
  });
});
