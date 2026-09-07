/**
 * The invariants byte-parity cannot see.
 *
 * The parity fixtures render only VALID producer output, so no validator rule and
 * no eviction path is reachable from them. Every rule here therefore needs its
 * own negative case: without one, deleting the rule leaves the suite green.
 */
import crypto from 'crypto';

import { describe, expect, it, vi } from 'vitest';

import { ProjectDocTooLargeError } from './doc-size-cap.js';
import { type ComposedSectionInput, type ProjectDocSpec, renderProjectDoc, stripFencedBlocks } from './project-doc.js';

const MARKER = '<!-- composed -->';

function title(body = '# Title'): ComposedSectionInput {
  return { role: 'title', droppable: false, name: 'Title', heading: { kind: 'verbatim' }, body };
}

function body(name: string, text: string, extra: Partial<ComposedSectionInput> = {}): ComposedSectionInput {
  return {
    role: 'body',
    droppable: false,
    name,
    heading: { kind: 'titled', level: 2 },
    body: text,
    ...extra,
  } as ComposedSectionInput;
}

function spec(sections: ComposedSectionInput[], maxBytes?: number): ProjectDocSpec {
  // Deliberately cast: several tests below feed the validator states the tuple
  // type forbids (empty, two titles), which is the point — the runtime guard has
  // to hold for values that arrive from JSON or an `as`-cast.
  return { fileName: 'CLAUDE.md', maxBytes, extraSections: sections as unknown as ProjectDocSpec['extraSections'] };
}

function render(sections: ComposedSectionInput[], maxBytes?: number) {
  return renderProjectDoc(MARKER, spec(sections, maxBytes));
}

describe('validator — cardinality and ordering', () => {
  it('rejects two titles', () => {
    expect(() => render([title(), title()])).toThrow(/2 title sections/);
  });

  // Separate from the two-title case on purpose: an implementation checking only
  // `count > 1` passes that test while accepting a document with no H1 at all.
  it('rejects zero titles', () => {
    expect(() => render([body('Only', 'x')])).toThrow(/no title section/);
  });

  it('rejects a title that is not first', () => {
    expect(() => render([body('First', 'x'), title()])).toThrow(/must come first/);
  });

  it('rejects a flat identity with no H1', () => {
    expect(() => render([title('No heading here')])).toThrow(/must render an H1/);
  });

  // A tilde fence is valid CommonMark. The three scanners this replaces test
  // backticks only, so a heading inside ~~~ would have satisfied the title check.
  it('does not accept a heading inside a tilde fence as the H1', () => {
    expect(() => render([title('~~~\n# fake\n~~~')])).toThrow(/must render an H1/);
  });

  it('accepts a real H1 after a fenced block', () => {
    expect(() => render([title('```\n## fenced\n```\n\n# Real')])).not.toThrow();
  });

  it('rejects two personas', () => {
    const persona: ComposedSectionInput = {
      role: 'persona',
      droppable: false,
      name: 'Additional Instructions',
      heading: { kind: 'verbatim' },
      body: 'p',
    };
    expect(() => render([title(), persona, persona])).toThrow(/2 persona sections/);
  });

  it('rejects content after the persona', () => {
    const persona: ComposedSectionInput = {
      role: 'persona',
      droppable: false,
      name: 'Additional Instructions',
      heading: { kind: 'verbatim' },
      body: 'p',
    };
    expect(() => render([title(), persona, body('After', 'x')])).toThrow(/must be last/);
  });

  it('rejects a synthesized H1 outside the title', () => {
    expect(() => render([title(), { ...body('Second', 'x'), heading: { kind: 'titled', level: 1 } }])).toThrow(
      /synthesizes an H1/,
    );
  });

  it('rejects an empty section list at runtime, not only in the type', () => {
    expect(() => renderProjectDoc(MARKER, { fileName: 'CLAUDE.md', extraSections: [] as never })).toThrow(
      /at least one section/,
    );
  });
});

