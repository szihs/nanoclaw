---
name: critique-overlay
license: MIT
type: overlay
description: "Stage-aware critique gates across the plan and implement workflows. Spawns codex-critique with a different ROLE at each gate."
applies-to:
  workflows: [plan, implement]
  traits: [code.edit, test.gen, doc.write]
insert-after: [diagnose, change, deliver]
insert-before: [change]
uses:
  workflows: [plan]
  skills: [codex-critique]
---

Splices a `/codex-critique` call at four anchors across `/plan` and `/implement`. Each anchor maps to a stage with its own question set. Three rounds max per stage; unresolved `must-fix` items never merge.

## DIAGNOSIS_REVIEW (after `diagnose`)

Artifact: working notes (evidence, hypotheses, approaches). Ask codex:

- Root cause supported by evidence, or a leap?
- Next-most-likely cause?
- Evidence strong enough, or research more first?
- Missed risks, edge cases, or spec requirements?
- Does the approach actually address the root cause?

## PLAN_REVIEW (before `change`)

Write the plan at `/workspace/agent/reports/<target_slug>.md` first (spec ref, clarifying Qs, investigation findings, the change, gap check). Ask codex:

- Does the plan cover every spec requirement?
- Unclear requirements needing user clarification?
- Is the root cause supported by evidence?
- Is the change minimal and reversible?
- Are verification steps strong enough?
- Gaps between spec and plan?

## CODE_REVIEW (after `change`)

Artifacts: plan at `/workspace/agent/reports/<target_slug>.md` + `git diff` (run it yourself). Ask codex:

- Does the code match the approved plan? Deviations?
- Does the plan satisfy the original spec?
- Spec requirements not covered by the patch?
- Correctness, safety, lifecycle, or performance issues?
- Are tests sufficient?

## OUTPUT_REVIEW (after `deliver`)

Artifact: the deliverable file path. Ask codex:

- Does the output fully answer what was asked?
- Factual errors or unsupported claims?
- Silent omissions from the spec?
- Clarifying questions to raise before finalizing?

## Protocol (3 rounds max)

1. Invoke `/codex-critique`. Send `Stage: <STAGE>`, the original spec verbatim, artifact pointer(s), and the stage's questions.
2. On `must-fix` → fix → re-invoke. `should-fix` may be declined with written justification.
3. Round 3 still `must-fix` → **STOP**, escalate to user. Never proceed with unresolved `must-fix`.

## Record the verdict (runtime-enforced)

A `critique-record-gate` PreToolUse hook blocks further `Edit`/`Write` until step 1 lands. Do these in order:

1. **Write** the reviewer output to `/workspace/agent/critiques/<slug>-round-N.md` (N from `workflow-state.json.critique_rounds`). Must contain:
   - Verdict label (`approve` | `approve-with-nits` | `request-changes` | `blocked`)
   - Every `must-fix` / `should-fix` with `<file:line>` + rationale + recommended fix
   - codex `threadId` (for round 2/3 reply linkage)
2. Append one line to `/workspace/agent/critiques/index.md`: `[STAGE] <slug> round N — <verdict> — M must-fix`
3. Broadcast via `mcp__nanoclaw__send_message` using the **verbatim** template below — don't paraphrase, don't change emoji (the runtime pattern-matches):

| Event | Template |
|---|---|
| Entering | `🔴 [STAGE] gate — invoking /codex-critique. [1-line artifact summary].` |
| Approved | `✅ [STAGE] round N/3 — approved. Verdict: [approve\|approve-with-nits]. Full: /workspace/agent/critiques/<slug>-round-N.md.` |
| Must-fix | `🟡 [STAGE] round N/3 — M must-fix items:\n- <file:line> — <issue>\n…\nFixing. Full: <path>.` |
| Escalating | `🚨 [STAGE] — 3 rounds exhausted. Unresolved:\n- <file:line> — <issue>\nEscalating to user.` |

`[STAGE]` ∈ {`PLAN_REVIEW`, `DIAGNOSIS_REVIEW`, `CODE_REVIEW`, `OUTPUT_REVIEW`}.
