/**
 * The publication contract: who may write, and what a caller must do when a write
 * only half-succeeded.
 *
 * Three properties, each of which was a live defect before this change:
 *
 *   1. The SWEEP publishes nothing. It used to publish the document and the
 *      markers, which mutates live enforcement for a container still running its
 *      OLD document (markers sit in the RW group-dir mount and three hooks `-f`
 *      test them at hook time), and made document and markers two separately
 *      failing writes that can strand a container on `D1 + M0` behind a matching
 *      hash the stale sweep can never see.
 *   2. A MARKER failure is distinguishable from a COMPOSE failure. They shared one
 *      catch, so a marker throw sent `assertComposedDocUsable` to read the document
 *      that same call had just written, find it non-empty, log "spawning on the
 *      previous document" — the wrong file and the wrong cause — and let the spawn
 *      proceed with markers describing the old document.
 *   3. SPAWN refuses to start on a marker failure, before recording a hash. It used
 *      to record the hash of the new document, which is exactly what
 *      `detectStaleContainers` computes next tick, so the divergence was permanent
 *      and invisible.
 *
 * Asserted against the source rather than by booting a container: these are
 * control-flow and ordering properties, and the alternative is a mock deep enough
 * that it would pin the mock instead of the code. Ordering is checked by offset
 * comparison, with each anchor's presence asserted first — `indexOf` returns -1 when
 * an anchor is absent, and -1 precedes every real offset, so a bare comparison would
 * pass vacuously on exactly the regression being guarded.
 */
import fs from 'fs';

import { describe, expect, it } from 'vitest';

const RUNNER = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf-8');
const SWEEP = fs.readFileSync(new URL('./host-sweep.ts', import.meta.url), 'utf-8');

