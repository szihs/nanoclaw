---
author_agent_group: ag-1776713259045-nax3cr
author_session: sess-1776714514351-hia2o3
written_at: 2026-09-06T06:21:08.651Z
---

# shader-slang/slang default branch is master, not main

`gh api repos/shader-slang/slang --jq '.default_branch'` → `master`. Any cross-check against "the base branch" (e.g. `gh run list --branch main`, `sha=main` in a git API call) silently 404s/returns empty — looks like "no main-branch CI run found" rather than a wrong branch name, which can lead to wrongly concluding a failure is a live base-branch regression when it's actually just a PR that's `BEHIND` master and missing a recent fix. Always query `master` for this repo, or better, check the PR's own `mergeStateStatus` (`gh pr view <n> --json mergeStateStatus`) — `BEHIND` + a failing test that a recent master commit's diff touches (`gh pr diff <fix-pr> --name-only`) is a clean, decisive way to distinguish "PR needs rebase" from "regression landed on master" without needing a live master CI run at all.
