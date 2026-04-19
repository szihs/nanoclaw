---
name: slang-ci-babysitter
type: workflow
description: Watch Slang CI, classify failures as flake vs. real, rerun only safe jobs, and requeue merge candidates when warranted. Use when a PR or merge queue hits CI failures and the maintainer needs a classification before deciding to rerun or dig in.
uses:
  skills: [slang-github]
  workflows: []
params:
  prNumber: { type: integer, required: false, description: "PR under watch. Required if not sweeping the whole queue." }
  repo:     { type: string, default: "shader-slang/slang" }
produces:
  - ci_report: { path: "/workspace/group/ci/pr-{{prNumber}}.md" }
---

# Slang CI Babysitter

Classify Slang CI failures and act narrowly.

## Steps

1. **Fetch state** — `/slang-github` → pull the PR (or merge queue) workflow runs. Record run IDs, jobs, and first-failure logs.

2. **Classify each failure**:
   - **Flake** — matches a known flaky signature (network timeout, runner disk pressure, known-intermittent test).
   - **Real** — reproducible, test-logic driven, or environment-independent.
   - **Environmental** — runner-side outage (GitHub Actions incident, GPU unavailable).

   Record the classification and evidence (log lines, prior occurrences) in `{{ci_report.path}}`.

3. **Act narrowly**:
   - **Flake** — rerun only that failed job (not the full workflow). Note the rerun ID.
   - **Environmental** — wait and recheck after the incident clears. Do not rerun.
   - **Real** — stop. Post the failure summary to the PR and hand off (do not attempt a fix here — `/slang-fix` owns that).

4. **Merge queue recovery** — if the failure is in the merge queue and classified as a flake, requeue the PR via `/slang-github`. Cap at two requeue attempts per PR.

5. **Summarize** — post a ≤5 bullet comment on the PR with the classification, action taken, and link to `{{ci_report.path}}`.

## Invariants

- Do not rerun the whole workflow for a single flaky job — it burns runner minutes and obscures signal.
- Do not silence a real failure by marking it flaky. Require evidence from known-flake signatures.
- Never merge a PR. The babysitter reports and reruns only.
- Do not disable or edit CI workflows. That is a maintainer decision, not an automation one.
