---
name: base-review
type: workflow
description: Review a proposed change (PR, diff, or patch) against project conventions and produce actionable feedback. Use when asked to review, critique, or approve a change. Do not use for investigation of an open bug — that is triage's job.
requires: [vcs-read, code-read]
uses:
  skills: []
  workflows: []
params:
  target: { type: string, required: true, description: "PR URL, commit range, or patch reference." }
  focus: { type: enum, default: "balanced", enum: ["security", "correctness", "performance", "style", "balanced"] }
produces:
  - review_log: { path: "/workspace/group/reviews/{{target_slug}}.md" }
---

# Base Review

Project-agnostic review. Specialize by declaring the project's code-navigation skills in the calling workflow's `uses.skills`.

## Invariants

- Prioritize (in order) security > correctness > performance > style. `focus` only changes emphasis, not priority.
- Distinguish **must-change** (blocks merge) from **should-change** (strong suggestion) from **nit** (take-it-or-leave-it).
- Every comment cites a concrete file + line. Abstract complaints are not actionable.
- Do not rewrite the author's work. Propose minimal diffs or describe the fix; the author implements.
- Do not approve a change you do not understand — ask or dig.

## Steps

1. **Load the change** {#load} — read the full diff for `{{target}}`. Identify the intent (commit message, PR description, linked issue).

2. **Map impact** {#map} — list files changed, subsystems touched, and externally visible surface (APIs, config, schemas).

3. **Assess** {#assess} each file in the diff:
   - **Security** — input validation, auth, secret handling, injection vectors.
   - **Correctness** — matches stated intent; edge cases handled; no off-by-one / null / race.
   - **Performance** — obvious hot-path issues only; no speculation.
   - **Style** — project convention, naming, comments only when they add information.

4. **Check tests** {#check-tests} — does the change include tests proportionate to risk? Do they cover the intent, not just the implementation?

5. **Write the review** {#write} to `{{review_log.path}}`:

```md
# Review: <target>
- verdict: <approve | approve-with-nits | request-changes | reject>
- must-change: <list, each with file:line>
- should-change: <list, each with file:line>
- nits: <list>
- questions: <list>
```

6. **Post upstream** {#post} — submit review comments at the concrete lines. Use the log's `verdict` as the overall state. Do not paste the log.

## Handoff

- If a must-change item requires architectural discussion, call that out explicitly and suggest a design review before implementation.
- If the change is too large to review meaningfully, request it be split before assessing.
