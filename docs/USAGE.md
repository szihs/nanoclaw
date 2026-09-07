# NanoClaw Dashboard — User Guide

## Quick Start

Open the dashboard:
- **Prod**: `http://nv/slang-coworkers`
- **Dev**: `http://nv/slang-coworkers-dev`

You'll see a pixel-art isometric office with agent characters and a real-time activity timeline.

## Interacting with Coworkers

### Talk to the Orchestrator

Click **Orchestrator** in the Coworkers tab. The Orchestrator is the coordinator — it creates coworkers, routes messages, reads reports, and synthesizes across agents.

```
What's the current CI status?          → Reads CI babysitter's report
Create a perf agent for linkAndOptimizeIR  → Spawns a specialist
@slang-triager triage issue #10744     → Routes directly to triager (fastest)
Summarize what all coworkers found     → Reads all reports and synthesizes
```

### Talk to a coworker directly

Click any coworker in the sidebar. Messages go directly — Orchestrator is not involved.

| Coworker | Trigger | Role |
|----------|---------|------|
| Slang Maintainer | `@SlangMaintainer` | Daily activity report, CI health, Discord monitoring |
| Slang Discord Support | `@SlangDiscordSupport` | Discord community support, unanswered questions |
| Slang CI Babysitter | `@CIBabysitter` | CI health, merge queue, workflow failures |
| slang-triager | `@slang-triager` | Issue triage for shader-slang/slang |
| slang-fixer | `@slang-fixer` | Implement fixes for triaged Slang issues |
| slang-reviewer | `@slang-reviewer` | PR review for shader-slang/slang |
| slangpy-triager | `@slangpy-triager` | Issue triage for shader-slang/slangpy |
| slangpy-fixer | `@slangpy-fixer` | Implement fixes for triaged SlangPy issues |
| slangpy-reviewer | `@slangpy-reviewer` | PR review for shader-slang/slangpy |

### Routing rule

- `@coworker-name` in Orchestrator chat = routed directly (fastest)
- Click into coworker's chat = direct conversation
- Plain text to Orchestrator = Orchestrator handles it (may delegate)

## Automated Schedules

| Coworker | Schedule | What |
|----------|----------|------|
| Maintainer | `*/10 * * * *` (heartbeat) | CI health + Discord new messages pre-check; wakes agent only when actionable |
| Discord Support | `*/5 * * * *` (heartbeat) | Discord channel scan, pending summons, CI thresholds; wakes only when needed |
| Funnel refresh | `17 */6 * * *` (crontab) | Dashboard funnel panel data refresh (`reports/funnel.json`) |
| Skills refresh | `37 * * * *` (crontab) | `scripts/refresh-skills-cron.sh` — fetches external skills from `shader-slang/slang-skills` into `container/skills/`, then mirrors them into every group's bind-mounted `.claude-shared/`. Running containers pick the new skills up with no restart |

The heartbeat scripts run lightweight shell checks (Discord API, CI health snapshot, summon requests) and only wake the agent when thresholds are crossed or actionable items exist. This minimizes API credit consumption.

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

## Onboarding a New Project

Use `/onboard-project` to scaffold a full lego project skeleton for any codebase. This generates everything needed to create typed coworkers for a new project — the same structure that `spine-slang` provides for the Slang compiler.

```
/onboard-project https://github.com/owner/repo short-name
/onboard-project /local/path/to/project
```

What it generates:

| Artifact | Count | What |
|----------|-------|------|
| Spine fragments | 3 | `identity/`, `invariants/`, `context/` |
| Capability skills | 5 | `{project}-build`, `{project}-code-reader`, `{project}-code-writer`, `{project}-docs`, `{project}-github` |
| Workflow extensions | 4 | `{project}-plan`, `{project}-implement`, `{project}-triage-issue`, `{project}-pr-review` |
| Coworker types | 3+ | `{project}-common`, `{project}-reader`, `{project}-writer` (plus specialized types if skill clusters warrant it) |

