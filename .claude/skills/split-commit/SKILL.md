---
name: split-commit
description: Split branches that were built from merged states into clean, disjoint branches with zero file overlap and zero merge conflicts. Battle-tested workflow for NanoClaw nv-* branch topology. Triggers on "split this commit", "split branches", "clean up branches", "strip overlap", or when branches carry leaked files from other branches.
---

# Split Commit

Split branches that were built from merged states into clean, disjoint branches. Each branch owns a disjoint set of files. Merging all branches into the base produces zero conflicts.

**When to use:** A set of branches (e.g. `nv-main`, `nv-dashboard`, `nv-slang`, `nv-slangpy`, `nv-nanoclaw`) were created by squashing from a merged state. Each squash silently carries the full tree of every ancestor branch — not just its own files. This skill strips the leaked content so each branch carries only what it owns.

**Minimum scope example:** The NanoClaw `nv-*` branch topology — 6 branches all forked from `origin/main`, each a squash of 40-70 commits, with 100+ files of leaked overlap per branch. After splitting: zero file overlap, zero merge conflicts, each branch carries only its owned files (6 to 148 files each).

## Core invariants

1. **Single ownership.** Every changed file is owned by exactly one bucket. `comm -12` between any two buckets' file lists = empty.
2. **Zero merge conflicts.** Merging all buckets into the base in any order produces no conflicts.
3. **No phantom deletions.** No bucket deletes a file that exists in the base unless the deletion is the bucket's explicit purpose (e.g. removing legacy files to create a clean slate).
4. **Merge-verification tree is the truth.** After every bucket is stripped, merge them all into a fresh worktree. If it conflicts, the strip is wrong — fix the bucket, not the merge.
5. **Authorship preserved.** All commits retain original author/date via `--author`.
6. **PRs, not direct pushes.** Each cleaned bucket creates a PR for review before force-pushing.

## Phase 1: Gather

Ask the user for:

1. **Base branch** all buckets fork from (e.g. `origin/main`).
2. **Bucket list** — the branches to split. For each: name, current ref, intended purpose (one sentence).
3. **Merge order** — the order buckets should merge into the base (matters for the verification tree).
4. **Test command** (optional) — run per bucket after stripping.

Fetch all remotes so refs are current:

```bash
git fetch --all
```

Create a **merge-verification worktree** — this is the central proof tree used throughout:

```bash
git worktree add /tmp/split-merge-verify <base> -b merge-verify
```

## Phase 2: Analyze

For each bucket, compute:

### 2a. File inventory

```bash
git diff <base>..<bucket> --name-only | sort > /tmp/<bucket>-files.txt
```

### 2b. Overlap matrix

For every pair of buckets (A, B):

```bash
comm -12 /tmp/<bucket-A>-files.txt /tmp/<bucket-B>-files.txt
```

Any file appearing in two buckets is an overlap that must be resolved.

### 2c. Divergence check on overlapping files

For each overlapping file, check whether the two buckets have identical or different content:

```bash
diff <(git show <bucket-A>:<file>) <(git show <bucket-B>:<file>) > /dev/null 2>&1
```

- **Identical** → pure leak. Strip from whichever bucket doesn't own it.
- **Divergent** → one bucket has the base version, the other has additions. Diff to determine:
  - Does bucket-A ADD anything beyond bucket-B? Or is it just MISSING things bucket-B has (stale copy)?
  - If stale: strip entirely from the stale bucket.
  - If has unique additions: extract only the unique additions as a separate commit on that bucket. Strip the shared base portion.

Present the overlap matrix to the user. For each overlapping file, propose which bucket owns it. Get confirmation before proceeding.

### 2d. Name-based ownership (overrides path-prefix)

Path-prefix alone mis-routes project-scoped files that live in shared dirs. Before accepting the path-prefix classification, apply name-based overrides:

| Filename pattern | Route to |
|---|---|
| `src/**/*.slang.test.ts`, `src/**/*slang-*.test.ts`, `src/slang-*` | nv-slang |
| `src/**/*.slangpy.test.ts`, `src/**/*slangpy-*.test.ts`, `src/slangpy-*` | nv-slangpy |
| `src/**/*.nanoclaw.test.ts`, `src/**/*nanoclaw-*.test.ts`, `src/nanoclaw-*` | nv-nanoclaw |
| `src/**/*.dashboard.test.ts`, `src/**/*dashboard-*.test.ts`, `src/channels/dashboard.*` | nv-dashboard |
| everything else under `src/`, `container/agent-runner/`, `container/hooks/`, `container/overlays/`, `container/workflows/{plan,implement}/`, `container/spines/base/`, `setup/`, `scripts/`, `docs/` | nv-main |

