---
name: remove-docker
description: Replace Docker container runtime with git worktree-based local agent execution. Agents run as direct Node.js processes instead of Docker containers. Not recommended for production — removes container isolation. Use when Docker is unavailable or undesired. Triggers on "remove docker", "no docker", "without docker", "worktree runtime".
---

# Remove Docker

This skill replaces NanoClaw's Docker container runtime with git worktree-based local process execution. Agents run as direct Node.js processes, each getting an isolated git worktree instead of a Docker container.

**WARNING: This removes container isolation.** Agents run directly on the host with your user permissions. Only use this when Docker is unavailable or undesired (e.g. Windows without WSL, lightweight setups).

**What this changes:**
- Agent runtime: Docker containers → local Node.js processes
- Isolation: Docker volumes → git worktrees (`data/worktrees/{folder}/`)
- Paths: hardcoded `/workspace/*` → `WORKSPACE_*` env vars
- Startup: `docker info` check → git repo + agent-runner compilation
- Config: removes `CONTAINER_IMAGE`, `CONTAINER_PREFIX` constants
- Networking: `host.docker.internal` → `localhost` / `127.0.0.1`
- Hooks: bash `curl` → cross-platform `node` one-liner

**What stays the same:**
- IPC protocol between host and agent
- MCP proxy for tool access control
- Session DB and message routing
- CLAUDE.md composition (lego coworker spine)
- Group registration and scheduling

## Prerequisites

Verify requirements:

```bash
node --version  # Must be >= 20
git --version
claude --version  # Claude Code CLI must be installed and authenticated
```

If Claude Code is not installed, the user needs to install it first: https://docs.anthropic.com/en/docs/claude-code

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f src/worktree-runtime.ts && echo "Already applied — worktree runtime exists" || echo "Not applied yet"
```

If already applied, skip to Phase 3 (verify).

## Phase 2: Apply Code Changes

### Fetch and merge the skill branch

```bash
git fetch origin skill/remove-docker
git merge origin/skill/remove-docker
```

This merges in:
- `src/worktree-runtime.ts` — new worktree-based runtime (replaces Docker container-runtime)
- `src/container-runner.ts` — rewritten to spawn local processes with env vars
- `src/container-runtime.test.ts` — tests for worktree runtime
- `src/container-runner.test.ts` — updated integration tests
- `src/index.ts` — swaps `ensureContainerRuntimeRunning` for worktree system init
- `src/ipc.ts` — adds `repo` field and workDir resolution for groups
- `src/config.ts` — removes `CONTAINER_IMAGE` constant
- `src/types.ts` — adds `workDir` to ContainerConfig
- `src/session-cleanup.ts` — cross-platform bash resolution (Windows support)
- `src/channels/index.ts` — .ts file auto-discovery for tsx
- `container/agent-runner/src/index.ts` — env var workspace paths
- `container/agent-runner/src/ipc-mcp-stdio.ts` — env var IPC directory
- `setup/local.ts` — new local setup step (validates Node, git, Claude Code)
- `setup/index.ts` — registers local setup step
- `package.json` — setup script update, better-sqlite3 upgrade

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides. The incoming (skill branch) side should be preferred for all runtime-related code.

### Install dependencies and build

```bash
npm install
npm run build
```

Both must succeed before proceeding.

### Run tests

```bash
npm test
```

All tests must pass.

## Phase 3: Verify

### Check worktree runtime is in place

```bash
test -f src/worktree-runtime.ts && echo "OK: worktree runtime present"
grep -q "CONTAINER_IMAGE" src/config.ts && echo "WARN: CONTAINER_IMAGE still present" || echo "OK: CONTAINER_IMAGE removed"
```

### Test local setup step

```bash
npx tsx setup/index.ts --step local
```

This validates:
1. Node.js >= 20
2. Git is available
3. Claude Code CLI is installed and authenticated
4. Agent-runner compiles successfully

### Start the service

```bash
npm run dev
```

Verify agents spawn as local processes (no Docker containers). Check that `data/worktrees/` is created when an agent starts.

## Post-setup: Update group CLAUDE.md files

After applying this skill, group CLAUDE.md files that reference `/workspace/` Docker paths should be updated:

- Replace `/workspace/project/` with relative paths from cwd
- Replace `/workspace/group/` with the group folder path
- Replace `/workspace/global/` with `groups/global/`
- Replace `/workspace/extra/` references — agents now use their cwd (the git worktree)
- Remove any Docker-specific instructions (container rebuilds, `install_packages`, etc.)

This is optional but recommended to avoid confusing agents with stale Docker-era path references.
