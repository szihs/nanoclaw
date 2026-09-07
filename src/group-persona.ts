import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Marker opening every composed group document.
 *
 * `CLAUDE.md` is the *output* of composition — spine fragments, workflows,
 * skills, and `instructions.prepend.md` merged together. `instructions.prepend.md`
 * is one *input* to it. The two are not interchangeable, and feeding a composed
 * document back in as persona compounds it on every spawn.
 *
 * `.claude/skills/migrate-memory/SKILL.md` already keys generated-vs-authored off
 * this marker, so the same string is what the writer must emit.
 */
export const COMPOSED_DOC_MARKER = '<!-- Composed at spawn';

/**
 * True when a document was produced by the composer rather than written by a
 * human. Only the head is inspected: the marker is the first line by contract,
 * and a persona file can legitimately mention it further down.
 */
export function isComposedDocument(content: string): boolean {
  return content.slice(0, 400).includes(COMPOSED_DOC_MARKER);
}

/**
 * Publish a composed document by writing a temp sibling and renaming over the
 * target, so a container spawn racing composition reads either the previous
 * document or the new one — never a truncated prefix. `assertComposedDocUsable`
 * only checks `size > 0`, so a torn file would otherwise pass as usable.
 *
 * `randomUUID()` rather than a `pid`-and-timestamp name, plus `wx`: the group dir
 * is agent-writable, so a reconstructible temp path can be pre-created as a
 * symlink pointing anywhere the host can write, and `wx` then fails closed
 * instead of following it. That bounds pre-creation; it does not bound an
 * in-flight swap of the temp entry between the write and the rename — an
 * unguessable name is what makes that race impractical rather than impossible.
 *
 * Renaming does NOT reach a running container — the composed document is a *file*
 * bind mount, so an established mount keeps pointing at the old inode. This
 * protects the next spawn from a torn read; live update is `killContainer`'s job.
 * Nor is it crash-durable: there is no `fsync`, so this orders visibility, not
 * persistence.
 */
export function writeComposedDocument(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  let created = false;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    created = true;
    fs.renameSync(tmp, filePath);
  } finally {
    // Only clean up an entry this call created. Without the guard a `wx` failure
    // — the path already existed, i.e. someone else's file — would be deleted on
    // the way out, turning a refusal to overwrite into a deletion.
    if (created) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Expected: the rename consumed it.
      }
    }
  }
}

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Read one standing-instructions file without following symlinks, reporting
 * PRESENCE separately from content.
 *
 * `present` distinguishes "no such path" from "a path exists but yields no
 * usable instructions" (empty, whitespace-only, a directory, a symlink). Callers
 * that fall back to a second file need that distinction: treating a null content
 * as absence lets an existing-but-empty canonical file hand precedence to a stale
 * legacy one.
 *
 * `O_NOFOLLOW` is the security boundary, not a nicety. These files live in the
 * group directory, which is mounted read-WRITE into the container, so their
 * content is agent-authored — and it lands verbatim in the next composed system
 * prompt. Following a symlink here turns "edit your own persona" into an
 * arbitrary host-file read.
 */
export function readStandingInstructionsFile(file: string): { present: boolean; content: string | null } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return { present: true, content: null };
    const content = fs.readFileSync(fd, 'utf-8').trim();
    return { present: true, content: content || null };
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return { present: false, content: null };
    }
    // ELOOP from O_NOFOLLOW lands here: the path exists, so `present` stays true
    // and no fallback may override it.
    log.warn('Could not read group standing instructions; omitting persona', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return { present: true, content: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read a group's standing instructions without following symlinks. */
export function readGroupPersona(groupDir: string): string | null {
  return readStandingInstructionsFile(path.join(groupDir, PERSONA_PREPEND_FILE)).content;
}
