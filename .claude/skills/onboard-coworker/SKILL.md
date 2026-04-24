---
name: onboard-coworker
description: Create coworkers from pre-packaged YAML definitions or build new ones. Scans coworkers/ directory and the lego coworker-type registry, lets user select which to create. Use when user wants to spawn coworkers, onboard agents, or set up a team.
---

# Onboard Coworkers

Scans pre-packaged YAML bundles in `coworkers/` and the lego coworker-type registry under `container/skills/*/coworker-types.yaml` to create agent instances. Also supports defining brand-new coworker types.

## Important Constraints

1. **`/workspace/project/` is READ-ONLY inside a coworker.** Type definitions and spine fragments live in the project root on the host.
2. **CLAUDE.md is composed, never hand-written.** The host regenerates it from the lego spine (`npm run rebuild:claude`). User-supplied instructions flow through `create_agent`'s `instructions` parameter and end up in `.instructions.md`, which is merged in as an overlay — not by editing `CLAUDE.md` directly.
3. **Type inheritance uses the lego spine.** `extends` in `coworker-types.yaml` composes spine fragments (identity / invariants / context), workflow and skill references, overlays, and trait bindings. Merge modes: identity + bindings leaf-wins; invariants, context, workflows, skills, overlays append + dedup.

## Key Files (READ-ONLY reference)

| File | Purpose |
|------|---------|
| `coworkers/*.yaml` | Pre-packaged coworker bundles (version 3 exports — name, trigger, instructions, memory snapshot) |
| `container/skills/*/coworker-types.yaml` | Lego coworker-type registry — each skill ships its own types; duplicate type names merge across skills |
| `container/skills/*/SKILL.md` | Container skills (capability / workflow / overlay bodies) loaded inside the agent |
| `groups/templates/instructions/` | Reusable instruction overlays (`thorough-analyst`, `terse-reporter`, `code-reviewer`, `ci-focused`) |
| `docs/lego-coworker-workflows.md` | Full schema for the lego model (types, spine fragments, workflows, skills, overlays, traits, bindings) |

## Phase 0: Discovery

Before asking the user anything:

1. **Scan `coworkers/` directory** for `.yaml` files — these are pre-packaged coworker bundles
2. **Scan `container/skills/*/coworker-types.yaml`** for registered coworker types. Skip the `main` and `global` type keys — those are the base agents, not spawnable coworkers
3. **Scan `groups/`** for already-spawned instances (each instance has its own folder)
4. **List instruction overlays** from `groups/templates/instructions/`

Present as a formatted summary:

```
Pre-packaged coworker bundles (coworkers/):
  [ ] <yaml-name-1>         — <agent.name / summary from bundle>
  [ ] <yaml-name-2>         — <agent.name / summary from bundle>
  ...

Available coworker types (container/skills/*/coworker-types.yaml):
  - <type-name-1>           — <description from yaml>
  - <type-name-2>           — <description from yaml>
  ...

Already created:
  ✓ <existing-folder>       (groups/<existing-folder>/)

Instruction overlays available:
  - thorough-analyst
  - terse-reporter
  - code-reviewer
  - ci-focused
```

Then ask using AskUserQuestion:
- **"Create from bundle"** — instantiate a pre-packaged coworker from `coworkers/*.yaml`
- **"Create custom"** — instantiate an existing coworker type with custom instructions, or define a new type

## Phase 1: Create from Pre-Packaged Bundle

For each selected YAML file:

