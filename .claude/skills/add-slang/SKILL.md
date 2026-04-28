---
name: add-slang
description: Add Slang shading language compiler support. Multi-agent coworker system with registry-driven specialist roles, container skills for building/navigating the Slang repo, MCP-based maintainer workflows, and coworker orchestration. Triggers on "add slang", "slang compiler", "slang support", "shader compiler".
---

# Add Slang Compiler Support

This skill adds the Slang shading language compiler multi-agent system to NanoClaw.

## Phase 1: Pre-flight

### Check if already applied

```bash
ls container/skills/slang-build/SKILL.md 2>/dev/null && echo "ALREADY_APPLIED" || echo "NEEDS_INSTALL"
```

If `ALREADY_APPLIED`, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure slang remote

```bash
git remote -v
```

If `slang` remote is missing, add it:

```bash
git remote add slang https://github.com/szihs/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch origin nv-slang
git merge origin/nv-slang || {
  # Resolve package-lock.json conflicts if any
  git checkout --theirs package-lock.json 2>/dev/null && git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/skills/slang-build/` — clone, build, navigate Slang (SKILL.md, build.md, structure.md, gotchas.md)
- `container/skills/slang-explore/` — compiler pipeline tracing, backend architecture
- `container/skills/slang-maintain-release-report/` — MCP-based daily reports, release notes, SPIR-V/GitLab updates
- `container/skills/spine-slang/` — lego-spine addon: declares `slang-*` coworker types
- `container/skills/slang-templates/` — role template files (building blocks for coworker types)

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Prompt layering

No direct edits to `groups/main/CLAUDE.md` or `groups/global/CLAUDE.md` are needed — both regenerate from the lego spine.

The composer scans every `container/skills/*/coworker-types.yaml`. This skill's `container/skills/spine-slang/coworker-types.yaml` declares the `slang-*` typed coworkers. To refresh the checked-in prompts:

```bash
npm run rebuild:claude
```

### Install MCP dependencies

The slang-mcp server requires `supergateway` (stdio-to-HTTP bridge) and Python deps:

```bash
# supergateway must be in host package.json (check with npm ls supergateway)
npm install

# Install Python deps for slang-mcp
cd container/mcp-servers/slang-mcp && uv sync && cd ../../..
```

### Configure MCP tokens

Add to `.env` if not present (the slang-mcp server needs these to expose tools):

```bash
# Required — GitHub access (auto-refreshed by cron if GH App is configured)
grep -q GITHUB_ACCESS_TOKEN .env || echo "GITHUB_ACCESS_TOKEN=$GH_TOKEN" >> .env

# Optional — enables Discord tools
# DISCORD_BOT_TOKEN=...
```

### Rebuild container

```bash
./container/build.sh
```

### Validate

```bash
npm run build
npx vitest run
```

All tests must pass before proceeding.

## Phase 3: Verify

### Check skills loaded

```bash
ls container/skills/slang*/SKILL.md
ls container/skills/slang-templates/templates/*.yaml
```

### Check coworker types

Slang types are declared in `container/skills/spine-slang/coworker-types.yaml` and merged with the base registry at compose time. List the Slang entries:

```bash
ls container/skills/spine-slang/coworker-types.yaml && \
  cat container/skills/spine-slang/coworker-types.yaml
```

### Test coworker types

Print `type: description` for every Slang type:

```bash
node -e "const y=require('js-yaml');const fs=require('fs');const t=y.load(fs.readFileSync('container/skills/spine-slang/coworker-types.yaml','utf-8'));Object.entries(t).filter(([k])=>k!=='main'&&k!=='global').forEach(([k,v])=>console.log(k+': '+(v.description||'(no description)')))"
```

## Phase 4: Configuration

### Slang repo access

Coworkers clone and build the Slang repo inside their containers using the `/slang-build` skill. No host-side clone or mount configuration is needed.

### Configure MCP server (for maintainer workflows)

AskUserQuestion: Do you have a slang-mcp server for GitHub/GitLab/Discord/Slack access? The maintainer skill uses MCP tools for daily reports and release management.

If yes, ensure the MCP server is configured in the container's `.claude/settings.json`. If no, maintainer workflows that require external access will be limited to what's available via `gh` CLI (GitHub token required in `.env`).

## After Setup

### Spawning coworkers

From the main chat, users can spawn specialist coworkers after choosing a type from the lego registry (`container/skills/*/coworker-types.yaml`):

```
@Andy spawn <type-from-registry> investigate-generics "Investigate generic type inference in the IR"
```

Or kick off the `/onboard-coworker` skill — it scans the registry and the `coworkers/` bundle directory, then walks the user through picking a type and customizing instructions.

### Discover available roles

Do not assume the current Slang role set is fixed.

Use these project-relative sources of truth instead:

- `container/skills/spine-slang/coworker-types.yaml` — Slang type registry (names, descriptions, `extends` chain, workflows, skills, overlays, trait bindings)
- `container/skills/spine-base/coworker-types.yaml` — universal `base-common` ancestor
- `container/skills/slang-templates/templates/` — reusable building blocks referenced by the Slang types

If new roles or building blocks are added later, they should be discovered from those paths rather than hardcoded in this skill.

### Creating new roles

Use the `/onboard-coworker` skill to create entirely new coworker types.

## Dashboard

AskUserQuestion: Would you like to add the Pixel Office dashboard? It provides real-time visualization of your coworkers as pixel-art characters in an isometric office, with live tool use indicators and activity timelines.

If yes, invoke the `/add-dashboard` skill.