### Two-step flow

1. **`/onboard-project <repo>`** — analyzes the codebase (clones it, reads existing AI config files, CI workflows, build scripts) and generates the full skeleton in `container/spines/{project}/`. Reuses existing base workflows (`/plan`, `/implement`) and the `codex-critique` skill — no duplication.
2. **`/onboard-coworker`** — selects a bundle or type from the registry and creates a running coworker instance.

After running `/onboard-project`, the new types (`{project}-reader`, `{project}-writer`) are immediately available in the lego registry for coworker creation.

## Creating New Coworkers

Via Orchestrator chat or `create_agent` MCP tool:

```
Create a compiler specialist to investigate generic inference bugs.
```

Or explicitly:
```
mcp__nanoclaw__create_agent(
  name: "Compiler Specialist",
  coworkerType: "slang-writer",
  instructionOverlay: "thorough-analyst",
  instructions: "Focus on generic type inference in the IR."
)
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Becomes the @mention trigger and destination name |
| `coworkerType` | no | Role from `coworker-types.yaml` (sets templates + allowed MCP tools) |
| `instructionOverlay` | no | Communication style: `thorough-analyst` (default), `terse-reporter`, `code-reviewer`, `ci-focused` |
| `instructions` | no | Custom instructions appended after overlay |
| `allowedMcpTools` | no | Override MCP tool allowlist |

The host composes CLAUDE.md from templates and wires the coworker to the channel with an @mention trigger.

## Cross-Agent Communication

By default, coworkers can only talk to the Orchestrator (parent). Use **peer wiring** to let them communicate directly:

### Wire two agents

Ask the Orchestrator:
```
Wire slang-fixer and slang-triager so they can share findings directly.
```

The Orchestrator calls `wire_agents`, and both agents get each other in their destination maps.

### How it works after wiring

```
Fixer:   <message to="slang-triager">Is this a type inference issue?</message>
Triager: <message to="slang-fixer">Yes, the generic constraint is wrong at line 42.</message>
```

Messages flow directly — no routing through the Orchestrator.

### When to wire

- Investigation tasks where agents need to share findings in real-time
- Multi-step pipelines (e.g., triager → fixer handoff)
- Any time "ask the Orchestrator to relay" adds unnecessary latency

### Communication patterns

| Pattern | How |
|---------|-----|
| Parent ↔ Child | Automatic at creation |
| Peer ↔ Peer | `wire_agents` (bidirectional) |
| Broadcast | Orchestrator sends to multiple children |
| Pipeline | Wire A→B→C for sequential handoffs |

### Current Wirings (prod)

The Orchestrator can reach all active agents. Peer wirings between specialists:

| Source | Can message | Purpose |
|--------|-------------|---------|
| slang-triager | slang-fixer | Hand off triaged issues for fixing |
| slang-fixer | slang-triager, slang-reviewer | Request triage context; request review |
| slang-reviewer | slang-fixer | Send review feedback back to fixer |
| slangpy-triager | slangpy-fixer | Hand off triaged issues for fixing |
| slangpy-fixer | slangpy-triager, slangpy-reviewer | Request triage context; request review |
| slangpy-reviewer | slangpy-fixer | Send review feedback back to fixer |
| Slang Maintainer | slang-fixer (as "slang-writer") | Delegate implementation tasks |
| Slang Discord Support | Orchestrator | Escalate questions |

Every agent also has a dashboard channel destination (for the Pixel Office UI) and an `agent-mg-a2a` channel (the GitHub webhook routing channel).

## Issue Supervision (`/supervise-issues`)

The `supervise-issues` container skill provides automated oversight of in-flight GitHub issue chains. It tracks every issue that has been routed to a coworker (triager/fixer) and ensures nothing falls through the cracks.

### What it does

- **Builds a live status table** from `ncl sessions list --thread-prefix "gh-issue-"` — discovers all active issue chains every tick
- **Classifies** each chain: dispatched → triaging → fixing → reviewing → pr_open → awaiting_human → silent → closed
- **Nudges** silent chains (no activity for N hours) by messaging the responsible coworker
- **Enforces the prime directive**: every chain must have a resumable GitHub artifact (open PR, issue comment, or triage report) so a human can land on it and pick up
- **Tracks no-PR chains** — issues that were triaged but handed off to external contributors or maintainers
- **Detects superseded PRs** — when a maintainer ships their own fix while our PR was in progress
- **GC sweep** — reclaims abandoned fixer worktrees

### Scheduling

Designed for `schedule_task` with a 6-hour cron (`0 */6 * * *`). Each tick runs in a fresh session (`new_session: true`) and is gated by a delta check — if nothing changed since the last tick, it's a no-op.

### State

Persists to `memory/supervisor-state.json` in the orchestrator's workspace. Tracks per-chain: `lastState`, `lastActivityAt`, `lastPrState`, last comment seen.

### Output

Reports lead with **NEW** and **UPDATED** chains (what moved since last tick), then collapse unchanged rows. Surfaces blockers and missing-artifact chains prominently.

## Repos & Channels Monitored

**GitHub**: shader-slang/slang, shader-slang/slang-rhi, shader-slang/slangpy

**Discord**: #slang-support, #slang-discussion, #slangpy-support (plus threads)

**Slack**: Configure channel IDs in your `.env` or group CLAUDE.md

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

Feature content is split across independent `nv-*` branches that fork from the upstream base. All downstream installs consume `nv-coworkers`, which is the aggregator that merges the per-bucket branches on every push:

```
upstream/main
  └── nv-main (neutral infrastructure + lego composer + register fixes)
        ├── nv-dashboard  (Pixel Office dashboard + ingress + hook events)
        ├── nv-slang      (Slang compiler support + MCP + coworker types)
        ├── nv-slangpy    (SlangPy Python bindings project)
        └── nv-nanoclaw   (NanoClaw-as-project trait set)
               → nv-coworkers (aggregator — consumed by prod + dev installs)
