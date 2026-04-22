# NanoClaw Dashboard — User Guide

## Quick Start

Open the dashboard:
- **Prod**: `http://nv/slang-coworkers`
- **Dev**: `http://nv/slang-coworkers-dev`

You'll see a pixel-art isometric office with agent characters and a real-time activity timeline.

## Interacting with Coworkers

### Talk to the Orchestrator

Click **Orchestrator** in the Coworkers tab. Andy is the coordinator — it creates coworkers, routes messages, reads reports, and synthesizes across agents.

```
What's the current CI status?          → Andy reads CI coworker's report
Create a perf agent for linkAndOptimizeIR  → Andy spawns a specialist
@SlangMaintainer daily 24h             → Routes directly to maintainer (fastest)
Summarize what all coworkers found     → Andy reads all reports and synthesizes
```

### Talk to a coworker directly

Click any coworker in the sidebar. Messages go directly — Orchestrator is not involved.

| Coworker | Trigger | Example prompts |
|----------|---------|----------------|
| Slang Maintainer | `@SlangMaintainer` | `daily 24h`, `What's blocking CI?`, `Check PR #10744` |
| Slang Triage | `@SlangTriage` | `Run triage now`, `What issues are unassigned?`, `approve 10747` |
| Slang CI | `@SlangCI` | `CI status`, `What's failing?`, `Full digest` |
| Slang Discord | `@SlangDiscord` | `Any unanswered questions?`, `Summarize #slang-discussion` |
| Orphan PR Tracker | `@SlangPRs` | `Scan now`, `Show critical PRs` |
| GPU Optimizer | `@GPUOpt` | `Profile this kernel`, `Analyze CUDA performance` |

### Routing rule

- `@CoworkerName` in Orchestrator chat = routed directly (fastest)
- Click into coworker's chat = direct conversation
- Plain text to Orchestrator = Andy handles it (may delegate)

## Automated Schedules

| Coworker | Schedule | What |
|----------|----------|------|
| Maintainer | Daily 4:30 UTC | Activity report — GitHub, Discord, Slack (3 repos, 3 Slack channels) |
| CI | Every 2h + daily 6:00 UTC | Silent health check + daily digest with trends |
| Triage | Every 2h | Issue scan, classify, gap analysis, attempt fixes |
| Discord | Every 6h | Channel scan, surface unanswered questions |
| Orphan PR | Daily 16:00 UTC | Orphan/stale PR scan across slang, slang-rhi, slangpy |
| Orchestrator | Weekly Sun 6:00 UTC | Curate shared learnings index |

Reports lead with **action items** (what needs human attention), then activity summary.

## Dashboard Features

### Pixel Office
- Characters animate when working (PC screen lights up)
- Status: green = working, yellow = thinking, grey = idle, red = error
- **Blue dot** = unread messages
- Click character to filter timeline

### Timeline
- Real-time tool use, messages, and events
- Filter by coworker (click name)
- **Load older events** button for history
- Tool failures show as yellow warnings

### Coworkers Tab
- **Chat**: send messages, see responses
- **Shell**: run commands inside the container (`cd` syncs with file browser)
- **Work**: browse files in coworker's workspace
- Blue pulsing dot = unread messages

### Keyboard Shortcuts
- `Ctrl +` / `Ctrl -` — Zoom in/out (persists)
- `Ctrl 0` — Reset zoom

## Creating New Coworkers

Via Orchestrator chat or `create_agent` MCP tool:

```
Create a compiler specialist to investigate generic inference bugs.
```

