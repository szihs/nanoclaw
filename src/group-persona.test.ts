import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { PERSONA_PREPEND_FILE, readGroupPersona, stageGroupPersona } from './group-persona.js';
import { log } from './log.js';

const TMP = '/tmp/nanoclaw-group-persona-test';

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readGroupPersona', () => {
  it('returns null when the prepend file is absent', () => {
    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '  \n\n');
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('returns the trimmed content when present', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '\nYou are an SDR agent.\n\n');
    expect(readGroupPersona(TMP)).toBe('You are an SDR agent.');
  });

  it('does not follow a symlink', () => {
    const target = path.join(TMP, 'outside.md');
    fs.writeFileSync(target, 'host-only content\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));

    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Could not read group standing instructions; omitting persona',
      expect.objectContaining({ file: path.join(TMP, PERSONA_PREPEND_FILE) }),
    );
  });
});

describe('stageGroupPersona', () => {
  it('creates standing instructions once', () => {
    expect(stageGroupPersona(TMP, 'You are concise.\n\n')).toBe(true);
    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(path.join(TMP, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are concise.\n');
  });

  it('does not replace an existing symlink', () => {
    const target = path.join(TMP, 'target.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));

    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
  });
});

// Symmetry with "every writer of the composed document publishes atomically" in
// `composed-doc-atomic-write.test.ts`: every READER of an agent-authored
// instructions file goes through the no-follow reader above. Both scripts read
// the legacy `.instructions.md` out of a group directory that is mounted
// read-write into a container, and both feed it somewhere it is trusted — one
// composes it into a document the agent runs under, the other exports it as the
// group's instructions in a v2 bundle. Neither has an exported seam to call, so
// the guard is against their source; the behaviour itself is covered by
// `readGroupPersona` above and `readStandingInstructions` in
// `container-runner.test.ts`.
//
// Asserted by CALL SHAPE, not by counting matches in the file: a count also
// counts the import and any prose, so it would pass or fail for reasons that
// have nothing to do with how the file is read.
describe('every reader of an agent-authored instructions file refuses symlinks', () => {
  const read = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8');

  it('the lego-templates migration reads instructions with O_NOFOLLOW', () => {
    const source = read('scripts/migrate-to-lego-templates.ts');
    const body = source.slice(source.indexOf('function readInstructions'));

    expect(body).toMatch(/readStandingInstructionsFile\(/);
    // The shape that was there before: `existsSync` then a plain `readFileSync`
    // of the same path, which follows a symlink to anywhere on the host.
    expect(body.slice(0, body.indexOf('\n}'))).not.toMatch(/readFileSync\(|existsSync\(/);
  });

  it('the v1 export reads instructions with O_NOFOLLOW', () => {
    const source = read('scripts/migrate-v1-to-v2.ts');

    expect(source).toMatch(/readStandingInstructionsFile\(path\.join\(groupDir, '\.instructions\.md'\)\)/);
    // Only this read changes: `readFileOr` still serves CLAUDE.md and the memory
    // files, which v1 composed rather than an agent.
    expect(source).not.toMatch(/readFileOr\(path\.join\(groupDir, '\.instructions\.md'\)\)/);
    expect(source).toMatch(/readFileOr\(path\.join\(groupDir, 'CLAUDE\.md'\)\)/);
  });
});
