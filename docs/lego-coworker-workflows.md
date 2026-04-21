# Coworker Architecture

NanoClaw spawns one container per coworker. The container's always-in-context `CLAUDE.md` — the **spine** — is composed at build time from five artifacts: **spine fragments**, **skills**, **workflows**, **overlays**, and **traits + bindings**. The composer renders the spine small and leaves procedural bodies on disk, loaded on demand via slash commands (Claude Code's native SKILL.md progressive disclosure).

Implementation: `src/claude-composer.ts` (facade) + `src/claude-composer/{types, registry, resolve, spine, legacy}.ts`. Runtime consumer: `src/container-runner.ts`. Author-time guardrail: `scripts/validate-templates.ts`.

## Architecture at a glance

Three concentric layers, composed bottom-up:

```
┌─────────────────────────────────────────────────────────────┐
│  Leaf coworker types                                        │
│  slang-triage · slang-fix · slang-maintainer · slang-ci-…   │  one-of-many
│  extends slang-common → extends base-common                 │
├─────────────────────────────────────────────────────────────┤
│  Project spine                                              │
│  slang-common (identity + invariants + bindings)            │  one per project
├─────────────────────────────────────────────────────────────┤
│  Universal spine                                            │
│  base-common (safety / truth / scope / capabilities / ops)  │  one
│  base-*-workflow (trait-driven, project-agnostic)           │
└─────────────────────────────────────────────────────────────┘

main / global (flat) — NanoClaw's admin + shared assistants; separate lineage.
                      Contributed to by dashboard-base, slang-spine, …
```

| Layer | What it owns | Where it lives | Directly composable? |
|---|---|---|---|
| **Universal spine** | Safety/truth invariants, workspace context, trait-only workflows | `container/skills/base-spine/` + `base-*-workflow/` | No — abstract base |
| **Project spine** | Project identity, project invariants, default bindings, project skills | `container/skills/<project>-spine/` + `<project>-*/` | No if extended — abstract base |
| **Leaf coworker** | Task-narrow persona, extra workflows, overlays, bindings | `container/skills/<project>-spine/coworker-types.yaml` (inline) | Yes |
| **Flat assistants** | `main`, `global` — verbatim upstream prose body + additive context | `container/skills/nanoclaw-base/` + any addon (`dashboard-base/`, `slang-spine/`) | Yes |

The composer doesn't distinguish "abstract" from "leaf" structurally — abstract types are simply those that other types `extends:`. The validator (`npm run validate:templates`) auto-detects them and skips direct composition checks.

## Why

Monolithic role templates burned context on procedural detail that was only relevant when a specific task ran. The previous fixed 6-section model (`role / capabilities / workflow / constraints / formatting / resources`) conflated always-in-context identity with on-demand procedure, and project-specific workflows forced you to fork base workflow bodies whenever a trait (e.g. which GitHub skill to use) needed swapping.

The lego model fixes both:

- **Spine + progressive disclosure** — CLAUDE.md stays small. Workflow and skill bodies live in `container/skills/<name>/SKILL.md` and load when the agent invokes the slash command.
- **Traits + bindings** — base workflows declare what they *need* (`requires: [vcs-pr, code-edit]`); coworker types declare what they *use* (`bindings: { vcs-pr: slang-github }`). The same `base-fix` workflow runs unchanged on Slang, on a Perforce project, or on a Jujutsu project.
- **Overlays** — orthogonal concerns (critique, telemetry, approval gating) plug into any matching workflow without editing its body.

## Glossary

