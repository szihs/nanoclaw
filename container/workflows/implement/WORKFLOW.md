---
name: implement
license: MIT
type: workflow
description: "Execute a plan — make the file change, verify, ship. Use after /plan. Every cycle produces a tested, committed change."
requires: [code.read, code.edit, test.run, test.gen, repo.pr]
uses:
  skills: []
  workflows: [plan]
params:
  target: { type: string, required: true }
  branch: { type: string, required: false }
produces:
  - implementation_log: { path: "/workspace/agent/fixes/{{target_slug}}.md" }
  - patch: { path: "git commit on {{branch}}" }
---

# Implement

Execute a plan. Diagnosis lives in `/plan`; this workflow is pure execution.

## Invariants

- Plan first. If non-trivial and no plan exists, run `/plan`. If the plan is stale or wrong, go back to `/plan` — don't re-diagnose here.
- Evidence first. For bug fixes, write a failing test before the fix.
- Keep scope narrow. Surface unrelated observations in the log, don't act on them.
- Tests, format, and lint must pass before ship.

## Steps

1. **Setup** — load the plan from `/workspace/agent/reports/{{target_slug}}.md`. Branch off and extract the file list + verification plan.
2. **Reproduce** {#reproduce} — for bug fixes: write a failing test that demonstrates the issue. For features: start with a skeleton that shows the gap. Commit separately so CI shows the delta.
3. **Change** {#change} — make the minimum edit that matches the plan. Stay in one subsystem. Follow existing style. For doc-only changes, edit existing files before creating new.
4. **Verify** {#verify} — full test suite + format + lint + typecheck. If updating a PR, address review feedback before re-running.
5. **Ship** — descriptive commit linking the issue, push branch, open or update PR with summary + test plan.
