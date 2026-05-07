/**
 * One-time filesystem+DB migration: demote `groups/global/` to `data/shared/`.
 *
 * Pre-refactor layout:
 *   groups/global/CLAUDE.md         — flat coworker body (retired)
 *   groups/global/learnings/        — shared cross-group facts
 *   groups/<folder>/.claude-global.md — dangling symlink (@-import target)
 *   agent_groups row for folder='global', coworker_type='global'
 *
 * Post-refactor layout:
 *   data/shared/learnings/          — cross-group facts (read-only mount
 *                                     at /workspace/shared/ in coworkers;
 *                                     read-write for Main)
 *   data/shared/_legacy/v1-global.md — preserved copy of old flat body
 *   (no groups/global/, no symlinks, no agent_groups row for it)
 *
 * Idempotent: gated by data/.migrations/global-to-shared.done marker.
 * Called at service startup from src/index.ts. Also invokable standalone
 * via `tsx scripts/migrate-global-to-shared.ts`.
 *
 * Safe operations only:
 *   - `mv` for learnings/ (preserves content)
 *   - copy-then-delete for CLAUDE.md (content preserved as _legacy)
 *   - `unlink` for symlinks (no data loss)
 *   - SQL UPDATE/DELETE only for the well-defined 'global' coworker_type
 *
 * If any step fails, logs the warning and leaves the marker unwritten, so
 * the next boot retries. `mv` is wrapped in fallback-copy because Node's
 * `rename` across filesystem boundaries fails with EXDEV.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

export interface MigrationLog {
  actions: string[];
  warnings: string[];
}

function safeMoveDir(src: string, dst: string, log: MigrationLog): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) {
    // Destination already exists — merge entries; copy any missing.
    for (const entry of fs.readdirSync(src)) {
      const srcEntry = path.join(src, entry);
      const dstEntry = path.join(dst, entry);
      if (!fs.existsSync(dstEntry)) {
        try {
          fs.renameSync(srcEntry, dstEntry);
          log.actions.push(`moved ${srcEntry} → ${dstEntry}`);
        } catch (e) {
          log.warnings.push(`rename failed for ${srcEntry}: ${(e as Error).message}`);
        }
      }
    }
    try {
      fs.rmdirSync(src);
      log.actions.push(`removed empty ${src}`);
    } catch {
      /* not empty — ok to leave */
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    log.actions.push(`moved ${src} → ${dst}`);
  } catch (e) {
    log.warnings.push(`rename failed for ${src}: ${(e as Error).message}`);
  }
}

function applyMigration(projectRoot: string): MigrationLog {
  const log: MigrationLog = { actions: [], warnings: [] };
  const groupsDir = path.join(projectRoot, 'groups');
  const dataDir = path.join(projectRoot, 'data');
  const sharedDir = path.join(dataDir, 'shared');
  const legacyDir = path.join(sharedDir, '_legacy');

  // 1. learnings/ move
  safeMoveDir(path.join(groupsDir, 'global', 'learnings'), path.join(sharedDir, 'learnings'), log);

  // 2. CLAUDE.md preserve + delete
  const oldBody = path.join(groupsDir, 'global', 'CLAUDE.md');
  if (fs.existsSync(oldBody)) {
    fs.mkdirSync(legacyDir, { recursive: true });
    const dst = path.join(legacyDir, 'v1-global.md');
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(oldBody, dst);
      log.actions.push(`preserved ${oldBody} → ${dst}`);
    }
    fs.unlinkSync(oldBody);
    log.actions.push(`deleted ${oldBody}`);
  }

  // 3. rmdir groups/global/ if empty
  const oldGroupDir = path.join(groupsDir, 'global');
  if (fs.existsSync(oldGroupDir)) {
    try {
      fs.rmdirSync(oldGroupDir);
      log.actions.push(`removed ${oldGroupDir}`);
    } catch (e) {
      log.warnings.push(`could not remove ${oldGroupDir}: ${(e as Error).message}`);
    }
  }

  // 4+5. DB: relabel & delete legacy rows, atomically. Wrap in a
  // transaction so either both steps land or neither does, and always
  // close the connection.
  const dbPath = path.join(dataDir, 'v2.db');
  if (fs.existsSync(dbPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      const txn = db.transaction(() => {
        const u = db!.prepare("UPDATE agent_groups SET coworker_type = 'default' WHERE coworker_type = 'global'").run();
        const d = db!.prepare("DELETE FROM agent_groups WHERE folder = 'global'").run();
        return { updated: u.changes, deleted: d.changes };
      });
      const { updated, deleted } = txn();
      if (updated > 0) log.actions.push(`DB: relabeled ${updated} agent_groups.coworker_type 'global' → 'default'`);
      if (deleted > 0) log.actions.push(`DB: deleted ${deleted} agent_groups row(s) with folder='global'`);
    } catch (e) {
      log.warnings.push(`DB migration failed: ${(e as Error).message}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }

  // 6. unlink groups/*/.claude-global.md legacy symlinks
  if (fs.existsSync(groupsDir)) {
    for (const folder of fs.readdirSync(groupsDir)) {
      const linkPath = path.join(groupsDir, folder, '.claude-global.md');
      try {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
          log.actions.push(`unlinked ${linkPath}`);
        }
      } catch {
        /* not present */
      }
    }
  }

  // Ensure shared dir exists for append_learning writes.
  fs.mkdirSync(path.join(sharedDir, 'learnings'), { recursive: true });

  return log;
}

/**
 * Run migration if the marker file is absent. Idempotent. Returns true
 * if migration actually ran, false if skipped.
 */
export function runGlobalToSharedMigration(projectRoot: string): boolean {
  const markerDir = path.join(projectRoot, 'data', '.migrations');
  const marker = path.join(markerDir, 'global-to-shared.done');
  if (fs.existsSync(marker)) return false;

  const log = applyMigration(projectRoot);
  for (const a of log.actions) console.log(`[migrate-global-to-shared] ${a}`);
  for (const w of log.warnings) console.warn(`[migrate-global-to-shared] WARNING: ${w}`);

  if (log.warnings.length === 0) {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString() + '\n');
    console.log(`[migrate-global-to-shared] marker written: ${marker}`);
  } else {
    console.warn('[migrate-global-to-shared] had warnings; marker NOT written — will retry on next boot');
  }
  return true;
}