| Term | What it is |
|---|---|
| **coworker type** | Named persona. Lives in `container/skills/*/coworker-types.yaml`. Composes spine fragments + skills + workflows + overlays + bindings. |
| **spine** | The always-in-context `CLAUDE.md`. Sections: identity, invariants, context, index, bindings, customizations. |
| **identity / invariants / context** | Spine fragments — markdown files referenced by path. Merge modes: identity = **leaf wins**; invariants + context = **append + dedup**. |
| **skill** | `SKILL.md` without `type:` (or `type: capability`). Body loads on `/skill-name`. Declares `allowed-tools`; optionally `provides: [trait, …]`. |
| **workflow** | `SKILL.md` with `type: workflow`. Body loads on `/workflow-name`. Declares `requires: [trait, …]`, `uses`, optional `extends` + per-step `overrides`. |
| **overlay** | `SKILL.md` with `type: overlay`. Compose-time augmentation. Declares `applies-to.{workflows, traits}` + `insert-before` / `insert-after` step anchors. Attached to a coworker type, not a workflow. |
| **trait** | An abstract dash-case capability name. Skills `provide`; workflows `require`; types `bind`. |
| **provides** | Skill frontmatter list of traits this concrete skill fulfills. |
| **requires** | Workflow frontmatter list of traits this workflow needs. |
| **bindings** | Coworker-type map from trait → concrete skill name. Leaf wins across the extends chain. |
| **step** | A numbered instruction inside a workflow body, optionally anchored with `{#step-id}`. Overlays splice relative to a step ID; `overrides` replace bodies by step ID. |
| **extends** (on workflow) | Workflow inheritance — the derived workflow renders as the parent's body with `overrides` applied. |
| **extends** (on type) | Type inheritance — ancestors contribute identity/invariants/context/skills/workflows/overlays/bindings with leaf-wins identity + leaf-wins bindings and append+dedup for the rest. |

Naming rules:

- Lowercase dash-case for every artifact, trait, and step ID.
- Base workflows: `base-*`. Project skills and types: `<project>-*`. Universal skills skip the project prefix (`deep-research`, `codex-critique`).
- Overlay names end in `-overlay`.
- Trait names follow `<domain>-<verb>`: `vcs-pr`, `code-edit`, `ci-inspect`. No nouny traits like `"github"` — that's a project, not a capability.

## Canonical trait vocabulary

Extend as new projects need them. A skill can provide multiple traits.

| Trait | Intent |
|---|---|
| `vcs-read` | Read repo state: status, diff, log, branches. |
| `vcs-write` | Commit, push, create branches. |
| `vcs-pr` | Open, update, comment on pull/merge requests. |
| `issue-tracker` | Read/update issues. |
| `ci-inspect` | Read CI status + logs. |
| `ci-rerun` | Trigger CI reruns. |
| `code-read` | Grep/Glob/Read source. |
| `code-edit` | Patch + commit a code change. |
| `code-build` | Build/compile the project. |
| `test-run` | Execute the existing test suite. |
| `test-gen` | Author new tests. |
| `doc-read` | Read project docs. |
| `doc-write` | Author/update docs. |
| `research` | External deep-research (deepwiki, web). |
| `critique` | Quality-assess an artifact and score/flag it. |

Each trait maps to a rendering category so the spine's Skills / Workflows lists group by domain (VCS / Code / Test / CI / Research / Critique / Other). The mapping is in `src/claude-composer/spine.ts#TRAIT_TO_CATEGORY`; unknown traits fall into Other. If only one category is present, sub-headers are suppressed. See "Spine category grouping" below.

---

## Flat types vs. structured coworkers

Two rendering modes exist, driven by the `flat: true` flag on a coworker-type entry:

- **Flat types** — `main` and `global`. The spine is the upstream/v2 prose body verbatim (plus any `context:` additions from addon skills like `dashboard-base` and `slang-spine`), separated by horizontal rules. No auto-generated title, no `## Identity` / `## Invariants` headings. The body file owns its own formatting end-to-end. Useful when the document is a single authored document that multiple skills append to, not a structured composition.
- **Structured types** — every typed coworker (e.g. `slang-triage`, `slang-fix`). The spine renders with explicit section headings (`## Identity`, `## Invariants`, `## Context`, `## Workflows Available`, `## Skills Available`, `## Trait Bindings`, `## Workflow Customizations`). Procedural bodies load on demand.

Flat types skip the trait/binding/overlay machinery. Structured types skip the verbatim-body convention. Both live side-by-side in the same registry.

### Duplicate-type merging

Multiple skills may contribute to the same coworker-type key (`main`, `global`, `slang-common`, …). The registry merges them in alphabetical discovery order:

- Scalars (`description`, `project`, `extends`, `flat`, `identity`) → leaf-wins.
- Arrays (`invariants`, `context`, `workflows`, `skills`, `overlays`) → append, deduped downstream by absolute path.
- `bindings:` → shallow merge, later wins per trait key.

This is how `dashboard-base/coworker-types.yaml` adds a formatting block to `main` and `global` without owning those types: it contributes only `context:` arrays; `nanoclaw-base/coworker-types.yaml` owns the identity body.

---

## The five artifacts — with concrete examples

