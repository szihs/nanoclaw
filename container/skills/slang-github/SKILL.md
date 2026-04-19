---
name: slang-github
description: "Interact with GitHub for shader-slang/slang. Trigger when given an issue number, PR number, or when a completed fix needs a PR. Fetches issues/PRs, reviews diffs, creates PRs. Keywords: issue, PR, review, github, fetch, create PR, gh."
provides: [vcs-read, vcs-write, vcs-pr, issue-tracker, ci-rerun]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob, mcp__slang-mcp__github_get_issue, mcp__slang-mcp__github_get_pull_request, mcp__slang-mcp__github_get_pull_request_comments, mcp__slang-mcp__github_get_pull_request_reviews
argument-hint: "[issue or PR number, e.g. 10650 or #10650]"
---

# Slang GitHub

Fetch issues, review PRs, and submit changes for shader-slang/slang.

## Context

- Slang repo: !`ls /workspace/group/slang/.git 2>/dev/null && echo "CLONED" || echo "NOT CLONED — run /slang-build first"`
- Branch: !`cd /workspace/group/slang 2>/dev/null && git branch --show-current || echo "N/A"`
- gh auth: !`gh auth status 2>&1 | head -2`

## Prerequisites

- `/slang-build` — clone and build the repo
- `/slang-explore` — investigate code paths
- `/slang-fix` — implement changes

## Workflow

### 1. Fetch Issue or PR

**Issue:**
```bash
gh issue view <NUMBER> --json title,body,comments,labels,assignees -R shader-slang/slang
```

**PR:**
```bash
gh pr view <NUMBER> --json title,body,comments,reviews,files,labels,headRefName -R shader-slang/slang
gh pr diff <NUMBER> -R shader-slang/slang
# Inline review comments (human + bot)
gh api repos/shader-slang/slang/pulls/<NUMBER>/comments --paginate | head -200
```

### 2. Investigate

Use `/slang-explore` to trace the relevant code paths. Read comments carefully for reproduction steps, reviewer feedback, and maintainer context.

### 3. Implement

Use `/slang-fix` to create a branch, implement the change, write tests, and commit.

### 4. Create PR

```bash
cd /workspace/group/slang
git push origin HEAD
gh pr create \
  --title "Fix #<NUMBER>: <concise title>" \
  --body "$(cat <<'PREOF'
## Summary
Fixes #<NUMBER>.

<1-2 sentences explaining root cause and fix>

## Changes
- <what changed and why>

## Testing
- Added regression test `tests/bugs/issue-<NUMBER>.slang`
- Ran existing test suite — no regressions

pr: non-breaking
PREOF
)" -R shader-slang/slang
```

### 5. Share

Share the root cause as a learning via the `append_learning` MCP tool so other coworkers benefit.

## Gotchas

- **`gh` auth in containers**: May not be authenticated in a fresh container. Error "could not determine base repo" means auth is missing — check `gh auth status`
- **Push before PR**: `gh pr create` requires the branch to be pushed first. `git push origin HEAD` will fail if no upstream fork is configured
- **CLA required**: shader-slang/slang requires CLA signing for external contributors. PRs from unrecognized accounts may be blocked
- **`--paginate` fetches all**: `gh api --paginate | head -200` still fetches ALL pages before truncating. For large PRs, use `--per-page 50` to limit
- **PR title convention**: Must start with `Fix #<N>:` for GitHub auto-linking to work

## Related Skills

- `/slang-build` — clone, build, run tests
- `/slang-explore` — investigate code paths (read-only)
- `/slang-fix` — implement changes, write tests, commit
- `/slang-maintain-release-report` — for release-related PR workflows