**Why this matters**: `src/claude-composer-scenarios.slang.test.ts` is a test for slang-specific scenarios. Path-prefix sends it to `nv-main`, but `origin/nv-slang` ALSO carries it (with a stale pre-refactor copy). A split that routes updates to nv-main while leaving nv-slang's stale copy intact produces a silent regression: on the next `/update-nanoclaw-instance` merge, origin/nv-slang's stale version wins, reverting the update.

Rule of thumb: if the filename contains a project token (`slang`, `slangpy`, `nanoclaw`, `dashboard`), that token is the ownership signal — not the directory.

### 2e. Deletion audit

For each bucket, check what files it deletes from the base:

```bash
git diff <base>..<bucket> --diff-filter=D --name-only
```

**Critical:** Any file that exists in the base and is deleted by a bucket must be explicitly justified. The squash-from-merged-state pattern creates **phantom deletions** — when the original squash predates files that were later added to the base (e.g. `circuit-breaker.ts` added to main after the squash was created), rebasing creates a deletion that was never intended.

Flag every deletion. Ask the user: "Is this deletion intentional, or a phantom from the old base?"

## Phase 3: Strip

For each bucket (process one at a time, in merge order):

### 3a. Create a rebase worktree

```bash
git worktree add /tmp/split-rebase-<bucket> <bucket-ref>
cd /tmp/split-rebase-<bucket>
git checkout -b <bucket>-rebased
```

### 3b. Soft reset and selective restage

```bash
git reset --soft <base>
```

All changes are now staged. Unstage every file that doesn't belong to this bucket:

```bash
# Unstage files owned by other buckets
cat /tmp/<other-bucket-1>-files.txt /tmp/<other-bucket-2>-files.txt ... | sort -u | \
  xargs git reset HEAD --
```

Also unstage any file flagged as a phantom deletion in Phase 2e.

### 3c. Restore phantom deletions

For files that were incorrectly deleted (phantom deletions from Phase 2e):

```bash
git checkout <base> -- <file1> <file2> ...
```

### 3d. Recommit

```bash
git commit --author="<original-author>" -m "<original-message>"
```

### 3e. Discard unstaged leftovers

```bash
git checkout -- .
git clean -fd
```

### 3f. Verify staged file count

```bash
git diff <base>..<bucket>-rebased --stat | tail -3
```

