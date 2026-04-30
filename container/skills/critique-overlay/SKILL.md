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

2. Invoke `/codex-critique` in PLAN_REVIEW mode:
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

Invoke `/codex-critique` to check whether the investigation is sound before acting on it:

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

Invoke `/codex-critique` to verify the implementation matches both the plan and the spec:

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

Invoke `/codex-critique` to verify the deliverable answers the original request:

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

1. Invoke `/codex-critique` with the stage-specific context above.
2. If `must-fix` items returned → fix each item → re-spawn critique (round 2).
3. Round 2 still has `must-fix` → fix → re-spawn (round 3).
4. Round 3 still has `must-fix` → **STOP**. Report unresolved items and ask the user.
5. `should-fix` items may be declined with written justification.
6. Record the final verdict before proceeding.

**Invariant:** Never proceed past any gate with unresolved `must-fix` items after 3 rounds. Escalate to the user.

## Record verdicts (REQUIRED — do both, in this order)

After EVERY critique round, do these two steps **in this order, no exceptions**. The runtime ENFORCES this: a `critique-record-gate` PreToolUse hook will deny any further `Edit`/`Write` on source files until step 1 lands a verdict file at `/workspace/agent/critiques/<slug>-round-N.md`. Skipping the steps does not save you time — it blocks you.

### Step 1 — write the verdict to disk (REQUIRED FIRST)

```bash
mkdir -p /workspace/agent/critiques
```

Then `Write` (the SDK Write tool) the full reviewer output to:

```
/workspace/agent/critiques/<slug>-round-N.md
```

Where `<slug>` matches the plan slug, and `N` is the round number from `workflow-state.json` (`.critique_rounds`). The file MUST contain:

- Verdict label (one of: `approve` | `approve-with-nits` | `request-changes` | `blocked`)
- Every `must-fix` item with `<file:line>` + rationale + recommended fix
- Every `should-fix` item
- Every note
- The codex `threadId` (for round 2/3 reply linkage)

Also append one line to `/workspace/agent/critiques/index.md`:

```
[STAGE] <slug> round N — <verdict> — M must-fix
```

### Step 2 — broadcast the status (REQUIRED SECOND)

Use ONE of these templates exactly. Substitute only the bracketed placeholders. **Do NOT paraphrase, summarize differently, or use a different emoji.**

| Event | Template (paste verbatim, fill `[…]` only) |
|---|---|
| Entering | `🔴 [STAGE] gate — invoking /codex-critique. [1-line summary of artifact under review].` |
| Approved | `✅ [STAGE] round N/3 — approved. Verdict: [approve\|approve-with-nits]. Notes: [≤2 short lines, must-fix items=0]. Full: /workspace/agent/critiques/[slug]-round-N.md.` |
| Must-fix | `🟡 [STAGE] round N/3 — M must-fix items:\n- <file>:<line> — <issue>\n- <file>:<line> — <issue>\n…\nFixing and re-invoking. Full: /workspace/agent/critiques/[slug]-round-N.md.` |
| Escalating | `🚨 [STAGE] — 3 rounds exhausted. Unresolved must-fix:\n- <file>:<line> — <issue>\n…\nEscalating to user. Full: /workspace/agent/critiques/[slug]-round-N.md.` |

`[STAGE]` is one of `PLAN_REVIEW` / `DIAGNOSIS_REVIEW` / `CODE_REVIEW` / `OUTPUT_REVIEW`.

**Examples of what the runtime will REJECT** (don't do these):

- ⚡ instead of 🔴/🟡/✅/🚨 — wrong emoji.
- "Critique gate hit (3 edits)" without `[STAGE] round N/3` — missing identifiers.
- Prose summary of must-fix instead of bulleted `<file:line> — <issue>` lines.
- Sending the broadcast WITHOUT first writing the disk file.

The reviewer reads source files directly — never let the parent agent be the sole narrator. Both the disk write and the broadcast are mandatory: the disk write is the durable record, the broadcast is real-time visibility.
