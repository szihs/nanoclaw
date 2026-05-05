---
name: codex-critique
description: "Independent second-opinion review by an external Codex (gpt-5.5) reviewer. Direct skill — you (the parent agent) call mcp__codex__codex yourself; there is no Sonnet subagent in the middle. Read-only — produces a structured critique, never modifies files. Trigger after a patch, plan, investigation, or draft. Keywords: critique, review, second opinion, codex."
provides: [critique.review]
allowed-tools: Read, Grep, Glob, Bash(git diff:*), mcp__codex__codex, mcp__codex__codex-reply
---

# Codex Critique

A direct second-opinion review against an external Codex model (gpt-5.5 via NVIDIA inference). **You** — the agent reading this — call `mcp__codex__codex` yourself. Do not spawn a subagent; there is no `codex-critique (agent)` anymore. The MCP boundary itself gives the isolation that a subagent used to provide: codex runs in a separate process, sees only what you put in `prompt` + `developer-instructions`, and starts a fresh session per call.

## When to use

- Before committing a non-trivial patch (CODE_REVIEW gate).
- After writing a plan, before implementing (PLAN_REVIEW gate).
- After investigation, before patching (DIAGNOSIS_REVIEW gate).
- After a draft or written deliverable (OUTPUT_REVIEW gate).
- Whenever you want an unbiased, decorrelated read on an approach.

## Why it works (decorrelation, by design)

The point of this skill is **independence**. Three layers enforce it:

1. **Different model** — codex is gpt-5.5, not the writing model.
2. **Different session** — every call gets a fresh `threadId`. Codex sees no history.
3. **Different process** — codex runs out-of-band via the host MCP server. Your transcript, memory, scratchpad, and file-watch state are unreachable; only the `prompt` field crosses the boundary.

Because of layer 3, codex sees only what you give it via `prompt` + `developer-instructions` AND whatever it reads itself from the filesystem under `cwd`. **Lean on its filesystem access.** Codex has its own `Read`, `Grep`, `Glob`, and shell tools — point it at directories and let it explore. Do NOT paste large file contents into the prompt; that wastes tokens and codex will read them anyway. The two things you MUST inline are:

