# Slang Coworker System — Guide

This document covers all features added in the Slang coworker system: what they do, how to use them, and how to debug them. Intended for both humans and AI agents.

---

## Table of Contents

1. [Overview](#overview)
2. [Coworker Types & Templates](#coworker-types--templates)
3. [Spawning Coworkers](#spawning-coworkers)
4. [Container Skills](#container-skills)
5. [Onboarding New Coworker Types](#onboarding-new-coworker-types)
6. [Pixel Art Dashboard](#pixel-art-dashboard)
7. [Hook Integration (Dev Mode)](#hook-integration-dev-mode)
8. [Skill Branch Updates](#skill-branch-updates)
9. [Debugging](#debugging)

---

## Overview

The Slang coworker system adds domain-specific AI agents for the [Slang](https://github.com/shader-slang/slang) shading language compiler. Each coworker type is a reusable template; multiple instances can be spawned for parallel work.

### Architecture

```
groups/coworker-types.json     ← Registry of all coworker types
groups/slang-base/CLAUDE.md    ← Base template (shared by all slang-* types)
groups/slang-ir/CLAUDE.md      ← Domain template (appended to base on spawn)
groups/slang_ir-generics/      ← Spawned instance (runtime, not tracked in git)
```

When a coworker is spawned:
1. Base template (`slang-base/CLAUDE.md`) is copied to a new group folder
2. Domain template (e.g., `slang-ir/CLAUDE.md`) is appended
3. A git worktree is created for isolated Slang repo access
4. The group is registered via IPC so NanoClaw picks it up
5. An optional initial task is queued

---

## Coworker Types & Templates

### Registry: `groups/coworker-types.json`

| Type | Specialization | Focus Files |
|------|---------------|-------------|
| `slang-base` | General Slang coworker (base for all) | Entire source |
| `slang-ir` | IR system (SSA, passes, transformations) | `slang-ir*.h/cpp` |
| `slang-frontend` | Lexer, parser, type checking | `slang-parser*.cpp`, `slang-check*.cpp` |
| `slang-cuda` | CUDA backend codegen | `slang-emit-cuda*.cpp` |
| `slang-optix` | OptiX/ray tracing backend | `slang-emit-cuda*.cpp` |
| `slang-langfeat` | End-to-end language features | All pipeline stages |
| `slang-docs` | Documentation | `docs/`, `prelude/` |
| `slang-coverage` | Test coverage analysis | `tests/` |
| `slang-test` | Test infrastructure | `tests/`, `tools/slang-test/` |

### Template Inheritance

Each domain template inherits from `slang-base`. The spawn script concatenates:
```
slang-base/CLAUDE.md + "---" separator + slang-<domain>/CLAUDE.md
```

### Adding a Template Manually

1. Create `groups/<type>/CLAUDE.md` following the structure of existing templates
2. Add an entry to `groups/coworker-types.json`:
   ```json
   {
     "<type-name>": {
       "description": "One-line description",
       "template": "groups/<type-name>/CLAUDE.md",
       "base": "slang-base",
       "focusFiles": ["source/slang/relevant-*.cpp"]
     }
   }
   ```

---

## Spawning Coworkers

### CLI

```bash
# Basic spawn
./scripts/spawn-coworker.sh --type slang-ir "ir-generics" "Investigate generics lowering in IR"

# List all types and active instances
./scripts/spawn-coworker.sh --list

# Show help
./scripts/spawn-coworker.sh --help
```

### What Spawn Does

1. Creates `groups/slang_<name>/` with merged CLAUDE.md
2. Creates `groups/slang_<name>/investigations/` and `architecture/` dirs
3. Creates git worktree at `data/worktrees/<name>` (if slang repo exists)
4. Writes IPC registration JSON to `data/ipc/main/tasks/`
5. Optionally writes initial task JSON to `data/ipc/slang_<name>/input/`

### Via Channel (Slack/Discord/WhatsApp)

Send to the main group:
```
spawn slang-ir ir-generics Investigate generics lowering
```

### Via Orchestrator (groups/main/CLAUDE.md)

The main group CLAUDE.md documents orchestration commands:
```
mcp__nanoclaw__register_group(jid: "cli:slang-<name>", name: "Slang: <name>", folder: "slang_<name>", trigger: "@slang", requiresTrigger: false)
```

---

## Container Skills

Skills are reusable capability modules mounted into containers at `.claude/skills/`.

| Skill | File | Purpose |
|-------|------|---------|
| `slang-repo` | `container/skills/slang-repo/SKILL.md` | Clone, build, test Slang (cmake, ninja, ctest) |
| `slang-explore` | `container/skills/slang-explore/SKILL.md` | Navigate codebase, trace features through pipeline |
| `github-issues` | `container/skills/github-issues/SKILL.md` | Read/create/comment on GitHub issues and PRs via `gh` |
| `slack-comms` | `container/skills/slack-comms/SKILL.md` | Send Slack messages via NanoClaw MCP |
| `discord-comms` | `container/skills/discord-comms/SKILL.md` | Send Discord messages via NanoClaw MCP |

### Container Additions

The Dockerfile adds these dependencies for Slang coworkers:
- `cmake`, `ninja-build`, `python3` — build tools
- `lcov` — code coverage
- `gh` (GitHub CLI) — issue/PR management

The `GH_TOKEN` environment variable is forwarded to containers via `src/container-runner.ts`.

---

## Onboarding New Coworker Types

Use the `/onboard-coworker` Claude Code skill to create entirely new coworker types through an interactive wizard.

### What It Does (10 Phases)

| Phase | Action |
|-------|--------|
| 0 | **Discovery Dashboard** — shows existing types, instances, skills, workflows |
| 1 | **Discovery** — asks about role, project, tasks, tools, channels |
| 2 | **Inventory** — checks existing skills/tools for reuse |
| 3 | **Create Skills** — builds new `container/skills/<name>/SKILL.md` |
| 4 | **Create Template** — writes `groups/<type>/CLAUDE.md` |
| 5 | **Container Deps** — adds tools to Dockerfile |
| 6 | **Environment** — configures credentials in `.env` |
| 7 | **Workflows** — integrates captured workflows from existing coworkers |
| 8 | **Register** — adds entry to `groups/coworker-types.json` |
| 9 | **Test** — spawns a test instance |
| 10 | **Summary** — reports what was created |

### Composable Building Blocks

The wizard can compose from:
- Existing container skills (`container/skills/*/SKILL.md`)
- Captured workflows (`groups/*/workflows/*.md`)
- Existing coworker type bases (`groups/coworker-types.json`)

---

## Pixel Art Dashboard

A real-time visualization of all coworkers as pixel art characters in a virtual office.

### Running

```bash
npm run dashboard
# Opens at http://localhost:3737
```

Or with custom port:
```bash
DASHBOARD_PORT=8080 npm run dashboard
```

### Tab 1: Pixel Office

- Each coworker appears as a pixel art character at a desk
- Characters use [Pixel Agents](https://github.com/pablodelucca/pixel-agents) sprites (MIT license) with procedural fallback
- Real-time status via WebSocket: idle, working, thinking, error
- Click a character to see: type, status, current task, memory (CLAUDE.md), hook events
- PC screens animate when a coworker is working
- Speech bubbles show current tool use or task

### Tab 2: Timeline / Audit Log

- Scrollable timeline of all events (task runs + hook events)
- Stats row: total coworkers, tasks, runs, success rate, avg duration
- 24-hour sparkline activity chart
- Useful for debugging and auditing coworker behavior

### Data Sources (All Read-Only)

| Source | What It Provides |
|--------|-----------------|
| `store/messages.db` | Registered groups, scheduled tasks, task run logs |
| `groups/coworker-types.json` | Type definitions (determines character appearance) |
| `data/ipc/*/input/` | Pending task detection |
| `POST /api/hook-event` | Live tool-use and notification events from containers |

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/state` | GET | Full dashboard state snapshot |
| `/api/types` | GET | Coworker type definitions |
| `/api/memory/<folder>` | GET | Read a group's CLAUDE.md |
| `/api/hook-event` | POST | Receive hook events from containers |
| `/` | GET | Dashboard UI |
| WebSocket `/` | WS | Real-time state push (500ms poll) |

---

## Hook Integration (Dev Mode)

The dashboard can receive real-time events from container Claude Code instances via hooks.

### Setup

1. Copy the hook script to a known location:
   ```bash
   cp dashboard/hooks/notify-dashboard.sh /usr/local/bin/notify-dashboard.sh
   chmod +x /usr/local/bin/notify-dashboard.sh
   ```

2. Add to container's `.claude/settings.json`:
   ```json
   {
     "hooks": {
       "PostToolUse": [{ "command": "/usr/local/bin/notify-dashboard.sh PostToolUse" }],
       "Notification": [{ "command": "/usr/local/bin/notify-dashboard.sh Notification" }],
       "Stop": [{ "command": "/usr/local/bin/notify-dashboard.sh Stop" }]
     }
   }
   ```

3. Set the group folder env var in `src/container-runner.ts` (or container env):
   ```
   NANOCLAW_GROUP_FOLDER=slang_ir-generics
   ```

### How It Works

- Hook script reads event JSON from stdin (piped by Claude Code)
- Extracts tool name and message
- POSTs to `http://host.docker.internal:3737/api/hook-event` (fire-and-forget)
- Dashboard broadcasts the event to all WebSocket clients
- Characters show live tool use in speech bubbles, status updates in real time

---

## Skill Branch Updates

Slang coworker files are organized into two independent skill branches for `/update-skills` support:

### `skill/slang-coworker`

Contains all slang-specific files:
- Container skills (`container/skills/slang-*/`, `github-issues/`, `slack-comms/`, `discord-comms/`)
- Templates (`groups/slang-*/CLAUDE.md`)
- Registry (`groups/coworker-types.json`)
- Spawn script (`scripts/spawn-coworker.sh`)
- Onboard wizard (`.claude/skills/onboard-coworker/SKILL.md`)

### `skill/dashboard`

Contains the dashboard:
- Server (`dashboard/server.ts`)
- UI (`dashboard/public/`)
- Sprites and Pixel Agents assets (`dashboard/public/assets/`)
- Hook script (`dashboard/hooks/`)

### Installing

```bash
git merge origin/skill/slang-coworker  # Install slang coworker system
git merge origin/skill/dashboard       # Install pixel art dashboard
```

### Updating

Run `/update-skills` in Claude Code — it detects new commits on `upstream/skill/*` branches and offers to merge them.

---

## Debugging

### Common Issues

#### Dashboard won't start

```bash
# Check if port is in use
lsof -i :3737

# Check if DB exists
ls -la store/messages.db

# Run with debug output
DASHBOARD_PORT=3737 npx tsx dashboard/server.ts
```

The dashboard works without a DB — it just won't show task history.

#### No coworkers show up in the dashboard

The dashboard scans `groups/` for non-template folders. Check:

```bash
# List all group folders
ls -d groups/*/

# Should see spawned instances like groups/slang_ir-generics/
# Template folders (slang-base, slang-ir, etc.) are filtered out
```

If you see the folder but not the character, check if it matches the type-detection pattern in `server.ts:getState()`. The folder must start with a type prefix (e.g., `slang_*`).

#### Coworker shows as "idle" when it's working

Status detection order:
1. DB: active scheduled tasks → `working`
2. DB: last task run with error status → `error`
3. IPC: pending input files → `thinking`
4. Hooks: recent hook event (< 30s) → `working`
5. Default → `idle`

If hooks aren't configured, the dashboard falls back to DB-based status which only updates on task scheduler runs. Configure hooks for real-time status.

#### Hook events not arriving

```bash
# Test the hook manually
echo '{"tool_name":"Read","message":"test"}' | \
  NANOCLAW_GROUP_FOLDER=slang_test \
  DASHBOARD_URL=http://localhost:3737 \
  ./dashboard/hooks/notify-dashboard.sh PostToolUse

# Check if dashboard received it
curl http://localhost:3737/api/state | jq '.hookEvents'
```

If running in Docker, ensure `host.docker.internal` resolves (Docker Desktop) or use the host IP.

#### Spawn script fails

```bash
# Check jq is installed (used for JSON operations)
which jq

# Check slang repo exists (optional, for worktrees)
ls data/slang-repo/.git

# Debug: run with verbose
bash -x scripts/spawn-coworker.sh --type slang-ir "test" "test task"
```

#### Container can't access GitHub

The `GH_TOKEN` env var must be set in the host `.env` file. Verify:

```bash
# Check token is set
grep GH_TOKEN .env

# Test inside a running container
docker exec <container> gh auth status
```

The token is forwarded via `src/container-runner.ts` → container env.

#### Template changes not taking effect

Templates are copied at spawn time, not dynamically loaded. To update a running coworker's template:

```bash
# Option 1: Edit the instance directly
vim groups/slang_<name>/CLAUDE.md

# Option 2: Respawn (destructive — loses memory)
rm -rf groups/slang_<name>
./scripts/spawn-coworker.sh --type <type> "<name>" "<task>"
```

#### WebSocket disconnects

The dashboard auto-reconnects after 2 seconds. If it keeps disconnecting:
- Check if the server process is still running
- Check for proxy/firewall issues with WebSocket upgrade
- The dashboard uses manual WebSocket (no `ws` library) — compatible with standard HTTP/1.1 upgrade

### Inspecting State

```bash
# Full dashboard state as JSON
curl -s http://localhost:3737/api/state | jq .

# Just coworkers
curl -s http://localhost:3737/api/state | jq '.coworkers'

# Coworker types registry
curl -s http://localhost:3737/api/types | jq .

# Read a coworker's memory
curl -s http://localhost:3737/api/memory/slang_ir-generics

# SQLite queries (if you have sqlite3)
sqlite3 store/messages.db "SELECT * FROM registered_groups"
sqlite3 store/messages.db "SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT 10"
```

### File Locations Reference

| What | Path |
|------|------|
| Coworker type registry | `groups/coworker-types.json` |
| Base template | `groups/slang-base/CLAUDE.md` |
| Domain templates | `groups/slang-*/CLAUDE.md` |
| Spawned instances | `groups/slang_*/` |
| Container skills | `container/skills/*/SKILL.md` |
| Dashboard server | `dashboard/server.ts` |
| Dashboard UI | `dashboard/public/` |
| Pixel Agents assets | `dashboard/public/assets/` |
| Hook script | `dashboard/hooks/notify-dashboard.sh` |
| Spawn script | `scripts/spawn-coworker.sh` |
| Onboard wizard | `.claude/skills/onboard-coworker/SKILL.md` |
| IPC directory | `data/ipc/` |
| Git worktrees | `data/worktrees/` |
| SQLite database | `store/messages.db` |
| Orchestrator config | `groups/main/CLAUDE.md` |
