/**
 * The composed document is rendered for four purposes — the two spawn paths
 * (untyped and typed) and the two staleness-hash paths (`recomposeAndUpdateHash`,
 * `detectStaleContainers`). Each used to build its own compose-options object.
 *
 * That duplication is the hazard: a section added to spawn but not to the hash
 * paths makes the digests disagree forever. The sweep then either sees drift on
 * every pass and restarts the container repeatedly, or misses a real change and
 * never refreshes. Neither shows up in a test that only exercises spawn, which is
 * why the seam is asserted structurally here as well as behaviourally.
 *
 * `renderComposedDocument` is that seam. These tests pin that it stays the only
 * compose call, and that the hash it returns is the hash of the content it
 * returns — the property both staleness paths depend on.
 */
import crypto from 'crypto';
import fs from 'fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderComposedDocument } from './container-runner.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const SOURCE = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf-8');

// The seam reads the group's `cli_scope` through `getContainerConfig`, so a live
// driver is required. No rows are seeded: a group with no `container_configs` row
// resolves to the 'group' default, which is what this case expects.
beforeAll(async () => {
  await runMigrations(await initTestDb());
});

afterAll(async () => {
  await closeDb();
});

describe('one render seam', () => {
  // The seam itself composes; nothing else in the runner should. The composer
  // entry point changed from `composeCoworkerSpine` (string) to
  // `renderCoworkerSections` + `renderProjectDoc` (sections, then assembly), so
  // both halves are pinned — a second producer call is the hazard, whichever name
  // it uses.
  it('is the only composer call site in the runner', () => {
    expect(SOURCE.match(/renderCoworkerSections\(/g) ?? []).toHaveLength(1);
    expect(SOURCE.match(/renderProjectDoc\(/g) ?? []).toHaveLength(1);
    expect(SOURCE.match(/composeCoworkerSpine\(/g) ?? []).toHaveLength(0);
  });

  // ONE, down from two. The typed and untyped publication arms were collapsed:
  // they differed only in the coworker type they named, and `composeOptionsFor`
  // already resolves an untyped group to the 'default' leaf. Two near-identical
  // arms was the shape that let their behaviour drift, which is what this test now
  // pins — a second arm reappearing is the regression.
  it('is reached by one shared publication path, not one per coworker kind', () => {
    expect(SOURCE.match(/await renderComposedDocument\(agentGroup\)/g) ?? []).toHaveLength(1);
  });

  // The sweep renders for a hash and publishes nothing, so `recomposeAndUpdateHash`
  // is now the only `(ag)` caller — `detectStaleContainers` reaches the seam through
  // its own call. Both still go through the seam, which is the invariant; the count
  // dropped because the sweep stopped being a publisher.
  it('is reached by the staleness paths through the same seam', () => {
    expect(SOURCE.match(/renderComposedDocument\(ag\)/g) ?? []).toHaveLength(2);
  });

  // No hash may be computed from a locally-composed string: that is exactly the
  // divergence this seam exists to prevent.
  it('computes no sha256 outside the seam except the on-disk baselines', () => {
    const hashes = SOURCE.match(/createHash\('sha256'\)/g) ?? [];

    // TWO, and both read from DISK — which is the whole point: no hash is computed
    // from a locally-composed string, so nothing can disagree with the assembler.
    //
    //   1. `assertComposedDocUsable` — digests the RETAINED document when a render
    //      or publication fails, so the caller reports the bytes actually on disk.
    //   2. the host-restart fallback — re-derives a baseline for a container this
    //      process did not spawn, so a restart doesn't make it invisible to the
    //      stale check.
    //
    // Spawn's own re-read is gone: it takes the digest from the seam now, which is
    // the digest of the exact bytes handed to `writeComposedDocument`. Re-reading
    // could only disagree, and did whenever the file predated the spawn.
    expect(hashes).toHaveLength(2);
    expect(SOURCE).not.toMatch(/readFileSync\(path\.join\(GROUPS_DIR, agentGroup\.folder, 'CLAUDE\.md'\)\)/);
  });
});

describe('hash/content agreement', () => {
  // Whatever the seam returns as `hash` must be the digest of what it returns as
  // `content`. Both staleness paths compare a hash produced this way against a
  // baseline hashed from the file on disk, so a disagreement makes every sweep see
  // permanent drift and respawn the container every 60 seconds, forever.
  //
  // This calls the seam. It used to assert that sha256-of-string equals
  // sha256-of-Buffer for a hand-written constant — a property of Node's crypto
  // module, true no matter what this file does. The seam could have returned a
  // hardcoded hash and it would still have passed.
  it('hashes the exact bytes it returns', async () => {
    const rendered = await renderComposedDocument({
      folder: 'seam-hash',
      name: 'Seam',
      coworker_type: 'main',
    } as AgentGroup);

    expect(rendered.hash).toBe(crypto.createHash('sha256').update(rendered.content).digest('hex'));
    // Guards against agreeing on emptiness: two digests of '' are also equal.
    expect(rendered.content.length).toBeGreaterThan(0);
  });
});

describe('stale comments removed', () => {
  // The old comment claimed the file on disk "may have @-import prefixes for flat
  // types", justifying two different hash bases. Measured: no such prefixing
  // exists anywhere, and both write sites persist the composed string verbatim.
  // Leaving the claim in place would send the next reader looking for a
  // divergence that cannot happen.
  it('no longer claims the on-disk document diverges from composer output', () => {
    expect(SOURCE).not.toMatch(/@-import prefixes/);
  });

  // Stronger than the old assertion, which only required a COMMENT saying a
  // recompose needs a kill to take effect. The sweep now publishes nothing at all —
  // no document, no markers — so the caveat is structural rather than documented:
  // there is nothing for a running container to fail to see. Asserted on the code,
  // not on prose, because a comment cannot regress.
  it('does not publish from the staleness path', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('export async function recomposeAndUpdateHash'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    expect(body).not.toMatch(/composeCoworkerClaudeMd\(/);
    expect(body).not.toMatch(/writeComposedDocument\(/);
    expect(body).not.toMatch(/materialize/);
    // And it still records the hash — without that, a sweep tick inside the async
    // shutdown window re-detects the old hash and fires a second kill.
    expect(body).toMatch(/spawnedClaudeMdHash\.set/);
  });
});
