#!/usr/bin/env tsx
/**
 * One-shot heuristic backfill for sdk_session_routes.
 *
 * Run once after `/update-nanoclaw-instance` brings in migration 018 and
 * the live-attribution intake path. Historical hook_events rows written
 * before that deploy have no route; this script stamps them with
 * source='backfill'.
 *
 * Idempotent: uses INSERT OR IGNORE, so re-runs never overwrite a
 * source='live' row and never duplicate a backfill row.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-sdk-session-routes.ts
 */
import Database from 'better-sqlite3';
import { join, resolve } from 'path';

import { DATA_DIR } from '../src/config.js';
import { recordBackfillRoute } from '../src/db/sdk-session-routes.js';

interface HookEventAggRow {
  session_id: string;
  group_folder: string;
  first_seen_at: number;
  last_seen_at: number;
}

interface NanoSessionRow {
  id: string;
  agent_group_id: string;
  created_at: string;
  thread_id: string | null;
}

function run(): void {
  const dbPath = resolve(join(DATA_DIR, 'v2.db'));
  console.log(`[backfill] opening ${dbPath}`);
  const db = new Database(dbPath);

  // 1. Find unrouted (folder, sdk_session_id) pairs.
  const unrouted = db
    .prepare(
      `SELECT he.session_id, he.group_folder,
              MIN(he.timestamp) AS first_seen_at,
              MAX(he.timestamp) AS last_seen_at
         FROM hook_events he
        WHERE he.session_id IS NOT NULL AND he.session_id != ''
          AND NOT EXISTS (
            SELECT 1 FROM sdk_session_routes r WHERE r.sdk_session_id = he.session_id
          )
        GROUP BY he.session_id, he.group_folder`,
    )
    .all() as HookEventAggRow[];

  console.log(`[backfill] ${unrouted.length} unrouted SDK sessions to resolve`);

  let routed = 0;
  let orphan = 0;
  let singleCandidate = 0;
  let heuristic = 0;
  const orphanSamples: string[] = [];

  for (const r of unrouted) {
    const folderSessions = db
      .prepare(
        `SELECT s.id, s.agent_group_id, s.created_at, s.thread_id
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
          WHERE ag.folder = ?
          ORDER BY s.created_at`,
      )
      .all(r.group_folder) as NanoSessionRow[];

    if (folderSessions.length === 0) {
      orphan++;
      if (orphanSamples.length < 5) orphanSamples.push(`${r.group_folder} (no nanoclaw session exists)`);
      continue;
    }

    let pick: NanoSessionRow | null = null;
    let method: 'single-candidate' | 'heuristic' = 'heuristic';
    if (folderSessions.length === 1) {
      // Shared-install / old-data case: unambiguous. Covers scheduled-task
      // newSession:true fires — all SDK UUIDs belong to the single session.
      pick = folderSessions[0];
      method = 'single-candidate';
    } else {
      // Multi-candidate: bracket by (created_at <= first_seen_at < next.created_at).
      // Compare sessions.created_at (ISO text) to hook first_seen_at (epoch ms).
      //
      // WARNING: this heuristic misattributes root-session activity that
      // happens AFTER a thread is created (the new root SDK UUID's
      // first_seen_at > thread.created_at so it brackets to the thread).
      // That's an acceptable failure mode for historical data only. Live
      // events from here on stamp source='live' at intake with exact
      // attribution; this script is purely a one-shot repair.
      for (let i = 0; i < folderSessions.length; i++) {
        const cur = folderSessions[i];
        const curMs = Date.parse(cur.created_at);
        if (curMs > r.first_seen_at) break;
        const next = folderSessions[i + 1];
        if (!next || Date.parse(next.created_at) > r.first_seen_at) {
          pick = cur;
          method = 'heuristic';
          break;
        }
      }
    }

    if (!pick) {
      orphan++;
      if (orphanSamples.length < 5)
        orphanSamples.push(
          `${r.group_folder}/${r.session_id.slice(0, 8)} (first_seen=${new Date(r.first_seen_at).toISOString()})`,
        );
      continue;
    }

    const inserted = recordBackfillRoute(db, {
      sdkSessionId: r.session_id,
      nanoclawSessionId: pick.id,
      agentGroupId: pick.agent_group_id,
      groupFolder: r.group_folder,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    });
    if (inserted) {
      routed++;
      if (method === 'single-candidate') singleCandidate++;
      else heuristic++;
    }
  }

  // Confirm on-disk totals for source='backfill' — exposes duplicates /
  // re-run idempotency at a glance.
  const backfillTotal = (db.prepare("SELECT COUNT(*) AS n FROM sdk_session_routes WHERE source='backfill'").get() as { n: number }).n;
  const liveTotal = (db.prepare("SELECT COUNT(*) AS n FROM sdk_session_routes WHERE source='live'").get() as { n: number }).n;

  db.close();

  console.log(`[backfill] routed=${routed}  (single-candidate=${singleCandidate}, heuristic=${heuristic})  orphan=${orphan}`);
  console.log(`[backfill] table totals: source='live'=${liveTotal}  source='backfill'=${backfillTotal}`);
  if (heuristic > 0) {
    console.log(
      `[backfill] WARNING: ${heuristic} route(s) used the multi-session timestamp-bracket heuristic.` +
        ` This can misattribute root-session activity that ran after a thread session was created.` +
        ` Treat these as best-effort historical repair only; live events stamp exact routes at intake.`,
    );
  }
  if (orphanSamples.length) {
    console.log(`[backfill] orphan samples:\n  ${orphanSamples.join('\n  ')}`);
  }
  console.log('[backfill] done — live events from here on stamp source=live at intake');
}

run();
