/**
 * The cap only helps if it sits where every composition passes, and if refusing
 * lands the group on a *usable* fallback rather than a technically-non-empty file.
 *
 * Two halves, both from constraint 5 of the plan:
 *
 *   1. The check runs BEFORE atomic publication. Checking after the write would
 *      publish the unusable document first and defeat the fallback entirely.
 *   2. `assertComposedDocUsable` used to accept `size > 0`, so a whitespace-only
 *      document counted as a healthy previous document. The group spawned with no
 *      instructions while the log claimed a successful fallback.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertComposedDocUsable } from './container-runner.js';
import { PROJECT_DOC_MAX_BYTES } from './claude-composer/doc-size-cap.js';
import type { AgentGroup } from './types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const GROUP = { folder: 'g', name: 'G' } as AgentGroup;

let dir: string;
let claudeMd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-wiring-'));
  claudeMd = path.join(dir, 'CLAUDE.md');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('assertComposedDocUsable', () => {
  it('accepts a real previous document', () => {
    fs.writeFileSync(claudeMd, '# Coworker\n\nInstructions.\n');

    expect(() => assertComposedDocUsable(claudeMd, GROUP, new Error('too large'))).not.toThrow();
  });

  it('refuses when no document exists', () => {
    expect(() => assertComposedDocUsable(claudeMd, GROUP, new Error('too large'))).toThrow(/no usable document exists/);
  });

  it('refuses an empty document', () => {
    fs.writeFileSync(claudeMd, '');

    expect(() => assertComposedDocUsable(claudeMd, GROUP, new Error('too large'))).toThrow();
  });

  // The tightening. `size > 0` passed this: 40 bytes of whitespace looked like a
  // healthy fallback, and the group spawned carrying no instructions at all.
  it('refuses a whitespace-only document that size > 0 accepted', () => {
    fs.writeFileSync(claudeMd, '\n\n   \t\n  \n'.repeat(4));
    expect(fs.statSync(claudeMd).size).toBeGreaterThan(0);

    expect(() => assertComposedDocUsable(claudeMd, GROUP, new Error('too large'))).toThrow(/no usable document exists/);
  });

  it('refuses a directory at the document path', () => {
    fs.mkdirSync(claudeMd);

    expect(() => assertComposedDocUsable(claudeMd, GROUP, new Error('too large'))).toThrow();
  });

  // The thrown error must carry the compose failure, or the operator sees "no
  // usable document" with no clue why composition failed.
  it('preserves the underlying cause', () => {
    expect(() => assertComposedDocUsable(claudeMd, GROUP, new Error('over the 4194304-byte cap'))).toThrow(
      /over the 4194304-byte cap/,
    );
  });
});

describe('the cap sits on the render seam', () => {
  const SOURCE = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf-8');
  const seam = SOURCE.slice(
    SOURCE.indexOf('export async function renderComposedDocument'),
    SOURCE.indexOf('export function assertComposedDocUsable'),
  );

  // One place, not per-write-site: this is the only function both spawn paths and
  // both staleness paths pass through.
  //
  // The cap moved from a standalone `assertWithinDocSizeCap(content, …)` after
  // assembly to a `maxBytes` handed to the assembler. Same seam, same
  // before-publication position, different mechanism — and the move is what makes
  // eviction possible at all: a check that only sees the finished string can
  // refuse, but it cannot drop the largest droppable section and retry.
  it('passes the cap to the assembler inside renderComposedDocument', () => {
    expect(seam).toContain('maxBytes: PROJECT_DOC_MAX_BYTES');
  });

  it('is the only place the cap is applied', () => {
    expect(SOURCE.match(/maxBytes: PROJECT_DOC_MAX_BYTES/g)).toHaveLength(1);
  });

  // Before publication, so the caller's catch can fall back. Applying it after the
  // write would already have replaced the group's good document.
  it('applies the cap before the content is returned for writing', () => {
    const checkAt = seam.indexOf('maxBytes: PROJECT_DOC_MAX_BYTES');
    const returnAt = seam.indexOf('return {');

    // Both must exist: `indexOf` returns -1 when the call is absent, and -1 is
    // less than any real offset, so a bare comparison passes vacuously on exactly
    // the regression this guards.
    expect(checkAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(returnAt);
  });

  // The seam is what makes spawn and the sweep agree. If the cap were applied at
  // one write site only, the sweep would hash a document spawn would reject.
  // Both staleness paths still reach it, but only one takes `.hash` inline now:
  // `recomposeAndUpdateHash` destructures it, because it also returns the hash to
  // its caller for the restart decision. Matching the call rather than the
  // destructuring shape keeps the invariant (both go through the seam) without
  // pinning one call's syntax.
  it('is reached by the staleness paths through the same seam', () => {
    expect(SOURCE.match(/renderComposedDocument\(ag\)/g)).toHaveLength(2);
  });
});

describe('real documents have headroom', () => {
  // Sanity floor: if a routine composed document were anywhere near the cap, this
  // change would brick the fleet rather than guard it. Measured at ~0.6% of the
  // cap for `main`.
  it('leaves the live documents far below the cap', async () => {
    const { composeCoworkerSpine } = await import('./claude-composer.js');

    for (const coworkerType of ['main', 'default']) {
      const bytes = Buffer.byteLength(composeCoworkerSpine({ coworkerType, projectRoot: process.cwd() }), 'utf-8');
      expect(bytes).toBeLessThan(PROJECT_DOC_MAX_BYTES / 10);
    }
  });
});
