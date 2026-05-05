# Slang Maintainer — Updates 2026-04-20 to 2026-04-21

Changes made after `MAINTAINER-UPDATES-2026-04-17.md`.

## Heartbeat Improvements

### Frequency and Conditional Wake
- Increased to every 10 minutes (`*/10 * * * *`)
- Pre-check script now checks Discord for new human messages via REST API (bot token in `memory/.discord-token`)
- Handles both text channels (direct message check) and forum channels (active thread scan)
- Only wakes the agent when new messages are found or CI queue exceeds threshold
- Saves last-check timestamp to `memory/.heartbeat-last-ts`
- Script uses `unset HTTP_PROXY HTTPS_PROXY SSL_CERT_FILE` to bypass OneCLI proxy for direct API calls

### Workflow Changes
- Heartbeat no longer posts draft messages to Discord
- Questions and draft answers saved locally to `memory/pending-questions.md` — queryable via coworker chat
- Heartbeat now reads #slang-support-bot forum for human-created threads and replies to them
- Feedback buttons (Resolved/Helpful/Not Helpful) attached to bot replies via `add_feedback_buttons: true`
- Corrections extracted from "Not Helpful" feedback into `memory/corrections.md`
- Agent reads `corrections.md` before drafting to avoid past mistakes

### Script Fix: OOM on health_snapshots.jsonl
- Changed from `curl | tail -1` (downloads full 1.2MB file) to `curl -r -2048` (fetches last 2KB only)
- Resolved exit code 137 (OOM killed) on heartbeat runs

## Discord Write Access

### `discord_send_message` MCP Tool
- Exposed in `server.py` with dispatch and tool schema
- Supports text channels, threads, and forum channels
- Forum channels: creates new thread via `channel.create_thread(name, content, view)`
- `thread_name` parameter for forum post titles
- `add_feedback_buttons` parameter attaches Resolved/Helpful/Not Helpful buttons

### Channel Allowlist
- `DISCORD_ALLOWED_SEND_CHANNELS` — comma-separated text channel IDs (currently empty)
- `DISCORD_ALLOWED_SEND_FORUMS` — comma-separated forum channel IDs (`1494023079666647200`)
- Enforcement in `send_message()`: checks direct match, thread parent, or forum ID
- If neither env var is set, all sends blocked

### FeedbackView (in discord.py)
- Persistent buttons with `custom_id` prefix `feedback:`
- Buttons disable after click, showing which was selected
- Registered on `on_ready` for persistence across restarts

## GitHub File Reading

### `github_get_file_contents` MCP Tool
- Read-only tool to browse directories and read files from GitHub repos
- Defaults to `shader-slang/slang`
- Parameters: `owner`, `repo`, `path`, `ref`
- Returns decoded file content or directory listing
- Added to coworker's `allowedMcpTools`

### Files Changed
- `container/mcp-servers/slang-mcp/src/github/github.py` — `GetFileContentsArgs` model + `get_file_contents` function
- `container/mcp-servers/slang-mcp/src/github/__init__.py` — exports
- `container/mcp-servers/slang-mcp/src/server.py` — tool registration

## Discord Feedback Collector

### Architecture
Standalone Python process running as a systemd service, separate from the MCP server. Clean security boundary — no MCP tools, no API access, no LLM. Only handles:
1. Button interaction callbacks (Resolved/Helpful/Not Helpful)
2. Passive capture of human replies in watched forum threads

### Why Separate
The MCP server's stdio transport (via supergateway + anyio) prevents discord.py's WebSocket gateway from processing real-time interactions. A dedicated process with its own event loop solves this cleanly.

### Button Behavior
- Only thread OP (creator) can click feedback buttons
- Non-OP gets ephemeral message: "Only the thread author can provide feedback"
- Buttons disable for everyone after OP clicks

### Data Storage
All written to `groups/slang_maintainer/memory/feedback/`:
- `feedback.jsonl` — button clicks: `{label, message_id, channel_id, user, timestamp}`
- `thread_replies.jsonl` — human messages: `{type, message_id, thread_id, thread_name, parent_id, user, content, timestamp}`

