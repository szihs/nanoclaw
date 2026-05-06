---
name: plan
license: MIT
type: workflow
description: "Plan, investigate, review, or research — any task that produces a written deliverable. Output is TEXT, never file changes."
requires: [issues.read, code.read, doc.read]
uses:
  skills: []
  workflows: []
params:
  target: { type: string, required: true }
  mode: { type: enum, default: "plan", enum: ["plan", "investigate", "review", "research"] }
produces:
  - report: { path: "/workspace/agent/reports/{{target_slug}}.md" }
---

# Plan

Any task that ends in a written artifact: a plan, an investigation, a review, or a research memo. No file changes — hand off to the implement workflow when code/docs need to change.

## Invariants

- Label facts vs hypotheses.
- Cite concrete files, lines, or URLs.
- Text output only.

## Steps

1. **Understand** — restate the ask. Identify `mode` (plan / investigate / review / research). Clarify scope if ambiguous.
2. **Research** — read code, issues, docs; run Grep, git log; spawn sub-agents for wide scope. Stay read-only.
3. **Synthesize** {#diagnose} — organize the evidence by mode:
   - **plan**: 2–3 approaches with trade-offs.
   - **investigate**: classify + facts vs hypotheses.
   - **review**: findings by severity (must-change / should-change / nit), each with file:line.
   - **research**: answer the question with evidence.
4. **Deliver** {#deliver} — write the deliverable to `{{report.path}}` with mode-appropriate sections (status/verdict/conclusion, facts, hypotheses, next, references).
5. **Handoff** — post a ≤5-bullet summary with a link to the report. If action is needed, route to the project's implement workflow or escalate.
