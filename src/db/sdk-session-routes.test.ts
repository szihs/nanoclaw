import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRoute,
  getRoutesForNanoSession,
  recordBackfillRoute,
  recordLiveRoute,
  stampLiveRouteValidated,
  touchRouteLastSeen,
} from './sdk-session-routes.js';
import { migration018 } from './migrations/018-sdk-session-routes.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  // The validated stamp joins sessions + agent_groups, so seed both when
  // testing it. Other helpers don't touch those tables.
  db.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL);
  `);
  migration018.up(db);
  return db;
}

function seedSession(db: Database.Database, sessionId: string, agentGroupId: string, folder: string) {
  db.prepare('INSERT OR IGNORE INTO agent_groups (id, folder) VALUES (?, ?)').run(agentGroupId, folder);
  db.prepare('INSERT OR IGNORE INTO sessions (id, agent_group_id) VALUES (?, ?)').run(sessionId, agentGroupId);
}

describe('sdk-session-routes helpers', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    // Seed the referenced rows so FK constraints pass for the basic
    // helper tests — the validated-stamp tests reseed via seedSession
    // for their own scenarios.
    seedSession(db, 'sess-root', 'ag-1', 'orchestrator');
    seedSession(db, 'sess-other', 'ag-1', 'orchestrator');
    seedSession(db, 'sess-thread', 'ag-1', 'orchestrator');
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

  describe('stampLiveRouteValidated', () => {
    it('routes when session exists and folder matches', () => {
      seedSession(db, 'sess-root', 'ag-1', 'orchestrator');
      const res = stampLiveRouteValidated(db, {
        sdkSessionId: 'sdk-a',
        nanoclawSessionId: 'sess-root',
        groupFolder: 'orchestrator',
        now: 1000,
      });
      expect(res).toEqual({ status: 'routed', inserted: true });
      expect(getRoute(db, 'sdk-a')!.nanoclaw_session_id).toBe('sess-root');
    });

    it('returns unknown_session when the claimed session does not exist', () => {
      const res = stampLiveRouteValidated(db, {
        sdkSessionId: 'sdk-x',
        nanoclawSessionId: 'sess-fake',
        groupFolder: 'orchestrator',
        now: 1000,
      });
      expect(res.status).toBe('unknown_session');
      expect(getRoute(db, 'sdk-x')).toBeNull();
    });

    it('returns folder_mismatch when the session belongs to a different folder', () => {
      seedSession(db, 'sess-root', 'ag-1', 'orchestrator');
      const res = stampLiveRouteValidated(db, {
        sdkSessionId: 'sdk-x',
        nanoclawSessionId: 'sess-root',
        groupFolder: 'other-coworker',
        now: 1000,
      });
      expect(res.status).toBe('folder_mismatch');
      expect(getRoute(db, 'sdk-x')).toBeNull();
    });

    it('touches last_seen_at on re-stamp of the same SDK UUID', () => {
      seedSession(db, 'sess-root', 'ag-1', 'orchestrator');
      stampLiveRouteValidated(db, { sdkSessionId: 'sdk-a', nanoclawSessionId: 'sess-root', groupFolder: 'orchestrator', now: 1000 });
      const second = stampLiveRouteValidated(db, { sdkSessionId: 'sdk-a', nanoclawSessionId: 'sess-root', groupFolder: 'orchestrator', now: 5000 });
      expect(second).toEqual({ status: 'routed', inserted: false });
      expect(getRoute(db, 'sdk-a')!.last_seen_at).toBe(5000);
      expect(getRoute(db, 'sdk-a')!.first_seen_at).toBe(1000);
    });
  });
});
