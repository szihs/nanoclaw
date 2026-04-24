---
name: investigate
type: workflow
description: Understand a problem before acting — triage an issue, research a topic, diagnose CI, or sweep across sources. Use when asked "what's going on?", "triage this", "why is CI red?", or "catch me up."
requires: [issues.read, code.read, doc.read, plan.research]
uses:
  skills: []
  workflows: []
params:
  target: { type: string, required: true, description: "Issue, question, CI failure, or topic to investigate." }
produces:
  - report: { path: "/workspace/agent/reports/{{target_slug}}.md" }
  - report_index: { path: "/workspace/agent/reports/index.md", append_only: true }
---

# Investigate

Understand the problem. Classify, research, and report — but do not fix.

## Invariants

- Separate confirmed facts from hypotheses — label each explicitly.
- Do not propose code changes. Investigation classifies and routes; `/implement` builds.
- Keep a written trail so the next session can resume without re-investigating.

## Steps

1. **Ingest** {#ingest} — read the target end-to-end: description, comments, attachments, prior reports. Write a one-paragraph summary of the reported behavior or question.

2. **Classify** {#classify} — determine what kind of investigation this is:
   - **Bug/regression** — assign severity, affected subsystem, reproduction hypothesis.
   - **CI failure** — classify as flake vs. real regression. Check run logs, compare across runners.
   - **Research question** — frame the question, identify what sources to consult.
   - **Status sweep** — define the time window and sources to scan.

3. **Investigate** {#investigate} — use the project's skills to:
   - Locate affected files, modules, or components.
   - Find related prior issues, PRs, or incidents.
   - For CI: inspect logs, classify failures, identify patterns.
   - For research: gather from external sources (deepwiki, web, docs).
   - For sweeps: collect across repos, channels, or trackers and rank by urgency.

4. **Decide** {#decide} — exactly one of:
   - **Ready for action** — enough evidence to hand off (fix, rerun CI, update docs).
   - **Needs more info** — blockers listed, questions posed.
   - **No action needed** — duplicate, won't-fix, flake already rerun, or question answered.

5. **Report** {#report} — write structured findings to `{{report.path}}`:

```md
# Investigation: <target>
- status: <ready-for-action | needs-info | resolved | no-action>
- type: <bug | regression | ci-failure | research | sweep>
- severity: <low | medium | high | critical>
- affected: <subsystem / component / repo>
- facts: <bulleted>
- hypotheses: <bulleted, each with evidence level>
- next: <concrete recommended action>
- references: <linked issues, PRs, files, URLs>
```

   Append a line to `{{report_index.path}}`.

6. **Summarize** {#summarize} — post a concise (≤5 bullet) summary to whoever requested the investigation. Link the full report.

## Resumability

- `{{report.path}}` is the durable record. Subsequent sessions read it before acting.
- If investigation is incomplete when the session ends, status stays `needs-info` with blockers listed.
