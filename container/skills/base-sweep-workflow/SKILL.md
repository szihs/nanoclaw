---
name: base-sweep
type: workflow
description: Periodic scan across a set of repos, channels, or sources to produce a ranked, action-first summary. Use when asked for a status report, weekly sweep, or "catch me up" across multiple sources. Not for deep-diving a single issue.
requires: [vcs-read, issue-tracker]
uses:
  skills: []
  workflows: []
params:
  scope:    { type: string, required: true, description: "What to sweep: repo list, channel list, or named scope." }
  since:    { type: string, required: false, description: "Lower time bound (e.g. '7d', '2026-04-10'). Defaults to last sweep." }
  topK:     { type: integer, default: 10, description: "Maximum items in the final report." }
produces:
  - sweep_report: { path: "/workspace/group/sweeps/{{scope_slug}}-{{sweep_date}}.md" }
  - sweep_index:  { path: "/workspace/group/sweeps/index.md", append_only: true }
---

# Base Sweep

Project-agnostic recurring sweep. Specialize by declaring the project's source skills in the calling workflow's `uses.skills` (e.g. `<proj>-github`, `<proj>-discord`).

## Invariants

- Action-first: every surfaced item has a proposed next step or is explicitly marked "no action".
- Rank by impact × recency × blocked-on-us. Do not sort chronologically.
- Cap the report at `{{topK}}` items. Additional items go to an appendix, not the main list.
- Do not open new issues or send notifications from a sweep; surface them for a human to decide.
- If nothing meaningful changed since last sweep, say so in one sentence — do not pad.

## Steps

1. **Determine window** {#window} — if `{{since}}` is set, use it. Otherwise read `{{sweep_index.path}}` for the last sweep timestamp; fall back to 7 days.

2. **Collect** {#collect} — for each source in `{{scope}}`, enumerate items updated in the window. Use the calling workflow's declared skills.

3. **Filter + rank** {#rank} — drop items that need no attention. Rank remaining by impact × recency × blocked-on-us. Take top `{{topK}}`.

4. **Propose action** {#propose} — for each surfaced item, write one of:
   - `action: <concrete next step>` — route to the right workflow or person.
   - `watch` — keep tracking, no action this cycle.
   - `stale` — should be closed or revisited; do not close from sweep.

5. **Write the report** {#report} to `{{sweep_report.path}}`:

```md
# Sweep: {{scope}} ({{sweep_date}})
- window: <since> → now
- source count: <n>, items surfaced: <k>

## Top items
1. <title> — <source> — <action>
2. ...

## Appendix (not surfaced)
<bulleted, grouped by source>
```

   Append the sweep to `{{sweep_index.path}}`.

6. **Summarize upstream** {#summarize} — post the top 3 items with proposed actions. Link the full report. Do not paste appendix.
