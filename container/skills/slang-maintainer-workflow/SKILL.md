---
name: slang-maintainer
type: workflow
description: Periodic Slang compiler maintainer sweep — scan open issues, PRs, CI health, and release-track status, producing a ranked action-first report. Use for scheduled maintainer check-ins or when asked "what needs attention across slang?". Specialization of `/base-sweep`.
extends: base-sweep
requires: [vcs-read, issue-tracker, ci-inspect]
uses:
  skills: [slang-build, slang-explore, slang-github]
  workflows: [base-sweep]
params:
  since: { type: string, required: false, description: "Lower time bound (e.g. '7d'). Defaults to the last sweep." }
  topK:  { type: integer, default: 10 }
  repo:  { type: string, default: "shader-slang/slang" }
produces:
  - sweep_report: { path: "/workspace/group/sweeps/slang-{{sweep_date}}.md" }
  - sweep_index:  { path: "/workspace/group/sweeps/index.md", append_only: true }
---

# Slang Maintainer Sweep

Project-specific specialization of `/base-sweep` for the Slang compiler repo.

## Steps

1. **Run base sweep** — `/base-sweep scope={{repo}}`. Use its output as the scaffold.

2. **Inventory inputs**:
   - Open issues without triage labels (via `/slang-github`).
   - PRs with stale review > 7d.
   - Recent CI failures on `master` (via `.github/workflows/`).
   - Release-track branches and their current HEAD.

3. **Rank** — weight each item by: user impact × severity × age. Surface the top-`{{topK}}`.

4. **Report** — write `{{sweep_report.path}}` with sections:
   - **Action now** — items the maintainer should pick up today.
   - **Needs triage** — issues missing classification.
   - **Stalled PRs** — PRs blocked on review or CI.
   - **CI health** — failure patterns across the sweep window.
   - **Release status** — track-by-track notes.

   Append a one-line link to `{{sweep_index.path}}`.

5. **Post summary** — concise (≤8 bullet) digest via `mcp__nanoclaw__send_message`. Do not paste the full report — link it.

## Invariants

- Do not self-assign maintainer actions. Surface, do not execute.
- Never close an issue as stale without maintainer sign-off.
- Use the triage report format from `/slang-triage` — do not invent a new schema.
