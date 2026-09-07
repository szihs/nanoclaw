/**
 * Byte-parity: the composed document must not change while the seam moves.
 *
 * Steps 1-9 of this refactor restructure how a document is assembled without
 * changing what it says, so every one of these goldens must stay byte-identical.
 * Only step 10 (three deliberate content fixes) may update them, and that commit
 * updates them visibly.
 *
 * This is the strongest available check on the refactor, and also the weakest in
 * one specific way, which is why it is not the whole verification plan: the three
 * in-tree types emit NEITHER `## Workflows` NOR `## Gate Protocol` — measured, zero
 * matches — because no coworker-types.yaml under `container/spines` declares
 * `workflows:`. So the highest-risk step has no coverage here, and the synthetic
 * fixtures in `claude-composer.test.ts` carry it instead.
 *
 * ## Why `main` is not byte-pinned
 *
 * Only types whose CONTENT this branch owns can be pinned to a golden here.
 * `main` is not one of them, and the reason is CI, not this refactor:
 * `ci.yml`'s test job merges every nv-* branch first ("test the composed state,
 * not standalone"), so `main` composes with sibling-branch skills that are absent
 * from a standalone checkout —
 * `origin/nv-slang:container/skills/slang-github-webhook/context/routing.md`
 * contributes a whole `## GitHub webhook routing` section, and the projects table
 * gains slang/slangpy rows. Measured: the same tree yields `main` = abaecd63bd33b299
 * standalone and 81022e6ba3c5e18e composed.
 *
 * A golden for `main` is therefore unpinnable from this branch in the environment
 * that matters, and would additionally go red on any unrelated nv-slang skill
 * edit. `base-common` and `default` compose only from nv-main-owned content and
 * ARE stable in both states — CI passes their byte tests while failing `main`'s,
 * which is the evidence for drawing the line exactly here.
 *
 * `main` keeps its coverage from assertions that do not depend on sibling content:
 * determinism and the second-H1 rule below (both over all three types), the
 * golden-to-golden transform in `anchor-retarget.test.ts`, and
 * `section-coverage.test.ts`. Its goldens stay on disk — that transform reads
 * them, and they still document the standalone document.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { composeCoworkerSpine } from '../claude-composer.js';
import { PARITY_MCP, PARITY_PERSONA, PARITY_TYPES } from './parity.fixtures.js';

/** The types composed from nv-main-owned content only — see the header. */
const BYTE_PINNED = ['base-common', 'default'] as const;

const GOLDEN_DIR = path.join(import.meta.dirname, '__goldens__');

function compose(type: string, withExtras: boolean): string {
  return composeCoworkerSpine({
    coworkerType: type,
    extraInstructions: withExtras ? PARITY_PERSONA : undefined,
    mcpInstructions: withExtras ? PARITY_MCP : undefined,
    projectRoot: process.cwd(),
  });
}

describe('composed-document byte parity', () => {
  for (const type of BYTE_PINNED) {
    for (const withExtras of [false, true]) {
      const name = withExtras ? `${type}.persona` : type;

      it(`${name} is byte-identical to its golden`, () => {
        const golden = fs.readFileSync(path.join(GOLDEN_DIR, `${name}.md`), 'utf-8');

        // Compare content, not just the digest: a mismatch should print the diff.
        expect(compose(type, withExtras)).toBe(golden);
      });
    }
  }

  // The digests the design records, asserted directly. Belt and braces over the
  // content comparison above: a golden file edited in the same commit as a
  // regression would let that test pass, and these constants would not.
  it('matches the recorded digests', () => {
    const digests: Record<string, string> = {
      'base-common': 'bbf5bfaf85f610b4',
      'base-common.persona': '9ece3c38c976fefa',
      // `main`/`main.persona` are absent by design, not omission: their bytes depend
      // on sibling-branch skills under CI's composed-state merge (header). The
      // standalone values the content phase produced — abaecd63bd33b299 and
      // 8129ebe911b83bec, moved once by the `agents.md` anchor retarget — are
      // preserved as the goldens on disk and asserted by `anchor-retarget.test.ts`,
      // which compares golden to golden and so holds in both states.
      default: 'e54e91ce72b8021c',
      'default.persona': 'cce70e837641f8da',
    };

    const actual: Record<string, string> = {};
    for (const type of BYTE_PINNED) {
      for (const withExtras of [false, true]) {
        const name = withExtras ? `${type}.persona` : type;
        actual[name] = crypto.createHash('sha256').update(compose(type, withExtras)).digest('hex').slice(0, 16);
      }
    }

    expect(actual).toEqual(digests);
  });

  // Composition is hashed by both the spawn path and the 60s staleness sweep. If
  // it varied between two calls the digests could never agree, and every
  // container would be killed and respawned once a minute, forever.
  it('is deterministic across repeated composition', () => {
    for (const type of PARITY_TYPES) {
      expect(compose(type, true)).toBe(compose(type, true));
    }
  });

  // `main` is the only flat type, and the flat path is the one that treats the
  // identity body's own `# Title` as structural. An H1 persona therefore yields a
  // second H1, which must remain legal — see parity.fixtures.ts.
  it('keeps a second H1 from an operator persona on the flat path', () => {
    const h1s = compose('main', true)
      .split('\n')
      .filter((l) => /^# \S/.test(l));

    expect(h1s.length).toBeGreaterThan(1);
  });
});