### 1. Spine fragment

Plain markdown. Composed by path reference from a coworker type.

`container/skills/base-spine/invariants/safety.md`:

```md
- Never silence a failing test to make a task "done".
- Never force-push, rebase published branches, or skip hooks without explicit authorization.
- Treat /workspace/project as read-only. All writes go under /workspace/group/.
```

`container/skills/slang-spine/identity/compiler.md`:

```md
You are a specialist on the Slang shading-language compiler (shader-slang/slang).
You know its subsystems, its public-API invariants, and its build + test layout.
```

### 2. Skill (capability)

`container/skills/slang-github/SKILL.md`:

```yaml
---
name: slang-github
description: Interact with GitHub for shader-slang/slang. Fetches issues/PRs, reviews diffs, creates PRs.
provides: [vcs-read, vcs-write, vcs-pr, issue-tracker, ci-rerun]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob, mcp__slang-mcp__github_get_issue, mcp__slang-mcp__github_get_pull_request
---

# Slang GitHub
<body — loads on `/slang-github`>
```

Key points:

- `provides:` lists every trait this skill fills. One skill can cover several trait slots.
- `allowed-tools:` is the source of truth for the MCP tool allowlist derivation. Non-MCP tokens (e.g. `Bash`, `Read`) are ignored by `extractAllowedTools`.
- A skill **without** `provides:` is still invokable directly but can't fill a trait slot.

### 3. Workflow (base)

`container/skills/base-fix-workflow/SKILL.md`:

```yaml
---
name: base-fix
type: workflow
description: Take a triaged issue from reproduction through minimal patch, tests, and PR-ready state.
requires: [code-read, code-edit, test-run, vcs-pr]
uses:
  skills: []
  workflows: [base-triage]
---

# Base Fix

## Steps

1. **Load context** {#load-context} — read the triage report for `{{target}}` …
2. **Reproduce** {#reproduce} — create a minimal repro …
3. **Root-cause** {#root-cause} — evidence: file + line + mechanism …
4. **Patch** {#patch} — implement the minimum change …
5. **Validate** {#validate} — run the project test suite + format/lint/typecheck …
6. **Commit + prepare PR** {#commit} — descriptive commit message …
```

Step IDs (`{#load-context}`, `{#patch}`, …) are the seams. Anchor only the steps a derived workflow or overlay might target.

### 4. Workflow (derived — extends + overrides)

`container/skills/slang-fix-workflow/SKILL.md`:

```yaml
---
name: slang-fix
type: workflow
description: Slang specialization of /base-fix — build, test, PR conventions.
extends: base-fix
requires: [code-read, code-edit, test-run, vcs-pr]
overrides:
  reproduce: "Extract the failing case into tests/bugs/issue-{{issueNumber}}.slang. Commit the failing test first so CI can show the delta."
  patch:     "Use /slang-patch to implement the minimum change. Keep the patch inside one subsystem."
  validate:  "Rebuild with /slang-build, run ./build/Debug/bin/slang-test tests/bugs/issue-{{issueNumber}}.slang and ./extras/formatting.sh."
uses:
  skills: [slang-build, slang-explore, slang-github, slang-patch]
  workflows: [base-fix]
---
```

The composer renders an `extends` customization line in the spine; on invocation Claude reads the parent body and applies the per-step `overrides` bodies.

### 5. Overlay

`container/skills/critique-overlay/SKILL.md`:

```yaml
---
name: critique-overlay
type: overlay
description: Insert an external critique step after a workflow's patch / generate / draft step.
applies-to:
  workflows: [base-fix, base-test-gen, base-docs]
  traits: [code-edit, test-gen, doc-write]
insert-after: [patch, generate, draft]
uses:
  skills: [codex-critique]
---

**Critique** {#critique} — before committing, invoke `/codex-critique` against the working diff.
- If the critique returns `must-fix` items, do not commit. Loop back.
- If `should-fix` items are declined, justify each one in the workflow log.
```

The overlay attaches to a **coworker type** (not a workflow). At compose time the composer intersects `applies-to.{workflows, traits}` with the workflows this coworker actually references; unused overlays are silently skipped.

### 6. Coworker type

`container/skills/base-spine/coworker-types.yaml`:

