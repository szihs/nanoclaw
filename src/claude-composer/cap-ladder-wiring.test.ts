/**
 * Eviction, end to end, through the real producers.
 *
 * `doc-size-cap.ts` deferred largest-first eviction "until the fork wires
 * droppable sections that can actually absorb the overflow", and refused instead.
 * Refusing was correct while every droppable candidate held nothing: measured on
 * the overflow case, `Additional Instructions` (the operator persona) was 5.2 MB
 * and every other section under 12 KB, so upstream's ladder would have evicted
 * the persona — silently discarding the operator's own instructions, which is the
 * failure the cap exists to prevent, relocated.
 *
 * Per-server MCP sections are the droppable source that changes it. These tests
 * use the REAL spine producers rather than synthetic sections, because the claim
 * being made is about the wiring: that a document composed from a live coworker
 * type can now shed weight instead of being refused.
 */
import { describe, expect, it } from 'vitest';

import { asNonEmpty, composedDocHeader, renderCoworkerSections } from '../claude-composer.js';
import { PROJECT_DOC_MAX_BYTES, ProjectDocTooLargeError } from './doc-size-cap.js';
import { renderProjectDoc } from './project-doc.js';

const PERSONA = '# Persona\n\nBe terse.';

function compose(mcpInstructions: Record<string, string>, maxBytes = PROJECT_DOC_MAX_BYTES) {
  return renderProjectDoc(composedDocHeader(), {
    fileName: 'CLAUDE.md',
    maxBytes,
    extraSections: asNonEmpty(renderCoworkerSections(process.cwd(), 'base-common', PERSONA, { mcpInstructions })),
  });
}

describe('cap ladder, wired through the real producers', () => {
  it('evicts only the oversized server and keeps the rest', () => {
    const out = compose({
      alpha: 'Use alpha.',
      huge: 'H'.repeat(5 * 1024 * 1024),
      zeta: 'Use zeta.',
    });

    expect(out.dropped).toEqual(['MCP Server: huge']);
    expect(out.diagnostics.bytes).toBeLessThanOrEqual(PROJECT_DOC_MAX_BYTES);
    // The point of per-server granularity: one bad server must not delete every
    // other server's guidance, which whole-section eviction would have done.
    expect(out.content).toContain('### alpha');
    expect(out.content).toContain('### zeta');
    expect(out.content).not.toContain('HHHH');
  });

  it('keeps the operator persona last, with the notice before it', () => {
    const out = compose({ huge: 'H'.repeat(5 * 1024 * 1024) });

    // Upstream appends the notice, which here would place generated text after
    // the operator's instructions and invert the last-word precedence the spine
    // documents. The persona must still close the document.
    expect(out.content.trimEnd().endsWith('Be terse.')).toBe(true);

    const notice = out.content.indexOf('Omitted for size');
    const persona = out.content.indexOf('Be terse.');

    // Presence first: -1 precedes every real offset, so a bare comparison passes
    // when the notice is not emitted at all.
    expect(notice).toBeGreaterThan(-1);
    expect(persona).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(persona);
  });

  it('names what it dropped, so an operator can see why guidance vanished', () => {
    const out = compose({ huge: 'H'.repeat(5 * 1024 * 1024) });

    expect(out.content).toContain('MCP Server: huge');
  });

  it('drops the wrapper once its last member is evicted', () => {
    const out = compose({ huge: 'H'.repeat(5 * 1024 * 1024) });

    expect(out.content).not.toContain('## MCP Servers');
    expect(out.diagnostics.structurallyOmitted).toEqual(['MCP Servers']);
  });

  it('does not evict when the document already fits', () => {
    const out = compose({ alpha: 'Use alpha.', zeta: 'Use zeta.' });

    expect(out.dropped).toEqual([]);
    expect(out.diagnostics.structurallyOmitted).toEqual([]);
    expect(out.content).toContain('## MCP Servers');
  });

  // The irreducible case. Everything droppable is gone and the document is still
  // over, so it refuses — upstream's `if (!largest) break` would write a document
  // Claude Code skips in full, leaving the agent with no instructions at all.
  it('refuses when only core remains, and reports what it tried', () => {
    let err: unknown;
    try {
      // A cap below the bare spine, so no amount of eviction can help.
      compose({ alpha: 'Use alpha.' }, 4096);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProjectDocTooLargeError);
    expect((err as ProjectDocTooLargeError).dropped).toEqual(['MCP Server: alpha']);
  });
});
