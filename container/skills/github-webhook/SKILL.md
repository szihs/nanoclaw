---
name: github-webhook
description: "Handle @nv-slang-bot PR mention webhooks: resolve branch, route to coworker, acknowledge and reply on GitHub."
provides: [github.webhook.routing]
allowed-tools: Bash(gh:*)
---

# GitHub webhook routing

Use this skill when you receive a `kind: webhook` message with `content.event: "github.pr_mention"`.

## Full routing flow

### 1. Parse the incoming message

```json
{
  "event": "github.pr_mention",
  "repo": "shader-slang/slang",
  "issue_number": 1234,
  "is_pr": true,
  "comment_id": 9876543,
  "comment_url": "https://github.com/shader-slang/slang/pull/1234#issuecomment-9876543",
  "commenter": "some-user",
  "body": "@nv-slang-bot please fix the validation error in this PR"
}
```

Extract the task text: everything in `body` after the bot mention (`@nv-slang-bot`).

### 2. Resolve branch (PRs only)

```bash
BRANCH=$(gh api repos/{repo}/pulls/{issue_number} --jq '.head.ref')
# e.g. "dev/slang/fix-validation-error"
```

Match against `dev/<folder>/` — the folder is the coworker group name.

If the API call fails or `is_pr` is false, skip to step 4 (handle directly).

### 3. Forward to coworker

Use a `<message to="<coworker-name>">` block addressed to the coworker whose folder matches the branch prefix.

Message format:
```
<message to="{coworker-name}">
GitHub PR mention from @{commenter} on {repo}#{issue_number}:

{task text}

Context:
- PR/Issue: {comment_url}
- Repo: {repo}
- Branch: {branch}

Reply directly on GitHub when done (use: gh api repos/{repo}/issues/{issue_number}/comments --method POST --field body="...")
</message>
```

### 4. Acknowledge on GitHub

Post a brief acknowledgement immediately so the requester isn't left waiting:

```bash
# Routing to coworker
gh api repos/{repo}/issues/{issue_number}/comments \
  --method POST \
  --field body="👋 @{commenter} — routing to the coworker who owns \`{branch}\`. They'll follow up here."

# Handling directly (no coworker match)
gh api repos/{repo}/issues/{issue_number}/comments \
  --method POST \
  --field body="👋 @{commenter} — on it. I'll reply here when done."
```

### 5. If handling directly

Perform the requested task (read the PR diff, review code, answer question, etc.) and post the result:

```bash
gh api repos/{repo}/issues/{issue_number}/comments \
  --method POST \
  --field body="{result}"
```
