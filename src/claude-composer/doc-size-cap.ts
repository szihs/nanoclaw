/**
 * A hard byte cap on the composed document, and the reason one is needed at all.
 *
 * Claude Code "loads a CLAUDE.md file of up to 4 MiB in full and skips a larger
 * file" (code.claude.com/docs/en/memory). Over the cliff the agent receives NO
 * instructions — no persona, no invariants, no gate protocol — silently. A group
 * that quietly stops following its own safety rules is a worse failure than one
 * that refuses to start, which is what makes this loud rather than degrading.
 *
 * MEASURED, not assumed: the only unbounded input is the persona
 * (`instructions.prepend.md`), and it lives in the group directory, which is
 * mounted READ-WRITE at `/workspace/agent`. So an agent editing its own standing
 * instructions can cross the cliff by itself — a 5 MiB persona composes to
 * 5,259,196 bytes today. Reachable, not theoretical.
 *
 * Why this REFUSES instead of evicting sections, diverging from upstream's
 * `fitToCap`:
 *
 *   - Upstream drops the largest droppable section repeatedly until the document
 *     fits. That works when droppable sections hold the bulk. On this fork they
 *     hold nothing: §4.3's droppable rows are module instructions (present on
 *     disk but with no reader), resident-skill instructions (one file, no
 *     reader), and external-MCP instructions (not wired yet). Measured on the
 *     overflow case, the section ranking is `Additional Instructions` at
 *     5,242,909 bytes and every other section under 12 KB.
 *   - `Additional Instructions` IS the persona — `extraInstructions` comes from
 *     `readStandingInstructions` → `readGroupPersona` → `instructions.prepend.md`.
 *     §4.3 marks the persona core precisely because a group whose persona is
 *     evicted stops being that group. Evicting it to fit would silently discard
 *     the operator's own instructions, which is the failure mode the cap exists
 *     to prevent, relocated.
 *
 * So there is nothing safe to evict, and degrading would mean either dropping
 * sections that carry mandatory gates or dropping the persona. Refusing lets
 * `assertComposedDocUsable` do its job: an existing group keeps spawning on its
 * previous document while an operator fixes the input, and a fresh group with no
 * usable document is refused loudly instead of started blind.
 *
 * Add largest-first eviction here if and when the fork wires droppable sections
 * that can actually absorb the overflow (GAP-4, step 6). The cap is the
 * prerequisite for that, not a replacement for it.
 */

/**
 * Claude Code's documented limit. Not configurable: it is a property of the
 * consumer, not a policy knob, and a per-install override would only let someone
 * raise it past the point where the CLI stops reading the file.
 */
export const PROJECT_DOC_MAX_BYTES = 4 * 1024 * 1024;

export class ProjectDocTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
    readonly sections: { section: string; bytes: number }[],
    /**
     * Sections the cap ladder already evicted before giving up. Carried on the
     * error because that is the only path it can travel: on
     * drop-some-then-still-fail the eviction list exists solely inside
     * `renderProjectDoc`, which throws, so a caller wanting to report what was
     * attempted has nowhere else to read it from.
     */
    readonly dropped: readonly string[] = [],
  ) {
    super(
      `Composed document is ${bytes} bytes, over the ${maxBytes}-byte cap. ` +
        `Claude Code skips a file this large entirely, so the agent would receive no instructions. ` +
        `Largest sections: ${sections
          .slice(0, 3)
          .map((s) => `${s.section} (${s.bytes}B)`)
          .join(', ')}.` +
        // In the message, not only as a property: every logger this error reaches
        // formats it via `String(err)` or name/message/stack (`log.ts:20`), so a
        // field alone never reaches the log line that reports the refusal.
        (dropped.length > 0 ? ` Already evicted before giving up: ${dropped.join(', ')}.` : ''),
    );
    this.name = 'ProjectDocTooLargeError';
  }
}