```yaml
base-common:
  description: "Universal coworker spine — safety, truthfulness, scope, workspace conventions."
  invariants:
    - container/skills/base-spine/invariants/safety.md
    - container/skills/base-spine/invariants/truthfulness.md
    - container/skills/base-spine/invariants/scope.md
  context:
    - container/skills/base-spine/context/capabilities.md
    - container/skills/base-spine/context/workspace.md
    - container/skills/base-spine/context/invocation.md
    - container/skills/base-spine/context/operations.md
  skills:
    - base-nanoclaw
    - deep-research
  workflows:
    - base-triage
    - base-review
    - base-sweep
    - base-ci-health
    - base-research
```

`container/skills/slang-spine/coworker-types.yaml`:

```yaml
slang-common:
  description: "Slang compiler spine — every Slang coworker extends this."
  project: slang
  extends: base-common
  identity: container/skills/slang-spine/identity/compiler.md
  invariants: [container/skills/slang-spine/invariants/public-api.md]
  context:    [container/skills/slang-spine/context/layout.md]
  skills:     [slang-build, slang-explore, slang-github]
  workflows:  [base-pr-update]
  bindings:
    vcs-read: slang-github
    vcs-write: slang-github
    vcs-pr: slang-github
    issue-tracker: slang-github
    code-read: slang-explore
    code-build: slang-build
    test-run: slang-build
    ci-inspect: slang-build
    ci-rerun: slang-github

slang-fix:
  description: "Turn triaged Slang reports into minimal fixes with tests."
  project: slang
  extends: slang-common
  skills: [slang-patch, codex-critique]
  workflows: [slang-fix, base-fix, base-test-gen]
  overlays: [critique-overlay]
  bindings:
    code-edit: slang-patch
    test-gen:  slang-patch
    critique:  codex-critique
```

---

## Resolution pipeline

`resolveCoworkerManifest(types, typeName, catalog, projectRoot)`:

1. **Walk the type chain.** `resolveTypeChain` does a DFS through `extends`, guarding against cycles. Chain order: ancestors → descendants.
2. **Accumulate fragments.** Identity is leaf-wins. Invariants + context are appended and deduped by resolved absolute path.
3. **Union skills, workflows, overlays.** Leaf-wins bindings merge across the chain.
4. **Validate references.** Every `skill`/`workflow`/`overlay` name must exist in the catalog; throws with an actionable message naming the offender.
5. **Validate traits.** For every `requires:` on every referenced workflow: either a skill in the set directly `provides:` the trait, or `bindings:` must map it to a skill that `provides:` it. Errors call out the exact missing trait or mis-mapped skill.
6. **Collect customizations.** Per-workflow: `extends` lines, each `overrides` step, and every overlay that targets the workflow (by name or via a matching `applies-to.traits` entry).
7. **Derive tools.** Union `allowedTools` from every referenced skill + transitive workflow `uses` + bound trait skills + overlay skills. Filter to `mcp__*` at the consumer (`container-runner.ts`).

Cross-project guardrails: `extends` across projects throws; `+` composition (e.g. `slang-fix+dashboard`) across projects warns but does not throw.

## What the composed CLAUDE.md looks like — `slang-fix`

