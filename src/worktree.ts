/**
 * Git worktree helpers for AGENT_RUNTIME=local.
 *
 * Each agent group gets an isolated working tree under WORKTREES_DIR. Local
 * agent processes cwd into the worktree so concurrent agents don't race on
 * the host repo's index / HEAD. The host repo remains the source of truth;
 * worktrees are disposable.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { WORKTREES_DIR } from './config.js';
import { log } from './log.js';

/** Safe characters for worktree folder names (matches container name rules). */
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function assertSafeName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Unsafe worktree name: ${name}`);
  }
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the source directory is a git repo. Throws with a helpful message
 * if not — local mode requires a git repo as the worktree source.
 */
export function ensureGitRepo(sourceDir: string): void {
  if (isGitRepo(sourceDir)) return;
  throw new Error(
    `AGENT_RUNTIME=local requires ${sourceDir} to be a git repository. ` +
      `Initialize it with 'git init' (and make at least one commit) or switch back to AGENT_RUNTIME=docker.`,
  );
}

/**
 * Get or create a git worktree for an agent group. Returns the absolute
 * worktree path. Idempotent — if a worktree for this folder already exists
 * and is still valid, reuses it.
 *
 * The worktree checks out a detached HEAD at `sourceDir`'s HEAD so the
 * source repo's branch work is unaffected.
 */
export function getOrCreateWorktree(folder: string, sourceDir: string): string {
  assertSafeName(folder);
  const worktreePath = path.join(WORKTREES_DIR, folder);

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Reuse if the worktree directory already contains a .git link file that
  // resolves to a worktree registered with the source repo.
  if (fs.existsSync(worktreePath)) {
    try {
      const worktreeList = execFileSync('git', ['-C', sourceDir, 'worktree', 'list', '--porcelain'], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (worktreeList.includes(`worktree ${worktreePath}\n`)) {
        log.debug('Reusing existing worktree', { folder, worktreePath });
        return worktreePath;
      }
    } catch {
      /* fall through — recreate */
    }
    // Stale directory without matching registration — wipe and recreate.
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  ensureGitRepo(sourceDir);

  execFileSync('git', ['-C', sourceDir, 'worktree', 'add', '--detach', worktreePath, 'HEAD'], {
    stdio: 'pipe',
  });
  log.info('Created worktree', { folder, worktreePath });
  return worktreePath;
}

/** Remove a worktree directory and its git registration. Idempotent. */
export function removeWorktree(folder: string, sourceDir: string): void {
  assertSafeName(folder);
  const worktreePath = path.join(WORKTREES_DIR, folder);
  try {
    execFileSync('git', ['-C', sourceDir, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'pipe',
    });
    log.debug('Removed worktree', { folder });
  } catch (err) {
    // Fall back to directory removal + prune.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', sourceDir, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch {
      /* best-effort */
    }
    log.debug('Worktree remove failed — fell back to manual cleanup', { folder, err });
  }
}

/**
 * Clean up stale worktrees at startup. Removes any subdirectory of
 * WORKTREES_DIR that is not registered with the source repo's worktree list,
 * then runs `git worktree prune` to drop orphan administrative entries.
 */
export function pruneOrphanWorktrees(sourceDir: string): void {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  let registered: Set<string>;
  try {
    const porcelain = execFileSync('git', ['-C', sourceDir, 'worktree', 'list', '--porcelain'], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    registered = new Set(
      porcelain
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length)),
    );
  } catch {
    log.warn('Could not list worktrees; skipping orphan prune');
    return;
  }

  for (const entry of fs.readdirSync(WORKTREES_DIR)) {
    const fullPath = path.join(WORKTREES_DIR, entry);
    if (!registered.has(fullPath)) {
      log.info('Removing orphan worktree directory', { path: fullPath });
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }

  try {
    execFileSync('git', ['-C', sourceDir, 'worktree', 'prune'], { stdio: 'pipe' });
  } catch {
    /* best-effort */
  }
}