1. The **original user task / spec** (only lives in your transcript — codex can't pull it from disk).
2. The **stage** + **specific questions** to answer at this gate.

Everything else (the plan, the diff, source code, invariants, reports, project conventions) — give codex paths and let it `Read` them itself. The whole `/workspace/agent` tree is mounted read-only into codex's process, including the project source, `plans/`, `reports/`, `critiques/`, `corvk/AGENTS.md`, etc.

## Steps

1. **Identify what to point codex at** — for the current stage, gather paths (NOT file contents) for: the artifact under review, the project invariant docs, any related plans/reports.

2. **Call `mcp__codex__codex` directly.** Pass:
   - `prompt`: the structured prompt below — describes WHAT to verify with paths, not full file contents.
   - `sandbox`: `"danger-full-access"` — Docker container is the sandbox; bwrap does not work inside Docker. Read-only enforcement comes from `disallowedTools` on the parent agent.
   - `developer-instructions`: see the template below — establishes role, output format, and the first-principles directive (telling codex it has filesystem access and should use it).
   - `cwd`: `"/workspace/agent"` — the workspace root. Codex can navigate to `corvk/`, `holohub/`, `plans/`, `reports/`, etc. from here.

3. **Capture the `threadId`** from the response. Save it for round 2/3 follow-ups via `mcp__codex__codex-reply`.

4. **Triage the verdict** —
   - `must-fix` → block the workflow; loop back to fix; re-invoke (round 2).
   - `should-fix` → address inline unless you justify declining in the verdict log.
   - `nits` → acknowledge; skip unless trivial.

5. **Record** — per `critique-overlay`, write the full verdict to `/workspace/agent/critiques/<slug>-round-N.md` AND broadcast a `mcp__nanoclaw__send_message` summary with the must-fix bullets. Both are mandatory; neither replaces the other.

## Prompt template

Send to codex as the `prompt` argument. Pass paths, not file contents — codex will read them.

```
[STAGE: PLAN_REVIEW | DIAGNOSIS_REVIEW | CODE_REVIEW | OUTPUT_REVIEW]

ORIGINAL TASK / SPEC (verbatim — only lives in the parent's transcript, codex cannot read this from disk):
<paste the user's original request here, no paraphrasing>

REVIEW THESE FILES (read them yourself — full contents are at these paths):
<for PLAN_REVIEW: plans/<slug>.md  (the proposed plan)>
<for DIAGNOSIS_REVIEW: reports/<slug>.md  (the investigation findings)>
<for CODE_REVIEW: run `git diff <base>..HEAD` from cwd; plans/<slug>.md (the approved plan)>
<for OUTPUT_REVIEW: <path-to-deliverable>>

PROJECT INVARIANTS — read these from disk (do not assume from training data):
- corvk/AGENTS.md  (the project's non-negotiable invariants)
- corvk/PLAN.md  (current project plan)
- Any *.md under corvk/invariants/ if present

ALSO INSPECT (cross-reference for verification):
- The actual source files referenced in the artifact (use Read/Grep)
- The test files that exercise the relevant code paths (use Glob)
- Recent git history if behavioural change is involved (use `git log`/`git show`)

QUESTIONS TO ANSWER (stage-specific — see critique-overlay/SKILL.md for the full list).
```

## developer-instructions template

Send as the `developer-instructions` argument (this becomes codex's system-side preamble):

```
You are an independent code/plan reviewer. You have NO prior conversation context — only what is in this prompt — but you DO have full read-only access to the workspace at `cwd` (default /workspace/agent).

USE YOUR TOOLS. Read the artifact, the invariants, and the source files yourself. Do not assume content from the prompt alone — verify by reading. Use `Read`, `Grep`, `Glob`, and `git diff`/`git show` freely. The whole project tree is browsable from `cwd`.

Reason from first principles. Verify each claim against the spec, the artifact, and the project invariants directly — not by analogy to "how similar code usually looks." If you don't have evidence, say so explicitly rather than infer. Cite files and line numbers for every concrete finding.

GUARD AGAINST SCOPE-SHRINKAGE. If the artifact under review reduces the deliverable below the original spec — e.g. proposing a "readiness assessment" when the spec said "make the consumer X work," or proposing a synthetic test that exercises only paths the artifact already supports instead of the consumer named in the spec — flag it as MUST-FIX unless the artifact also documents an actual attempted execution that hit a concrete, evidenced blocker. Aspirational reductions ("the dependency probably can't be installed") are not acceptable; the agent must have tried before downgrading. Tests that mirror the artifact's current API surface are circular and pass in a vacuum — reject them and require a test that loads the spec's mandatory feature set (the original consumer, or a faithful surrogate of it).

Read-only sandbox is enforced: do not propose actions that would mutate state. Use `git`/`ls`/`cat`/`grep`/`find` freely for verification; do not run any command that writes.

Produce the structured output below — nothing else. No conversational framing, no apologies, no follow-up offers.

OUTPUT FORMAT
=============

### Verdict
One of: `approve` | `approve-with-nits` | `request-changes` | `blocked`

### Must-fix (blocks merge)
- <file:line> — what is wrong, why it matters, the specific fix recommendation.

### Should-fix (advisory)
- <file:line> — concern + suggested change. The author may decline with written justification.

### Notes
- Observations, patterns, suggestions for future work. No "what" without "why."

(End of output. Stop.)
```

## Round 2 / Round 3 follow-ups

After fixing must-fix items, call `mcp__codex__codex-reply` with the saved `threadId` and a follow-up prompt: the new diff (or revised plan), and an explicit "I addressed items 1, 2, 3 — please re-verify and check whether the fixes introduce new issues." Codex will continue the same session and remember its prior verdict.

If the same `must-fix` survives 3 rounds, **stop** and escalate to the user via `mcp__nanoclaw__send_message` (per critique-overlay).

## Invariants

- This skill is read-only end-to-end: the parent's `disallowedTools` is unchanged; the codex sandbox uses `danger-full-access` (Docker is the security boundary); nothing is committed by this skill.
- The MCP boundary is what makes the review independent. Do not paste your own reasoning, conclusions, or earlier-turn dialogue into the prompt — only artifacts and invariants.
- Critique is advisory; the parent agent still owns the decision. A bad critique does not silently block work, but it must be *answered* in the verdict log (either fix, justify, or reject).
- Do not ship the raw critique as the PR review — summarize and attribute.