```md
# Slang Fix

## Identity
You are a specialist on the Slang shading-language compiler (shader-slang/slang).
You know its subsystems, its public-API invariants, and its build + test layout.

## Invariants
- Never silence a failing test to make a task "done".
- Never force-push, rebase published branches, or skip hooks without explicit authorization.
- Treat /workspace/project as read-only. All writes go under /workspace/group/.
- include/slang.h and *.meta.slang are stable public surface …

## Context
- Capabilities: browse web, read/write files, bash, scheduling, messaging …
- Workspace layout: /workspace/{group, project, global} …
- Invocation protocol: respond in-channel; summarize; link artifacts …
- Operations: communication, memory, message formatting, packages, task scripts …
- Slang repo lives at /workspace/group/slang …

## Workflows Available
- `/slang-fix` — Slang specialization of /base-fix. Requires traits: code-read, code-edit, test-run, vcs-pr.
- `/base-fix` — Take a triaged issue through reproduction → patch → PR. Requires traits: code-read, code-edit, test-run, vcs-pr.
  Steps: load-context → reproduce → root-cause → patch → validate → commit
- `/base-test-gen` — Author tests from a spec or bug. Requires traits: code-read, test-gen, vcs-pr.
  Steps: read → enumerate → generate → verify → commit
- `/base-triage`, `/base-review`, `/base-sweep`, `/base-ci-health`, `/base-research`, `/base-pr-update` — …

## Skills Available
- `/base-nanoclaw` — Host tools. Provides: messaging, scheduling, elicitation, learning.
- `/slang-github` — Provides: vcs-read, vcs-write, vcs-pr, issue-tracker, ci-rerun.
- `/slang-build` — Provides: code-build, test-run, ci-inspect.
- `/slang-explore` — Provides: code-read, doc-read.
- `/slang-patch` — Provides: code-edit, test-gen.
- `/codex-critique` — Provides: critique.
- `/deep-research` — Provides: research.

## Trait Bindings
- `ci-inspect` → `/slang-build`
- `ci-rerun` → `/slang-github`
- `code-build` → `/slang-build`
- `code-edit` → `/slang-patch`
- `code-read` → `/slang-explore`
- `critique` → `/codex-critique`
- `doc-read` → `/slang-explore`
- `issue-tracker` → `/slang-github`
- `test-gen` → `/slang-patch`
- `test-run` → `/slang-build`
- `vcs-pr` → `/slang-github`
- `vcs-read` → `/slang-github`
- `vcs-write` → `/slang-github`

## Workflow Customizations
- `/slang-fix` extends `/base-fix` — run base steps, then the specialized steps.

- In `/slang-fix`, step `reproduce` is overridden.

  Extract the failing case into tests/bugs/issue-{{issueNumber}}.slang. Commit the failing test first …

- In `/slang-fix`, step `patch` is overridden.

  Use /slang-patch to implement the minimum change. Keep the patch inside one subsystem.

- `/base-fix` is augmented by `critique-overlay` after step `patch`.

  **Critique** — before committing, invoke `/codex-critique` against the working diff. …

_Invoke a workflow or skill with its slash command. Bodies load on demand._
```

Procedural bodies (the actual Steps sections of `/base-fix`, `/slang-fix`, etc.) are **not** in this document — they load when the agent invokes the slash command. The spine surfaces only the shape.

## Base vs. project layer — where things live

Use these rules to decide whether something belongs at the universal layer, the project spine, or a leaf coworker type.

| Concern | Lives at | Examples |
|---|---|---|
| Safety / truthfulness / scope invariants | `base-spine/invariants/` | "Never silence a failing test", "Treat /workspace/project as read-only" |
| Workspace layout + invocation protocol | `base-spine/context/` | `/workspace/{group, project, global}` convention |
| Project-agnostic workflows | `base-*-workflow/` | `base-triage`, `base-fix`, `base-review`, `base-sweep`, `base-ci-health`, `base-research`, `base-pr-update`, `base-test-gen`, `base-docs` |
| Universally-useful skills | `base-<name>/` (no project prefix) | `base-nanoclaw`, `deep-research`, `codex-critique` |
| Project identity + public-API invariants | `<project>-spine/identity/`, `<project>-spine/invariants/` | Slang compiler identity, Slang public-API invariants |
| Project-specific skills (concrete tools) | `<project>-<name>/` | `slang-github`, `slang-build`, `slang-explore`, `slang-patch` |
| Project trait bindings (defaults) | `<project>-common.bindings` in `<project>-spine/coworker-types.yaml` | `vcs-pr → slang-github`, `code-build → slang-build` |
| Project-specific workflow specializations | `<project>-<name>-workflow/SKILL.md` with `extends: base-<name>` | `slang-fix` (extends `base-fix`) |
| Leaf coworker persona (role + extra workflows) | `<project>-<name>:` block in `<project>-spine/coworker-types.yaml` | `slang-triage`, `slang-fix`, `slang-maintainer`, `slang-ci-health` |
| Orthogonal compose-time augmentations | `<name>-overlay/SKILL.md` | `critique-overlay` — attaches a critique step after any `code-edit` workflow |
| Addon to the flat main/global assistants | `<addon>-base/coworker-types.yaml` (duplicate-type merge) | `dashboard-base` adds web formatting; `slang-spine` adds Slang orchestration context |

### Decision tree: base or project?

Ask in order. Stop at the first "yes".

