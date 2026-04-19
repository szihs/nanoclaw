---
name: critique-overlay
type: overlay
description: "Insert an external critique step after a workflow's patch / implement / generate step. Attach to a coworker type via `overlays: [critique-overlay]`. Blocks commit on must-fix critiques; loops back to the step it's attached to."
applies-to:
  workflows: [base-fix, base-test-gen, base-docs]
  traits: [code-edit, test-gen, doc-write]
insert-after: [patch, generate, draft]
uses:
  skills: [codex-critique]
---

**Critique** {#critique} — before committing, invoke `/codex-critique` against the working diff.

- Pass the diff, the stated intent (from the triage / docs / test log), and the relevant invariants (from the spine).
- If the critique returns `must-fix` items, do **not** commit. Loop back to the step this overlay was attached to and address each must-fix in the next iteration.
- If `should-fix` items are declined, justify each one in the workflow's log.
- Record the critique verdict (approve / approve-with-nits / request-changes) in the log before proceeding to the commit step.
- Critique is advisory — the coworker still owns the call — but a declined `must-fix` requires an explicit written justification, not silence.
