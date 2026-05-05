# Coworker Architecture

NanoClaw spawns one container per coworker. The container's always-in-context `CLAUDE.md` — the **spine** — is composed from: **spine fragments**, **skills**, **workflows**, **overlays**, and **traits + bindings**.

Workflow step bodies and overlay gate protocols are **embedded into CLAUDE.md at compose time** — not loaded as slash commands at runtime. Capability skills remain runtime slash commands; their bodies load on demand when invoked.

| Root | Contents | Filename | Runtime-loaded? |
|------|----------|----------|-----------------|
| `container/spines/<name>/` | Identity, invariants, context, project `coworker-types.yaml` | — | no (compose-time) |
| `container/workflows/<name>/` | Workflow step sequences (full body embedded) | `WORKFLOW.md` | no (compose-time) |
| `container/overlays/<name>/` | Cross-workflow gates (full body inlined at anchor) | `OVERLAY.md` | no (compose-time) |
| `container/skills/<name>/` | Capability skills the agent invokes as `/slash` | `SKILL.md` | yes |

## Layers

```
┌───────────────────────────────────────────────────┐
│  Leaf types: slang-reader · slang-writer           │  permission boundary
│  extends slang-common → extends base-common        │
├───────────────────────────────────────────────────┤
│  Project spine: slang-common                       │  one per project
│  (identity + invariants + bindings + skills)       │
├───────────────────────────────────────────────────┤
│  Universal spine: base-common                      │  one
│  (safety / truth / scope / capabilities / ops)     │
│  4 core workflows: investigate, implement,         │
│  review, document                                  │
└───────────────────────────────────────────────────┘

main / global (flat) — admin + shared assistants, separate lineage.
```

## Glossary

| Term | What it is |
|---|---|
| **coworker type** | Named entry in `container/{spines,skills}/*/coworker-types.yaml`. Composes spine fragments + skills + workflows + overlays + bindings. |
| **spine** | The always-in-context `CLAUDE.md`: identity → invariants → context → workflow/skill index → bindings → customizations → additional instructions. |
| **trait** | Dotted capability name (`repo.pr`, `code.edit`). Skills `provide`; workflows `require`; types `bind` at the domain level. |
| **skill** | `SKILL.md` with `provides: [trait, ...]`. Body loads on `/skill-name`. |
| **workflow** | `SKILL.md` with `type: workflow` + `requires: [trait, ...]`. Body has steps with `{#step-id}` anchors. |
| **overlay** | `SKILL.md` with `type: overlay`. Splices steps into workflows by matching workflow names or trait domains. |
| **extends** (type) | Inheritance: identity leaf-wins; invariants/context/skills/workflows/overlays append+dedup; bindings leaf-wins per domain. |
| **extends** (workflow) | Inheritance: parent body + `overrides` per `{#step-id}`. Unoverridden steps run as-is. |

## Traits

8 domains with dotted qualifiers. Bindings use domain-only keys; `provides:`/`requires:` use the full qualified form.

| Domain | Qualifiers |
|---|---|
| `repo` | `repo.read`, `repo.write`, `repo.pr` |
| `issues` | `issues.read`, `issues.write` |
| `ci` | `ci.inspect`, `ci.rerun` |
| `code` | `code.read`, `code.edit`, `code.build` |
| `test` | `test.run`, `test.gen` |
| `doc` | `doc.read`, `doc.write` |
| `plan` | `plan.research` |
| `critique` | `critique.review` |

**Validation:** the resolver extracts the domain from a qualified trait (`repo.pr` → `repo`), looks up the binding, and checks the bound skill provides the full qualifier. Falls back to any skill in the set that directly provides it.

**Overlay matching:** `applies-to.traits: [code.edit]` matches only workflows requiring `code.edit` — not `code.read`. Domain-level (`code`) matches all qualifiers under that domain.

## 4 Core Workflows

| Workflow | Requires | Steps |
|---|---|---|
| `/investigate` | `issues.read, code.read, doc.read, plan.research` | ingest → classify → investigate → decide → report → summarize |
| `/implement` | `code.read, code.edit, test.run, test.gen, repo.pr` | load-context → reproduce → root-cause → patch → test → validate → commit |
| `/review` | `repo.read, code.read, doc.read` | load → map → assess → check-tests → write → post |
| `/document` | `code.read, doc.read, doc.write, repo.pr` | scope → survey → draft → verify → link → commit |

`base-common` lists no workflows (abstract). Project types add them.

## How extension works

### Type inheritance (`extends`)

```yaml
slang-reader:
  extends: slang-common    # inherits identity, invariants, context, skills, bindings
  workflows:
    - slang-investigate     # adds one workflow
```

### Workflow inheritance (`extends` + `overrides`)

```yaml
name: slang-implement
extends: implement          # inherits all 7 steps
overrides:
  reproduce: "Extract into tests/bugs/issue-{{N}}.slang..."
  patch: "Use /slang-code-writer..."
  validate: "Rebuild with /slang-build..."
```

Steps 1, 3, 5, 7 run as the base wrote them. Steps 2, 4, 6 use the overrides. The agent reads both documents and applies overrides as it goes.

