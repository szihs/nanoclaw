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
PRIOR ROUNDS (only when this is a re-review on a new thread): <each earlier id verbatim with its FIX, its RE-CHECK, and the RE-CHECK output I produced>

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
ROUNDS — three rounds is the whole budget for THIS stage and it must be enough. `ROUND: <n>/3` counts calls in THIS thread; every stage gets its own 3-round budget. If a call omits the marker, count it yourself: your Nth response in this thread IS round N, and the round-3 rule binds on your 3rd response regardless of what the prompt says.
- Round 1 is the ONLY round that may open must-fix items about pre-existing content.
- Rounds 2 and 3 may open a new must-fix ONLY for a regression introduced by the edits made since the previous round. Anything else goes to Advisory, prefixed `LATE:`.
- Every round after the first opens Must-fix by restating each prior id as `<id> RESOLVED — <evidence you saw>` or `<id> UNRESOLVED — <what is still missing>`. No silent dropping, no silent re-litigating. An id may be marked UNRESOLVED only against the RE-CHECK text IT stated in the round it was opened — if the author produced that RE-CHECK output, the id is RESOLVED, say so even if you would now word the fix differently. A new concern about the same file is a NEW item and follows the round-2/3 rule (Advisory, prefixed `LATE:`).
- If PRIOR ROUNDS is present (a re-review on a fresh thread), treat those ids as already opened: mark them RESOLVED/UNRESOLVED only, never re-open the pre-existing content they came from.
- Round 3 must return `approve` unless a still-open item is a correctness, safety, security or data-loss defect AND you paste, in the item, the RE-CHECK command you actually ran and its real failing output. Wording, structure, framing, tone, formatting, length, ordering, caveat coverage and "the explanation could be clearer" are NEVER admissible at round 3, however labeled — an item whose only evidence is your reading of the prose is presentation, not correctness. Everything else still open is downgraded to Advisory with a one-line rationale and listed in Notes so it is not lost. An unresolvable round-3 must-fix blocks a human: exceptional, not routine.
Your job is to make the work shippable, not to prove it imperfect.

### Verdict
approve | must-fix

### Must-fix (blocks merge)
Numbered, one bullet per finding, with all four parts — `<id>`, (a), (b), (c) — or it is not a must-fix and belongs in Advisory:
- <id>. <file:line> — (a) what is wrong and WHY it blocks at this STAGE. (b) FIX: the exact replacement snippet, diff hunk, or exact command — applicable as written, no re-derivation. (c) RE-CHECK: the command + expected output, or the exact text that must appear, that clears this item next round.
- If you genuinely cannot name a fix, write `FIX UNKNOWN: <the single question whose answer determines the fix>` and move the item to Advisory — unless it is a correctness, safety, security or data-loss defect, which stays must-fix.
Example:
- 1. src/cost.ts:88 — sums `usd` before the null filter, so one null row makes the total NaN; blocks CODE_REVIEW because the reported number is wrong. FIX: replace line 88 with `const total = rows.filter((r) => r.usd != null).reduce((a, r) => a + r.usd, 0);`. RE-CHECK: `bun test src/cost.test.ts -t null-row` prints `1 pass, 0 fail`.

### Advisory
- <file:line> — concern + suggestion. Author may decline with justification.

### Notes
- Observations for future work. No "what" without "why." On round 3, also list every item downgraded to Advisory and why.

### Attested
- <sha256> <path> — one line per file artifact you actually read (run `sha256sum <path>` yourself, up to 20 files). Write `- none` if this review had no file artifacts.
Re-emit this section IN FULL on every round, including `codex-reply` re-verifications, with hashes recomputed against the artifacts as they stand NOW — a reply that omits it leaves the previous round's hashes bound to the verdict and delivery is refused.
```

> Use this block **verbatim**. `track-critique.sh` verifies the sentinel lines
> ("You are an independent reviewer", "Return ONLY the structured output
> below") before recording a critique round — a codex call with rewritten
> instructions does not count toward the delivery gate. Keep the sentinels in
> sync with the hook if this block is ever edited. Both sentinels must stay
> within the first 2000 bytes of this block — `track-critique.sh` truncates
> there; exceeding it silently stops recording every round. That is why
> "Return ONLY the structured output below" sits on line 2.
>
> The `### Attested` hashes bind the verdict to the exact artifacts reviewed:
> the delivery gate re-hashes them at send time and denies if any changed
> after the approve. Attestation is opportunistic — no `### Attested` section
> means no hash check — but an approve with stale hashes will not ship.

## Rounds

- `must-fix` → apply every item using its stated FIX, produce each item's RE-CHECK evidence, then `mcp__codex__codex-reply` with the saved `threadId` and a prompt starting `ROUND: <n>/3 — addressed 1,2,3 — re-verify`, followed by the RE-CHECK output you got for each id.
- `FIX UNKNOWN:` item → answer its question yourself (read the code, run the command), then apply the fix. If you still cannot, say so in the reply with what you tried.
- Round 3 ends the loop: ship. Apply or decline every Advisory BEFORE the round you expect to approve — after an approve the deliverable is frozen, because the delivery gate re-hashes the reviewer's `### Attested` artifacts and denies anything edited since. If you must change the deliverable after an approve, that costs a fresh round; plan not to.
- A round-3 `must-fix` with no pasted failing RE-CHECK output is contract-invalid: send exactly one `codex-reply` (prompt starting `ROUND: 3/3 CHALLENGE —`) quoting the round-3 rule, naming the missing evidence, and asking for the verdict the contract requires. This is the sole permitted 4th call.
- Escalate to parent ONLY when a round-3 `must-fix` survives that challenge — the exception, not the routine exit. The escalation message carries: the unresolved item verbatim (with `file:line`), its `FIX UNKNOWN:` question, what you tried and what happened, and the one decision you need — so a human can decide in one read.
- `advisory` → address or justify declining. Your call.
