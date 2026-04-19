# Lego Coworker Workflows — Design

Successor to `v2-template-composition-design.md`. Restructures typed coworkers around five artifacts (spine fragments, skills, workflows, overlays, traits) with a thin always-in-context CLAUDE.md, progressive disclosure of procedural content, and pluggable extension points that work across projects.

## Problem

The composer used to merge role templates across a type chain into a monolithic CLAUDE.md pinned on every agent turn. Long-running coworkers burned context on procedural detail only relevant when a specific task runs. The fixed 6-section model (`role / capabilities / workflow / constraints / formatting / resources`) conflated always-in-context identity with on-demand procedure — fine for small coworkers, broken for long-running ones with many responsibilities.

The first lego iteration fixed the context-bloat problem (spine + progressive-disclosure workflows) but left two gaps:

- **Base workflows couldn't be truly generic.** A workflow like `slang-fix` hard-codes `uses: [slang-github, slang-patch, slang-build]`. Porting the same workflow to a Perforce-backed project means forking the body and re-authoring every reference.
- **No plug-in extension point.** Adding a critique step, a telemetry step, or an approval gate to an existing workflow required editing the workflow body — forking it per coworker.

This iteration adds **traits**, **bindings**, **step overrides**, and **overlays** so base workflows stay generic, projects specialize by binding, and orthogonal concerns (critique, telemetry, gating) plug in without touching workflow bodies.

## Glossary — naming chosen to generalize across projects

| Term | What it is | Examples |
|------|------------|----------|
| **coworker type** | A typed persona composed from spine fragments + skills + workflows + overlays + bindings. Lives in `container/skills/*/coworker-types.yaml`. | `slang-triage`, `slang-fix`, `slang-maintainer` |
| **spine** | The always-in-context CLAUDE.md. Four sections: identity, invariants, context, index. | |
| **identity / invariants / context** | Spine fragments. Markdown files referenced by path from a coworker type. Merge modes: identity = leaf, invariants + context = append + dedup. | `container/skills/slang-spine/identity/compiler.md` |
| **skill** | A concrete capability. SKILL.md without `type:` (or `type: skill`). Body loads on `/skill-name`. Declares `allowed-tools:` and optionally `provides:`. | `slang-github`, `slang-patch`, `deep-research` |
| **workflow** | An ordered procedure. SKILL.md with `type: workflow`. Body loads on `/workflow-name`. Declares `requires:` (traits), `uses:` (concrete skills), `extends:` (parent workflow), `overrides:` (per-step replacements). | `base-fix`, `base-ci-health`, `slang-fix` |
| **overlay** | A compose-time augmentation. SKILL.md with `type: overlay`. Injects an extra step into one or more workflows at declared anchors. Attached to a coworker type — not to a workflow. | `critique-overlay`, `telemetry-overlay` |
| **trait** | An abstract capability interface, like a Rust trait. A trait names a behavior; skills declare they provide it; workflows declare they require it. Dash-case strings. | `vcs-pr`, `code-edit`, `test-run`, `research`, `critique` |
| **provides** | Frontmatter list on a skill: which traits this concrete skill fulfills. | `provides: [vcs-pr, issue-tracker]` on `slang-github` |
| **requires** | Frontmatter list on a workflow: which traits this workflow needs at every `{{trait:x}}` placeholder. | `requires: [vcs-pr, code-edit, test-run]` on `base-fix` |
| **bindings** | Coworker-type map from trait → concrete skill name. Resolves `{{trait:x}}` for this coworker. | `bindings: { vcs-pr: slang-github, code-edit: slang-patch }` |
| **step** | A numbered instruction inside a workflow body. Optionally anchored with `{#step-id}` in the heading. Overlays insert relative to step IDs; `overrides` replace bodies by step ID. | `## 3. Patch {#patch}` |
| **extends** (on workflow) | A workflow declares a parent workflow. The derived workflow's body is rendered as the parent's body with `overrides` applied per step. | `extends: base-fix` on `slang-fix` |
| **overrides** (on workflow) | Map of step ID → replacement markdown, used when `extends:` is set. | `overrides: { patch: "Use /slang-patch --debug-preset ..." }` |
| **insert-after / insert-before** | Overlay directive: splice the overlay's step after/before the named step ID in the target workflow. | `insert-after: [patch]` |
| **applies-to** | Overlay scope: which workflows the overlay targets (by name, by trait requirement, or `"*"`). | `applies-to: { workflows: [base-fix, base-test-gen] }` |

Naming rules:

