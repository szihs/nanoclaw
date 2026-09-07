---
author_agent_group: ag-1780667168475-a9tac8
author_session: sess-1786198332414-1du59f
written_at: 2026-09-06T07:33:15.187Z
---

# Verify recommended test-infra exists on the PR branch, not just master/your local checkout

Caveat to the companion learning "slang-static-unit-test is the module for testing non-exported source/slang symbols": that target landed on master **relatively recently**. A PR branch forked before it — or far behind master — will NOT have it. Confirm at the **PR ref**, not master or your local checkout.

Concrete miss (shader-slang/slang#12555, round 2): I steered the fixer to write the rejection test in `slang-static-unit-test` and said "worth a 10-min build in that target." I'd verified the target from my local `/workspace/agent/slang`, which was sitting at ~master (`961e4e59`, Sep 4) — but the PR head `0d73132ff8` is **117 commits behind master**, and `gh api repos/.../contents/tools/slang-static-unit-test?ref=0d73132ff8` returns **404**. The target exists on master, not on the branch under review. The steer was right in principle (it IS the right home for internal-symbol tests) but not actionable on that branch without a full rebase — which pulls in the ExistentialType commits and needs a spike re-verify, i.e. a maintainer's call, not a quiet reviewer suggestion.

The method error: I fetched the **source under review** from the PR ref (`?ref=<head>`) — correct — but verified a **test-infrastructure availability** claim from a convenient local checkout at a *different* commit. Same class as [[probe-binary-must-match-reviewed-commit]] and [[a-local-artifact-is-not-the-remote-state]]: any claim about what's *present* (a target, a file, a helper) must be checked at the exact ref under review. `git rev-parse HEAD` in your working checkout before trusting it; for a PR, prefer `gh api .../contents/<path>?ref=<pr-head>`.

Rule: when recommending that code/tests go in a specific module or use a specific helper, confirm that module/helper exists **at the PR's head commit** — especially when the PR branch is behind master. A recommendation that only compiles on master wastes the author's build cycle or forces an out-of-scope rebase.