```

Each `nv-*` branch carries only its own files. Merging them into `nv-coworkers` produces the full install; neither branch inherits the other's content. Changes land on the owning `nv-*` branch first, then propagate via `nv-coworkers`.

### Coworker Types (Lego Registry)

Types are defined in `container/spines/*/coworker-types.yaml`. The extends chain composes identity, invariants, context, workflows, skills, overlays, and bindings.

| Type | Role | Extends |
|------|------|---------|
| `base-common` | Universal spine (safety, truth, scope) | — |
| `default` | Untyped fallback (slim, no project skills) | `base-common` |
| `slang-common` | Slang compiler spine (identity, invariants, ABI) | `base-common` |
| `slang-reader` | Read-only: plan / investigate / review via `/slang-plan` | `slang-common` |
| `slang-writer` | Write-capable: `/slang-plan` + `/slang-implement` | `slang-common` |
| `slang-maintainer` | Recurring maintenance (no code changes) | `slang-reader` |
| `slang-triage` | Issue triage specialist | `slang-reader` |
| `slang-fixer` | Issue fixer (A/B test mode, no push/PR) | `slang-writer` |
| `slang-reviewer` | PR review runner | `slang-reader` |
| `slang-discord` | Discord support (read-only, no posting) | `slang-reader` |
| `slangpy-common` | SlangPy identity & repo layout | `base-common` |
| `slangpy-reader` | Read-only SlangPy investigator | `slangpy-common` |
| `slangpy-writer` | Write-capable SlangPy implementer | `slangpy-common` |
| `slangpy-triage` | SlangPy issue triage | `slangpy-reader` |
| `slangpy-fixer` | SlangPy issue fixer | `slangpy-writer` |
| `slangpy-reviewer` | SlangPy PR reviewer | `slangpy-reader` |
| `main` | Flat admin orchestrator (no `extends` — verbatim body) | — (flat) |

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
| `ENABLE_PROMPT_CACHING_1H` | 1-hour prompt cache TTL (non-Bedrock path only) |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | 1-hour prompt cache TTL when using an `aws/anthropic/bedrock-*` model (the path most NVIDIA inference-api setups are on). Set one or the other depending on provider. |
| `FORCE_PROMPT_CACHING_5M` | Override back to the 5-minute default, e.g. for comparative testing |
| `CLAUDE_CODE_EFFORT_LEVEL` | Reasoning effort |
| `CODEX_MODEL`, `CODEX_MODEL_PROVIDER` | Codex model config |
| `CODEX_REASONING_EFFORT` | Codex reasoning level |

### OneCLI Credential Proxy

API keys are managed by OneCLI Agent Vault. Containers reach the gateway at `172.17.0.1:10254` (Docker bridge IP). The host injects `HTTPS_PROXY` into each container so API requests are routed through the vault. No keys or tokens are passed to containers directly.

### Flat vs. Typed Coworker Initialization

| Aspect | Flat (`main`) | Typed (e.g. `slang-writer`, `default`) |
|--------|--------------|----------------------------------------|
| CLAUDE.md | Slim admin-orchestrator body + auto-discovered project fragments | Composed from lego spine on every wake |
| Identity | `container/skills/nanoclaw-base/prompts/main-body.md` | From spine: `*-common.identity` |
| Projects | Auto-emitted by composer from spine `project:` metadata | N/A |
| Spine | No spine — verbatim body | Full spine: identity + invariants + context + workflows + bindings |
| Shared mount | `/workspace/shared` (read-write — Main only) | `/workspace/shared` (read-only) |
| Runtime | `composeCoworkerClaudeMd` renders flat body + fragments | `composeCoworkerClaudeMd` renders spine |

The pre-lego `@./.claude-global.md` @-import pattern is retired. All coworker content is composed on every wake; there is no runtime symlink machinery.

### Coworker YAML Bundle Format (v3)

Pre-packaged coworker bundles in `coworkers/*.yaml`:

```yaml
version: 3
agent:
  name: "Display Name"
  folder: "folder-slug"
  coworkerType: "type-from-registry"
  agentProvider: null          # "claude" (default) or "codex"
  routing: direct              # "direct" or "internal"
requires:
  coworkerTypes:
    - "type-name"              # must resolve in the lego registry
instructions: |
  Domain-specific instructions.
trigger: "@folder-slug\\b"
destinations:                  # optional
  - name: "orchestrator"
    type: agent
    targetFolder: main
scheduledTasks:                # optional
  - name: heartbeat
    scheduleType: cron
    scheduleValue: "*/10 * * * *"
    contextMode: isolated
    script: |
      #!/bin/bash
      # Pre-check script; agent wakes only if script exits 0
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

