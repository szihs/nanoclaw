# Slang Maintainer Coworker — Setup Summary

## Overview

AI coworker that supports Slang sprint maintainership duties. Registered as a NanoClaw coworker with restricted MCP tool access and a scheduled heartbeat for continuous monitoring.

| Field | Value |
|-------|-------|
| JID | `dashboard:slang-maintainer` |
| Folder | `slang_maintainer` |
| Trigger | `@SlangMaintainer` |
| Type | Custom (static CLAUDE.md) |

## Capabilities

### Issue Triage
- Scans open issues across `shader-slang/slang`, `shader-slang/slangpy`, `shader-slang/slang-rhi`
- Identifies untriaged issues (missing `Dev_Reviewed` label)
- Assesses priority: SS (Ship Stopper), P0, Normal
- Checks GitHub Discussions for unreported issues
- Trigger: "triage issues" or part of heartbeat

### Discord Monitoring
- Reads messages from primary channels (read-only, never posts to source channels):
  - #slang-support (`1313936640661524601`)
  - #slang-discussion (`1305995870046650368`)
  - #slangpy-support (`1337094433816051813`)
- Identifies unanswered questions and bug reports
- Drafts suggested answers using DeepWiki documentation lookup
- Posts combined draft to #slang-support-bot forum channel
- Responds to feedback threads in #slang-support-bot
- Trigger: "check discord" or part of heartbeat

### CI Health Monitoring
- Fetches latest CI queue snapshot from `shader-slang/slang-ci-analytics` (JSONL, last 2KB range fetch)
- Checks recent GitHub Actions failures across all three repos
- Thresholds: jobs_queued > 50, runner saturation, failed runs in last 4h
- Data source: https://github.com/shader-slang/slang-ci-analytics

### Scheduled Heartbeat
- Cron: `7 1,5,9,13,17,21 * * *` (every 4 hours at :07 UTC)
- Pre-check script fetches CI health + workflow failures (cheap, no agent cost)
- Always wakes the agent to also check Discord and post drafts
- Reports saved to `memory/latest-report.md` (latest) and `memory/heartbeat-log.md` (running history)
- Compares against previous runs to detect trends (persistent failures, aging questions, queue patterns)
- Task ID: `task-1776150548767-euafnj`

## MCP Tools (Allowed)

| Tool | Purpose |
|------|---------|
| `mcp__slang-mcp__github_list_issues` | List recent issues |
| `mcp__slang-mcp__github_get_issue` | Get issue details |
| `mcp__slang-mcp__github_search_issues` | Search issues by label/state |
| `mcp__slang-mcp__github_get_discussions` | Read GitHub Discussions |
| `mcp__slang-mcp__discord_read_messages` | Read Discord messages |
| `mcp__slang-mcp__discord_send_message` | Post to #slang-support-bot only |
| `mcp__deepwiki__ask_question` | Slang documentation lookup |

## Discord Configuration

**Server:** Shader Slang (Guild ID: `1303735196696445038`)

**Bot channel:** #slang-support-bot (`1494023079666647200`) — forum channel

**Write restrictions:**
- `DISCORD_ALLOWED_SEND_CHANNELS=` (empty — no text channel writes)
- `DISCORD_ALLOWED_SEND_FORUMS=1494023079666647200` (only #slang-support-bot)
- Enforced at MCP server level in `discord.py:send_message()`
- Forum posts: bot creates threads with combined draft answers
- Thread replies: bot responds to human feedback in existing threads

**Note:** Forum channel permissions must allow members to view threads and read message history without individual invites. Adjust in Discord server settings > #slang-support-bot > Permissions.

## MCP Server (slang-mcp)

**Env vars** (in `.env`, passed via `.env-vars`):
- `GITHUB_ACCESS_TOKEN` — GitHub PAT for issue/PR/Actions API
- `DISCORD_BOT_TOKEN` — Discord bot for reading channels and posting
- `DISCORD_ALLOWED_SEND_CHANNELS` — comma-separated channel IDs for text sends
- `DISCORD_ALLOWED_SEND_FORUMS` — comma-separated forum channel IDs for thread creation/replies

**Custom changes to slang-mcp:**
- `src/discord/discord.py`: Added message ID + URL to `filter_message_data()` output. Added channel allowlist enforcement and forum thread creation to `send_message()`.
- `src/server.py`: Exposed `discord_send_message` as MCP tool with `thread_name` parameter.
- `.env-vars`: Created with `GITHUB_ACCESS_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_SEND_CHANNELS`, `DISCORD_ALLOWED_SEND_FORUMS`.

## Infrastructure Fixes

### Duplicate Process Guard
- Added pidfile singleton in `src/index.ts` (`data/nanoclaw.pid`)
- Prevents multiple orchestrators from processing the same messages
- Pidfile cleaned at start of shutdown handler (not just on exit) to survive SIGKILL

### Container Prefix Isolation
- Added `CONTAINER_PREFIX=nc-jkiviluoto` to systemd service
- Prevents other NanoClaw instances on the same machine from killing our containers during their restart

### Dashboard Layout
- Fixed flex overflow: body is flex column, tab content uses `flex: 1; min-height: 0`
- Chat input visibility: added `min-height: 0` and `overflow: hidden` to `.cw-chat`
- Canvas scale-to-fit: office map scales down when canvas is smaller than 1008x576
- Removed custom CSS zoom (was breaking layout); use browser Ctrl+/- instead
- Converted all font sizes to rem units (`font-size: 16px` on `:root`) for scalability
- Responsive breakpoints at 800px and 600px for narrow viewports

## Files

| File | Purpose |
|------|---------|
| `groups/slang_maintainer/CLAUDE.md` | Coworker instructions (static, edit directly) |
| `groups/slang_maintainer/memory/latest-report.md` | Most recent heartbeat report |
| `groups/slang_maintainer/memory/heartbeat-log.md` | Running history of all heartbeats |
| `container/mcp-servers/slang-mcp/.env-vars` | Token names passed to MCP server |
| `container/mcp-servers/slang-mcp/src/discord/discord.py` | Discord API with allowlist + forum support |
| `container/mcp-servers/slang-mcp/src/server.py` | MCP tool registration |
| `dashboard/public/index.html` | Dashboard CSS (rem fonts, layout fixes) |
| `dashboard/public/app.js` | Canvas scale-to-fit, zoom removal |
| `src/index.ts` | Pidfile singleton guard |

## Manual Commands

```bash
# Check heartbeat status
node -e "const db=require('better-sqlite3')('store/messages.db');console.log(db.prepare('SELECT status,last_run,next_run FROM scheduled_tasks').get())"

# Check run history
node -e "const db=require('better-sqlite3')('store/messages.db');console.log(JSON.stringify(db.prepare('SELECT run_at,status,duration_ms FROM task_run_logs ORDER BY run_at DESC LIMIT 5').all(),null,2))"

# Read latest report
cat groups/slang_maintainer/memory/latest-report.md

# Restart service
systemctl --user restart nanoclaw-jkiviluoto

# Check MCP tools
curl -s http://localhost:8810/tools
```
