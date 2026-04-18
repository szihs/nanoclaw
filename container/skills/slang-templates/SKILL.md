---
name: slang-templates
description: Role templates for the Slang compiler team. Trigger when you need to understand another specialist's domain, find the right person for a handoff, or check which files belong to which role.
---

# Slang Role Reference

Templates in `templates/` describe each specialist role's domain, key files, and team pairing boundaries.

## When to Use

- Before handing off work to another specialist — read their template to understand the boundary
- When your task touches another role's domain — check their Key Files section
- To understand the full team structure

## Registry-First Lookup

Use the project-relative registry as the source of truth:

- `groups/coworker-types.json` — current type names, descriptions, inheritance, and `template` paths
- `container/skills/slang-templates/templates/` — the YAML template files those entries point at, plus additional reusable building blocks

When you need to understand the current team structure:

1. Read the relevant entry in `groups/coworker-types.json`
2. Follow its `template` path
3. Open any neighboring files in `container/skills/slang-templates/templates/` if you need broader context

Do not assume this skill documents an exhaustive or fixed set of roles.

## Available Skills

All coworkers share these composable skills:

| Skill | Purpose |
|-------|---------|
| `/slang-build` | Clone, build, run tests |
| `/slang-explore` | Investigate code paths (read-only) |
| `/slang-fix` | Implement changes, write tests, commit |
| `/slang-github` | Fetch issues/PRs, create PRs |
| `/slang-maintain-release-report` | Daily reports, release notes, SPIRV updates |