### Capability Skills (container/skills/)

Skills loaded inside agent containers at runtime:

| Skill | Purpose |
|-------|---------|
| `base-nanoclaw` | Core NanoClaw container primitives |
| `buddy` | Pair-programming assistant |
| `codex-critique` | Critique stage gates (PLAN_REVIEW, CODE_REVIEW, etc.) |
| `explain-diff-html` | Self-contained HTML explanation (background, intuition, code walkthrough, quiz) of every PR a coworker opens; asked for by the PR-created hook |
| `self-customize` | Agent self-modification tools |
| `agent-browser` | In-container web browsing |
| `slack-formatting` | Slack message formatting |
| `whatsapp-formatting` | WhatsApp message formatting |
| `welcome` | First-run welcome flow |
| `slang-build` | Build the Slang compiler from source |
| `slang-code-reader` | Navigate/search the Slang codebase |
| `slang-code-writer` | Write/modify Slang source code |
| `slang-docs` | Slang documentation workflows |
| `slang-github` | GitHub integration for shader-slang/slang |
| `slang-github-webhook` | GitHub webhook routing for Slang PRs/issues |
| `slang-maintainer-tools` | Maintainer reporting tools |
| `slang-pr-review-runner` | Structured PR review workflow |
| `slang-clarity-review-runner` | Clarity-focused PR review |
| `slangpy-build` | Build SlangPy from source |
| `slangpy-code-reader` | Navigate/search the SlangPy codebase |
| `slangpy-code-writer` | Write/modify SlangPy source code |
| `slangpy-docs` | SlangPy documentation workflows |
| `slangpy-github` | GitHub integration for shader-slang/slangpy |
| `supervise-issues` | Cross-repo issue supervision |

