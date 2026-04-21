---
name: base-triage
type: workflow
description: Triage an incoming issue, bug report, or task into a subsystem + severity + next-step report. Use when a new issue is assigned, when a user says "triage this", or when a report needs to be classified and routed before any fix work.
requires: [issue-tracker, code-read]
uses:
  skills: []
  workflows: []
params:
  target: { type: string, required: true, description: "The issue URL, ticket id, or task reference being triaged." }
  repo: { type: string, required: false, description: "Repository slug when the triage involves source code." }
  severityDefault: { type: enum, default: "medium", enum: ["low", "medium", "high", "critical"] }
produces:
  - triage_report: { path: "/workspace/group/reports/{{target_slug}}.md" }
  - triage_index:  { path: "/workspace/group/reports/index.md", append_only: true }
---

# Base Triage

Project-agnostic triage. Specialize by picking the project's investigation skills (e.g. `<proj>-github`, `<proj>-explore`) via the calling workflow's `uses.skills`. This workflow is the shape — the skills are the parts.

## Invariants

- Separate confirmed facts from hypotheses and open questions — explicitly label each.
- Do not label something a duplicate, regression, or not-a-bug without evidence.
- Do not propose a fix here. Triage classifies and routes; fix workflows implement.
- Keep a short written trail so the next session can resume without re-investigating.

## Steps

1. **Ingest** {#ingest} — read the target (`{{target}}`) end-to-end: description, comments, attachments, prior triage notes. Write a one-paragraph summary of the reported behavior.

2. **Classify** {#classify} — assign:
   - **Category** (bug / regression / feature / task / question / duplicate).
   - **Severity** (default `{{severityDefault}}`; raise with evidence).
   - **Affected surface** — subsystem, component, or area of the codebase/product.

3. **Investigate** {#investigate} — use the calling workflow's declared skills to locate:
   - Likely affected files or modules.
   - Related prior issues, PRs, or incidents.
   - A first reproduction hypothesis if applicable.

4. **Decide next step** {#decide} — exactly one of:
   - **Ready for fix** — enough evidence to hand off to a fix workflow.
   - **Needs more info** — blockers listed, questions posed back to the reporter.
   - **Duplicate / won't-fix / out-of-scope** — with justification.

5. **Report** {#report} — write the structured report to `{{triage_report.path}}`:

```md
# Triage: <target>
- status: <ready-for-fix | needs-info | duplicate | wont-fix>
- category: <bug | regression | feature | task | question>
- severity: <low | medium | high | critical>
- affected: <subsystem / component>
- facts: <bulleted>
- hypotheses: <bulleted, each with evidence level>
- next: <concrete action>
- references: <linked issues, PRs, files>
```

   Append a line to `{{triage_index.path}}` linking the new report.

6. **Summarize upstream** {#summarize} — post a concise (≤5 bullet) summary to whoever requested the triage. Link the full report. Do not paste the report body.

## Resumability

- `{{triage_report.path}}` is the durable record. Subsequent sessions read it before acting.
- `{{triage_index.path}}` is append-only; never rewrite prior entries.
- If the triage is incomplete when the session ends, status stays `needs-info` with the blockers listed.
