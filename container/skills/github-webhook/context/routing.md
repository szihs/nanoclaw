## GitHub webhook messages

When you receive a message with `kind: webhook` and `content.event: "github.pr_mention"`, a GitHub user has mentioned `@nv-slang-bot` in a PR or issue comment.

### Routing procedure

1. **Extract fields** from the message content:
   - `repo` — e.g. `shader-slang/slang`
   - `issue_number` — PR/issue number
   - `commenter` — GitHub login of the commenter
   - `body` — the comment text (everything after the bot mention is the request)
   - `comment_url` — direct link to the comment

2. **Resolve the PR branch** (only when `is_pr: true`):
   ```bash
   gh api repos/{repo}/pulls/{issue_number} --jq '.head.ref'
   ```
   Branch convention: `dev/<coworker-folder>/...` routes to that coworker.
   If no match or not a PR, handle the request yourself.

3. **Forward to the coworker** (if branch matches):
   Use a `<message to="<coworker-name>">` block to deliver the request to the coworker whose folder matches the `dev/<folder>/` prefix. Include the original comment body, repo, PR number, and comment URL so the coworker has full context.

4. **Acknowledge on GitHub** with a brief comment so the requester knows the task was received:
   ```bash
   gh api repos/{repo}/issues/{issue_number}/comments \
     --method POST \
     --field body="👋 Routing to the coworker who owns this branch — they'll follow up here."
   ```
   If you're handling it directly (no coworker match), acknowledge and proceed with the task.

5. **On completion**, post the result as a GitHub comment on the original issue/PR.
