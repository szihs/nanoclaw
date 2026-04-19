---
name: base-pr-update
type: workflow
description: Respond to review feedback or CI failures on an existing PR by updating the branch — rebase, amend, add commits, and re-run CI. Use when a PR needs iteration, not for the original fix. Do not widen scope in this workflow.
requires: [vcs-read, vcs-write, vcs-pr]
uses:
  skills: []
  workflows: []
params:
  prTarget: { type: string, required: true, description: "PR URL or repo#<number>." }
  mode:     { type: enum, default: "respond", enum: ["respond", "rebase", "retest"] }
produces:
  - update_log: { path: "/workspace/group/pr-updates/{{prTarget_slug}}.md" }
  - patch:      { path: "additional commit(s) on the PR branch" }
---

# Base PR Update

Project-agnostic PR-iteration workflow. Moves an open PR forward in response to review or CI — without changing its scope.

## Invariants

- Do not widen the PR. If feedback requires scope change, close + open a new PR, or split.
- Never force-push without explicit authorization; prefer additional commits, then a squash on merge.
- Re-run CI only after a push. Speculative reruns mask flakes — surface them instead (hand off to `/base-ci-health`).
- Respond to every reviewer comment, even if the response is "deferred, see issue #X".

## Steps

1. **Load PR state** {#load} — fetch `{{prTarget}}`, its diff, its reviews, its inline comments, and its CI state.

2. **Classify feedback** {#classify} — per comment: `must-fix`, `should-fix`, `nit`, `question`, `out-of-scope`. Record in `{{update_log.path}}`.

3. **Update branch** {#update} — address `must-fix` + `should-fix`. Mode:
   - **respond**: address comments, commit incrementally with messages that cite the comment.
   - **rebase**: rebase onto the latest target branch, resolve conflicts, force-push with-lease (authorized).
   - **retest**: push an empty commit or re-run CI safely when only CI signals changed.

4. **Reply** {#reply} — reply inline to each comment with: resolution or justification. Mark resolved only when the change is pushed.

5. **Verify CI** {#verify} — watch the updated CI run. Do not mark ready-for-review until green.

6. **Summarize** {#summarize} — top-level comment: what changed in this round, how each reviewer's asks were handled, link to `{{update_log.path}}`.

## Handoff

- If reviewers disagree, do not pick — escalate. Surface the disagreement to the author + reviewers; do not resolve from this workflow.
- CI regressions introduced in the update block the workflow; loop to `/base-fix` for the regression before continuing.
