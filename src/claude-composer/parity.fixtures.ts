/**
 * The exact inputs the byte-parity goldens were captured with.
 *
 * Shared so the golden test and any future re-capture cannot drift apart: the
 * baselines were first reproduced by guessing these values, and two of them were
 * wrong in ways that showed up only as a byte-count mismatch (a `### Persona`
 * heading instead of `# Persona` changes `main` by exactly 2 bytes).
 */

/**
 * An H1 persona deliberately. On the flat `main` path this makes the document
 * carry TWO H1s — `main.persona.md:3` and the persona's own — which is legal and
 * must stay legal: demoting operator-authored headings would be a behaviour
 * change, and `contract-in-spine.test.ts:75-85` cannot see it because its `out()`
 * helper composes without `extraInstructions`.
 */
export const PARITY_PERSONA = '# Persona\n\nBe terse.';

export const PARITY_MCP: Record<string, string> = { demo: 'Use demo carefully.' };

/** Every coworker type declared in-tree, each with and without the extras. */
export const PARITY_TYPES = ['base-common', 'main', 'default'] as const;
