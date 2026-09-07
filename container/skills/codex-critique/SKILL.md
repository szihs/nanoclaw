---
name: codex-critique
license: MIT
description: 'Independent second-opinion review by codex. You call mcp__codex__codex directly — no subagent. Read-only — produces a structured critique, never modifies files.'
provides: [critique.review]
allowed-tools: Read, Grep, Glob, Bash(git diff:*), mcp__codex__codex, mcp__codex__codex-reply
---

# Codex Critique

You call `mcp__codex__codex` yourself — no subagent. Codex runs in a separate process, fresh session, read-only filesystem. Pass file paths, not contents. Capture `threadId` — needed for rounds 2/3 via `mcp__codex__codex-reply`.

**IMPORTANT: Always pass `sandbox: "danger-full-access"`.** Any other value (including "read-only") will be rejected by a PreToolUse hook — bwrap sandboxing does not work inside Docker containers.

```
mcp__codex__codex({ prompt: <below>, developer-instructions: <below>, sandbox: "danger-full-access", cwd: "/workspace/agent" })
```

## Prompt

```
STAGE: <DIAGNOSIS_REVIEW | PLAN_REVIEW | CODE_REVIEW | DECISION_REVIEW | OUTPUT_REVIEW>
ROUND: <n>/3

TASK (verbatim — only you have this, codex cannot read it from disk):
<the original user request, no paraphrasing>

WHAT I DID: <1-3 sentence summary of this stage's action/decision>
WHY: <reasoning, evidence, tradeoffs>
ARTIFACTS (read these yourself): <file paths, or "run git diff <base>..HEAD">
```

## When to invoke each STAGE

Run each at its natural workflow transition. If `critique-gate` is in your overlay set with required stages, the gate denies delivery markers / `gh pr create` until each has a recorded round (naming what's missing).

| Stage              | Run after                                 | Pass to codex                                                        |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `DIAGNOSIS_REVIEW` | Root cause / request identified           | Issue; your reading; file:line pointers                              |
| `PLAN_REVIEW`      | Approach chosen, before editing           | Plan file (`/workspace/agent/reports/<n>.md`); approaches considered |
| `CODE_REVIEW`      | Edits + tests pass, before reporting / PR | `git diff <base>..HEAD`; test path + result                          |
| `DECISION_REVIEW`  | Verdict derived, before recording it      | The derivation: clauses from data, verdict parse vs. the review doc, source tier stated |
| `OUTPUT_REVIEW`    | Deliverable drafted, before sending       | Deliverable text/path; referenced artifacts                          |

Answer-style work (a question, a release note) uses `OUTPUT_REVIEW` for factual accuracy and source coverage. No separate `ANSWER_REVIEW` stage.

## developer-instructions

```
You are an independent reviewer with read-only intent but you MAY run read commands (git, cat, grep) to inspect artifacts. Read the artifacts yourself — verify every claim against the code, not by analogy.
Return ONLY the structured output below.
Guard against scope shrinkage: if the deliverable reduces scope below spec without evidenced blockers, flag it must-fix.
Comment hygiene (when a code diff is under review): a comment that restates what the adjacent line already says, or that narrates change-history / scratchpad reasoning / why-an-alternative-was-rejected (that content belongs in the PR body or commit message, not source), is must-fix. A concise comment explaining non-obvious *why* — intent, an invariant, a subtle edge case — is correct: do NOT flag those, and do NOT demand comments on self-evident code.
ROUNDS (`ROUND: <n>/3` is in the prompt; three is the whole budget and must be enough):
- Round 1 alone may open must-fix items on pre-existing content. Later rounds may open one only for a regression from the latest edits; anything else is Advisory, prefixed `LATE:`.
- From round 2, first restate every prior id as `RESOLVED — <evidence>` or `UNRESOLVED — <what is still missing>`.
- Round 3 returns `approve` unless an open item is a correctness, safety, security or data-loss defect with its failing RE-CHECK output pasted. Everything else is downgraded to Advisory and listed in Notes.
Make the work shippable; do not prove it imperfect.

### Verdict
approve | must-fix

### Must-fix (blocks merge)
- <id>. <file:line> — what is wrong and why it blocks at this STAGE. FIX: exact snippet, diff hunk or command, applicable as written. RE-CHECK: command + expected output that clears it.
- No applicable fix? Write `FIX UNKNOWN: <the one question that decides it>` and move the item to Advisory, unless it is a correctness or safety defect.

### Advisory
- <file:line> — concern + suggestion. Author may decline with justification.

### Notes
- Observations for future work. No "what" without "why." Round 3: list each item downgraded to Advisory.

### Attested
- <sha256> <path> — one line per file artifact you actually read (run `sha256sum <path>` yourself, up to 20 files). Write `- none` if this review had no file artifacts. Re-emit in full every round with fresh hashes.
```

> Use this block **verbatim**. `track-critique.sh` verifies the sentinel lines
> (keep both within the first 2000 bytes of the block — the hook truncates there)
> ("You are an independent reviewer", "Return ONLY the structured output
> below") before recording a critique round — a codex call with rewritten
> instructions does not count toward the delivery gate. Keep the sentinels in
> sync with the hook if this block is ever edited.
>
> The `### Attested` hashes bind the verdict to the exact artifacts reviewed:
> the delivery gate re-hashes them at send time and denies if any changed
> after the approve. Attestation is opportunistic — no `### Attested` section
> means no hash check — but an approve with stale hashes will not ship.

## Rounds

- `must-fix` → apply each item's FIX, produce its RE-CHECK evidence, then `mcp__codex__codex-reply` on the saved `threadId`: `ROUND: <n>/3 — addressed 1,2,3 — re-verify`.
- `FIX UNKNOWN:` → answer the question yourself (read the code, run the command) and apply; if you cannot, say what you tried.
- Round 3 ships. A round-3 `must-fix` without pasted failing RE-CHECK output is contract-invalid: one `codex-reply` starting `ROUND: 3/3 CHALLENGE —`, then ship if it does not stand.
- Escalate to parent only when a round-3 `must-fix` survives the challenge; quote the item, its RE-CHECK output and what you tried.
- `advisory` → address or justify declining. Your call.
