---
name: slang-maintain-release-report
description: "Daily reports, release notes, SPIRV updates, GitLab rebase. Use when preparing releases or generating reports. Keywords: daily report, release, SPIRV, GitLab, MCP, changelog, nv-master."
argument-hint: "[task: daily-report|release-notes|update-spirv|update-gitlab|full-release] [time-range: 5m|24h|48h|7d|30d] [output: file|terminal|both]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - WebFetch
  - mcp__slang-mcp__github_get_issue
  - mcp__slang-mcp__github_list_issues
  - mcp__slang-mcp__github_search_issues
  - mcp__slang-mcp__github_list_pull_requests
  - mcp__slang-mcp__github_get_pull_request
  - mcp__slang-mcp__github_get_pull_request_comments
  - mcp__slang-mcp__github_get_pull_request_reviews
  - mcp__slang-mcp__github_get_discussions
  - mcp__slang-mcp__gitlab_list_issues
  - mcp__slang-mcp__gitlab_list_merge_requests
  - mcp__slang-mcp__gitlab_get_file_contents
  - mcp__slang-mcp__discord_read_messages
  - mcp__slang-mcp__slack_post_message
  - mcp__slang-mcp__slack_get_channel_history
  - mcp__slang-mcp__slack_reply_to_thread
  - mcp__slang-mcp__slack_get_user_profile
---

# Slang Maintainer Workflow

Automates Slang release maintainer tasks using the `slang-mcp` MCP server for all external data access (GitHub, GitLab, Discord, Slack).

## Tasks

| Task | Read | When to run |
|------|------|-------------|
| Daily report | daily-report.md | Daily or on-demand |
| Release notes | release-notes.md | Before a release |
| SPIRV submodule update | update-spirv.md | When spirv-tools/headers update |
| GitLab nv-master rebase | update-gitlab.md | After GitHub master advances |
| Full release | All of the above | Release day |

## Prerequisites

- `slang-mcp` MCP server configured and running
- GitHub token with read access to `shader-slang/slang`
- GitLab token for `nv-master` operations (if using update-gitlab)
- Discord bot token for community channel reads (if using daily-report)
- Slack token for Slack channel reads (if using daily-report)

## Gotchas

- **MCP server must be running** — if `mcp__slang-mcp__*` tools return errors, check that the slang-mcp server is configured in Claude Code settings
- **Rate limits** — GitHub API has 5000 req/hr for authenticated requests. Daily reports fetching many PRs/issues can hit this. Use time-range filters.
- **GitLab merge conflicts** — `update-gitlab` may encounter conflicts when nv-master diverges significantly. Always create a backup branch first.
- **Discord message limits** — Discord API returns max 100 messages per request. For channels with heavy traffic, multiple fetches needed.
- **Time ranges** — Always specify a time range. Without one, the report covers the last 24h by default.