---

## v2 Changelog

### Infrastructure (nv-main)

- **Lego coworker template system** — composable spine from types, fragments, skills, workflows, overlays, and trait bindings. Replaces monolithic role templates.
- **Register.ts v2 flags** — `--coworker-type`, `--agent-provider`, `--is-admin`, engage modes, sender scope. Dashboard channel gets `unknown_sender_policy: 'public'`.
- **Build script cleanup** — `rm -rf dist && tsc` prevents stale `.js` files when `.ts` files are renamed/deleted.
- **Flat type detection** — `FLAT_COWORKER_TYPES` set ensures `main`/`global` agents get their CLAUDE.md + symlink even when `coworker_type` is set.
- **Container env forwarding** — `ANTHROPIC_MODEL`, `CODEX_*`, caching, and effort-level vars passed into containers.
- **Drift detection tests** — `claude-composer-scenarios.test.ts` compares `groups/*/CLAUDE.md` against `composeCoworkerSpine()` output.
- **Onboard-project skill** — generates a complete lego project skeleton (spine, 5 capability skills, workflow extensions, 3+ coworker types) for any GitHub repo or local path. Analyzes existing AI config, CI, and build files; reuses base skills where possible.
- **Onboard-coworker skill** — scans YAML bundles + lego registry, creates agents via dashboard API or `create_agent` MCP tool.
- **Split-commit skill** — interactive skill for splitting mixed-concern commits into per-bucket branches with independent topology support.

### Dashboard (nv-dashboard)

- **Pixel Office** — isometric pixel-art office visualization with real-time agent status, SSE event streaming, tool use indicators.
- **Dashboard ingress** — localhost HTTP bridge (port 3738) for browser chat → NanoClaw host routing.
- **Eager session creation** — `POST /api/coworkers` now bootstraps a session immediately so memory/task imports don't hit ENOENT.
- **Hook event timeline** — real-time visualization of container tool use, message delivery, and errors.
- **Coworker management** — create, delete, update coworkers via the dashboard API with proper `coworker_type` and sender policy handling.

### Slang Support (nv-slang)

- **Slang MCP server** — Python-based MCP server with tools for GitHub, Discord, Slack, and GitLab integration.
- **Coworker types** — full hierarchy: `slang-common` → `slang-reader` / `slang-writer` → specialized types (`slang-triage`, `slang-fixer`, `slang-reviewer`, `slang-maintainer`, `slang-discord`) with lego spine composition.
- **Container skills** — explore, build, fix, maintain, review, and CI health workflows for the Slang compiler repo.
- **Pre-packaged bundles** — 4 YAML bundles in `coworkers/` (maintainer, triage, fixer, discord-support).
- **Heartbeat-driven schedules** — lightweight shell pre-checks wake agents only when actionable (CI failures, new Discord messages, pending summons).

### SlangPy Support (nv-slangpy)

- **SlangPy spine** — `slangpy-common` → `slangpy-reader` / `slangpy-writer` → `slangpy-triage`, `slangpy-fixer`, `slangpy-reviewer`.
- **Container skills** — build, code-reader, code-writer, docs, github for shader-slang/slangpy.
- **Live agents** — `slangpy-triager`, `slangpy-fixer`, `slangpy-reviewer` running in prod.
