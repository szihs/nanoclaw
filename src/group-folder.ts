import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Always reserved — these collide with system paths (groups/templates/ is
// the lego template tree; global is the retired flat type; shared is the
// data/shared/ mount namespace that must not also exist as a group dir).
const RESERVED_FOLDERS = new Set(['global', 'shared', 'templates']);

// Reserved only for non-admin groups. 'main' is the legitimate folder name
// for the single admin coworker, so `isValidGroupFolder('main', { adminSetup: true })`
// is allowed. Everywhere else, creating a user-facing folder called 'main'
// would collide with the admin orchestrator.
const ADMIN_ONLY_FOLDERS = new Set(['main']);

export interface GroupFolderValidationOptions {
  /** True when called during admin setup — allows 'main' as the folder name. */
  adminSetup?: boolean;
}

export function isValidGroupFolder(folder: string, opts: GroupFolderValidationOptions = {}): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  const lower = folder.toLowerCase();
  if (RESERVED_FOLDERS.has(lower)) return false;
  if (ADMIN_ONLY_FOLDERS.has(lower) && !opts.adminSetup) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