1. **"Could a developer on a different codebase use this as-is, unchanged?"** → base. It's project-agnostic.
2. **"Does it name the project (invariants, build commands, directory layout)?"** → project.
3. **"Does it call a specific tool or MCP server (slang-mcp, gh with org pinned)?"** → project.
4. **"Is it a concrete skill that `provides:` a trait?"** → project (a concrete skill is always project-specific; the trait is the portable abstraction).
5. **"Is it a workflow that `requires:` traits but doesn't care which skill fills them?"** → base. It composes with every project's bindings.
6. **"Is it a leaf persona with task-narrow scope?"** → project.
7. **"Does it augment a workflow orthogonally (critique, telemetry, approval)?"** → overlay, usually project-neutral unless it names a specific tool.

### Naming convention for bases

- `base-common` — universal spine, root of every project chain.
- `base-<capability>-workflow` — universal workflows (`base-fix`, `base-review`, …).
- `<project>-common` — project spine, extends `base-common`, sets bindings.
- `<project>-<capability>-workflow` — project-specific workflow specialization, usually `extends: base-<capability>`.

A `<project>-common` is always abstract — it exists so leaf types can inherit bindings without repetition. Authoring a single leaf type without a `<project>-common` is legal but inlines everything into that type; once a second type appears, lift the shared part to `<project>-common`.

## Extending the system

### Add a new base workflow

1. Author `container/skills/base-<name>-workflow/SKILL.md` with `type: workflow`, a `requires:` list, and a body with anchored step IDs.
2. Reference it from `base-common.workflows` (or any type that should expose it).
3. Every coworker whose bindings cover the `requires:` gets it automatically — no TS change.

### Add a new overlay

1. Author `container/skills/<name>-overlay/SKILL.md` with `type: overlay`, `applies-to`, `insert-after` / `insert-before`, and a step body.
2. Attach it to a coworker type via `overlays: [<name>-overlay]`.
3. Bind any trait the overlay needs.

### Specialize a base workflow for a project

1. Author `container/skills/<project>-<name>-workflow/SKILL.md` with `extends: base-<name>` and per-step `overrides:`.
2. No body is needed — the composer splices. `overrides.<step-id>` replaces the base step's body.
3. Reference the derived workflow from the leaf type that should expose it.

### Bring up a new project

End-to-end walkthrough. Example: a fictional `graphics` project that tracks issues in Jira, builds with Bazel, and uses Gerrit for code review.

1. **Author project skills.** One `container/skills/graphics-<tool>/SKILL.md` per concrete tool the project needs. Each declares `provides:` for every trait it fills.
   - `graphics-gerrit` — `provides: [vcs-read, vcs-write, vcs-pr]`, `allowed-tools: Bash(git:*), Bash(gerrit:*)`.
   - `graphics-bazel` — `provides: [code-build, test-run, ci-inspect]`.
   - `graphics-explore` — `provides: [code-read, doc-read]`.
   - `graphics-jira` — `provides: [issue-tracker]`.

2. **Author the project spine.** `container/skills/graphics-spine/` with:
   - `identity/engine.md` — "You are a specialist on the Graphics project…"
   - `invariants/public-api.md` — project-specific invariants the base doesn't own.
   - `context/layout.md` — where the repo lives, build output location, etc.
   - `coworker-types.yaml` — declare `graphics-common`:
     ```yaml
     graphics-common:
       description: "Graphics project spine — every Graphics coworker extends this."
       project: graphics
       extends: base-common
       identity: container/skills/graphics-spine/identity/engine.md
       invariants: [container/skills/graphics-spine/invariants/public-api.md]
       context:    [container/skills/graphics-spine/context/layout.md]
       skills:     [graphics-gerrit, graphics-bazel, graphics-explore, graphics-jira]
       bindings:
         vcs-read: graphics-gerrit
         vcs-write: graphics-gerrit
         vcs-pr: graphics-gerrit
         code-read: graphics-explore
         doc-read: graphics-explore
         code-build: graphics-bazel
         test-run: graphics-bazel
         ci-inspect: graphics-bazel
         issue-tracker: graphics-jira
     ```

3. **Declare leaf types.** Same file. Each extends `graphics-common`:
   ```yaml
   graphics-triage:
     description: "Triage Graphics bugs."
     project: graphics
     extends: graphics-common
     workflows: [base-triage]

   graphics-fix:
     description: "Minimal fixes for Graphics bugs."
     project: graphics
     extends: graphics-common
     skills: [graphics-patch]
     workflows: [base-fix, base-test-gen]
     bindings:
       code-edit: graphics-patch
       test-gen: graphics-patch
   ```

