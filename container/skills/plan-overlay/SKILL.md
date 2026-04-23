---
name: plan-overlay
type: overlay
description: "Insert a plan gate before code changes. Agent writes a structured plan, then iterates via codex-critique up to 3 rounds before proceeding to implementation. Attach to a coworker type via `overlays: [plan-overlay]`."
applies-to:
  workflows: [implement]
  traits: [code.edit]
insert-before: [patch]
uses:
  skills: [plan, codex-critique]
---

**Plan** {#plan} — invoke `/plan` for `{{target}}` before writing any code. Write the plan to `/workspace/group/plans/{{target_slug}}.md`.

**What to plan depends on the workflow context:**

- Before `patch` in `/implement` — plan the minimum code change. The plan must specify: which files to modify, what the change is, why this approach over alternatives, and how to verify correctness. Pass the investigation report / root-cause analysis as input context.

**3-round critique protocol:**

1. Run `/codex-critique` with the plan document (not a diff). The reviewer assesses: is the approach sound? Is it minimal? Are risks identified? Will it actually solve the root cause?
2. If the critique returns `must-fix` items:
   - Revise the plan to address each must-fix item.
   - Re-run `/codex-critique` with the updated plan.
   - This is round 2.
3. If round 2 still has `must-fix` items:
   - Revise and re-run one final time (round 3).
4. If round 3 still has `must-fix` items:
   - Stop. Do NOT proceed to implementation. Report the unresolved items and ask for human guidance.
5. `should-fix` items may be declined with written justification in the plan file.
6. Record the final critique verdict (approve / approve-with-nits / request-changes / blocked) at the top of the plan file before proceeding.

**Handoff to implementation:** Once the plan is approved, subsequent steps (especially `patch`) MUST read `/workspace/group/plans/{{target_slug}}.md` and follow it. When invoking `/codex-critique` after `patch`, pass the plan file alongside the diff so the reviewer can verify the implementation matches the approved plan.

**Invariant:** Never proceed past the plan gate with unresolved `must-fix` items after 3 rounds. Escalate to the user instead.
