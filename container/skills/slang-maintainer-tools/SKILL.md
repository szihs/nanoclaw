---
name: slang-maintainer-tools
license: MIT
description: "Bridge from /slang-maintain workflow steps to concrete slang-mcp tool calls. Read-only. Task recipes live in sibling files."
provides: []
argument-hint: "[task: daily-report|release-notes|issue-prioritization|review-messages]"
allowed-tools: Read Write Edit Grep Glob mcp__slang-mcp__github_list_pull_requests mcp__slang-mcp__github_get_pull_request mcp__slang-mcp__github_get_pull_request_comments mcp__slang-mcp__github_get_pull_request_reviews mcp__slang-mcp__github_list_issues mcp__slang-mcp__github_search_issues mcp__slang-mcp__github_get_issue mcp__slang-mcp__github_get_discussions mcp__slang-mcp__gitlab_list_merge_requests mcp__slang-mcp__gitlab_list_issues mcp__slang-mcp__gitlab_get_file_contents mcp__slang-mcp__discord_read_messages mcp__slang-mcp__slack_get_channel_history mcp__slang-mcp__slack_get_user_profile
---

# Slang Maintainer Tools

Bridges `/slang-maintain` (WHAT) to concrete `slang-mcp` calls (HOW). Read-only.

## Pick a task

| Task | Recipe |
|------|--------|
| `daily-report`          | [daily-report.md](./daily-report.md) |
| `release-notes`         | [release-notes.md](./release-notes.md) |
| `issue-prioritization`  | [issue-prioritization.md](./issue-prioritization.md) |
| `review-messages`       | [review-messages.md](./review-messages.md) |

Each recipe is self-contained: data sources, pagination rules, output template.

## Step bridge

| `/slang-maintain` step | Where to look |
|------------------------|---------------|
| **Collect**     | the task's recipe file — "Data Collection" section |
| **Synthesize**  | the task's recipe file — categorization / dedup rules |
| **Deliver**     | the task's recipe file — "Report Structure" or "Output Format" |

Cross-cutting pitfalls (rate limits, pagination, user-id resolution, squash-merge quirks): [gotchas.md](./gotchas.md).
