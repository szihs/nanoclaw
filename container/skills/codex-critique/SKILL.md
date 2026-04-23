---
name: codex-critique
description: "Ask an external Codex MCP reviewer to critique a proposed patch, test, or design. Trigger after a patch is written but before commit, or when a workflow's critique-overlay is active. Read-only — produces a structured critique, not changes. Keywords: critique, review, second opinion, codex."
provides: [critique.review]
allowed-tools: Read, Grep, Glob, Bash(git diff:*), mcp__codex__codex, mcp__codex__codex-reply
---

# Codex Critique

Project-agnostic critique skill. Wraps an external Codex MCP reviewer so any workflow can request a second opinion on a proposed change.

## When to use

- Immediately before committing a non-trivial patch in a fix workflow.
- When a workflow activates `/critique-overlay` after its patch / implement / generate step.
- When a reviewer wants an independent read on an approach before investing in review comments.

## Steps

1. **Prepare the diff** — `git diff` against the branch point. Keep the diff focused; critique quality drops on sprawling changes.

2. **Request critique** — `mcp__codex__codex` with `sandbox: read-only`. Pass: the diff, the stated intent, and the relevant invariants (from the coworker spine) in the prompt. Set `developer-instructions` to request verdict + must-fix + should-fix + nits format. Use `mcp__codex__codex-reply` if follow-up is needed.

3. **Triage the response** —
   - `must-fix`: block the workflow from proceeding; loop back to patch.
   - `should-fix`: address inline unless justifying in the fix log.
   - `nits`: acknowledge, skip unless trivial.

4. **Record** — write the critique verdict + reasoning into the workflow's fix/review log. Do not paste the full critique.

## Invariants

- Critique is advisory — the responsible agent still makes the call. A bad critique does not block work, but it must be answered in the log.
- Never ship a critique's raw output as the PR review — summarize and attribute.
- Critique is read-only; it does not modify files or commit.
