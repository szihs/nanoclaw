import path from 'path';

import { describe, expect, it } from 'vitest';

import { isValidGroupFolder, resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
    expect(isValidGroupFolder('slang-writer')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('shared')).toBe(false);
    expect(isValidGroupFolder('templates')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it("rejects 'main' for non-admin groups; allows it during admin setup", () => {
    expect(isValidGroupFolder('main')).toBe(false);
    expect(isValidGroupFolder('main', { adminSetup: false })).toBe(false);
    expect(isValidGroupFolder('main', { adminSetup: true })).toBe(true);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(true);
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`)).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});