1. Read the YAML file from `coworkers/{name}.yaml`
2. Check `requires.coworkerTypes` — verify every referenced type exists in the merged registry (scan `container/skills/*/coworker-types.yaml`). If a required type is missing, the user likely needs to install its provider skill first (e.g. `/add-<project>`)
3. Ask the user for optional customizations:
   - **Instruction overlay** (from `groups/templates/instructions/`) — communication style
   - **Custom instructions** (appended after the overlay) — domain-specific tweaks
   - **Custom folder name** (defaults to the bundle's `agent.folder`)
4. Create the agent:

```
mcp__nanoclaw__create_agent(
  name: "<bundle's agent.name>",
  coworkerType: "<bundle's agent.coworkerType>",
  instructions: "<overlay + custom instructions>",
  instructionOverlay: "<optional overlay name>",
  allowedMcpTools: <null or explicit list — overrides type defaults>
)
```

### Batch creation

If the user selects multiple bundles, create them in sequence. After all are created, optionally wire peers for direct coworker-to-coworker messaging:

```
mcp__nanoclaw__wire_agents(agent_a: "worker-a", agent_b: "worker-b")
```

## Phase 2: Create Custom Coworker

### 2a — Instantiate an existing type with custom instructions

For one-off coworkers that reuse an existing type:

1. Ask: name, parent type (pick from the registry), optional instruction overlay, optional extra instructions
2. Create with `create_agent`:

```
mcp__nanoclaw__create_agent(
  name: "Custom Specialist",
  coworkerType: "<existing-type-from-registry>",
  instructions: "<custom domain-specific instructions>",
  instructionOverlay: "<optional overlay name>"
)
```

The type's bindings, workflows, skills, invariants, context fragments, and MCP allowlist are all inherited from its `coworker-types.yaml` entry.

### 2b — Define a new reusable coworker type

If the user wants the new role to be reusable (available for future `onboard-coworker` runs), add a new entry to an existing lego skill's registry — typically `container/skills/<project>-spine/coworker-types.yaml`. If there's no project spine yet, create a new `container/skills/<project>-spine/` directory with its own `coworker-types.yaml`.

A minimal entry:

```yaml
<project>-benchmark:
  description: "Run <project> compile/runtime benchmarks and report regressions."
  project: <project>
  extends: <project>-common
  workflows:
    - investigate
  skills:
    - <project>-benchmark-harness   # add the SKILL.md alongside if new
  bindings:
    code: <project>-explore
    test: <project>-build
```

Key rules (full schema in `docs/lego-coworker-workflows.md`):

- `extends` — parent type name. Invariants, context, workflows, skills, overlays append + dedup; identity and bindings leaf-wins.
- `identity` / `invariants` / `context` — paths to markdown files under `container/skills/`. These render into the always-in-context spine.
- `workflows` / `skills` / `overlays` — names matching `SKILL.md` `name:` frontmatter under `container/skills/*/`. Bodies load on-demand when the agent invokes the slash command.
- `bindings` — map abstract trait names (`repo.pr`, `code.edit`, `test.run`, …) to concrete skill names. The composer uses these to derive the agent's MCP tool allowlist from each bound skill's `allowed-tools`.
- `flat: true` — special mode for base agents like `main` / `global` that render verbatim without structural headings. Leave unset for typed coworkers.

After editing the YAML, regenerate the checked-in base prompts so any additive `context:` contributions get picked up:

```
npm run rebuild:claude
```

Then create an instance as in 2a. Optionally author a `coworkers/<folder>.yaml` bundle so the type can be re-instantiated via `onboard-coworker` in the future.

## Phase 3: Verify

After creation:

1. Check the coworker appears in your destination list
2. Send a test message: `<message to="coworker-name">introduce yourself</message>`
3. Verify it responds with the correct role-specific behavior — identity, invariants, and available workflows should reflect the composed spine

## YAML Bundle Format (pre-packaged coworkers)

```yaml
version: 3

agent:
  name: "Display Name"
  folder: "folder-slug"
  coworkerType: "type-from-registry"
  allowedMcpTools: null          # or explicit list to override type defaults
  agentProvider: null            # "claude" (default) or "codex"

requires:
  coworkerTypes:
    - "type-name"                # every name must resolve in the lego registry

instructions: |
  Domain-specific instructions for this coworker.

trigger: "@folder-slug\\b"

destinations:
  - name: "parent"
    type: "agent"
    targetFolder: "main"
```

Exported bundles (produced by an export tool) may additionally contain `memory:` and `archive:` fields — a snapshot of the coworker's persistent state at export time.
