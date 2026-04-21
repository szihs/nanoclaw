---
name: slang-fix
type: workflow
description: "Turn a triaged Slang compiler issue into a reproducing test, a minimal fix, and a PR-ready branch. Use after `/slang-triage` has produced a report with `status: ready-for-fix`. Specialization of `/base-fix` with Slang build + test conventions."
extends: base-fix
requires: [code-read, code-edit, test-run, vcs-pr]
overrides:
  reproduce: "Extract the failing case into `tests/bugs/issue-{{issueNumber}}.slang` (or the category directory implied by triage's subsystem mapping). Commit the failing test first so CI can show the delta."
  patch: "Use `/slang-patch` to implement the minimum change. Keep the patch inside one subsystem when possible. If the cause spans subsystems, stop and re-triage."
  validate: "Rebuild with `/slang-build`, then run `./build/Debug/bin/slang-test tests/bugs/issue-{{issueNumber}}.slang` and `./extras/formatting.sh`. Run the wider affected test category (e.g. `tests/compute/`) and confirm no regressions."
uses:
  skills: [slang-build, slang-explore, slang-github, slang-patch]
  workflows: [base-fix]
params:
  issueNumber: { type: integer, required: true }
  repo: { type: string, default: "shader-slang/slang" }
  branch: { type: string, required: false, description: "Branch name; default: slang/fix-issue<N>" }
produces:
  - fix_log: { path: "/workspace/group/fixes/issue-{{issueNumber}}.md" }
  - patch:   { path: "git commit on {{branch}}" }
---

# Slang Fix

Project-specific specialization of `/base-fix` for the Slang compiler.

## Steps

1. **Run base fix** — invoke `/base-fix target={{repo}}#{{issueNumber}}`. Use its shape (reproduce → root-cause → patch → validate → commit).

2. **Load triage** — read `/workspace/group/reports/issue-{{issueNumber}}.md`. Do not proceed if it is missing or `status != ready-for-fix` — run `/slang-triage` first.

3. **Ensure build** — `/slang-build` must succeed with the default preset before you begin. Without a working build, you cannot confirm the repro.

4. **Reproduce** — extract the failing case into `tests/bugs/issue-{{issueNumber}}.slang` (or the category directory implied by the triage's subsystem mapping). Commit the failing test first so CI can show the delta.

5. **Patch** — use `/slang-patch` to implement the minimum change. Keep the patch inside one subsystem when possible. If the cause spans subsystems, stop and re-triage.

6. **Validate** — rebuild with `/slang-build`, then:

   ```bash
   ./build/Debug/bin/slang-test tests/bugs/issue-{{issueNumber}}.slang
   ./extras/formatting.sh
   ```

   Run the wider affected test category (e.g. `tests/compute/`) and confirm no regressions.

7. **Commit + PR** — use `/slang-github` to push and open a PR. Title format: `Fix #{{issueNumber}}: <concise summary>`. Body must summarize root cause, patch, and test coverage.

## Slang-specific invariants

- Never delete or silence a `tests/` file. Tests are the contract.
- `include/slang.h` and `.meta.slang` files are stable surface — changes there require maintainer sign-off in the PR.
- `-DSLANG_ENABLE_TESTS=ON` must remain in the build; without it the test targets disappear.