- **Lowercase dash-case** for every artifact name, trait, and step ID.
- **Verbs for sides of a relationship**: skills `provide`, workflows `require`, types `bind`.
- **Domain-verb trait names**: `<domain>-<verb>`. `vcs-read`, `vcs-pr`, `ci-inspect`, `doc-write`, `test-gen`. No nouny traits like `"github"` — that's a project, not an abstract capability.
- **`base-*` for reusable cross-project workflows**; `<project>-*` for project-specific skills and coworker types; no project prefix on universal skills (`deep-research`, `codex-critique`).
- **Overlay names end in `-overlay`** to flag that the artifact is not a skill or workflow.

## Canonical trait vocabulary (seeded)

Add traits as projects need them; a canonical list in one file avoids drift.

| Trait | Intent |
|-------|--------|
| `vcs-read` | Read repo state: status, diff, log, branches |
| `vcs-write` | Commit, push, create branches |
| `vcs-pr` | Open, update, comment on pull/merge requests |
| `issue-tracker` | Read/update issues in whatever tracker is used |
| `ci-inspect` | Read CI status and logs for a ref or branch |
| `ci-rerun` | Trigger CI reruns on specific jobs |
| `code-read` | Read source files (Grep, Glob, Read) |
| `code-edit` | Modify source (patch + commit a code change) |
| `code-build` | Build/compile the project |
| `test-run` | Execute an existing test suite |
| `test-gen` | Author new tests from specs or bug reports |
| `doc-read` | Read project documentation |
| `doc-write` | Update/author documentation |
| `research` | External deep-research (deepwiki, web, etc.) |
| `critique` | Quality-assess an artifact and score/flag it |

A project's skill can provide multiple traits (e.g. `slang-github` provides `vcs-pr` + `issue-tracker`). Skills without `provides:` are invokable directly but can't fill trait slots.

## Five artifacts

### 1. Spine (always in context)

Unchanged intent. New additions to what's rendered:

```md
# <Coworker Name>

## Identity
<leaf identity fragment>

## Invariants
<append + dedup>

## Context
<append + dedup>

## Workflows Available
- `/slang-fix` — Turn a triaged Slang issue into a minimal fix + test + PR. Requires: vcs-pr, code-edit, test-run.
- `/base-docs` — Update docs after a code change. Requires: code-read, doc-write, vcs-pr.

## Skills Available
- `/slang-github` — GitHub issue + PR operations. Provides: vcs-pr, issue-tracker.
- `/slang-patch` — Implement a Slang code change. Provides: code-edit.

## Bindings
| Trait | Skill |
|-------|-------|
| `vcs-pr` | `/slang-github` |
| `code-edit` | `/slang-patch` |
| `test-run` | `/slang-build` |
| `research` | `/deep-research` |
| `critique` | `/codex-critique` |

## Workflow Customizations
For `/base-fix` when invoked in this coworker:
- Override step `patch`: Use `/slang-patch --debug-preset`. Keep within one subsystem.
- Insert after step `patch`: Run `/codex-critique` on the diff; halt if score < 6.

## Additional Instructions
<from .instructions.md>
```

The **Bindings** table is how Claude resolves `{{trait:x}}` placeholders when it reads a workflow body on invocation. It lives in always-in-context so substitution needs no extra lookup.

**Workflow Customizations** is rendered only when the coworker has overrides (from a derived workflow) or attached overlays targeting a workflow it uses. Otherwise omit the section.

### 2. Skill

```md
---
name: slang-github
description: GitHub issue + PR operations for shader-slang repos.
allowed-tools: Bash(gh:*), mcp__slang-mcp__github_get_issue, mcp__slang-mcp__github_get_pull_request
provides: [vcs-pr, issue-tracker]
---
```

Rules:

- `provides:` is optional. A skill without it is directly invokable but can't fill a trait slot.
- `allowed-tools:` remains the source of truth for tool derivation.
- Naming: universal skills skip the project prefix (`deep-research`, `codex-critique`). Project-specific skills get one (`slang-github`, `slang-patch`).

### 3. Workflow

```md
---
name: base-fix
type: workflow
description: Reproduce → root-cause → patch → validate → commit → PR. Generic.
requires: [vcs-read, code-edit, test-run, vcs-pr]
uses:
  skills: []
  workflows: []
---

# Base Fix

## 1. Reproduce {#reproduce}
Use `/{{trait:vcs-read}}` to pin the failing revision.
Use `/{{trait:test-run}}` to confirm the failure locally.

## 2. Root-cause {#root-cause}
...

## 3. Patch {#patch}
Use `/{{trait:code-edit}}` to apply the minimum change.

## 4. Validate {#validate}
Rerun `/{{trait:test-run}}`. Confirm no regressions in adjacent suites.

## 5. Commit + PR {#commit-pr}
Use `/{{trait:vcs-pr}}` to push the branch and open a PR.
```

Project-specific workflow specializes by extending + overriding:

