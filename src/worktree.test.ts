import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config to point WORKTREES_DIR at a scratch tmp dir.
let TMP_ROOT: string;
let SRC_REPO: string;

vi.mock('./config.js', () => ({
  get WORKTREES_DIR() {
    return path.join(TMP_ROOT, 'worktrees');
  },
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Import AFTER the mocks above.
import { ensureGitRepo, getOrCreateWorktree, pruneOrphanWorktrees, removeWorktree } from './worktree.js';

beforeEach(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-wt-'));
  SRC_REPO = path.join(TMP_ROOT, 'src-repo');
  fs.mkdirSync(SRC_REPO, { recursive: true });
  execFileSync('git', ['-C', SRC_REPO, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', SRC_REPO, 'config', 'user.email', 't@t'], { stdio: 'pipe' });
  execFileSync('git', ['-C', SRC_REPO, 'config', 'user.name', 't'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(SRC_REPO, 'README.md'), 'hello');
  execFileSync('git', ['-C', SRC_REPO, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', SRC_REPO, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });
});

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('ensureGitRepo', () => {
  it('is a no-op on an existing repo', () => {
    expect(() => ensureGitRepo(SRC_REPO)).not.toThrow();
  });

  it('throws with a helpful message on a non-repo path', () => {
    const bare = path.join(TMP_ROOT, 'not-a-repo');
    fs.mkdirSync(bare);
    expect(() => ensureGitRepo(bare)).toThrow(/AGENT_RUNTIME=local requires/);
  });
});

describe('getOrCreateWorktree', () => {
  it('creates a worktree on first call', () => {
    const wt = getOrCreateWorktree('group-a', SRC_REPO);
    expect(fs.existsSync(path.join(wt, 'README.md'))).toBe(true);
  });

  it('reuses the worktree on subsequent calls for the same folder', () => {
    const wt1 = getOrCreateWorktree('group-a', SRC_REPO);
    // touch a marker so we can detect accidental recreation
    fs.writeFileSync(path.join(wt1, '.marker'), 'present');
    const wt2 = getOrCreateWorktree('group-a', SRC_REPO);
    expect(wt2).toBe(wt1);
    expect(fs.existsSync(path.join(wt2, '.marker'))).toBe(true);
  });

  it('rejects unsafe folder names', () => {
    expect(() => getOrCreateWorktree('../escape', SRC_REPO)).toThrow(/Unsafe worktree name/);
  });

  it('recreates when a stale directory exists without a registered worktree', () => {
    const worktreeRoot = path.join(TMP_ROOT, 'worktrees');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const stalePath = path.join(worktreeRoot, 'group-b');
    fs.mkdirSync(stalePath);
    fs.writeFileSync(path.join(stalePath, '.stale'), 'yes');
    const wt = getOrCreateWorktree('group-b', SRC_REPO);
    expect(wt).toBe(stalePath);
    expect(fs.existsSync(path.join(wt, '.stale'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'README.md'))).toBe(true);
  });
});

describe('removeWorktree', () => {
  it('removes both the directory and the git registration', () => {
    const wt = getOrCreateWorktree('group-a', SRC_REPO);
    expect(fs.existsSync(wt)).toBe(true);
    removeWorktree('group-a', SRC_REPO);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('is idempotent when the worktree has already been removed', () => {
    getOrCreateWorktree('group-a', SRC_REPO);
    removeWorktree('group-a', SRC_REPO);
    expect(() => removeWorktree('group-a', SRC_REPO)).not.toThrow();
  });
});

describe('pruneOrphanWorktrees', () => {
  it('removes directories under WORKTREES_DIR that are not registered worktrees', () => {
    getOrCreateWorktree('kept', SRC_REPO);
    const orphan = path.join(TMP_ROOT, 'worktrees', 'orphan');
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, 'trash.txt'), 'garbage');

    pruneOrphanWorktrees(SRC_REPO);

    expect(fs.existsSync(path.join(TMP_ROOT, 'worktrees', 'kept'))).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('is a no-op when WORKTREES_DIR does not exist', () => {
    // Ensure the directory is absent — no worktree has been created in this test.
    const wtDir = path.join(TMP_ROOT, 'worktrees');
    expect(fs.existsSync(wtDir)).toBe(false);
    expect(() => pruneOrphanWorktrees(SRC_REPO)).not.toThrow();
  });
});
