# Slang Maintainer — Updates 2026-04-17

Changes made after the initial setup documented in `MAINTAINER-SETUP.md`.

## Discord Write Access

### `discord_send_message` MCP Tool
- Wired up `send_message` and `SendMessageArgs` in `server.py` (import, dispatch, tool definition)
- Added `thread_name` parameter to `SendMessageArgs` for creating forum posts
- `send_message` now handles three channel types:
  - **Text channels** — direct `channel.send()`
  - **Threads** — reply in existing thread via `channel.send()`
  - **Forum channels** — creates a new thread via `channel.create_thread(name, content)`

### Channel Allowlist Enforcement
- `send_message` enforced via two env vars:
  - `DISCORD_ALLOWED_SEND_CHANNELS` — comma-separated text channel IDs (currently empty)
  - `DISCORD_ALLOWED_SEND_FORUMS` — comma-separated forum channel IDs (`1494023079666647200`)
- For threads: checks if parent forum is in the allowed list
- For forum channels: checks if forum ID is in the allowed list
- If neither env var is set, all sends are blocked

### Files Changed
- `container/mcp-servers/slang-mcp/src/discord/discord.py` — allowlist logic, forum thread creation, thread_name param
- `container/mcp-servers/slang-mcp/src/server.py` — registered `discord_send_message` tool
- `container/mcp-servers/slang-mcp/.env-vars` — added `DISCORD_ALLOWED_SEND_CHANNELS`, `DISCORD_ALLOWED_SEND_FORUMS`
- `.env` — set `DISCORD_ALLOWED_SEND_FORUMS=1494023079666647200`

## GitHub File Reading

### `github_get_file_contents` MCP Tool
- New read-only tool to browse directories and read files from GitHub repos
- Defaults to `shader-slang/slang`, supports `owner`, `repo`, `path`, `ref` params
- Returns file content (base64-decoded) or directory listing
- Coworker can now look up Slang source code to improve draft answer quality

### Files Changed
- `container/mcp-servers/slang-mcp/src/github/github.py` — added `GetFileContentsArgs` model and `get_file_contents` function
- `container/mcp-servers/slang-mcp/src/github/__init__.py` — exported new function and model
- `container/mcp-servers/slang-mcp/src/server.py` — registered `github_get_file_contents` tool

## Updated Coworker Allowed Tools

Added to `allowedMcpTools` in DB for `dashboard:slang-maintainer`:
- `mcp__slang-mcp__discord_send_message`
- `mcp__slang-mcp__github_get_file_contents`

Full list now: `github_list_issues`, `github_get_issue`, `github_search_issues`, `github_get_discussions`, `discord_read_messages`, `deepwiki__ask_question`, `discord_send_message`, `github_get_file_contents`

## Discord Workflow Update

Updated `groups/slang_maintainer/CLAUDE.md` Discord monitoring workflow:

1. **Read-only source channels** — explicitly marked as never-post
2. **Draft answers** — uses DeepWiki + GitHub file reading for quality
3. **Post combined drafts** — creates a single forum post in #slang-support-bot titled "Support Drafts — YYYY-MM-DD HH:MM UTC" with all questions and drafts
4. **Respond to feedback** — reads #slang-support-bot for human replies on existing threads, posts updated drafts

## Heartbeat Changes

### Frequency
- Changed from every 4 hours to every 30 minutes (`*/30 * * * *`)
- Tested at 15-minute intervals before settling on 30

### Prompt Updated
- Added #slang-support-bot forum (`1494023079666647200`) reading to heartbeat
- Coworker now checks for new human threads and feedback on every heartbeat run
- Replies to new threads and posts combined drafts for new unanswered questions

### `next_run` Recomputation
- Learned that changing `schedule_value` in DB doesn't recompute `next_run` automatically
- Must also update `next_run` using `CronExpressionParser` when changing cron

## Infrastructure Issues Encountered

### OneCLI Auth Failures
- Containers failed with "Not logged in — Please run /login" due to OneCLI gateway losing auth state
- Fixed by restarting OneCLI container (`docker restart onecli`) and NanoClaw service
- `applyContainerConfig` returning false was transient — resolved after gateway restart

### Container Prefix
- Added `CONTAINER_PREFIX=nc-jkiviluoto` to systemd service (done in previous session but relevant to today's debugging)
- Without it, other instances' shutdown handlers killed our containers

## Bot Channel Configuration

| Setting | Value |
|---------|-------|
| Channel | #slang-support-bot |
| Channel ID | `1494023079666647200` |
| Type | Forum channel |
| Bot permissions | Create threads, reply in threads |
| Human workflow | Review drafts in forum, reply with feedback |

**Note:** Forum channel permissions must allow members to view all threads and read message history without individual invites. Adjust in Discord server settings if new posts aren't visible to team members.