Confirm the file count matches expectations (only this bucket's owned files).

### 3g. Check for remaining deletions

```bash
git diff <base>..<bucket>-rebased --diff-filter=D --name-only
```

Must be empty (or contain only intentional, user-approved deletions).

### 3h. Merge-verification tree checkpoint

After EVERY bucket is stripped, test on the verification tree:

```bash
cd /tmp/split-merge-verify
git reset --hard <base>
git merge <bucket-1-rebased> --no-edit   # for each bucket stripped so far
git merge <bucket-2-rebased> --no-edit
...
```

**Must be zero conflicts.** If a conflict appears, the strip was incomplete — go back to step 3b and remove the conflicting overlap.

### 3i. Run tests (if test command was provided)

```bash
cd /tmp/split-rebase-<bucket>
<test-command>
```

## Phase 4: Verify

After ALL buckets are stripped, run the final verification:

### 4a. Zero-overlap check

For every pair of stripped buckets:

```bash
comm -12 \
  <(git diff <base>..<bucket-A>-rebased --name-only | sort) \
  <(git diff <base>..<bucket-B>-rebased --name-only | sort)
```

Must be empty for every pair.

### 4b. Full merge-verification tree

```bash
cd /tmp/split-merge-verify
git reset --hard <base>
for bucket in <merge-order>; do
  git merge <bucket>-rebased --no-edit
done
```

Zero conflicts required. Report the merge result for each bucket (fast-forward / auto-merge / conflict).

### 4c. Zero-deletion check

For each bucket:

```bash
git diff <base>..<bucket>-rebased --diff-filter=D --name-only
```

Only intentional, user-approved deletions should remain.

## Phase 5: Audit

For each bucket, spawn a subagent to independently verify the diff:

```
Agent(subagent_type="general-purpose", prompt="
  Audit the rebased <bucket> branch.
  Run: git diff <base>..<bucket>-rebased --stat
  Then: git diff <base>..<bucket>-rebased
  
  This bucket should ONLY contain: <bucket-description>
  
  It should NOT contain:
  - Files belonging to <other-bucket-1>: <description>
  - Files belonging to <other-bucket-2>: <description>
  ...
  
  Report:
  1. Files that clearly belong to <bucket>
  2. Files that look suspicious / may belong to other buckets
  3. Any deletions of base files
  4. Verdict: clean or has leaks
")
```

**Challenge the status quo** for each bucket:
- Does this bucket modify any shared infrastructure file (index.ts, container-runner.ts, package.json, etc.)?
- If yes: does it ADD anything unique, or is it a stale copy of another bucket's version?
- If stale copy: strip it — the other bucket owns it.
- If has unique additions: extract only the additions. Confirm with the user.

If any audit finds issues, return to Phase 3 for that bucket.

## Phase 6: PR & Finalize

### 6a. Push and create PRs

For each bucket:

```bash
git push origin <bucket>-rebased
gh pr create \
  --base <bucket> \
  --head <bucket>-rebased \
  --title "chore: clean <bucket> branch — strip leaked overlap" \
  --body "$(cat <<'EOF'
## Summary
- Stripped files leaked from other branches (squash-from-merged-state artifact)
- <N> files owned by this bucket (was <M> before stripping)
- Zero overlap with all other buckets
- Zero merge conflicts in verification tree

## Verification
- Overlap matrix: zero shared files with any other bucket
- Merge tree: all buckets merge cleanly in order
- Deletion audit: no phantom deletions
- Subagent audit: clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 6b. Final summary

Report to the user:

| Bucket | Files | Overlap | Deletions | PR |
|--------|-------|---------|-----------|-----|

Plus:
- Merge-verification tree result (all zero conflicts)
- Worktree paths for each bucket
- PR URLs
- Next step: review PRs, then force-push to the target branches

## Recipes

### The soft-reset-and-restage pattern

This is the core operation. Instead of trying to surgically edit commits, we:

1. `git reset --soft <base>` — puts all changes in staging
2. `git reset HEAD -- <files-to-remove>` — unstages files that belong to other buckets
3. `git commit` — only the owned files are committed
4. `git checkout -- . && git clean -fd` — discard unstaged leftovers

This is idempotent and avoids all merge/rebase conflict resolution.

### Detecting stale copies vs unique additions

When a file appears in two buckets:

```bash
diff <(git show <bucket-A>:<file>) <(git show <bucket-B>:<file>)
```

- Empty diff → identical → pure leak, strip from the non-owner
- Non-empty diff → check which direction:
  - Bucket-A has MORE lines than bucket-B → A has additions, B is a subset
  - Bucket-A has FEWER lines → A is stale, B has the real version
  - Both add different things → file has genuine changes from both buckets, needs content-level split

### Catching phantom deletions

Files added to the base AFTER the original squash was created appear as deletions when rebasing. Always check:

```bash
git diff <base>..<bucket>-rebased --diff-filter=D --name-only
```

For each deletion, verify the file doesn't exist in the base:

```bash
git show <base>:<deleted-file> > /dev/null 2>&1 && echo "EXISTS — phantom deletion" || echo "OK — file was added by bucket"
```

Restore phantom deletions:

```bash
git checkout <base> -- <phantom-deleted-file>
git commit --amend --no-edit
```

### Moving a file between buckets

If the audit discovers a file in the wrong bucket:

1. Strip it from the wrong bucket: soft reset, unstage, recommit
2. Add it to the right bucket: cherry-pick or checkout from the old commit
3. Re-run merge verification

### Handling files owned by a bucket that also need a one-line addition from another

Example: `setup/service.ts` is owned by bucket-A, but bucket-B needs to add one line (`EnvironmentFile=...`).

Resolution: add bucket-B's line to bucket-A (the owner). Bucket-B should not touch the file at all. Single ownership is more important than perfect attribution.

## Anti-patterns

1. **Merging to get content.** Never `git merge --squash <source>` to populate a bucket — it brings the entire ancestor tree. Use `git reset --soft` + selective staging instead.

2. **Checking overlap only against other buckets' diffs.** Also check for deletions of base files. The overlap matrix catches files modified by multiple buckets, but misses files that exist in the base and are silently deleted by a squash.

3. **Skipping the merge-verification tree.** "It should work" is not verification. Merge the actual commits. Every time.

4. **Fixing merge conflicts in the verification tree.** Never hand-edit the merge tree. If it conflicts, the bucket is wrong — go back and fix the bucket.

5. **Assuming identical file names mean identical content.** Always `diff` overlapping files. A file can be in both buckets with different content — one has fixes the other lacks.

6. **Direct force-push without review.** Create PRs. The stripped branches may have lost content that was intentionally placed. PRs give a chance to catch this before the force-push destroys the old refs.

7. **Trusting path-prefix over filename for ownership.** `src/` routes to `nv-main` by default, but `src/claude-composer-scenarios.slang.test.ts` is a slang test. If a project token appears anywhere in the filename (`slang`, `slangpy`, `nanoclaw`, `dashboard`), the token is the ownership signal. See Phase 2d. Missing this rule causes silent regressions on the next `/update-nanoclaw-instance` cycle: the update's auto-resolver takes the stale project-branch copy over the correctly-routed nv-main update.
