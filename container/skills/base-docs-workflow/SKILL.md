---
name: document
type: workflow
description: Turn a code change, new feature, or stale doc into refreshed, linked, and verified project documentation. Use after a feature lands, when a doc gap is reported, or as part of a release-prep pass. Not for building the feature itself.
requires: [code.read, doc.read, doc.write, repo.pr]
uses:
  skills: []
  workflows: []
params:
  target:  { type: string, required: true, description: "Feature, module, PR, or doc path to refresh." }
  repo:    { type: string, required: true }
  audience: { type: enum, default: "user", enum: ["user", "contributor", "maintainer"] }
produces:
  - docs_log: { path: "/workspace/group/docs/{{target_slug}}.md" }
  - patch:    { path: "git commit on {{branch}}" }
---

# Base Docs

Project-agnostic documentation workflow. Produces user-facing, contributor-facing, or maintainer-facing docs with examples, links, and a verified build.

## Invariants

- Every example must be copy-pasteable and verified to run as written — quote exact output, do not paraphrase.
- Prefer updating an existing doc to creating a new one. Only create when no existing doc is a good home.
- Do not document internals the audience does not need. User docs stay user-level.
- Do not ship docs for behavior that isn't landed on the target branch.

## Steps

1. **Scope** {#scope} — read `{{target}}` (code, PR, or stale doc). Identify the audience (`{{audience}}`) and the smallest useful change.

2. **Survey existing docs** {#survey} — `grep -r` and the project's docs index for prior coverage. Plan edits, not rewrites.

3. **Draft** {#draft} — write the doc diff: concept first, then examples, then reference. Keep each example minimal and self-contained.

4. **Verify examples** {#verify} — run every code block. Paste exact output into the doc. If a block cannot be run, mark it `# illustrative only` and explain why.

5. **Cross-link** {#link} — add anchors from neighboring docs; add a see-also back. Broken links are a bug.

6. **Commit + PR** {#commit} — descriptive commit. PR body: what changed, who it's for, how it was verified. Log the diff to `{{docs_log.path}}`.

## Handoff

- If the code being documented is ambiguous, loop back to a triage or clarify with the author rather than guessing.
- Deprecation notes live with the old doc, not a new doc. Keep the breadcrumb.