Or explicitly:
```
mcp__nanoclaw__create_agent(
  name: "Compiler Specialist",
  coworkerType: "slang-compiler",
  instructionOverlay: "thorough-analyst",
  instructions: "Focus on generic type inference in the IR."
)
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Becomes the @mention trigger and destination name |
| `coworkerType` | no | Role from `coworker-types.json` (sets templates + allowed MCP tools) |
| `instructionOverlay` | no | Communication style: `thorough-analyst` (default), `terse-reporter`, `code-reviewer`, `ci-focused` |
| `instructions` | no | Custom instructions appended after overlay |
| `allowedMcpTools` | no | Override MCP tool allowlist |

The host composes CLAUDE.md from templates and wires the coworker to the channel with an @mention trigger.

## Cross-Agent Communication

By default, coworkers can only talk to the Orchestrator (parent). Use **peer wiring** to let them communicate directly:

### Wire two agents

Ask the Orchestrator:
```
Wire slang-compiler and slang-language so they can share findings directly.
```

The Orchestrator calls `wire_agents`, and both agents get each other in their destination maps.

### How it works after wiring

```
Compiler:  <message to="slang-language">Is this a type inference issue?</message>
Language:  <message to="slang-compiler">Yes, the generic constraint is wrong at line 42.</message>
```

Messages flow directly — no routing through the Orchestrator.

### When to wire

- Investigation tasks where agents need to share findings in real-time
- Multi-step pipelines (e.g., compiler builds → quality tests)
- Any time "ask the Orchestrator to relay" adds unnecessary latency

### Communication patterns

| Pattern | How |
|---------|-----|
| Parent ↔ Child | Automatic at creation |
| Peer ↔ Peer | `wire_agents` (bidirectional) |
| Broadcast | Orchestrator sends to multiple children |
| Pipeline | Wire A→B→C for sequential handoffs |

## Repos & Channels Monitored

**GitHub**: shader-slang/slang, shader-slang/slang-rhi, shader-slang/slangpy

**Slack**: Configure channel IDs in your `.env` or group CLAUDE.md

**Discord**: Configure channel IDs in your `.env` or group CLAUDE.md

## Tips

- **Don't wait for reports** — ask coworkers directly
- **Coworkers persist** — workspace, memory, and session survive restarts
- **Shell + file browser** — `cd` in the shell navigates the file browser too
- **Reports saved** — each coworker saves to `memory/`. Other coworkers can read them.
- **Containers auto-spawn** — clicking a coworker starts its container if not running

---

## v2 Architecture (Lego Coworker Model)

v2 replaces the monolithic role-template system with a composable "lego" model. CLAUDE.md is composed at container wake time from five artifacts: spine fragments, skills, workflows, overlays, and trait bindings. See `docs/lego-coworker-workflows.md` for the full specification.

### Branch Topology

Feature content is split across independent skill branches that fork from the neutral infrastructure base:

```
upstream/v2
  └── v2_main (neutral infrastructure + lego composer + register fixes)
        ├── nv-dashboard (Pixel Office dashboard + ingress + hook events)
        └── nv-slang (Slang compiler support + MCP + coworker types)
