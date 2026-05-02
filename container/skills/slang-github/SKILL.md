---
name: slang-github
description: "GitHub operations for the Slang compiler. Clone, branch, PR, issues, CI."
provides: [repo.read, repo.write, repo.pr, issues.read, issues.write, ci.rerun]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob
---

## From project

Drawn from: `repos/slang/CLAUDE.md` (PR workflow), `repos/slang/CONTRIBUTING.md` (contribution process, fork model, code review, labeling).

## Repository

- **URL:** https://github.com/shader-slang/slang
- **Clone:** `git clone --recursive --tags https://github.com/shader-slang/slang.git`
- **Discussions:** https://github.com/shader-slang/slang/discussions
- **Discord:** https://khr.io/slangdiscord

## Clone with tags

Tags are required for the build system. After cloning, add upstream and fetch tags:

```bash
git remote add upstream https://github.com/shader-slang/slang.git
git fetch --tags upstream
git push --tags origin
```

## PR process

1. Fork -> clone -> branch (`feature/description`)
2. Implement, test, format (`./extras/formatting.sh`)
3. Push to fork, create PR against `shader-slang/slang:master`
4. Label: `pr: non-breaking` (default) or `pr: breaking` (ABI/language breaking)
5. PR requires review approval + all CI workflows passing
6. Squash merge -- rewrite final commit message to be descriptive

During review, push follow-up commits (do not rebase after PR creation). Sync with upstream via merge:

```bash
git fetch upstream master
git merge upstream/master
git submodule update --recursive
```

**Formatting bot**: Comment `/format` on the PR to auto-fix formatting via bot PR. Comment `/regenerate-toc` for user-guide table of contents.

## CI

Runs on self-hosted GPU runners (Windows, Linux, macOS). Key commands:

```bash
gh run list --repo shader-slang/slang --workflow=ci.yml --limit 5
gh run view <id> --log-failed
gh run rerun <id> --failed
```

## Issues

```bash
gh issue list --repo shader-slang/slang
gh issue view <number> --repo shader-slang/slang
gh issue create --repo shader-slang/slang --title "..." --body "..."
```

## GitHub API rate limits

CMake configure fetches from GitHub REST API. If rate-limited, pass `-DSLANG_GITHUB_TOKEN=<token>` to cmake.
