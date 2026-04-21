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
