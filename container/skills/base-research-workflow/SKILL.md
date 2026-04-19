---
name: base-research
type: workflow
description: Produce a grounded, cited research memo on a topic (library, protocol, standard, subsystem) before committing to an approach. Use when planning a non-trivial change and the answer isn't already in the codebase. Not for implementation.
requires: [research, code-read, doc-read]
uses:
  skills: [deep-research]
  workflows: []
params:
  topic:  { type: string, required: true, description: "The question or subject to investigate." }
  scope:  { type: string, required: false, description: "Repo, module, or corpus to focus on." }
  depth:  { type: enum, default: "survey", enum: ["skim", "survey", "deep"] }
produces:
  - research_memo: { path: "/workspace/group/research/{{topic_slug}}.md" }
---

# Base Research

Project-agnostic research workflow. Produces a written memo with cited sources — never an implementation.

## Invariants

- Every claim in the memo cites a source (file + line, URL, wiki path, or doc section). Uncited claims are flagged `[speculation]`.
- Prefer primary sources (code, specs, RFCs) over secondary (blog posts).
- The memo ends with a decision framework, not a recommendation — the caller decides.
- Do not chase tangents past `{{depth}}`. A survey does not become a deep-dive mid-flight.

## Steps

1. **Frame** {#frame} — restate `{{topic}}` as a concrete question. Scope to `{{scope}}` if given, else default to the current project.

2. **Gather** {#gather} — run `/deep-research` for external references, code-read for local references. Cap at the `{{depth}}` budget.

3. **Synthesize** {#synthesize} — cluster findings into claims. Each claim: one sentence + citation + confidence.

4. **Compare alternatives** {#compare} — for decision-oriented topics, list at least two options with trade-offs. Reject any option without evidence for/against.

5. **Write memo** {#memo} — `{{research_memo.path}}` with: question, scope, findings (cited), alternatives, decision framework.

6. **Handoff** {#handoff} — summarize (≤10 bullets) upstream. Link the memo; do not paste.

## Handoff

- If the research surfaces a blocker the caller didn't anticipate, loop back before they commit to an approach.
- The memo is append-only once shared. Revise in a new memo that links to the prior one.
