/**
 * The composed `CLAUDE.md` is published into a group dir that the agent itself
 * can write, and it is a bind-mount source read at container spawn. A plain
 * `writeFileSync` is therefore two hazards at once:
 *
 *   - a spawn racing the write reads a TRUNCATED document, and
 *     `assertComposedDocUsable` only checks `size > 0`, so a torn file passes
 *     as "usable" and the agent boots on half its instructions;
 *   - a predictable temp path in an agent-writable dir is symlink-plantable,
 *     which is why the temp name must be unguessable rather than
 *     `pid`-and-timestamp.
 *
 * Upstream solved this in `project-doc-compose.ts` (`writeAtomic`); this is that
 * helper, living beside the composed-document marker it pairs with. These tests
 * pin the behaviour and that EVERY writer of the document uses it — the typed
 * spawn path is the one most real groups take, and it was the one an earlier
 * revision of the plan missed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeComposedDocument } from './group-persona.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-doc-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('writeComposedDocument', () => {
  it('writes the full content', () => {
    const target = path.join(tmp, 'CLAUDE.md');

    writeComposedDocument(target, 'composed body\n');

    expect(fs.readFileSync(target, 'utf-8')).toBe('composed body\n');
  });

  it('replaces an existing document', () => {
    const target = path.join(tmp, 'CLAUDE.md');
    fs.writeFileSync(target, 'old\n');

    writeComposedDocument(target, 'new\n');

    expect(fs.readFileSync(target, 'utf-8')).toBe('new\n');
  });

  // The point of the exercise: a reader either sees the old document or the new
  // one, never a partial write. Observable via the inode — a fresh one means the
  // bytes were assembled elsewhere and swapped in.
  it('publishes by rename, so the target is never partially written', () => {
    const target = path.join(tmp, 'CLAUDE.md');
    fs.writeFileSync(target, 'old\n');
    const before = fs.statSync(target).ino;

    writeComposedDocument(target, 'x'.repeat(200_000));

    expect(fs.statSync(target).ino).not.toBe(before);
  });

  it('leaves no temp file behind', () => {
    const target = path.join(tmp, 'CLAUDE.md');

    writeComposedDocument(target, 'body\n');

    expect(fs.readdirSync(tmp)).toEqual(['CLAUDE.md']);
  });

  // A rename failure must leave the PREVIOUS document intact and clean up the
  // temp file. `assertComposedDocUsable` then spawns on that previous document
  // rather than refusing — losing the update is recoverable, losing the document
  // is not.
  it('leaves the previous document intact when the rename fails', () => {
    const target = path.join(tmp, 'CLAUDE.md');
    fs.writeFileSync(target, 'previous\n');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    });

    try {
      expect(() => writeComposedDocument(target, 'next\n')).toThrow(/EXDEV/);
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(target, 'utf-8')).toBe('previous\n');
    expect(fs.readdirSync(tmp)).toEqual(['CLAUDE.md']);
  });
});

/**
 * `randomUUID()` makes the temp name unguessable, so a test cannot plant the
 * name the implementation will pick — but it can learn that name by intercepting
 * the write, which turns the symlink guarantee into a real assertion rather than
 * a structural one.
 */
describe('temp-path hardening', () => {
  it('refuses to write through a symlink planted at its own temp path', () => {
    const target = path.join(tmp, 'CLAUDE.md');
    fs.writeFileSync(target, 'previous\n');
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'untouched\n');

    // Intercept the first write to learn the real temp path, plant a symlink to
    // the victim there, and let the call proceed. `wx` must reject the existing
    // path instead of following it.
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest) => {
      spy.mockRestore();
      fs.symlinkSync(victim, p as string);
      return (real as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => writeComposedDocument(target, 'attacker-visible\n')).toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched\n');
    expect(fs.readFileSync(target, 'utf-8')).toBe('previous\n');
  });

  // A `wx` refusal must not become a deletion: the entry it collided with
  // belongs to someone else, and an unconditional cleanup would remove it.
  it('does not delete the colliding entry when its temp path already exists', () => {
    const target = path.join(tmp, 'CLAUDE.md');

    // Occupy the exact temp path the call is about to use, so `wx` collides with
    // a real file. The cleanup must leave it alone: it is not ours to remove.
    let occupied: string | undefined;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor) => {
      spy.mockRestore();
      occupied = p as string;
      fs.writeFileSync(occupied, 'not mine\n');
      throw Object.assign(new Error(`EEXIST: file already exists, open '${occupied}'`), { code: 'EEXIST' });
    }) as typeof fs.writeFileSync);

    try {
      expect(() => writeComposedDocument(target, 'composed\n')).toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
    }

    expect(occupied).toBeDefined();
    expect(fs.existsSync(occupied!)).toBe(true);
    expect(fs.readFileSync(occupied!, 'utf-8')).toBe('not mine\n');
  });

  // Belt to the above brace: the policy itself, so a future edit that swaps
  // `randomUUID()` for a reconstructible name fails here even if the behavioural
  // test above is ever weakened.
  it('derives the temp name from randomUUID, not pid/timestamp', () => {
    const source = fs.readFileSync(new URL('./group-persona.ts', import.meta.url), 'utf-8');
    const body = source.slice(source.indexOf('function writeComposedDocument'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);

    expect(fn).toContain('randomUUID()');
    expect(fn).not.toMatch(/process\.pid|Date\.now\(\)/);
  });
});

describe('both compose paths publish atomically', () => {
  const source = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf-8');

  it('never writes the composed document with a bare writeFileSync', () => {
    const bareComposedWrites = source.match(/fs\.writeFileSync\(claudeMdPath/g) ?? [];

    expect(bareComposedWrites).toHaveLength(0);
  });

  // ONE write site, down from two. The typed and untyped arms were collapsed into a
  // single publication path — so "fixing only one leaves most real groups
  // torn-writable" is no longer a way to be wrong, because there is only one.
  // The count is still asserted: a second write site reappearing means the arms
  // were forked again, which is the regression this file was written for.
  it('routes the one compose path through writeComposedDocument', () => {
    const atomicWrites = source.match(/writeComposedDocument\(claudeMdPath/g) ?? [];

    expect(atomicWrites).toHaveLength(1);
  });
});

describe('every writer of the composed document publishes atomically', () => {
  // The spawn path is not the only writer: `npm run rebuild:claude` and the
  // lego migration write the same file, and a spawn racing either one would read
  // a torn document just the same.
  const writers = ['scripts/rebuild-claude-md.ts', 'scripts/migrate-to-lego-templates.ts'];

  it.each(writers)('%s does not write the document with a bare writeFileSync', (rel) => {
    const source = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8');

    expect(source).toContain('writeComposedDocument(');
    expect(source).not.toMatch(/fs\.writeFileSync\((?:filePath|claudeMd)\b/);
  });
});