```

Each branch carries only its own files. Merging both into v2_main produces the full install. Neither branch inherits the other's content.

### Coworker Types (Lego Registry)

Types are defined in `container/skills/*/coworker-types.yaml`. The extends chain composes identity, invariants, context, workflows, skills, overlays, and bindings.

| Type | Role | Extends |
|------|------|---------|
| `base-common` | Universal spine (safety, truth, scope) | — |
| `slang-common` | Slang compiler spine (identity, invariants) | `base-common` |
| `slang-reader` | Read-only: investigate issues, review PRs, research | `slang-common` |
| `slang-writer` | Write-capable: investigate, implement, review | `slang-common` |
| 
| 
| `main` / `global` | Flat admin + shared assistants | — (verbatim body, no spine) |

Validate types: `npm run validate:templates`. Rebuild checked-in prompts: `npm run rebuild:claude`.

### Registration Flags

`setup/register.ts` creates agent groups, messaging groups, and wiring. Key flags added in v2:

| Flag | Purpose |
|------|---------|
| `--coworker-type <type>` | Lego registry type name (e.g. `slang-writer`). Stored in `agent_groups.coworker_type`. |
| `--agent-provider <name>` | `claude` (default) or `codex`. Determines container runtime behavior. |
| `--is-admin` | Marks the group as admin/orchestrator (`is_admin=1`). |
| `--session-mode <mode>` | `shared` (one session per channel), `per-thread`, or `agent-shared`. |
| `--no-trigger-required` | Messages don't need to match a trigger pattern to activate this agent. |

Engage mode fields (`engage_mode`, `engage_pattern`, `sender_scope`) are set automatically based on trigger configuration.

### Dashboard Ports

| Port | Service | Environment Variable |
|------|---------|---------------------|
| 3737 | Dashboard rendering server (Pixel Office UI) | `DASHBOARD_PORT` |
| 3738 | Dashboard ingress (browser chat → NanoClaw host) | `DASHBOARD_INGRESS_PORT` |

The ingress forwards browser chat messages to the NanoClaw host's message processing loop. It also handles credential submission for OneCLI approval flows.

### Container Environment Forwarding

The host forwards these `.env` variables into agent containers via Docker `-e` flags:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_MODEL` | Which Claude model the SDK uses |
| `ANTHROPIC_BASE_URL` | API endpoint routing |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | Model overrides |
| `ENABLE_PROMPT_CACHING_1H` | 1-hour prompt caching |
| `CLAUDE_CODE_EFFORT_LEVEL` | Reasoning effort |
| `CODEX_MODEL`, `CODEX_MODEL_PROVIDER` | Codex model config |
| `CODEX_REASONING_EFFORT` | Codex reasoning level |

### OneCLI Credential Proxy

API keys are managed by OneCLI Agent Vault. Containers reach the gateway at `172.17.0.1:10254` (Docker bridge IP). The host injects `HTTPS_PROXY` into each container so API requests are routed through the vault. No keys or tokens are passed to containers directly.

### Flat vs. Typed Coworker Initialization

| Aspect | Flat (`main`, `global`) | Typed (e.g. `slang-writer`) |
|--------|------------------------|--------------------------|
| CLAUDE.md | `@./.claude-global.md` import directive | Composed from lego spine on every wake |
| Symlink | `.claude-global.md` → `/workspace/global/CLAUDE.md` | No symlink |
| Spine | No spine — verbatim upstream body | Full spine: identity + invariants + context + index |
| Runtime | `composeCoworkerClaudeMd` skips (`is_admin`) | `composeCoworkerClaudeMd` renders spine |

### Coworker YAML Bundle Format (v3)

Pre-packaged coworker bundles in `coworkers/*.yaml`:

```yaml
version: 3
agent:
  name: "Display Name"
  folder: "folder-slug"
  coworkerType: "type-from-registry"
  agentProvider: null          # "claude" (default) or "codex"
requires:
  coworkerTypes:
    - "type-name"              # must resolve in the lego registry
instructions: |
  Domain-specific instructions.
trigger: "@folder-slug\\b"
scheduledTasks:                # optional
  - cron: "0 9 * * 1-5"
    prompt: "Run daily triage"
memory:                        # optional (export snapshot)
  files:
    - path: "memory/report.md"
      content: "..."
```

### Session Modes

| Mode | Behavior |
|------|----------|
| `shared` | One session per messaging group (default). All messages in the channel share context. |
| `per-thread` | One session per thread. Each thread has independent context. |
| `agent-shared` | One session per agent group, shared across all messaging groups wired to it. |

Sessions are created lazily on first message. The dashboard API eagerly creates sessions after coworker creation to support immediate memory/task imports.

---

## v2 Changelog

### Infrastructure (v2_main)

- **Lego coworker template system** — composable spine from types, fragments, skills, workflows, overlays, and trait bindings. Replaces monolithic role templates.
- **Register.ts v2 flags** — `--coworker-type`, `--agent-provider`, `--is-admin`, engage modes, sender scope. Dashboard channel gets `unknown_sender_policy: 'public'`.
- **Build script cleanup** — `rm -rf dist && tsc` prevents stale `.js` files when `.ts` files are renamed/deleted.
- **Flat type detection** — `FLAT_COWORKER_TYPES` set ensures `main`/`global` agents get their CLAUDE.md + symlink even when `coworker_type` is set.
- **Container env forwarding** — `ANTHROPIC_MODEL`, `CODEX_*`, caching, and effort-level vars passed into containers.
- **Drift detection tests** — `claude-composer-scenarios.test.ts` compares `groups/*/CLAUDE.md` against `composeCoworkerSpine()` output.
- **Onboard-coworker skill** — scans YAML bundles + lego registry, creates agents via dashboard API or `create_agent` MCP tool.
- **Split-commit skill** — interactive skill for splitting mixed-concern commits into per-bucket branches with independent topology support.

### Dashboard (nv-dashboard)

- **Pixel Office** — isometric pixel-art office visualization with real-time agent status, SSE event streaming, tool use indicators.
- **Dashboard ingress** — localhost HTTP bridge (port 3738) for browser chat → NanoClaw host routing.
- **Eager session creation** — `POST /api/coworkers` now bootstraps a session immediately so memory/task imports don't hit ENOENT.
- **Hook event timeline** — real-time visualization of container tool use, message delivery, and errors.
- **Coworker management** — create, delete, update coworkers via the dashboard API with proper `coworker_type` and sender policy handling.

### Slang Support (nv-slang)

- **Slang MCP server** — Python-based MCP server with 14 tools for GitHub, Discord, Slack, and GitLab integration.
- **Coworker types — `slang-reader` (investigate + review, read-only) and `slang-writer` (implement + document, full write) with lego spine composition.
- **Container skills** — explore, build, fix, maintain, and CI health workflows for the Slang compiler repo.
- **Pre-packaged bundles** — 4 YAML bundles in `coworkers/` for one-click coworker creation via `/onboard-coworker`.
- **Scheduled tasks** — triage (weekday 9am), maintainer sweep (every 10 min) imported from bundles.
