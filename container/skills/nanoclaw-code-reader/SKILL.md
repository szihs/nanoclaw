---
name: nanoclaw-code-reader
description: "Read-only investigation of the NanoClaw codebase. Navigate source, trace call paths, understand architecture."
provides: [code.read, doc.read]
allowed-tools: Bash, Read, Grep, Glob, mcp__deepwiki__ask_question
---

# Code Reader

## Architecture

Single Node.js process (`src/index.ts`) that:
1. Starts channel adapters (dashboard, CLI, WhatsApp, Telegram, etc.)
2. Starts MCP servers via supergateway (loopback HTTP)
3. Starts MCP auth proxy (credential injection for containers)
4. Polls session DBs for inbound messages
5. Spawns Docker containers with Claude Agent SDK to process messages

## Key modules

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: startup, message loop, shutdown |
| `src/container-runner.ts` | Container spawn, mounts, env, lifecycle |
| `src/claude-composer.ts` + `src/claude-composer/` | Lego spine composition |
| `src/router.ts` | Outbound message formatting and delivery |
| `src/delivery.ts` | Inbound message routing to sessions |
| `src/mcp-auth-proxy.ts` | OneCLI credential proxy for containers |
| `src/mcp-registry.ts` | MCP server lifecycle management |
| `src/host-sweep.ts` | Stale container detection and cleanup |
| `src/db/migrations/` | Schema evolution (additive only) |

## Module system (`src/modules/`)

- `agent-to-agent/` — create_agent, wire_agents, send_message between coworkers
- `approvals/` — install_packages, credential requests, ask_user_question cards
- `permissions/` — channel approval, sender approval, user roles
- `scheduling/` — cron-like task scheduling with recurrence
- `self-mod/` — agent self-modification (install packages, restart)

## Container agent (`container/agent-runner/`)

Bun runtime. Providers: `claude.ts` (Claude Agent SDK), `codex.ts` (Codex CLI), `opencode.ts` (OpenCode). MCP tools: `agents.ts`, `learnings.ts`, `self-mod.ts`.

## Search strategies

- Architecture questions → read `docs/lego-coworker-workflows.md`
- Message flow → trace from `src/delivery.ts` → `src/container-runner.ts` → `container/agent-runner/src/index.ts`
- Spine composition → `src/claude-composer/resolve.ts` (type resolution) → `spine.ts` (rendering)
- DB schema → `src/db/migrations/*.ts` (ordered by version number)
