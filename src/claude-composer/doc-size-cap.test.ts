/**
 * Claude Code loads a CLAUDE.md up to 4 MiB and SKIPS a larger one. Over the
 * cliff the agent receives no instructions at all — no persona, no invariants,
 * no gate protocol — silently. A group that quietly stops following its own
 * safety rules is worse than one that refuses to start.
 *
 * Reachability is measured, not assumed: the persona (`instructions.prepend.md`)
 * lives in the group directory, mounted READ-WRITE at `/workspace/agent`, so an
 * agent editing its own standing instructions can cross the cliff by itself.
 *
 * These cases used to exercise `assertWithinDocSizeCap`, a standalone check on an
 * already-assembled string. The cap now lives inside `renderProjectDoc`, which is
 * what makes eviction possible — the check ran after assembly, so it could only
 * refuse. The helper had no production caller left, so the cases move to the
 * assembler; the properties they assert are unchanged, and the ones about LOGGING
 * moved to `publication-contract.test.ts`, because the assembler must stay silent
 * (the 60s sweep calls it for every group).
 */
import { describe, expect, it, vi } from 'vitest';

import { PROJECT_DOC_MAX_BYTES, ProjectDocTooLargeError } from './doc-size-cap.js';
import { type ComposedSectionInput, type ProjectDocSpec, renderProjectDoc } from './project-doc.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const MARKER = '<!-- composed -->';

function renderAt(sections: ComposedSectionInput[], maxBytes: number | undefined) {
  return renderProjectDoc(MARKER, {
    fileName: 'CLAUDE.md',
    maxBytes,
    extraSections: sections as unknown as ProjectDocSpec['extraSections'],
  });
}

/** A minimal valid document: one verbatim H1 title, plus whatever else a case needs. */
function render(sections: ComposedSectionInput[]) {
  return renderAt(sections, PROJECT_DOC_MAX_BYTES);
}

// Separate from `render` rather than an optional parameter: a default parameter is
// applied when the argument is `undefined`, so `render(x, undefined)` would silently
// be the CAPPED call — which is exactly the mistake this helper prevents.
function renderUncapped(sections: ComposedSectionInput[]) {
  return renderAt(sections, undefined);
}

function title(body = '# Coworker'): ComposedSectionInput {
  return { role: 'title', droppable: false, name: 'Title', heading: { kind: 'verbatim' }, body };
}

function core(name: string, text: string): ComposedSectionInput {
  return { role: 'body', droppable: false, name, heading: { kind: 'titled', level: 2 }, body: text };
}

/** Body length that renders to exactly `bytes` total, so "at the limit" is exact. */
function padTo(bytes: number): ComposedSectionInput[] {
  const base = Buffer.byteLength(render([title()]).content, 'utf-8');
  // '## Pad\n\n' + body + the separator already accounted for by `base`.
  const overhead = Buffer.byteLength('\n\n## Pad\n\n', 'utf-8');
  return [title(), core('Pad', 'x'.repeat(bytes - base - overhead))];
}

describe('the cap value', () => {
  // Not a policy knob: it is a property of the consumer. A configurable cap would
  // only let someone raise it past the point where the CLI stops reading at all.
  it('is Claude Code’s documented 4 MiB', () => {
    expect(PROJECT_DOC_MAX_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('within the cap', () => {
  it('accepts a document at the limit exactly', () => {
    const at = render(padTo(PROJECT_DOC_MAX_BYTES));

    expect(Buffer.byteLength(at.content, 'utf-8')).toBe(PROJECT_DOC_MAX_BYTES);
    expect(at.dropped).toEqual([]);
  });

  it('accepts a typical document', () => {
    expect(render([title(), core('Identity', 'Hi.')]).dropped).toEqual([]);
  });
});

describe('over the cap', () => {
  it('throws one byte over', () => {
    expect(() => render(padTo(PROJECT_DOC_MAX_BYTES + 1))).toThrow(ProjectDocTooLargeError);
  });

  it('reports the actual and permitted sizes', () => {
    try {
      render(padTo(PROJECT_DOC_MAX_BYTES + 10));
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as ProjectDocTooLargeError;
      expect(e.bytes).toBe(PROJECT_DOC_MAX_BYTES + 10);
      expect(e.maxBytes).toBe(PROJECT_DOC_MAX_BYTES);
    }
  });

  // The operator has to know WHICH section blew the budget, or the only remedy is
  // guesswork against a 4 MB file. Section names now come from the model rather
  // than from re-splitting the rendered string on `## `, so a `## …` inside a
  // fenced block can no longer mislabel a byte count.
  it('names the largest sections', () => {
    try {
      render([title(), core('Small', 'tiny'), core('Huge', 'y'.repeat(PROJECT_DOC_MAX_BYTES))]);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as ProjectDocTooLargeError;
      expect(e.sections[0].section).toBe('Huge');
      expect(e.message).toContain('Huge');
    }
  });

  // Bytes, not characters: a multi-byte document would otherwise pass a
  // character-length check and still be skipped by the consumer.
  it('measures UTF-8 bytes, not string length', () => {
    const half = PROJECT_DOC_MAX_BYTES / 2;
    const multibyte = [title(), core('É', 'é'.repeat(half))];

    // Half the cap in 2-byte characters is under the cap by LENGTH and over it by
    // BYTES: a character-length check would accept this and the consumer would
    // still skip the file.
    expect(renderUncapped(multibyte).content.length).toBeLessThan(PROJECT_DOC_MAX_BYTES);
    expect(() => render(multibyte)).toThrow(ProjectDocTooLargeError);
  });
});

describe('refusing rather than degrading', () => {
  // Upstream's `fitToCap` writes the oversized document once nothing droppable is
  // left (`if (!largest) break`), which the consumer then skips in full. This
  // throws instead, so the caller's catch reaches `assertComposedDocUsable`: an
  // existing group keeps spawning on its previous document, and a fresh group with
  // none is refused loudly.
  //
  // Evicting the persona to fit would relocate the failure rather than fix it — the
  // agent would run without its own instructions, which is what the cap exists to
  // prevent. So the persona is never droppable, and a document that only fits
  // without it does not fit.
  it('never returns a document that is over the cap', () => {
    expect(() => render(padTo(PROJECT_DOC_MAX_BYTES + 1))).toThrow(ProjectDocTooLargeError);
  });

  it('refuses rather than evicting a non-droppable section', () => {
    const persona: ComposedSectionInput = {
      role: 'persona',
      droppable: false,
      name: 'Persona',
      heading: { kind: 'titled', level: 2 },
      body: 'p'.repeat(PROJECT_DOC_MAX_BYTES),
    };

    expect(() => render([title(), persona])).toThrow(ProjectDocTooLargeError);
  });
});

describe('purity', () => {
  // The staleness sweep and spawn both hash the composed string through
  // `renderComposedDocument`. A size decision that varied between those two calls
  // would make the digests disagree forever and respawn the container every 60s.
  it('is a pure function of the sections', () => {
    const ok = [title(), core('Identity', 'Hi.')];
    const over = padTo(PROJECT_DOC_MAX_BYTES + 1);

    for (let i = 0; i < 3; i++) expect(render(ok).hash).toBe(render(ok).hash);
    for (let i = 0; i < 3; i++) expect(() => render(over)).toThrow(ProjectDocTooLargeError);
  });
});