```md
---
name: slang-fix
type: workflow
extends: base-fix
description: Slang specialization of /base-fix.
overrides:
  patch: |
    Use `/slang-patch` with the minimal subsystem-local change. If the cause
    spans subsystems, halt and re-triage.
  validate: |
    Rebuild with `/slang-build`. Then run `slang-test tests/bugs/issue-<N>.slang`
    and `./extras/formatting.sh`. Run the wider category; confirm zero regressions.
---
```

No body needed for a derived workflow — the composer renders the parent's body with overrides spliced by step ID. If the extended workflow is referenced by a coworker type, the composer emits the expanded form into CLAUDE.md's "Workflow Customizations" section (concise diff) and Claude reads the parent body on invocation, substituting overrides.

Step IDs are the seams. Don't anchor every step; anchor only the ones a derived workflow or overlay might target.

### 4. Overlay

```md
---
name: critique-overlay
type: overlay
description: Inject an AI critique phase after code-modification steps.
applies-to:
  workflows: [base-fix, base-test-gen, base-docs]
  # or:  traits: [code-edit]   # match any workflow that requires this trait
insert-after: [patch, implement, generate]
step:
  id: critique
  body: |
    Run `/{{trait:critique}}` against the artifact just produced. Halt and
    report if the critique flags blocking issues or returns a score < 6.
---
```

An overlay is attached on a coworker type. The composer only applies the overlay to workflows this coworker actually references, and only substitutes traits that are bound on this coworker. Unused overlays are silently skipped.

### 5. Trait

Traits are just strings. No file. Canonical list lives in `docs/lego-coworker-workflows.md` (this file) and is referenced by spec. Validator ensures every `requires:` and `provides:` names a trait in the canonical list.

## Coworker type schema

```ts
export interface CoworkerTypeEntry {
  extends?: string | string[];
  project?: string;
  description?: string;

  identity?: string;
  invariants?: string[];
  context?: string[];

  workflows?: string[];
  skills?: string[];

  overlays?: string[];                       // attached overlays (by name)
  bindings?: Record<string, string>;         // trait → skill name
}
```

Resolution (`resolveCoworkerManifest`) produces:

```ts
{
  typeName;
  title;
  identity;                                  // leaf-merged
  invariants; context;                       // append + dedup
  workflows: { name; description; requires; customizations }[];
  skills: { name; description; provides }[];
  bindings: Record<string, string>;          // trait → skill, after chain merge
  overlays: { name; insertAfter; insertBefore; step; appliesTo }[];
  tools: string[];                           // derived from direct + transitive
}
```

Validator errors (actionable, name the offender):

- Required trait has no binding in the chain.
- Bound skill doesn't declare `provides: [<trait>]`.
- `extends:` targets a workflow that doesn't exist.
- Override refers to a step ID not present in the parent workflow body.
- Overlay targets a step ID not present in the target workflow body.
- Overlay attached to a coworker references a trait not bound.

## Compose-time pipeline

1. Read coworker types from every `container/skills/*/coworker-types.yaml`.
2. Read skill catalog from every `container/skills/*/SKILL.md`. Parse frontmatter including `provides`, `requires`, `extends`, `overrides`, `applies-to`, `insert-after`, `insert-before`, `step`.
3. Resolve the coworker's type chain; accumulate identity/invariants/context/skills/workflows/overlays/bindings.
4. Expand each workflow: if `extends:`, splice parent body with overrides. Record any step IDs available for overlays.
5. For each attached overlay: if `applies-to` matches a workflow the coworker uses, record the injection into that workflow's customization block.
6. Validate every `requires:` is bound, every binding target provides the trait.
7. Render CLAUDE.md: spine + index (workflows with requires, skills with provides) + bindings table + customizations block + additional instructions.
8. Derive MCP tool allowlist from bound skills + transitive workflow uses + overlay step skills.

## What NOT to build (reaffirmed)

- **No runtime.** All lego machinery is compose-time → static files. Agent invokes a workflow, native progressive disclosure loads the body, agent consults the spine for bindings and customizations.
- **No expression language.** No `when:`, `unless:`, `requires: (x or y)`. Two overlays is the answer, or two workflows.
- **No trait inference.** `provides:` is explicit. Skills can't "probably provide" `vcs-pr`.
- **No overlay chaining semantics.** Overlays apply in declared order on the coworker type. Dependencies between overlays → author one overlay that covers the combined concern.
- **No per-group materialized workflow SKILL.md files.** Customizations are rendered into the spine (CLAUDE.md). The original workflow body stays shared.
- **No cycle detection beyond reference resolution.** Ship and iterate.

## Why this generalizes

