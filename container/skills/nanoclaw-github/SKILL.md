---
name: nanoclaw-github
description: "GitHub operations for NanoClaw. Clone, branch, PR, issues, CI."
provides: [repo.read, repo.write, repo.pr, issues.read, issues.write, ci.rerun]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob
---

# GitHub

## Repos

- **Upstream:** `qwibitai/nanoclaw` (main branch)
- **Fork:** `slang-coworkers/nanoclaw` (nv-coworkers default branch)

## Branches

- `nv-coworkers` — base for all nv-* merges
- `nv-main` — coworker infrastructure
- `nv-dashboard` — Pixel Office dashboard
- `nv-slang` — Slang compiler skills
- `nv-slangpy` — SlangPy skills

## PR process

1. Branch from `nv-coworkers` (post-merge)
2. One thing per PR
3. `pnpm exec vitest run` + `npm run validate:templates` must pass
4. Squash merge
