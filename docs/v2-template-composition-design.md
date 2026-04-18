# Template Composition System — Design Document

## Problem Statement

NanoClaw's coworker system needs reusable, composable prompt templates that work across projects without duplicating common process knowledge. The original JSON-based system stored all type definitions in a single `groups/coworker-types.json`, coupling base infrastructure to project-specific types.

## Design Goals

1. **Reusability above all** — base templates define universal process (what/when/why), project templates add domain knowledge (where/how/which files)
2. **Simplicity** — minimal files, minimal concepts, minimal surface area for conflicts
3. **Composability** — project types pick which base pillars to extend and layer domain-specific knowledge on top
4. **Isolation** — projects cannot accidentally inherit from each other's types
5. **Backward compatibility** — existing JSON-based workflows continue working during transition

## Core Design: Lifecycle Pillars as Abstract Base Types

Every software task follows the same lifecycle regardless of domain:

```
input problem → understand → plan → design → build → test → release → maintain
```

Whether writing a compiler, a device driver, or a web app — you still understand the problem, plan the work, design the solution, build it, test it, release it, and maintain it.

**Base types are these lifecycle pillars.** They live in `v2_main` and provide universal process guidance (~15 lines each). Project types (slang, graphics, etc.) choose which pillars to extend and add domain-specific knowledge on top.

This is the **abstract class pattern applied to the filesystem**: base types define the interface (process structure), project types provide the implementation (domain knowledge).

### The 7 Pillars

| Pillar | Purpose | Example content |
|--------|---------|-----------------|
| `base-understand` | Analyze problems before acting | Read context, separate facts from hypotheses, identify affected area |
| `base-plan` | Break down work into steps | Define scope, sequence tasks, estimate complexity |
| `base-design` | Architect solutions | Consider alternatives, define interfaces, assess trade-offs |
| `base-build` | Implement the solution | Read existing code first, minimal changes, follow conventions |
| `base-test` | Validate correctness | Write tests, cover edge cases, verify no regressions |
| `base-release` | Ship and monitor | Check CI, review deployment, monitor after release |
| `base-maintain` | Fix, improve, sustain | Prioritize by impact, investigate root causes, keep fixes scoped |

### Design Diagram

```
    v2_main: Universal Lifecycle Pillars
    ┌──────────────────────────────────────────────────────┐
    │                                                      │
    │  base-understand   Analyze problems, investigate     │
    │  base-plan         Break down work, sequence tasks   │
    │  base-design       Architect solutions, interfaces   │
    │  base-build        Implement, compile, CI/CD         │
    │  base-test         Validate, verify, ensure quality  │
    │  base-release      Deploy, monitor, ship             │
    │  base-maintain     Fix, sweep, improve               │
    │                                                      │
    └────────────────────────┬─────────────────────────────┘
                             │ extends (picks pillars)
    ┌────────────────────────▼─────────────────────────────┐
    │  skill/v2_slang: Domain-Specific Types               │
    │                                                      │
    │  slang-build       extends base-build                │
    │    + CMake, Slang CI, compiler toolchain              │
    │                                                      │
    │  slang-compiler    extends slang-build                │
    │    + parser, IR, codegen file knowledge               │
    │                                                      │
    │  slang-quality     extends [slang-build, base-test]   │
    │    + slang test runner, API surface                   │
    │                                                      │
    │  slang-triage      extends [slang-compiler,           │
    │                     slang-quality, base-understand]    │
    │    + subsystem mapping, triage reports                │
    │                                                      │
    │  slang-fix         extends [slang-compiler,           │
    │                     slang-quality, base-maintain]      │
    │    + repro→fix→test→PR workflow                       │
    │                                                      │
    │  slang-maintainer  extends [slang-build,              │
    │                     slang-quality, base-maintain]      │
    │    + recurring sweeps, community reports              │
    │                                                      │
    │  slang-ci-babysitter extends [slang-build,            │
    │                        base-release]                  │
    │    + flaky test classification, rerun logic           │
    └──────────────────────────────────────────────────────┘
```

### Pillar Selection by Slang Types

| Slang Type | Pillars Used |
|------------|-------------|
| slang-build | build |
| slang-compiler | build (via slang-build) |
| slang-language | build (via slang-build) |
| slang-quality | build + test |
| slang-triage | build + test + understand |
| slang-fix | build + test + maintain |
| slang-maintainer | build + test + maintain |
| slang-ci-babysitter | build + release |

## Key Design Decisions

### 1. YAML-Only Type Distribution

**Decision:** Types defined in `container/skills/*/coworker-types.yaml`, scanned alphabetically.

**Why:** Each skill branch ships its own types alongside its templates. No central registry file that every branch must modify (merge conflict magnet).

**Rules:**
- Duplicate type names across files = error (fail fast)
- If any YAML files found, legacy JSON ignored entirely (clean transition)
- JSON fallback preserved for backward compatibility when no YAML exists