### Overlay (`insert-after`)

```yaml
name: critique-overlay
applies-to:
  workflows: [investigate, implement, document]
  traits: [plan.research, code.edit, test.gen, doc.write]
insert-after: [investigate, patch, draft]
```

Splices a critique gate after the named steps. 3-round protocol: must-fix items block progress; escalate to user after 3 rounds.

## Instance customization via `.instructions.md`

Every coworker instance has `groups/<folder>/.instructions.md`. The composed `CLAUDE.md` appends it under `## Additional Instructions`.

| Level | Where | Scope |
|---|---|---|
| Base workflow | `investigate-workflow/SKILL.md` | Every project, every agent |
| Project override | `slang-investigate-workflow/SKILL.md` | Every Slang agent |
| Instance persona | `groups/<folder>/.instructions.md` | This specific agent |

**Start in `.instructions.md`.** Lift to a project workflow override when multiple agents share the same behavior. Lift to the base workflow when it applies to all projects.

## Extending the system

### Add a skill

1. Create `container/skills/<name>/SKILL.md` with `provides: [trait.qualifier]`
2. Reference from a coworker type's `skills:` list
3. Bind the trait domain: `bindings: { domain: <name> }`

### Add a workflow

1. Create `container/workflows/<name>/WORKFLOW.md` with `type: workflow`, `requires:`, and `{#step-id}` anchors
2. Reference from a coworker type's `workflows:` list
3. Ensure all required traits have bindings

### Specialize a workflow

1. Create `container/workflows/<project>-<name>/WORKFLOW.md` with `extends: <base-name>` and `overrides:`
2. Only override the steps that need project-specific behavior

### Add an overlay

1. Create `container/skills/<name>-overlay/SKILL.md` with `type: overlay`, `applies-to`, `insert-after`
2. Attach via `overlays:` on a coworker type

### Bring up a new project

1. **Author skills** — one per concrete tool (`<project>-github`, `<project>-build`, `<project>-code-reader`, `<project>-code-writer`)
2. **Author spine** — `container/spines/<project>/` with identity, invariants, context, `coworker-types.yaml`
3. **Declare types** — permission-level types (reader/writer) that extend `<project>-common`
4. **Validate** — `npm run validate:templates`

Example:

```yaml
# container/spines/graphics/coworker-types.yaml
graphics-common:
  project: graphics
  extends: base-common
  identity: container/spines/graphics/identity/engine.md
  skills: [graphics-gerrit, graphics-bazel, graphics-explore, graphics-jira, deep-research]
  workflows: [investigate, review]
  bindings:
    repo: graphics-gerrit
    issues: graphics-jira
    code: graphics-explore
    doc: graphics-explore
    test: graphics-bazel
    ci: graphics-bazel
    plan: deep-research

graphics-reader:
  project: graphics
  extends: graphics-common
  workflows: [graphics-investigate]

graphics-writer:
  project: graphics
  extends: graphics-common
  skills: [graphics-code-writer]
  workflows: [graphics-implement, implement, document]
  bindings:
    code: graphics-code-writer
    test: graphics-code-writer
```

## Flat types (main/global)

`main` and `global` use `flat: true`. The spine is the verbatim upstream body + additive `context:` fragments from addon skills (e.g. `dashboard-base` formatting). No structured headings, no trait machinery.

Addons contribute via duplicate-type merging:

```yaml
# container/skills/dashboard-base/coworker-types.yaml
main:
  context:
    - container/skills/dashboard-base/prompts/formatting.md
```

## Runtime

- `composeCoworkerClaudeMd` runs on every container wake — regenerates CLAUDE.md from spine + `.instructions.md`
- `initGroupFilesystem` creates group dirs, symlinks (flat types), `.claude-shared/` (all types)
- `resolveAllowedMcpTools` derives the MCP tool allowlist from the manifest
- `mcpServers` from `coworker-types.yaml` are injected via `NANOCLAW_MCP_SERVERS` env var

## Validation

`npm run validate:templates` — walks every leaf type through the composer. Catches:

- Unknown skill/workflow/overlay references
- Unresolved traits (no binding + no direct provider)
- Mis-mapped bindings (skill doesn't provide the qualifier)
- Cross-project `extends`

## File map

| Path | Role |
|---|---|
| `container/spines/base/` | Universal invariants + context + `base-common` type |
| `container/spines/<project>/` | Project identity + invariants + context + types |
| `container/workflows/<name>/` | Workflow SKILL.md (base or project) |
| `container/skills/<name>-overlay/` | Overlay SKILL.md |
| `container/skills/<name>/` | Skill SKILL.md |
| `container/skills/nanoclaw-base/` | Flat main/global body templates |
| `src/claude-composer/` | Composer: registry, resolver, spine renderer |
| `src/container-runner.ts` | Runtime: composeCoworkerClaudeMd, resolveAllowedMcpTools |
| `scripts/validate-templates.ts` | Author-time validator |
| `groups/<folder>/.instructions.md` | Per-instance customization |