4. **Validate.** Run `npm run validate:templates`. Every leaf should compose clean. Errors name the exact trait/skill/workflow that's missing.

5. **(Optional) Contribute to main/global.** If the Graphics project needs the orchestrator to know about itself, add `graphics-spine/coworker-types.yaml` entries for `main:` and `global:` with `context:` pointing at a small prose fragment. No `extends`, no `flat`, no `identity` — the duplicate-type merge handles it.

That's the entire TS-free surface. The composer discovers everything through filesystem layout + frontmatter.

### Add an addon to main/global (flat types)

`main` and `global` are flat — their `identity:` body comes from `nanoclaw-base/prompts/*-body.md` (upstream-parity). Addons contribute via `context:` only:

```yaml
# container/skills/<addon>-base/coworker-types.yaml
main:
  context:
    - container/skills/<addon>-base/prompts/formatting.md
global:
  context:
    - container/skills/<addon>-base/prompts/formatting.md
```

The composer appends every `context:` fragment after the body, separated by `---`. Multiple addons can contribute; order is alphabetical by skill directory. Do **not** set `flat`, `identity`, or `extends` in an addon — those belong to `nanoclaw-base` and changing them breaks upstream parity.

## Author-time validator

`scripts/validate-templates.ts` (invoke: `npm run validate:templates`) walks every registered coworker type through `composeCoworkerSpine` and reports failures. Runs as a CI step before tests.

Behavior:

- Skips types that are ancestors of another type (detected by scanning `extends:` across the registry). Those are abstract bases not meant to compose on their own.
- Composes each leaf type; catches unknown skill/workflow references, unresolved traits, cross-project `extends`, missing spine fragments.
- Exit 0 on success, 1 on any failure. Lists each failing type with the underlying error message.

Output shape:

```
Validated 6 coworker type(s) against 28 catalog entries (2 abstract base(s) skipped).
  skip  base-common  (abstract base)
  ok    global
  ok    main
  ok    slang-ci-health
  skip  slang-common  (abstract base)
  ok    slang-fix
  ok    slang-maintainer
  ok    slang-triage
```

## Spine category grouping

The spine's `## Workflows Available` and `## Skills Available` sections group entries by category when more than one category is represented. Categories in order: **VCS, Code, Test, CI, Research, Critique, Other**. An entry is classified by the most-common category across its `requires:` (workflows) or `provides:` (skills) traits. Ties break toward the earlier category in the order — so a workflow with `[vcs-read, code-read]` lands under VCS. Entries with no traits, or only unknown traits, fall into Other.

Implementation: `src/claude-composer/spine.ts#renderCategorizedList`. Authoring: nothing to do — classification is automatic from the trait declarations already on each skill/workflow.

## Upstream drift detection

`nanoclaw-base/prompts/{main,global}-body.md` are expected to equal the upstream/v2 prose bodies byte-for-byte. Two fixture files in `test-fixtures/upstream-v2/{main,global}.md` pin the expected content. Two test layers catch drift:

- **Always-on.** `src/claude-composer-scenarios.test.ts` asserts `nanoclaw-base/prompts/*-body.md === test-fixtures/upstream-v2/*.md`. Runs in every CI build. If a developer edits the shipped body without updating the fixture (or vice versa), the test fails with a diff-friendly assertion.
- **Best-effort.** The same suite includes two tests that compare the fixture to `git show upstream/v2:groups/{main,global}/CLAUDE.md`. They run only when the `upstream/v2` remote is present in the clone (skipped otherwise). On developer machines this surfaces upstream drift so the fixtures can be resynced via `scripts/rebuild-claude-md.ts` + regenerating fixtures.

When upstream lands a new version of `main.md` or `global.md`, either intentionally absorb the change (edit shipped body + fixture together, update any downstream breakage) or deliberately hold back (leave both files as-is until ready to merge).

## Validator errors

Every validation path throws with a message naming the exact offender. Examples:

- `Coworker type "slang-fix" references unknown skill/workflow: frobnicator.` — fix the `skills:` / `workflows:` / `overlays:` list.
- `Coworker type "slang-fix" requires trait(s) with no binding: telemetry.` — add a skill that `provides: [telemetry]`, or bind it explicitly.
- `Coworker type "slang-fix" binds trait "code-edit" → "runner-skill", but "runner-skill" does not declare provides: [code-edit].` — fix the mapping or annotate the skill's `provides:`.
- `Duplicate coworker type "slang-fix" found in <path>.` — two `coworker-types.yaml` files declared the same key.
- `Cross-project extends: "slang-fix" (project: slang) cannot extend "graphics-common" (project: graphics).` — use `+` composition at the type-name level instead.

