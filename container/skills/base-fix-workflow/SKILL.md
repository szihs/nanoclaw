---
name: base-fix
type: workflow
description: Take a triaged issue (or well-scoped fix request) from reproduction through minimal patch, tests, and PR-ready state. Use after triage is complete and a fix is authorized. Do not use for exploratory investigation — that is triage's job.
requires: [code-read, code-edit, test-run, vcs-pr]
uses:
  skills: []
  workflows: [base-triage]
params:
  target: { type: string, required: true, description: "Issue, ticket, or triage report reference." }
  repo: { type: string, required: true }
  branch: { type: string, required: false, description: "Branch name; auto-generated if omitted." }
produces:
  - fix_log: { path: "/workspace/group/fixes/{{target_slug}}.md" }
  - patch:   { path: "git commit on {{branch}}" }
---

# Base Fix

Project-agnostic fix lifecycle. Specialize by declaring the project's build + explore + github skills in the calling workflow's `uses.skills`.

## Invariants

- No fix without a reproduction, or a written justification for why reproduction is impossible.
- Change the minimum that makes the test pass. Resist drive-by refactors.
- Every fix ships with at least one test that would have caught the original bug.
- Run the project's format/lint/typecheck pipeline before declaring done.
- Do not force-push, rebase published branches, or skip hooks (`--no-verify`) without explicit authorization.

## Steps

1. **Load context** {#load-context} — read the triage report for `{{target}}`. If none exists, run `/base-triage` first; do not proceed without one.

2. **Reproduce** {#reproduce} — create a minimal repro:
   - A failing test is the preferred form. Commit it first.
   - If a test cannot express the failure, write a step-by-step repro into `{{fix_log.path}}`.

3. **Root-cause** {#root-cause} — investigate until the cause is identified with evidence (file + line + mechanism). Record the finding in `{{fix_log.path}}`. If the cause ends up broader than the triage suggested, stop and re-triage.

4. **Patch** {#patch} — implement the minimum change. Keep unrelated edits out. If the patch touches more than 3 areas, reconsider scope.

5. **Validate** {#validate} — run the project test suite + format/lint/typecheck. Re-run the repro test: it must now pass. Add additional tests for adjacent cases only if they catch real regressions.

6. **Commit + prepare PR** {#commit} — descriptive commit message referencing `{{target}}`. Fill in `{{fix_log.path}}` with: root cause, patch summary, test coverage, risks. PR body summarizes the log — does not paste it.

## Handoff

- If review feedback requires scope change, open a fresh fix iteration — do not silently widen the patch in place.
- If CI fails, read the log before guessing. Classify as flake vs real. For flakes, defer to a CI-babysitter workflow if available.