function fnBody(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

describe('spawn is the only publisher', () => {
  const recompose = fnBody(RUNNER, 'export async function recomposeAndUpdateHash');

  it('the sweep path publishes neither the document nor the markers', () => {
    expect(recompose).not.toMatch(/composeCoworkerClaudeMd\(/);
    expect(recompose).not.toMatch(/writeComposedDocument\(/);
    expect(recompose).not.toMatch(/materialize/);
  });

  it('the sweep path still records the hash', () => {
    // Its one remaining job. `killContainer` is fire-and-forget, so the session
    // stays in `activeContainers` until `finishAndResolve` removes it; a sweep tick
    // inside that window would otherwise re-detect the OLD hash and fire a second
    // kill plus a second refresh message.
    expect(recompose).toMatch(/spawnedClaudeMdHash\.set/);
  });

  it('there is exactly one publication path, not one per coworker kind', () => {
    // The typed and untyped arms differed only in the coworker type they named,
    // while `composeOptionsFor` already resolves an untyped group to 'default'. Two
    // near-identical arms is the shape that lets behaviour drift.
    expect(RUNNER.match(/writeComposedDocument\(claudeMdPath/g) ?? []).toHaveLength(1);
    expect(RUNNER.match(/await renderComposedDocument\(agentGroup\)/g) ?? []).toHaveLength(1);
  });
});

describe('marker failure is distinguishable from compose failure', () => {
  const compose = fnBody(RUNNER, 'async function composeCoworkerClaudeMd');

  it('publishes the document before materializing markers', () => {
    const write = compose.indexOf('writeComposedDocument(claudeMdPath');
    const markers = compose.indexOf('materializeOverlayMarkers(');

    expect(write).toBeGreaterThan(-1);
    expect(markers).toBeGreaterThan(-1);
    expect(write).toBeLessThan(markers);
  });

  it('does not route a marker failure through the previous-document fallback', () => {
    // The document has already been replaced by the time markers run, so there is
    // nothing to fall back TO — and that helper would inspect the new document and
    // report it as the previous one.
    const markers = compose.indexOf('materializeOverlayMarkers(');
    const fallback = compose.indexOf('assertComposedDocUsable(');

    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(markers);
    expect(compose.slice(markers)).not.toMatch(/assertComposedDocUsable\(/);
  });

  it('reports a marker failure as markersStale rather than as a failed publication', () => {
    // `published: false` would make the caller adopt the retained hash and
    // republish the same document forever. The document DID publish; only the
    // markers did not.
    expect(compose).toMatch(/markersStale: true/);
    expect(compose).toMatch(/marker materialization failed/i);
  });

  it('names marker materialization in the log, not composition', () => {
    const line = compose.slice(compose.indexOf('materializeOverlayMarkers('));

    expect(line).toMatch(/marker materialization failed — refusing to spawn/);
    // Today's misattributed message must not be what an operator sees for this
    // failure: it named the wrong cause and counted the wrong file's bytes.
    expect(line).not.toMatch(/spawning on the retained document/);
  });
});

describe('spawn refuses to start on stale markers', () => {
  const spawn = fnBody(RUNNER, 'async function spawnContainer');

  it('aborts before recording the hash', () => {
    const abort = spawn.indexOf('markersStale');
    const record = spawn.indexOf('spawnedClaudeMdHash.set');

    expect(abort).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(-1);
    expect(abort).toBeLessThan(record);
  });

  it('aborts before the container is prepared or started', () => {
    const abort = spawn.indexOf('markersStale');

    // Presence asserted here too, not only in the sibling test: without it,
    // deleting the abort makes `indexOf` return -1, and -1 precedes every real
    // offset — so the ordering comparison would pass on exactly the regression.
    expect(abort).toBeGreaterThan(-1);
    for (const anchor of ['materializeContainerJson(', 'buildMounts(']) {
      const at = spawn.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(-1);
      expect(abort, anchor).toBeLessThan(at);
    }
  });

  it('takes the hash from the seam rather than re-reading the file', () => {
    // `published: true` gives the digest of the exact bytes handed to
    // `writeComposedDocument`; `published: false` gives the digest of the exact
    // retained document. A second read could only disagree — and did, whenever the
    // on-disk file predated this spawn.
    expect(spawn).toMatch(/spawnedClaudeMdHash\.set\(session\.id, projectDoc\.hash\)/);
    expect(spawn).not.toMatch(/readFileSync\(path\.join\(GROUPS_DIR, agentGroup\.folder, 'CLAUDE\.md'\)\)/);
  });

  it('throws rather than returning, so wakeContainer treats it as a failed wake', () => {
    // `wakeContainer` catches, logs, and returns false; pending messages stay in
    // `messages_in` for the sweep's due-message wake. Returning early instead would
    // report a successful wake for a container that never started.
    const abort = spawn.slice(spawn.indexOf('markersStale'));

    expect(abort.slice(0, abort.indexOf('\n\n'))).toMatch(/throw new Error/);
  });
});

describe('the sweep gates its restart on the outcome', () => {
  it('kills and notifies only when the recompose is restart-ready', () => {
    const kill = SWEEP.indexOf("killContainer(sessionId, 'claude-md-stale')");
    const gate = SWEEP.indexOf("outcome.kind !== 'restart-ready'");

    expect(gate).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(kill);
    // The refresh message must be gated too: announcing "your instructions were
    // updated" for an update that did not happen is its own defect.
    expect(gate).toBeLessThan(SWEEP.indexOf('claudemd-refresh-'));
  });

  // Every non-ready outcome, not just the one that motivated the gate. A guard
  // written as `if (outcome.kind === 'render-failed') continue` would pass the
  // restart-ready test above while still killing on a vanished session.
  it.each(['render-failed', 'session-gone', 'group-gone'])(
    'treats %s as non-restartable via the single negated check',
    (kind) => {
      const outcomes = fnBody(RUNNER, 'export type RecomposeOutcome');

      expect(outcomes).toContain(kind);
      // One negated comparison covers all of them by construction. Enumerating the
      // failure kinds instead would silently miss any kind added later.
      expect(SWEEP.match(/outcome\.kind !== 'restart-ready'/g) ?? []).toHaveLength(1);
      expect(SWEEP).not.toMatch(/outcome\.kind === '(render-failed|skipped)'/);
    },
  );

  // A persistent failure must not become a 60s kill loop — the defect the
  // unconditional body had: it killed the container and announced an update on
  // every tick, forever, for a recompose that never succeeded.
  it('does not kill on a repeated non-ready outcome', () => {
    const loop = SWEEP.slice(SWEEP.indexOf('for (const { sessionId, agentGroupId, folder } of stale)'));
    const beforeKill = loop.slice(0, loop.indexOf("killContainer(sessionId, 'claude-md-stale')"));

    // `continue`, not a logged warning that falls through: the kill has to be
    // unreachable for a non-ready outcome, on this tick and every later one.
    expect(beforeKill).toMatch(/if \(outcome\.kind !== 'restart-ready'\) continue;/);
  });

  it('wraps each stale session in its own try', () => {
    // The outer try wraps the whole tick, so a throw on one session used to skip
    // every remaining one — a single broken group silently disabling instruction
    // refresh fleet-wide.
    const loop = SWEEP.slice(SWEEP.indexOf('for (const { sessionId, agentGroupId, folder } of stale)'));
    const body = loop.slice(0, loop.indexOf('\n    }\n'));

    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/CLAUDE\.md refresh failed for session/);
  });
});

describe('rendering does not write', () => {
  // The sweep renders every group's candidate document every 60 seconds purely to
  // compare hashes. Anything the RENDER path writes therefore lands on the shared
  // group directory on a timer, for containers running a different document — the
  // exact hazard the sweep was made non-publishing to close.
  //
  // The rename was inside `readStandingInstructions`, which all four render call
  // sites share, so property 1 above held for the document and the markers but not
  // for the group directory as a whole.
  it('the standing-instructions read path performs no rename', () => {
    const read = fnBody(RUNNER, 'export function readStandingInstructions');

    expect(read).not.toMatch(/renameSync|writeFileSync|copyFileSync|mkdirSync/);
  });

  it('the migration lives in its own function, called only from publication', () => {
    expect(fnBody(RUNNER, 'export function migrateStandingInstructions')).toMatch(/renameSync\(/);

    // One caller, and it is the publisher. `renderComposedDocument` reaching it
    // would put the write back on the sweep's path by a different route.
    expect(RUNNER.match(/migrateStandingInstructions\(groupDir, instructionsPath\)/g) ?? []).toHaveLength(1);
    expect(fnBody(RUNNER, 'export async function renderComposedDocument')).not.toMatch(/migrateStandingInstructions/);
    expect(fnBody(RUNNER, 'async function composeCoworkerClaudeMd')).toMatch(/migrateStandingInstructions\(/);
  });
});

describe('size-cap pressure is reported', () => {
  // At base, spawn called `assertWithinDocSizeCap` inside the render, and that
  // helper emitted the near-cap warning. Moving the cap into the assembler removed
  // its last production caller, so a group could sit one byte under the cap — or
  // lose whole sections to eviction — with nothing in the log: the diagnostics were
  // computed and then discarded.
  const compose = fnBody(RUNNER, 'async function composeCoworkerClaudeMd');

  // WHERE it is called from. That it fires on the right condition is asserted
  // behaviourally against a mocked logger in `container-runner.test.ts` — a source
  // regex passes for logging that is dead or triggered by the wrong test.
  it('is reported from the publication path, after the markers', () => {
    const markers = compose.indexOf('materializeOverlayMarkers(');
    const report = compose.indexOf('reportProjectDocPressure(');

    expect(markers).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(-1);
    expect(markers).toBeLessThan(report);
  });

  it('is not reported from a failed publication', () => {
    // `published: false` returns through `assertComposedDocUsable`, which logs the
    // failure itself. Reporting pressure there would describe a document that was
    // never written.
    const fallback = compose.indexOf('assertComposedDocUsable(');
    const report = compose.indexOf('reportProjectDocPressure(');

    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(report);
    // One call, and it is inside the publisher. Counting the whole FILE instead
    // (declaration + call = 2) passes for the regression this is meant to catch:
    // move the declaration to another module, import it, add a render-path call,
    // and the file still holds two matches.
    expect(compose.match(/reportProjectDocPressure\(/g) ?? []).toHaveLength(1);
  });

  // Not in the render: the sweep calls that every 60s, so a near-cap document would
  // repeat the same warning until someone fixed it. Publication runs once per
  // spawn, which is the rate this should fire at.
  it('does not warn from the render seam, directly or indirectly', () => {
    const render = fnBody(RUNNER, 'export async function renderComposedDocument');

    expect(render).not.toMatch(/log\.(warn|error)\(/);
    // Named explicitly because the regression is a RESTORED call, not a new one:
    // `assertWithinDocSizeCap` logged on the caller's behalf, so a direct-call-only
    // assertion stays green when that line comes back. Matching the CALL, not the
    // bare name — this file and the runner both mention the helper in prose
    // explaining why it is gone.
    expect(render).not.toMatch(/assertWithinDocSizeCap\(/);
    expect(render).not.toMatch(/reportProjectDocPressure\(/);
  });

  // The helper had no production caller once the cap moved into the assembler, and
  // its policy is the OPPOSITE of the current one: refuse a whole oversized
  // document rather than evict what can be shed. Leaving it exported invites a
  // caller back to the superseded behaviour.
  it('the superseded standalone cap check is gone from the tree', () => {
    const capModule = fs.readFileSync(new URL('./claude-composer/doc-size-cap.ts', import.meta.url), 'utf-8');

    expect(capModule).not.toMatch(/function assertWithinDocSizeCap/);
    // The cap value and the error type are still the shared vocabulary; only the
    // check and its now-unreachable helpers went.
    expect(capModule).toMatch(/export const PROJECT_DOC_MAX_BYTES/);
    expect(capModule).toMatch(/export class ProjectDocTooLargeError/);
  });
});
