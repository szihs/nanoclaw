---
name: add-coworkers
description: "Bootstrap the NanoClaw nv coworker system. Merges base infrastructure (composer, trait resolver, spine system), then offers project-specific add-ons (dashboard, slang, custom projects via /onboard-project)."
---

# Add Coworkers

Bootstrap the full nv coworker system into a NanoClaw installation.

## Pre-flight

If on a detached HEAD, create a local branch first:
```bash
git symbolic-ref HEAD 2>/dev/null || git checkout -b nv-coworkers
```

Check if already applied:
```bash
ls container/spines/base/coworker-types.yaml 2>/dev/null
```
If it exists, skip to Phase 3 (project add-ons).

## Phase 1: Merge base infrastructure

Fetch all remote refs (ensures latest branches after any upstream rebase):
```bash
git fetch origin
```

```bash
git merge origin/nv-main --no-edit || {
  git checkout --theirs package-lock.json pnpm-lock.yaml 2>/dev/null
  git add package-lock.json pnpm-lock.yaml 2>/dev/null
  git merge --continue
}
```

This brings in:
- Lego spine composer (`src/claude-composer/`)
- Project-scoped trait resolver with cross-project binding protection
- Base spine (`container/spines/base/`) with universal invariants + context
- Core workflows: investigate, implement, review, document
- Base skills: base-nanoclaw, plan, deep-research, codex-critique
- Updated add-dashboard and add-slang skills (merge from nv-* branches)
- /onboard-project and /onboard-coworker skills
- Container runner with MCP proxy wiring
- Agent routing (direct/internal) and dashboard channel creation

## Phase 2: Rebuild

```bash
pnpm install
pnpm run build
npm run rebuild:claude
npm run validate:templates
```

Verify: `validate:templates` should show `main` and `global` types composing cleanly.

## Phase 3: Project add-ons

Ask the user which projects to add. Use `AskUserQuestion` with multi-select:

1. **Dashboard (recommended)** — Pixel Office real-time agent visualization. Run `/add-dashboard`.
2. **Slang compiler** — Multi-agent support for shader-slang/slang. Run `/add-slang`.
3. **Custom project** — Onboard any OSS GitHub repo. Run `/onboard-project <url>`.

Before each project merge, restore the tracked lockfile so git merge doesn't conflict:
```bash
git checkout -- pnpm-lock.yaml 2>/dev/null
```

Then invoke the skill. Each skill merges its own `origin/nv-*` branch.

## Phase 4: Final rebuild

After all projects are added:

```bash
pnpm install
pnpm run build
./container/build.sh
npm run validate:templates
npx vitest run
```

## Phase 5: Create first coworker

Offer to run `/onboard-coworker` to create agents from the installed project types.
