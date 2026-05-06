# Maintainer Gotchas

Cross-cutting pitfalls that affect every `/slang-maintain` task. Read before your first sweep; re-skim if a task surfaces unexpected results.

## Rate limits

- **GitHub REST**: 5000 req/hr for authenticated calls. A wide time range with one request per label/author will exhaust this fast. Fetch once per repo and filter client-side.
- **GitHub GraphQL**: 5000 points/hr (different budget from REST). `list_issues` uses GraphQL under the hood.
- **Slack**: tier-dependent; `slack_get_user_profile` has built-in retry with backoff but issuing calls sequentially is still cheaper than parallel.
- **Discord**: 50 req/s per bot. Usually not a bottleneck, but chained `read_messages` pagination can trigger the global limit.

## Pagination

- **`github_list_issues`** — returns `hasNextPage` + `endCursor`. Loop with `after=<endCursor>` until `hasNextPage` is false. A single page caps at 100.
- **`discord_read_messages`** — max 100 per call. For busy channels, paginate backwards (`before=<last_message_id>`) until you cover the window.
- **`slack_get_channel_history`** — tier 3 rate class; `limit=100` per call; pass `since` to bound the window.

## Identity resolution

- Slack messages reference users by ID (`U01ABC…`). Resolve to human names with `slack_get_user_profile` **sequentially**, not in parallel, to avoid burst limits.
- Correlate GitHub login ↔ Slack name ↔ Discord name only when both sides are present in the input. Never invent mappings.
- Prefer full names over handles when both are available.

## Data quirks

- **Squash-merged PRs** lose their per-commit messages. Use the PR description (not commit log) for release notes.
- **Draft PRs** are excluded from release-notes and daily-report. Confirm via `pr.draft == false` if the MCP layer hasn't already filtered.
- **PRs without labels** need manual categorization in release-notes — ask the user when uncertain, don't guess.
- **Issues with no `priority` field** fall through the ProjectV2 priority extractor. Treat as `P3` / unknown in issue-prioritization.

## Configuration

- **Channel IDs** for Discord and Slack are per-group, not hardcoded. Configure via the group's `CLAUDE.md` or `.env`. A recipe that references channel IDs inline is stale.
- **GitLab project ID** is installation-specific (e.g. `6417` for NVIDIA's nv-master). Parameterize, don't hardcode across installs.
- **Default owner/repo** for GitHub tools defaults to `shader-slang/slang`. Override in `Args` when sweeping `slang-rhi` or `slangpy`.

## Output hygiene

- Use Unicode emoji (🚨 ⚠️ ✅), not Slack/GitHub shortcodes (`:rotating_light:`, `:white_check_mark:`) — shortcodes don't render in terminal or markdown viewers.
- Always include timestamps (`YYYY-MM-DD` or ISO 8601) on reports; a report without one is useless a week later.
- Cite direct URLs; don't just say "see PR 1234" — link it.
- If a data source failed (MCP error, rate-limit), note it under a "Data Collection Notes" section at the bottom of the report. Silent partial reports mislead readers.

## When to escalate to `/plan` or `/slang-implement`

- The sweep surfaces a bug or regression → `/plan` to diagnose, then `/slang-implement` to fix.
- The sweep surfaces a stale PR / abandoned MR → escalate to the user; don't auto-close.
- The sweep surfaces a git ops need (SPIRV submodule update, GitLab rebase) → those are WRITE operations; out of scope for `/slang-maintain`. Raise a task for a writer coworker.
