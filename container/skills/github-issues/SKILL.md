---
name: github-issues
description: Read, create, comment on, and manage GitHub issues and PRs using the gh CLI. Use when working with bug reports, feature requests, code reviews, or pull requests.
allowed-tools: Bash(gh:*)
---

# GitHub Issues & PRs with gh CLI

## Setup

The `gh` CLI is pre-installed and authenticated via `GH_TOKEN` environment variable.

Default repository: `shader-slang/slang`

## Issues

### List issues
```bash
gh issue list -R shader-slang/slang --limit 20
gh issue list -R shader-slang/slang --label "bug" --state open
gh issue list -R shader-slang/slang --assignee "@me"
gh issue list -R shader-slang/slang --search "keyword in:title,body"
```

### View issue details
```bash
gh issue view 1234 -R shader-slang/slang
gh issue view 1234 -R shader-slang/slang --comments
```

### Create issue
```bash
gh issue create -R shader-slang/slang \
  --title "Brief description" \
  --body "Detailed description with reproduction steps" \
  --label "bug"
```

### Comment on issue
```bash
gh issue comment 1234 -R shader-slang/slang --body "Analysis: ..."
```

### Search issues
```bash
gh search issues --repo shader-slang/slang "SPIRV codegen" --limit 10
gh search issues --repo shader-slang/slang --label "good first issue"
```

## Pull Requests

### List PRs
```bash
gh pr list -R shader-slang/slang --state open
gh pr list -R shader-slang/slang --author "username"
```

### View PR
```bash
gh pr view 5678 -R shader-slang/slang
gh pr diff 5678 -R shader-slang/slang
gh pr checks 5678 -R shader-slang/slang
```

### Create PR
```bash
gh pr create -R shader-slang/slang \
  --title "Fix: brief description" \
  --body "## Summary\n- What changed\n\n## Test plan\n- How to verify"
```

### Review PR
```bash
gh pr review 5678 -R shader-slang/slang --comment --body "Review notes..."
gh pr review 5678 -R shader-slang/slang --approve
gh pr review 5678 -R shader-slang/slang --request-changes --body "Please fix..."
```

## Releases & Tags

```bash
gh release list -R shader-slang/slang --limit 5
gh release view v2024.1.0 -R shader-slang/slang
```

## Best Practices

- Always include context when commenting (file paths, line numbers, reproduction steps)
- Link related issues: "Related to #1234"
- Use labels for categorization
- When creating issues from investigations, include the full pipeline trace
- Reference specific commits with their SHA
