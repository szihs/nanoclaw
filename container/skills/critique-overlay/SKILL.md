---
name: critique-overlay
type: overlay
description: "Stage-aware critique gates across all workflows. Spawns codex-critique with a different ROLE at each gate: PLAN_REVIEW before coding, DIAGNOSIS_REVIEW after investigation, CODE_REVIEW after patch, OUTPUT_REVIEW after docs/review. Same agent, different hard questions."
applies-to:
  workflows: [investigate, implement, document, review]
  traits: [plan.research, code.edit, test.gen, doc.write]
insert-after: [root-cause, patch, draft, report, write]
insert-before: [patch]
uses:
  skills: [plan, codex-critique]
---

<IMPORTANT>
This is a MANDATORY gate. You MUST stop at this point and follow the stage-specific protocol below before proceeding. Do NOT skip any gate. Do NOT continue to the next workflow step without completing the critique for this stage. If you find yourself about to move past a gate without completing it, STOP and re-read this block.
</IMPORTANT>

## Gate Stages

This overlay fires at multiple points in every workflow. The **same codex-critique agent** is used each time, but with a different **stage role** that determines what hard questions to ask. Identify which stage you're at from the workflow step that triggered the gate:

| Triggered by | Stage | What it checks |
|---|---|---|
| `insert-before: patch` | **PLAN_REVIEW** | spec ↔ plan: is the plan complete? |
| `insert-after: root-cause` or `report` | **DIAGNOSIS_REVIEW** | spec ↔ findings: is the analysis correct? |
| `insert-after: patch` | **CODE_REVIEW** | spec ↔ plan ↔ code: does the code match? |
| `insert-after: draft` or `write` | **OUTPUT_REVIEW** | spec ↔ deliverable: is the output complete? |

---

## PLAN_REVIEW (before `patch` in /implement)

**You must write a plan before writing any code.**

1. Write a spec-traced plan to `/workspace/agent/plans/{{target_slug}}.md` containing:
   - **Spec reference** — quote the original task/requirement verbatim. This is the acceptance criterion.
   - **Clarifying questions** — list ambiguities. If any could change the implementation, ask the user BEFORE coding.
   - **Investigation findings** — reference `/workspace/agent/reports/{{target_slug}}.md` if it exists, or summarize the root cause with evidence.
   - **The change** — which files, what per file, why this approach, how to verify.
   - **Gap check** — spec requirements NOT addressed, and why.

2. Spawn codex-critique in PLAN_REVIEW mode:
```
Stage: PLAN_REVIEW
Spec: [paste original task text]
Plan: /workspace/agent/plans/{{target_slug}}.md (read it yourself)
Questions to answer:
- Does the plan cover every spec requirement?
- Are there unclear requirements needing user clarification?
- Is the root cause supported by evidence?
- Is the proposed change minimal and reversible?
- Are verification steps strong enough?
- What gaps exist between spec and plan?
```

3. Record verdict at the top of the plan file. Then proceed to `patch`.

**Visibility:** Send `mcp__nanoclaw__send_message("🟡 Plan gate — writing plan for [target].")` on entry, `"✅ Plan approved (round N/3)."` on approval.

---

## DIAGNOSIS_REVIEW (after `root-cause` or `report`)

Spawn codex-critique to check whether the investigation is sound before acting on it:

```
Stage: DIAGNOSIS_REVIEW
Spec: [paste original task/issue text, or path]
Report: /workspace/agent/reports/{{target_slug}}.md (read it yourself)
Plan: /workspace/agent/plans/{{target_slug}}.md (if exists)
Questions to answer:
- Is the root-cause diagnosis correct? Could it be something else?
- Is the evidence strong enough, or should we investigate more?
- Are there risks, edge cases, or requirements the investigation missed?
- Does the plan (if any) actually address the root cause?
```

---

## CODE_REVIEW (after `patch`)

Spawn codex-critique to verify the implementation matches both the plan and the spec:

```
Stage: CODE_REVIEW
Spec: [paste original task text]
Plan: /workspace/agent/plans/{{target_slug}}.md (read it — code must match)
Diff: run `git diff` yourself against the working tree
Questions to answer:
- Does the code change match the approved plan? Any deviations?
- Does the plan actually satisfy the original spec?
- Are there spec requirements not covered by the patch?
- Are there correctness, safety, lifecycle, or performance issues?
- Are tests sufficient for the requirements?
```

---

## OUTPUT_REVIEW (after `draft` or `write`)

Spawn codex-critique to verify the deliverable answers the original request:

```
Stage: OUTPUT_REVIEW
Spec: [what was asked — the original question or task]
Output: [path to the deliverable file]
Questions to answer:
- Does the output fully answer what was asked?
- Are there factual errors or unsupported claims?
- Is anything silently omitted from the spec?
- Are there clarifying questions that should be asked before finalizing?
```

---

## 3-Round Protocol (all stages)

1. Spawn codex-critique with the stage-specific context above.
2. If `must-fix` items returned → fix each item → re-spawn critique (round 2).
3. Round 2 still has `must-fix` → fix → re-spawn (round 3).
4. Round 3 still has `must-fix` → **STOP**. Report unresolved items and ask the user.
5. `should-fix` items may be declined with written justification.
6. Record the final verdict before proceeding.

**Invariant:** Never proceed past any gate with unresolved `must-fix` items after 3 rounds. Escalate to the user.

## Record verdicts

After each critique round, write the full verdict to `/workspace/agent/critiques/{{target_slug}}-round-N.md`. Keep an index at `/workspace/agent/critiques/index.md`.

## Visibility

At each gate, send a status message via `mcp__nanoclaw__send_message`:

- **Entering:** `"🔴 [STAGE] gate — spawning codex-critique. [1-line summary]."`
- **Approved:** `"✅ [STAGE] round N/3 — approved. Verdict: /workspace/agent/critiques/[slug]-round-N.md."`
- **Must-fix:** `"🟡 [STAGE] round N/3 — M must-fix items. Fixing and re-spawning."`
- **Escalating:** `"🚨 [STAGE] — 3 rounds exhausted. Escalating to user."`

The reviewer reads source files directly — never let the parent agent be the sole narrator.