### Service
- Unit: `~/.config/systemd/user/nanoclaw-jkiviluoto-discord-buttons.service`
- Script: `container/mcp-servers/slang-mcp/src/discord/feedback_collector.py`
- Log: `logs/discord-feedback.log`
- Env: reads from `.env` via `EnvironmentFile`
- Watches forums listed in `DISCORD_WATCHED_FORUMS` (default: `1494023079666647200`)

### Files
- `container/mcp-servers/slang-mcp/src/discord/feedback_collector.py` — new file
- `~/.config/systemd/user/nanoclaw-jkiviluoto-discord-buttons.service` — new service

## Container Prefix Isolation

### Problem
All NanoClaw instances on the machine used `nanoclaw-` as container name prefix. When any instance restarted, its shutdown handler killed ALL instances' containers.

### Fix
- Added `CONTAINER_PREFIX=nc-jkiviluoto` to systemd service env
- `container-runner.ts`: container names use `${CONTAINER_PREFIX}-${name}-${timestamp}`
- `container-runtime.ts`: orphan cleanup filters by prefix
- `index.ts`: shutdown handler filters by prefix
- `config.ts`: exported `CONTAINER_PREFIX` constant

## Proxy Bypass for Container Scripts

### Problem
Container pre-check scripts couldn't call Discord/GitHub APIs — requests went through OneCLI MITM proxy which blocked them (403).

### Fix
- Added `discord.com`, `api.github.com`, `raw.githubusercontent.com` to `NO_PROXY`/`no_proxy` env vars in container-runner
- Script also does `unset HTTP_PROXY HTTPS_PROXY SSL_CERT_FILE` for Python urllib compatibility

## Pidfile Cleanup Fix

### Problem
`systemctl restart` sent SIGTERM but the async shutdown handler (docker stop, queue drain) could hang, causing systemd to SIGKILL without the exit handler running. Stale pidfile blocked restart.

### Fix
- `cleanPidfile()` called at the very start of the shutdown handler, before any async work

## Coworker CLAUDE.md Workflow

Updated `groups/slang_maintainer/CLAUDE.md` Discord monitoring to 6 steps:
1. Collect from source channels (read-only)
2. Draft answers locally (save to `pending-questions.md`, do NOT post)
3. Reply to human posts in #slang-support-bot (with feedback buttons)
4. Learn from feedback (extract corrections from "Not Helpful" + human replies)
5. Report summary

## Updated MCP Tool Allowlist

Full list for `dashboard:slang-maintainer`:
- `mcp__slang-mcp__github_list_issues`
- `mcp__slang-mcp__github_get_issue`
- `mcp__slang-mcp__github_search_issues`
- `mcp__slang-mcp__github_get_discussions`
- `mcp__slang-mcp__github_get_file_contents`
- `mcp__slang-mcp__discord_read_messages`
- `mcp__slang-mcp__discord_send_message`
- `mcp__deepwiki__ask_question`

## Manual Commands

```bash
# Check heartbeat status
node -e "const db=require('better-sqlite3')('store/messages.db');console.log(db.prepare('SELECT status,schedule_value,next_run,last_run FROM scheduled_tasks').get())"

# Check feedback
cat groups/slang_maintainer/memory/feedback/feedback.jsonl
cat groups/slang_maintainer/memory/feedback/thread_replies.jsonl

# Restart feedback collector
systemctl --user restart nanoclaw-jkiviluoto-discord-buttons

# Check feedback collector log
tail -f logs/discord-feedback.log

# Change heartbeat frequency
node -e "const {CronExpressionParser}=require('cron-parser');const db=require('better-sqlite3')('store/messages.db');const c='*/10 * * * *';db.prepare('UPDATE scheduled_tasks SET schedule_value=?,next_run=? WHERE id=?').run(c,CronExpressionParser.parse(c,{tz:'UTC'}).next().toISOString(),'task-1776150548767-euafnj')"
```