describe('validator — group topology', () => {
  const header: ComposedSectionInput = {
    role: 'group-header',
    droppable: false,
    name: 'MCP Servers',
    heading: { kind: 'titled', level: 2 },
    group: 'mcp',
    body: '',
  };
  const member = (name: string) => body(name, `body-${name}`, { group: 'mcp', droppable: true });

  it('accepts a header followed by contiguous members', () => {
    expect(() => render([title(), header, member('a'), member('b')])).not.toThrow();
  });

  it('rejects an orphan member', () => {
    expect(() => render([title(), member('a')])).toThrow(/has no header/);
  });

  it('rejects two headers for one group', () => {
    expect(() => render([title(), header, member('a'), header, member('b')])).toThrow(/more than one header/);
  });

  it('rejects a member emitted before its header', () => {
    expect(() => render([title(), member('a'), header])).toThrow(/directly follow their header/);
  });

  it('rejects non-contiguous members', () => {
    expect(() => render([title(), header, member('a'), body('Other', 'x'), member('b')])).toThrow(/contiguous/);
  });

  it('rejects a header with no members', () => {
    expect(() => render([title(), header])).toThrow(/no members/);
  });
});

describe('rendering', () => {
  it('joins with a blank line, marker first, and ends in exactly one newline', () => {
    const out = render([title(), body('Second', 'text')]).content;

    expect(out).toBe(`${MARKER}\n\n# Title\n\n## Second\n\ntext\n`);
  });

  // `## name\n\n` plus the join's separator would emit three newlines; the tail
  // is exactly where byte-parity breaks.
  it('emits a heading-only block for an empty titled body', () => {
    const out = render([title(), body('Empty', '')]).content;

    expect(out).toBe(`${MARKER}\n\n# Title\n\n## Empty\n`);
  });

  it('hashes the content it returns', () => {
    const { content, hash } = render([title()]);

    expect(hash).toBe(crypto.createHash('sha256').update(content).digest('hex'));
  });
});