- **slang + p4 + jj + fossil** all share `base-fix`, `base-ci-health`, `base-docs`, `base-pr-update`. Each project declares skills that provide `vcs-pr` / `ci-inspect` / etc. A coworker in that project binds the traits.
- **Codex critique plug-in** is one overlay + one binding. Adding it to any existing coworker is a one-line edit on the type.
- **A new universal skill (e.g. `rfc-search`)** that provides `research` is immediately available to every coworker in every project that binds `research`.
- **A new base workflow** (e.g. `base-security-scan` requiring `code-read`, `ci-inspect`, `issue-tracker`) is instantly offered to any coworker whose bindings cover those traits. No TS change.

## Seeded base workflows (this restructure)

| Workflow | Requires | Purpose |
|----------|----------|---------|
| `base-triage` | `issue-tracker`, `code-read` | Map a report to a subsystem + severity + next-step. |
| `base-fix` | `vcs-read`, `code-edit`, `test-run`, `vcs-pr` | Reproduce → patch → validate → PR. |
| `base-review` | `code-read`, `critique` | Structured review against a checklist. |
| `base-sweep` | `issue-tracker`, `vcs-pr`, `ci-inspect` | Periodic multi-track inventory. |
| `base-ci-health` | `ci-inspect`, `ci-rerun`, `vcs-pr` | Classify CI failures as flake vs real; rerun-safe jobs; report. |
| `base-docs` | `code-read`, `doc-write`, `vcs-pr` | Update docs after a behavior change. |
| `base-test-gen` | `code-read`, `test-gen`, `vcs-pr` | Author tests from a spec, a bug, or a coverage gap. |
| `base-research` | `research`, `code-read`, `doc-read` | Deep external research synthesis into a report. |
| `base-pr-update` | `vcs-read`, `vcs-pr` | Refresh a PR after reviewer feedback; push, update description, relink issues. |

Overlays seeded:

| Overlay | Intent |
|---------|--------|
| `critique-overlay` | Inserts a critique step after code-modification steps (`patch`, `implement`, `generate`). Target trait: `critique`. |

## Migration from the previous lego iteration

Purely additive — the previous spine composition still works. Skills without `provides:` and workflows without `requires:` keep working (no trait substitution, no binding check). Projects adopt traits one at a time.

- `slang-github` annotated with `provides: [vcs-pr, issue-tracker]`.
- `slang-patch` annotated with `provides: [code-edit]`.
- `slang-build` annotated with `provides: [test-run, code-build]`.
- `slang-explore` annotated with `provides: [code-read]` (and is generic enough that its `provides` list could be just that).
- Universal skills added: `deep-research` (`provides: [research]`), `codex-critique` (`provides: [critique]`).
- `slang-fix-workflow` collapses to `extends: base-fix` + two step overrides (`patch`, `validate`).
- `slang-ci-babysitter` coworker type retired. Replaced by `slang-ci-health` referring to `base-ci-health` + bindings.
- `base-common` gains the five new base workflows in its `workflows:` list so every coworker's spine surfaces them.

## Critical files

| File | Change |
|------|--------|
| `src/claude-composer.ts` | Parse `provides` / `requires` / `extends` / `overrides` / `applies-to` / `insert-after` / `insert-before` / `step` on skill frontmatter; parse `bindings` / `overlays` on coworker types; extend manifest; render Bindings + Workflow Customizations; validator for trait wiring. |
| `src/claude-composer.test.ts` | Add suites for traits+bindings resolution, workflow extends+overrides, overlay application, validator errors. |
| `container/skills/*/SKILL.md` | Add `provides:` to existing skills; add `requires:` + step IDs to existing workflows; add new `base-*-workflow/SKILL.md` artifacts; add `critique-overlay/SKILL.md`. |
| `container/skills/*/coworker-types.yaml` | Add `bindings:` + `overlays:` to existing types; retire `slang-ci-babysitter`; add `slang-ci-health`. |
| `coworkers/slang_ci-babysitter.yaml` | Renamed / coworkerType updated. |

## Verification

1. **Trait substitution** — a workflow body containing `{{trait:vcs-pr}}` composes with the binding, and CLAUDE.md carries the bindings table.
2. **Overrides** — a derived workflow with `extends: base-fix` + `overrides: { patch: "..." }` composes a Workflow Customizations block naming step `patch` with the override body.
3. **Overlay application** — an overlay with `applies-to.workflows: [base-fix]` + `insert-after: [patch]` produces a customizations line "Insert after step `patch`: ...".
4. **Validator errors** — unbound trait, wrong provider, unknown step ID, unknown parent workflow each raise an actionable error.
5. **Progressive disclosure** — the workflow body still lives in `container/skills/<name>/SKILL.md`; the spine only changes size by the bindings table and any customizations for the referenced workflows.
6. **Cross-project reuse** — a toy `demo-*` project extending `base-common` + binding traits to dummy skills composes cleanly with zero TS edits.
