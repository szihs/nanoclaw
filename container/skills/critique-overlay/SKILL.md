---
name: critique-overlay
type: overlay
description: "Insert a critique gate after planning and after code changes. Runs up to 3 rounds per gate — blocks progress on must-fix items. Attach to a coworker type via `overlays: [critique-overlay]`."
applies-to:
  workflows: [investigate, implement, document]
  traits: [plan.research, code.edit, test.gen, doc.write]
insert-after: [investigate, patch, draft]
uses:
  skills: [codex-critique]
---

**Critique** {#critique} — invoke `/codex-critique` to review the work so far before proceeding.

**What to critique depends on the gate:**

- After `investigate` (plan gate) — critique the investigation findings and proposed approach. Pass the report draft, the original question/issue, and the decision rationale. The reviewer assesses: is the analysis sound? Are alternatives considered? Is the recommendation justified?
- After `patch` (code gate) — critique the code change. Pass the diff, the stated intent, and the relevant invariants from the spine. The reviewer assesses: correctness, minimality, test coverage, style.
- After `draft` (doc gate) — critique the documentation draft. Pass the draft, the feature/change it documents, and any accuracy constraints.

**3-round protocol:**

1. Run `/codex-critique` with the appropriate context for this gate.
2. If the critique returns `must-fix` items:
   - Address each must-fix by looping back to the step this overlay is attached to.
   - Re-run `/codex-critique` with the updated work.
   - This is round 2.
3. If round 2 still has `must-fix` items:
   - Address them and re-run one final time (round 3).
4. If round 3 still has `must-fix` items:
   - Stop. Do NOT proceed. Report the unresolved items and ask for human guidance.
5. `should-fix` items may be declined with written justification in the workflow log.
6. Record the final critique verdict (approve / approve-with-nits / request-changes / blocked) in the log before proceeding.

**Invariant:** Never proceed past a critique gate with unresolved `must-fix` items after 3 rounds. Escalate to the user instead.
