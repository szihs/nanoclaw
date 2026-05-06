---
name: slang-maintain
license: MIT
type: workflow
description: "Recurring read-only Slang maintainer sweeps — daily report, release notes, issue prioritization, Slack review. Output is text; no code changes."
requires: [issues.read, repo.read]
uses:
  skills: [slang-maintainer-tools]
  workflows: []
params:
  task:
    type: enum
    enum: [daily-report, release-notes, issue-prioritization, review-messages]
    required: true
  time_range:
    type: string
    default: "24h"
produces:
  - report: { path: "/workspace/agent/reports/slang-maintain-{{task}}-{{date}}.md" }
---

# Slang Maintain

Read-only maintainer sweeps. Produce a written artifact; never change source. If a sweep surfaces work that needs code or git changes, escalate to a writer coworker (whose `slang-implement` workflow handles the fix) — don't act here.

## Invariants

- Read-only. No pushes, no submodule updates, no rebases.
- Always pass a time range. Default is `24h`.
- Cite sources in the deliverable (PR/issue/thread URLs).

## Steps

1. **Confirm** {#confirm} — restate the `task` and `time_range`.
2. **Collect** {#collect} — invoke the `slang-maintainer-tools` skill to gather the data set the task requires.
3. **Synthesize** {#synthesize} — categorize and deduplicate. Separate facts from open questions.
4. **Deliver** {#deliver} — write the report to `{{report.path}}` and post a ≤5-bullet summary with a link.

## Handoff

- If the sweep finds a bug, regression, or pending migration that needs code changes, raise it to the user or route to a writer coworker for a `slang-implement` run. This workflow does not make changes.
