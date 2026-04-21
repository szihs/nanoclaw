# Daily Report

Aggregates activity from GitHub, GitLab, Discord, and Slack into a structured summary.

## Data Sources

### GitHub (shader-slang/slang, shader-slang/slang-rhi, shader-slang/slangpy)
```
mcp__slang-mcp__github_list_pull_requests — merged PRs in time range
mcp__slang-mcp__github_list_issues — new/closed issues
mcp__slang-mcp__github_get_discussions — active discussions
```

Repos to scan (all three for each report):
| Repo | Focus |
|------|-------|
| `shader-slang/slang` | Main compiler — PRs, issues, discussions |
| `shader-slang/slang-rhi` | RHI layer — PRs, issues, CI |
| `shader-slang/slangpy` | Python bindings — PRs, issues, CI |

### GitLab (if configured)
```
mcp__slang-mcp__gitlab_list_merge_requests — nv-master MRs
mcp__slang-mcp__gitlab_list_issues — internal issues
```

### Discord
```
mcp__slang-mcp__discord_read_messages — fetch with limit, filter client-side to time range
```

Channel IDs:
| Channel ID | Name |
|------------|------|
| Channel ID | Name |
Configure Discord channel IDs in your group CLAUDE.md or `.env`.

### Slack
```
mcp__slang-mcp__slack_get_channel_history — recent messages
```

Channel IDs:
| Channel ID | Name |
|------------|------|
| Channel ID | Name |
Configure Slack channel IDs in your group CLAUDE.md or `.env`.

## Report Format

```
*Slang Daily Report — {date}*

*GitHub — shader-slang/slang*
• {n} PRs merged: {titles with PR numbers}
• {n} issues opened: {titles}
• {n} issues closed: {titles}
• Active discussions: {titles}

*GitHub — shader-slang/slang-rhi*
• {n} PRs merged / {n} issues updated

*GitHub — shader-slang/slangpy*
• {n} PRs merged / {n} issues updated

*Community (Discord/Slack)*
• Key questions: {summary}
• Bug reports: {summary}
• Unanswered threads: {count}

*GitLab (nv-master)*
• {n} MRs merged
• Sync status: {ahead/behind master}
```

## Workflow

1. Determine time range (default: last 24h)
2. Fetch GitHub PRs, issues, discussions via MCP tools
3. Fetch Discord/Slack messages via MCP tools
4. Fetch GitLab MRs if configured
5. Categorize and deduplicate
6. Generate formatted report
7. Send via `mcp__nanoclaw__send_message` or write to file
