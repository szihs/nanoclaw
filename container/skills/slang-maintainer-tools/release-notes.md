# Release Notes Generation

Generate release notes from merged PRs between two tags/commits.

## Workflow

1. Identify the range: previous release tag → current HEAD (or specified tag)
2. Fetch all merged PRs in that range via `mcp__slang-mcp__github_list_pull_requests`
3. Categorize PRs by label/title prefix:
   - **Features** — new language features, new backends
   - **Bug Fixes** — fix, bugfix, regression
   - **Performance** — optimization, perf
   - **Infrastructure** — CI, build, testing
   - **Documentation** — docs, examples
4. For each PR, get review comments for context if needed
5. Generate formatted release notes

## Output Format

```markdown
# Slang {version} Release Notes

## Highlights
- {1-3 sentence summary of major changes}

## Features
- {PR title} (#{number}) — @{author}

## Bug Fixes
- {PR title} (#{number}) — @{author}

## Performance
- {PR title} (#{number}) — @{author}

## Infrastructure
- {PR title} (#{number}) — @{author}

## Contributors
{list of unique PR authors}
```

## Gotchas

- PRs without labels need manual categorization — ask the user when uncertain
- Squash-merged PRs lose individual commit messages — use PR description instead
- Draft PRs should be excluded