describe('cap ladder', () => {
  const big = (name: string, size: number) => body(name, 'x'.repeat(size), { group: 'mcp', droppable: true });
  const header: ComposedSectionInput = {
    role: 'group-header',
    droppable: false,
    name: 'MCP Servers',
    heading: { kind: 'titled', level: 2 },
    group: 'mcp',
    body: '',
  };

  it('does nothing when no cap is configured', () => {
    const { dropped, diagnostics } = render([title(), header, big('a', 5000)]);

    expect(dropped).toEqual([]);
    expect(diagnostics.maxBytes).toBeUndefined();
    expect(diagnostics.nearCap).toBe(false);
  });

  it('evicts the largest droppable section first', () => {
    const { dropped, content } = render([title(), header, big('small', 100), big('large', 4000)], 3000);

    expect(dropped).toEqual(['large']);
    expect(content).toContain('## small');
  });

  it('ranks by rendered block bytes, not body length', () => {
    // Equal bodies; 'has-a-much-longer-heading' is larger once its heading counts.
    const short = body('s', 'y'.repeat(500), { group: 'mcp', droppable: true });
    const long = body('has-a-much-longer-heading', 'y'.repeat(500), { group: 'mcp', droppable: true });
    const { dropped } = render([title(), header, short, long], 700);

    expect(dropped[0]).toBe('has-a-much-longer-heading');
  });

  it('places the notice immediately before the persona, never after it', () => {
    const persona: ComposedSectionInput = {
      role: 'persona',
      droppable: false,
      name: 'Additional Instructions',
      heading: { kind: 'verbatim' },
      body: 'PERSONA-BODY',
    };
    const { content } = render([title(), header, big('a', 4000), persona], 3000);
    const notice = content.indexOf('Omitted for size');
    const body_ = content.indexOf('PERSONA-BODY');

    // Presence first: `indexOf` returns -1 when the notice is absent, and -1
    // precedes every real offset, so a bare `toBeLessThan` passes when notice
    // generation is deleted — the exact regression this names.
    expect(notice).toBeGreaterThan(-1);
    expect(body_).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(body_);
  });

  it('places the notice last when there is no persona', () => {
    const { content } = render([title(), header, big('a', 4000), body('Tail', 'TAIL-BODY')], 3000);
    const notice = content.indexOf('Omitted for size');
    const tail = content.indexOf('TAIL-BODY');

    expect(notice).toBeGreaterThan(-1);
    expect(tail).toBeGreaterThan(-1);
    expect(tail).toBeLessThan(notice);
  });

  it('drops a group header once its last member is evicted, and reports it as structural', () => {
    const { dropped, diagnostics, content } = render([title(), header, big('a', 4000)], 2000);

    expect(dropped).toEqual(['a']);
    expect(diagnostics.structurallyOmitted).toEqual(['MCP Servers']);
    expect(content).not.toContain('## MCP Servers');
  });

  it('reports no structural omission when nothing was configured', () => {
    const { diagnostics } = render([title(), body('Plain', 'x')], 100000);

    expect(diagnostics.structurallyOmitted).toEqual([]);
  });

  it('refuses when only core remains, carrying the full attempted eviction list', () => {
    const core = body('Core', 'z'.repeat(5000));
    let err: unknown;
    try {
      render([title(), header, big('a', 400), big('b', 800), core], 1000);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProjectDocTooLargeError);
    // Largest-first, so 'b' before 'a' — the order proves the ladder ran rather
    // than the cap simply rejecting the input outright.
    expect((err as ProjectDocTooLargeError).dropped).toEqual(['b', 'a']);
  });

  it('never logs — the 60s sweep calls this seam, so a near-cap document must not warn forever', async () => {
    const { log } = await import('../log.js');
    const warn = vi.spyOn(log, 'warn');
    const error = vi.spyOn(log, 'error');

    for (let i = 0; i < 3; i++) render([title(), header, big('a', 4000)], 3000);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('diagnostics', () => {
  it('accounts every rendered byte: sum of sections + marker + separator === total', () => {
    const { content, diagnostics } = render([title(), body('A', 'aaa'), body('B', 'bbb')]);
    const sum = diagnostics.sections.reduce((n, s) => n + s.bytes, 0);

    expect(sum + Buffer.byteLength(MARKER, 'utf-8') + 2).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  // Same identity, final section ending in whitespace the assembly trims. This is
  // the case a per-section constant cannot express: `renderSection(s).length + 1`
  // charges the last section bytes that are not in the document, and no fixed
  // adjustment predicts how many, because it depends on how much trailing
  // whitespace the body happens to carry. Only slicing the final render is right.
  it('charges no section for bytes the trim removed', () => {
    const { content, diagnostics } = render([title(), body('A', 'aaa'), body('Tail', 'tail   \n\n')]);
    const sum = diagnostics.sections.reduce((n, s) => n + s.bytes, 0);

    expect(sum + Buffer.byteLength(MARKER, 'utf-8') + 2).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  // The consequence of getting the above wrong: eviction ranks by these counts, so
  // an overcounted section is evicted ahead of a genuinely larger one and the
  // document loses content that was never the problem.
  //
  // 'Padded' is LAST, which is the only position where trailing whitespace is
  // trimmed. Its raw body is the longest (160 bytes), so ranking by
  // `renderSection` picks it first; its contribution to the document is the
  // smallest (100 bytes), so ranking by the final render picks 'Big'. The
  // assertion is on the FIRST victim — that is where the two orderings differ.
  it('ranks eviction by bytes present in the final render, not by raw body length', () => {
    const sections = [
      title(),
      body('Big', 'b'.repeat(120), { droppable: true }),
      body('Padded', 'p'.repeat(100) + ' '.repeat(60), { droppable: true }),
    ];
    const unbounded = Buffer.byteLength(render(sections).content, 'utf-8');

    expect(render(sections, unbounded - 1).dropped[0]).toBe('Big');
  });

  // Nothing requires section names to be unique — two MCP servers, two skills —
  // and a name-keyed byte lookup collapses duplicates onto one count. Measured
  // with that bug: the ladder evicted the 100-byte section while the 1000-byte one
  // with the same name survived, so the document stayed over the cap for an extra
  // round and lost the wrong content.
  it('ranks duplicate-named droppable sections independently', () => {
    const sections = [
      title(),
      body('dup', 'S'.repeat(100), { droppable: true }),
      body('dup', 'L'.repeat(1000), { droppable: true }),
    ];
    const unbounded = Buffer.byteLength(render(sections).content, 'utf-8');

    const { content } = render(sections, unbounded - 1);

    expect(content).not.toContain('LLLL');
    expect(content).toContain('SSSS');
  });

  // Nor by object identity: a producer may push one section object twice, and any
  // keyed lookup collapses both occurrences onto a single count — `Map.set` keeps
  // whichever it saw last. Occurrence-index alignment removes the assumption.
  //
  // The two occurrences must MEASURE differently for the collapse to change the
  // answer, which is why the shared body carries trailing whitespace: only the
  // final position is trimmed, so occurrence 1 contributes ~500 bytes and
  // occurrence 3 contributes ~100. A keyed lookup records 100 for both, ranks
  // 'medium' (300) highest, and evicts it — while the 500-byte occurrence that
  // actually blew the budget stays.
  it('ranks repeated section references as distinct occurrences', () => {
    const shared = body('same', 'S'.repeat(100) + ' '.repeat(400), { droppable: true });
    const sections = [title(), shared, body('medium', 'M'.repeat(300), { droppable: true }), shared];
    const unbounded = Buffer.byteLength(render(sections).content, 'utf-8');

    expect(render(sections, unbounded - 1).dropped[0]).toBe('same');
  });

  // The message says "Largest sections" and shows only the top three, so document
  // order can name three small ones and omit the culprit — leaving an operator to
  // guess against a 4 MB file.
  it('orders refusal diagnostics largest-first', () => {
    let err: unknown;
    try {
      render([title(), body('Tiny A', 'a'), body('Tiny B', 'b'), body('Culprit', 'c'.repeat(5000))], 300);
    } catch (e) {
      err = e;
    }

    const e = err as ProjectDocTooLargeError;
    expect(e.sections[0].section).toBe('Culprit');
    expect(e.message).toMatch(/Largest sections: Culprit/);
  });

  // After a partial eviction the notice is a real section in the measured
  // document. Omitting it from the refusal made the reported per-section bytes
  // fail to account for the total the same error reports.
  it('includes the omission notice in the refusal diagnostics', () => {
    let err: unknown;
    try {
      render([title(), body('Core', 'c'.repeat(400)), body('Droppable', 'd'.repeat(400), { droppable: true })], 300);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProjectDocTooLargeError);
    const e = err as ProjectDocTooLargeError;
    expect(e.dropped).toEqual(['Droppable']);
    expect(e.sections.map((s) => s.section)).toContain('Omitted for size');
    expect(e.sections.reduce((n, s) => n + s.bytes, 0) + Buffer.byteLength(MARKER, 'utf-8') + 2).toBe(e.bytes);
    // The eviction list has to reach the LOG, and every logger formats this error
    // by message (`log.ts:20`) — a property alone never appears.
    expect(e.message).toMatch(/Already evicted before giving up: Droppable/);
  });
});

describe('stripFencedBlocks', () => {
  it('removes backtick and tilde blocks, and does not let one style close the other', () => {
    const lines = stripFencedBlocks('a\n```\nb\n```\nc\n~~~\n```\nd\n~~~\ne');

    expect(lines.filter(Boolean)).toEqual(['a', 'c', 'e']);
  });

  // A closing fence carries nothing but the fence and whitespace. Treating
  // '```not-close' as a closer ends the block early, so a heading still inside the
  // code block is read as the document's H1 — the validator then accepts a fake
  // title, or rejects a real one.
  it('does not let fence-looking content close a fence', () => {
    expect(stripFencedBlocks('```\n```not-close\n# fake\n```')).not.toContain('# fake');
  });

  // Four spaces make an indented code block, not a fence. Treating it as an opener
  // swallows the rest of the document and hides the real H1.
  it('does not open a fence at four spaces of indent', () => {
    expect(stripFencedBlocks('    ```\n# Real')).toContain('# Real');
  });

  it('still opens a fence at three spaces of indent', () => {
    expect(stripFencedBlocks('   ```\n# hidden\n   ```\n# Real')).toEqual(['# Real']);
  });

  // An info string may not contain a backtick on a backtick fence, so this opens
  // nothing and the heading after it is ordinary content.
  it('does not open a backtick fence whose info string contains a backtick', () => {
    expect(stripFencedBlocks('```a`b\n# Real')).toContain('# Real');
  });
});
