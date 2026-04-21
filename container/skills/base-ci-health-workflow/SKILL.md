---
name: base-ci-health
type: workflow
description: Periodically classify CI failures across a repo as flake vs. real, surface real regressions, and safely requeue flakes. Use for merge-queue babysitting, release-branch health, or "why is CI red?" sweeps. Not for fixing the underlying bugs — surface and route.
requires: [vcs-read, ci-inspect, ci-rerun, issue-tracker]
uses:
  skills: []
  workflows: []
params:
  repo:   { type: string, required: true, description: "Repository slug, e.g. owner/name." }
  window: { type: string, default: "24h", description: "How far back to look for CI activity." }
  maxRerun: { type: integer, default: 5, description: "Hard cap on jobs this workflow may rerun per invocation." }
produces:
  - ci_report: { path: "/workspace/group/ci/{{repo_slug}}-{{sweep_date}}.md" }
  - ci_index:  { path: "/workspace/group/ci/index.md", append_only: true }
---

# Base CI Health

Project-agnostic CI-health maintainer workflow. Runs every N minutes (or on demand) and produces a short, high-signal report plus safe reruns.

## Invariants

- Never rerun a job whose failure signature matches a **real regression** pattern. Flakes only.
- Hard cap at `{{maxRerun}}` reruns per invocation; if you'd exceed it, surface instead.
- Classification (flake vs. real) must cite evidence: log snippet + matching heuristic or prior-history link.
- This workflow never edits code, opens PRs, or disables tests. That routes to a fix workflow.

## Steps

1. **Collect failures** {#collect} — enumerate failing CI runs on `{{repo}}` within `{{window}}`. Bucket by workflow + job + failure signature.

2. **Classify** {#classify} — for each failure:
   - **real** — deterministic failure on `master` / `main`, or reproduces on rerun, or matches a known regression fingerprint.
   - **flake** — intermittent across runs, matches a known flake fingerprint (network, timing, resource).
   - **unknown** — insufficient evidence; treat as real until proven otherwise.

3. **Rerun safely** {#rerun} — for each `flake` bucket, rerun the smallest set of jobs that clears the merge queue (PR-scoped reruns preferred). Respect `{{maxRerun}}`.

4. **Route reals** {#route} — for each `real`, post a concise summary and a proposed next step (open issue / page owner / hold release). Do not open the issue from this workflow.

5. **Write report** {#report} — `{{ci_report.path}}` with:

```md
# CI health: {{repo}} ({{sweep_date}})
- window: {{window}}
- runs inspected: <n>, failures: <k>
## Real regressions
- <job> — <signature> — <next step>
## Flakes requeued
- <job> — <signature> — <run id>
## Unknown (held)
- <job> — <signature>
```

   Append a line to `{{ci_index.path}}`.

6. **Summarize upstream** {#summarize} — top 5 items with next steps. Link the full report.

## Handoff

- Repeat flakes across multiple sweeps with the same signature graduate to `real` on the fourth occurrence.
- When the merge queue stalls for reasons this workflow cannot resolve, escalate rather than retrying.
