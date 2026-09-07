/**
 * The content phase changed composed bytes on purpose. This bounds by how much.
 *
 * Reviewing the commit diff is not enough: a squash, a rebase, or a later edit to
 * the same goldens all erase that evidence. So the pre-change goldens are kept as
 * immutable fixtures, the substitution is applied PROGRAMMATICALLY, and the result
 * is compared to the shipped goldens. If anything else moved, the transform cannot
 * reproduce them.
 *
 * The fix: `agents.md:20` pointed at `#chain-reporting`, which resolves to nothing —
 * measured, zero matching sections in any composed document. `main-body.md:25`
 * already links the same concept as `#chain-communication--the-rules`, which does
 * exist (`main.md:234`), so this is a retarget to the section that was always meant,
 * not a de-link.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { composeCoworkerSpine } from '../claude-composer.js';
import { PARITY_MCP, PARITY_PERSONA } from './parity.fixtures.js';

const GOLDEN_DIR = path.join(import.meta.dirname, '__goldens__');
const PRE_DIR = path.join(import.meta.dirname, '__goldens__', 'pre-anchor-retarget');

const OLD_ANCHOR = '[chain-reporting](#chain-reporting)';
const NEW_ANCHOR = '[chain-reporting](#chain-communication--the-rules)';

/** Only `main` carries `agents.md`; the other two types compose without it. */
const AFFECTED = ['main', 'main.persona'] as const;
const UNAFFECTED = ['base-common', 'base-common.persona', 'default', 'default.persona'] as const;

function golden(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, `${name}.md`), 'utf-8');
}

describe('the anchor retarget is the only content change', () => {
  for (const name of AFFECTED) {
    it(`${name}: applying the substitution to the pre-change golden reproduces the shipped one`, () => {
      const before = golden(PRE_DIR, name);

      // Exact cardinality, asserted before transforming. "Transformed equality"
      // alone would also pass if the substitution had been applied twice, or if a
      // second unrelated edit happened to cancel out.
      expect(before.split(OLD_ANCHOR).length - 1).toBe(1);

      const transformed = before.replaceAll(OLD_ANCHOR, NEW_ANCHOR);

      expect(transformed).toBe(golden(GOLDEN_DIR, name));
      // Byte delta is the length difference of the two anchor strings, nothing more.
      expect(Buffer.byteLength(transformed) - Buffer.byteLength(before)).toBe(
        Buffer.byteLength(NEW_ANCHOR) - Buffer.byteLength(OLD_ANCHOR),
      );
    });
  }

  for (const name of UNAFFECTED) {
    it(`${name}: untouched by the content phase`, () => {
      expect(golden(GOLDEN_DIR, name)).toBe(golden(PRE_DIR, name));
    });
  }

  it('leaves no unresolved chain-reporting anchor in any composed document', () => {
    for (const type of ['base-common', 'main', 'default']) {
      const out = composeCoworkerSpine({
        coworkerType: type,
        extraInstructions: PARITY_PERSONA,
        mcpInstructions: PARITY_MCP,
        projectRoot: process.cwd(),
      });

      expect(out, type).not.toContain(OLD_ANCHOR);
    }
  });

  // The retarget is only correct if the new anchor's slug actually exists. `main` is
  // the type that carries both the reference and the target section.
  it('points at a section that exists', () => {
    const out = composeCoworkerSpine({ coworkerType: 'main', projectRoot: process.cwd() });
    const slugs = new Set(
      (out.match(/^#{1,6} .+$/gm) ?? []).map((h) =>
        h
          .replace(/^#+ /, '')
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, '')
          .trim()
          .replace(/ /g, '-'),
      ),
    );

    expect(slugs).toContain('chain-communication--the-rules');
  });
});