## Non-goals

- **No runtime.** All lego machinery is compose-time → static files. The agent reads the workflow body via native progressive disclosure and consults the spine for bindings + customizations.
- **No expression language.** No `when:`, `unless:`, `requires: (x or y)`. Two workflows or two overlays is the answer.
- **No trait inference.** `provides:` is explicit.
- **No overlay chaining.** Overlays apply in declared order on the coworker type. Merge concerns into one overlay if they depend on each other.
- **No per-group materialized workflow files.** Customizations are rendered into CLAUDE.md; the original workflow body stays shared.

## File map

| File | Role |
|---|---|
| `src/claude-composer.ts` | Public facade. Re-exports `composeCoworkerSpine`, `composeLegacyPrompt`, `readCoworkerTypes`, `readSkillCatalog`, `resolveCoworkerManifest`, `resolveTypeChain`, types. |
| `src/claude-composer/types.ts` | Shared type definitions (manifest / type entry / skill meta / overlay / customization). |
| `src/claude-composer/registry.ts` | `readCoworkerTypes` + `readSkillCatalog` + duplicate-type merge + skill frontmatter parser. |
| `src/claude-composer/resolve.ts` | `resolveTypeChain`, `resolveCoworkerManifest` — chain walk, fragment merge, trait/binding validation, tool derivation. |
| `src/claude-composer/spine.ts` | `renderCoworkerSpine` — structured + flat render, category grouping. |
| `src/claude-composer/legacy.ts` | 6-section composer for the pre-lego admin documents (not used for typed coworkers). |
| `src/claude-composer.test.ts` + `src/claude-composer-scenarios.test.ts` | Unit + scenario coverage, including upstream drift detection. |
| `src/container-runner.ts` | `resolveAllowedMcpTools` consumes `manifest.tools`; `composeCoworkerClaudeMd` renders the spine on every container wake. |
| `scripts/validate-templates.ts` | Author-time guardrail — walks every leaf type through the composer. Invoke: `npm run validate:templates`. |
| `scripts/rebuild-claude-md.ts` | Rebuild `groups/main/CLAUDE.md` + `groups/global/CLAUDE.md` from the flat types. |
| `container/skills/<name>/SKILL.md` | Skill / workflow / overlay bodies + frontmatter. |
| `container/skills/*/coworker-types.yaml` | Distributed type registry. Each spine (base, slang, nanoclaw-base, dashboard-base, …) ships its own. |
| `container/skills/*-spine/identity/*.md` | Identity fragments. |
| `container/skills/*-spine/invariants/*.md` | Invariant fragments. |
| `container/skills/*-spine/context/*.md` | Context fragments. |
| `container/skills/nanoclaw-base/prompts/*-body.md` | Upstream-parity `main` + `global` bodies. |
| `test-fixtures/upstream-v2/*.md` | Pinned upstream/v2 snapshots — drift detector compares against these. |
| `docs/lego-coworker-workflows.md` | This document. |

## Verification checklist

1. **Trait substitution.** A workflow body containing `/{{trait:vcs-pr}}` composes with the binding. CLAUDE.md carries the bindings table.
2. **Overrides.** A derived workflow with `extends: base-fix` + `overrides: { patch: "…" }` composes a Workflow Customizations block naming step `patch` with the override body.
3. **Overlay application.** An overlay with `applies-to.workflows: [base-fix]` + `insert-after: [patch]` produces a customization line: `/base-fix is augmented by <overlay> after step \`patch\`.`
4. **Validator errors.** Unbound trait, wrong provider, unknown skill/workflow/overlay, cross-project extends — each raises an actionable error naming the offender.
5. **Progressive disclosure.** Workflow bodies stay in `container/skills/<name>/SKILL.md`; the spine carries a step outline (auto-extracted from `{#step-id}` anchors), bindings table, and customizations — enough for routing decisions without loading the full body.
6. **Cross-project reuse.** A new project extending `base-common` + binding traits to its own skills composes cleanly with zero TS edits.
