Generate a daily report draft for the Slang project. The report should be concise but comprehensive.

IMPORTANT: Today's date is provided in the system context. Use it to compute "24 hours ago" as an ISO 8601 timestamp (e.g., if today is 2026-02-17, then since = "2026-02-16T00:00:00Z"). Double-check the year is correct.

---

## Data Collection Instructions

You MUST query ALL of the following data sources. Make parallel calls where possible.

### 1. GitHub (owner: "shader-slang", repo: "slang")

**Issues — fetch ALL from last 24 hours:**
- `github_list_issues` with state=OPEN, first=100, since=<24h ago ISO 8601>
  - If `hasNextPage` is true in the response, call again with `after=<endCursor>` and repeat until `hasNextPage` is false
- `github_list_issues` with state=CLOSED, first=100, since=<24h ago ISO 8601>
  - Same pagination logic

**Pull Requests — fetch recent activity:**
- `github_list_pull_requests` with state=open, per_page=30, sort=updated, direction=desc
- `github_list_pull_requests` with state=closed, per_page=30, sort=updated, direction=desc
- Additionally, use `github_search_issues` with q="repo:shader-slang/slang is:pr updated:>=YYYY-MM-DD" to catch any PRs missed by the list (replace YYYY-MM-DD with yesterday's date)

**Discussions:**
- `github_get_discussions` with owner=shader-slang, repo=slang, first=10

### 2. GitLab (project_id: "6417")

- `gitlab_list_issues` with project_id="6417", state=opened, per_page=20, order_by=updated_at
- `gitlab_list_merge_requests` with project_id="6417", state=opened, per_page=20, order_by=updated_at

### 3. Discord (7 channels — fetch ALL in parallel)

Call `discord_read_messages` with limit=50 for each configured Discord channel.

### 4. Slack

- `slack_get_channel_history` with the configured Slack channel_id, limit=100, since=<24h ago ISO 8601>

### 5. User ID Resolution

After collecting all data, gather all unique Slack user IDs found in messages.
- Resolve each via `slack_get_user_profile` — call them **sequentially** (not in parallel) to avoid rate limits
- The tool has built-in retry logic for rate limits, but spacing calls out helps

---

## Report Structure

### 1. Urgent Matters (limit to 3, prioritized):
   - 🚨 Critical issues requiring immediate attention
   - ⚠️ Blocking issues affecting team/development
   - 🔄 Time-sensitive updates/changes
   Include clear action items or owners when available

### 2. GitHub Activity (last 24 hours):
   - New issues opened: [number] with issue title and URL
   - Issues/PRs closed: [number] with title and URL
   - PRs requiring review: [number] with title and URL
   - Add 🚨 for high-priority items
   - Don't create tables, use only lists

### 3. GitLab Activity:
   - Open issues (notable/recent)
   - Open merge requests
   - Include links using GitLab base URL

### 4. Key Discussions (limit to 3 most impactful):
   - From Slack threads, Discord channels, and GitHub Discussions
   - Technical decisions/changes
   - Architecture discussions
   - Team process updates
   Include relevant context and next steps if any

### 5. Progress Updates:
   - Active Development:
     • Major features/changes in progress
     • Notable achievements/milestones
   - Infrastructure:
     • Build/CI status
     • Test results
     • System health indicators (nightly statuses from Slack)

### 6. Notes & Reminders:
   - Important announcements
   - Upcoming deadlines
   - Best practices/guidelines to follow

---

## Format Requirements
- Use clear hierarchical headings (##, ###)
- Use Unicode emoji characters (e.g. 🚨 ✅ ❌ ⚠️ 🔄), NOT Slack/GitHub shortcode style (e.g. :rotating_light: :white_check_mark:) — shortcodes only render on Slack/GitHub, not in markdown viewers or terminals
- Resolve user ids to names and email addresses when correlating identities across GitHub/Slack/etc.
- Include direct links to referenced items
- Keep tone professional but conversational
- Use bullet points for easy scanning
- Highlight action items or decisions needed
- Add timestamp of report generation

Only use full names and usernames which are present in the input data. If both are found, prefer full names.

Save the report as 'daily-report-YYYY-MM-DD.md'. Or if a report with that name exists, ask whether to update it accordingly.

---

## Completeness Checklist

Before saving the report, verify you queried:
- [ ] GitHub issues (open + closed, with pagination)
- [ ] GitHub PRs (open + closed)
- [ ] GitHub Discussions
- [ ] GitLab issues and merge requests (project 6417)
- [ ] All 7 Discord channels
- [ ] Slack channel history (with since filter)
- [ ] All Slack user IDs resolved to names

If any source failed or returned an error, note it in the report under "Data Collection Notes" at the bottom.
