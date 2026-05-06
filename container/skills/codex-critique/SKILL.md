---
name: codex-critique
license: MIT
description: "Independent second-opinion review by an external Codex (gpt-5.5) reviewer. Direct skill — you (the parent agent) call mcp__codex__codex yourself; there is no Sonnet subagent in the middle. Read-only — produces a structured critique, never modifies files. Trigger after a patch, plan, investigation, or draft. Keywords: critique, review, second opinion, codex."
provides: [critique.review]
allowed-tools: Read, Grep, Glob, Bash(git diff:*), mcp__codex__codex, mcp__codex__codex-reply
---

# Codex Critique

You call `mcp__codex__codex` yourself — no subagent. Codex runs in a separate process (gpt-5.5 on NVIDIA inference), gets a fresh session per call, and has its own read-only filesystem access.

## Why this works

Three independence layers: **different model** (gpt-5.5, not yours), **different session** (fresh `threadId`), **different process** (MCP boundary — codex sees only `prompt` + `developer-instructions` + whatever it reads itself).

**Pass paths, not file contents.** The whole workspace is readable at `cwd`; pasting file bodies wastes tokens and codex will re-read them anyway. The only things you MUST inline are the original user spec (not on disk) and the stage + stage-specific questions.

## Call

```
mcp__codex__codex({
  prompt:                 <prompt template below>,
  developer-instructions: <developer-instructions template below>,
  sandbox:                "danger-full-access",   // Docker IS the sandbox; bwrap doesn't work nested.
  cwd:                    "/workspace/agent",
})
```

Capture `threadId` from the response — required for round 2/3 via `mcp__codex__codex-reply`.

Triage: `must-fix` → fix → re-invoke (up to 3 rounds); `should-fix` → address or justify declining; `nits` → ack and skip. Record per `critique-overlay`: write `/workspace/agent/critiques/<slug>-round-N.md` AND broadcast a `send_message` summary — both are mandatory.

## Prompt template

```
[STAGE: PLAN_REVIEW | DIAGNOSIS_REVIEW | CODE_REVIEW | OUTPUT_REVIEW]

ORIGINAL TASK / SPEC (verbatim — only lives in the parent's transcript, codex cannot read this from disk):
<paste the user's original request here, no paraphrasing>

REVIEW THESE FILES (read them yourself):
<for PLAN_REVIEW: /workspace/agent/reports/<slug>.md  (the proposed plan)>
<for DIAGNOSIS_REVIEW: inline your synthesis notes here (evidence, hypotheses, approaches under consideration) — no file exists at this gate; it fires before the report is written>
<for CODE_REVIEW: run `git diff <base>..HEAD` from cwd + /workspace/agent/reports/<slug>.md>
<for OUTPUT_REVIEW: <path-to-deliverable>>

PROJECT INVARIANTS — read from disk, do not assume from training data:
- <project>/AGENTS.md or CLAUDE.md
- Any *.md under <project>/invariants/ or docs/invariants/ if present

ALSO INSPECT (cross-reference):
- Source files the artifact references (Read/Grep)
- Test files that exercise those paths (Glob)
- Recent git history for behavioural changes (`git log`/`git show`)

QUESTIONS TO ANSWER (stage-specific — see critique-overlay for the list).
```

## developer-instructions template

```
You are an independent reviewer. You have NO prior conversation context — only what is in this prompt — but you DO have full read-only access to the workspace at `cwd`.

USE YOUR TOOLS. Read the artifact, invariants, and source files yourself — do not assume content from the prompt alone. Cite file and line for every concrete finding.

Reason from first principles. Verify each claim against the spec, artifact, and invariants directly — not by analogy to "how similar code usually looks." If you lack evidence, say so explicitly.

GUARD AGAINST SCOPE-SHRINKAGE. If the artifact reduces the deliverable below the original spec — e.g. proposing a "readiness assessment" when the spec said "make consumer X work", or proposing a synthetic test that exercises only paths the artifact already supports instead of the consumer named in the spec — flag it as MUST-FIX unless the artifact also documents an actual attempted execution that hit a concrete, evidenced blocker. Aspirational reductions ("the dependency probably can't be installed") are not acceptable; the agent must have tried before downgrading. Tests that mirror the artifact's current API surface are circular.

Do not propose actions that mutate state. Use `git`/`ls`/`cat`/`grep`/`find` freely for verification; no writes.

Produce the structured output below — nothing else. No conversational framing, no apologies, no follow-up offers.

OUTPUT FORMAT
=============

### Verdict
One of: `approve` | `approve-with-nits` | `request-changes` | `blocked`

### Must-fix (blocks merge)
- <file:line> — what is wrong, why it matters, the specific fix.

### Should-fix (advisory)
- <file:line> — concern + suggested change. The author may decline with written justification.

### Notes
- Observations, patterns, suggestions for future work. No "what" without "why."

(End of output. Stop.)
```

## Round 2 / Round 3

Call `mcp__codex__codex-reply` with the saved `threadId` and a follow-up: the new diff (or revised plan) + "I addressed items 1, 2, 3 — please re-verify and check whether the fixes introduced new issues." Same session, codex remembers its prior verdict. Same `must-fix` surviving 3 rounds → stop and escalate to the user via `mcp__nanoclaw__send_message`.

## Invariants

- Critique is advisory — the parent still owns the decision. But every `must-fix` must be *answered* in the verdict log (fix, justify, or reject); silent skipping is not allowed.
- Never paste your own reasoning, conclusions, or earlier-turn dialogue into the prompt. The MCP boundary is what makes the review independent — only artifacts and invariants cross it.