### 2. Per-Section Merge Modes

**Decision:** Two merge modes applied per prompt section.

| Section | Mode | Rationale |
|---------|------|-----------|
| Role | **leaf-only** | Only the leaf type defines identity — prevents stacked "You specialize in X" from every ancestor |
| Capabilities | append | Additive — base process skills + domain capabilities |
| Workflow | append | Base process steps + domain-specific details |
| Constraints | append | Rules accumulate across the chain |
| Formatting | **leaf-only** | One consistent output format |
| Resources | append | File lists, tools, docs — additive |

**Alternative considered:** Uniform append for all sections. Rejected because it creates identity crisis — a type extending 3 ancestors would have 3 "You are..." statements in the Role section.

**Alternative considered:** Per-entry merge annotations (`_replace`, `_prepend`). Rejected as over-engineering for the current need. Can be added later if needed.

### 3. Single Inheritance Channel — No Template-Level Extends

**Decision:** The type registry `extends` field is the ONLY inheritance mechanism. Template YAML files have no `extends:` directive — each template is a self-contained document with the 6 prompt sections only.

**Why:** Two inheritance channels (type registry + template YAML) create ambiguity about which one wins and make the composition order hard to reason about. Removing template-level `extends:` entirely eliminates this class of confusion. Templates that previously shared content via `extends:` now inline that content directly.

**Alternative considered:** Restricting template `extends:` to same skill directory (keeps file-level DRY). Rejected because even same-directory extends creates a second inheritance path that developers must reason about. The small cost of inlining shared content into 2-3 templates is worth the simplicity of having exactly one inheritance graph.

**Result:** One inheritance mechanism, one graph, zero ambiguity. Template files use only the 6 prompt section keys (`role`, `capabilities`, `workflow`, `constraints`, `formatting`, `resources`) — any other key (including `extends`) is rejected as an error.

### 4. Cross-Project Validation

**Decision:**
- `extends` across projects = **ERROR** (hard block)
- `+` composition across projects = **WARNING** (user explicitly chose it)

**Why:** Cross-project `extends` would silently couple projects together, making it impossible to update one project's types without risking breakage in another. The `+` operator is explicit user choice at the coworker level, so a warning is sufficient.

**Cross-project rules:**
```
✅  slang-build extends base-build        (project → pillar: allowed)
✅  slang-compiler extends slang-build    (same project: allowed)
❌  gfx-test extends slang-quality        (cross-project: ERROR)
⚠️  slang-compiler + gfx-test             (cross-project +: WARNING)
```

### 5. Diamond Dedup

**Decision:** Deduplicate at type resolution level using visited sets in `resolveTypeChain()`.

**Why:** Diamond inheritance is common (slang-triage extends both slang-compiler and slang-quality, which both extend slang-build → base-build). Without dedup, base-build's templates would appear multiple times.

### 6. Cache Fingerprinting

**Decision:** Max mtime of all `container/skills/*/coworker-types.yaml` files.

**Why:** Simple, fast, and catches any change to any type file. No need for content hashing — mtime is sufficient for cache invalidation.

## File Layout

```
container/skills/
  base-templates/
    coworker-types.yaml          ← 7 pillar type definitions
    templates/
      base-understand.yaml       ← ~15 lines each
      base-plan.yaml
      base-design.yaml
      base-build.yaml
      base-test.yaml
      base-release.yaml
      base-maintain.yaml
  slang-templates/
    coworker-types.yaml          ← 8 slang types (project: slang)
    templates/
      slang-build.yaml
      slang-compiler.yaml
      ...
```

## Implementation

3 source files changed:

| File | Changes |
|------|---------|
| `src/claude-composer.ts` | YAML scanner, merge modes, cross-project validation, removed template extends |
| `src/claude-composer.test.ts` | 7 new tests covering all behaviors, updated for single inheritance channel |
| `src/container-runner.ts` | YAML-aware cache fingerprinting |

## What This Does NOT Include

These were explicitly out of scope for this iteration:

- **Base skill extraction** — moving shared skills to `v2_main` (separate PR)
- **Merge annotations** (`_replace`, `_prepend`) — per-entry override directives
- **Composition trace** — logging which template contributed which section
- **Abstract type enforcement** — requiring that base types are never used directly
- **Versioning** — type version numbers for compatibility checking
- **Manifest changes** — the existing manifest system is untouched

## Future Considerations

1. **New projects** follow the pattern: create `container/skills/<project>-templates/coworker-types.yaml` with `project: <name>`, extend lifecycle pillars as needed
2. **New pillars** can be added to base-templates if the lifecycle model expands (unlikely — the 7 pillars cover the universal software lifecycle)
3. **Legacy JSON cleanup** — `groups/coworker-types.json` can be deleted after all consumers migrate to YAML
4. **Template-level extends** was considered and explicitly removed in favor of a single inheritance channel (see Decision 3)
