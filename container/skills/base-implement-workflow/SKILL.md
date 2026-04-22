---
name: implement
type: workflow
description: Turn an investigated issue or spec into code — reproduce, fix, write tests, and submit a PR. Use after investigation confirms the problem, or when given a clear spec. Covers bug fixes, features, and test authoring.
requires: [code.read, code.edit, test.run, test.gen, repo.pr]
uses:
  skills: []
  workflows: [investigate]
params:
  target: { type: string, required: true, description: "Issue, spec, or investigation report reference." }
  repo: { type: string, required: true }
  branch: { type: string, required: false, description: "Branch name; auto-generated if omitted." }
produces:
  - implementation_log: { path: "/workspace/group/fixes/{{target_slug}}.md" }
  - patch: { path: "git commit on {{branch}}" }
---

# Implement

Reproduce, fix, test, and ship. One branch, one PR.

## Invariants

- Always reproduce before patching. No fix without evidence the problem exists.
- Always add or update tests. No code change ships without a regression guard.
- Run the full test suite before declaring ready. Partial runs are not sufficient.
- Do not widen scope. Fix what was asked; surface observations for separate work.
- Format and lint before committing.

## Steps

1. **Load context** {#load-context} — read the investigation report for `{{target}}`. If none exists, run `/investigate {{target}}` first. Extract: root cause, affected files, reproduction steps.

2. **Reproduce** {#reproduce} — create a minimal reproduction that demonstrates the problem. For bugs: a failing test case. For features: a skeleton that shows the gap. Commit the reproduction separately so CI shows the delta.

3. **Root-cause** {#root-cause} — trace from the reproduction to the exact code path. Document: file, line, mechanism. If the root cause differs from the investigation's hypothesis, update the report.

4. **Patch** {#patch} — implement the minimum change that fixes the root cause or delivers the spec. Stay inside one subsystem. Follow existing code style.

5. **Test** {#test} — write or update tests that cover:
   - The specific fix (regression guard).
   - Edge cases surfaced during investigation.
   - Do NOT modify existing passing tests unless they test wrong behavior.

6. **Validate** {#validate} — run the full project test suite + format/lint/typecheck. All must pass. If updating an existing PR, address all review feedback before re-running.

7. **Commit & PR** {#commit} — descriptive commit message linking the issue. Push the branch. Create or update the PR with:
   - Summary of what changed and why.
   - Link to the issue.
   - Test plan.

## Resumability

- `{{implementation_log.path}}` tracks progress. Each step appends its outcome.
- If the session ends mid-work, the log records what's done, what's pending, and any blockers.
