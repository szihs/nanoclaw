---
name: split-commit
description: Split a mixed-concerns commit on the current repo into one branch per concern. Interactive — prompts for the split plan, creates per-bucket worktrees, commits neutral + specialized content separately, runs tests per branch, and verifies that merging all branches reproduces the source commit. Triggers on "split this commit", "split commit into branches", "carve apart commit", or when the user describes a commit that couples multiple independent concerns they want in separate PRs.
---

# Split Commit

Carve a commit that touches multiple concerns into one branch per concern. Use when a single change couples independent subsystems and needs to be re-shaped for reviewability or selective adoption (e.g. splitting a combined "feature + project integration" commit into a neutral infra branch and one branch per integration).

Runs from the host — drives `git worktree`, local filesystem edits, and the project's test command.

## Invariants

- Tests pass per bucket branch before that branch is declared done.
- Merging all bucket branches (in order) into the base produces a tree **diff-equal** to the source. `git diff <merged> <source>` = empty is the acceptance gate.
- Source commit and its branch are never modified. All work happens in new worktrees on new branches.
- Mixed files are split at the content level, not dropped into a single bucket.
- Never run destructive git operations (`reset --hard`, `push --force`, `branch -D` of anything other than the verify branch) without asking the user first.
- When a classification call is ambiguous, ask the user — do not guess.

## UX Note

Use `AskUserQuestion` only for multiple-choice prompts (bucket selection for a mixed file, choosing a base branch from a list). For free-text input (commit SHAs, bucket names, marker patterns) ask in plain text and wait for the user's reply.

## 1. Gather the split plan

### 1a. Ask for the basics

Ask the user for:

1. **Source commit** to split (default: `HEAD`). Free-text.
2. **Base branch** the buckets diverge from (default: `main`). Free-text.
3. **Test command** per branch. Default: read `scripts.test` from `package.json`; if absent, ask.

### 1b. Auto-detect candidate projects / buckets

Before asking the user to enumerate buckets, scan the source commit for evidence of distinct concerns. Propose the bucket list; the user confirms or edits it. This keeps the common case low-friction — the user rarely has to hand-type project names.

Signals to use (stop at the first strong signal; fall back to weaker ones if needed):

1. **Top-level directory names** introduced or modified in the commit, especially under `container/skills/`, `projects/`, `groups/templates/projects/`, or equivalent. Each distinct top-level directory name is a candidate project marker.
2. **File-naming prefixes / suffixes** in added or modified files (e.g. `<name>-*.ts`, `*-<name>-adapter.*`). Cluster these and treat each cluster as a candidate bucket.
3. **Identifier / import hotspots** in the diff — run `git diff <source>^ <source> | grep -E 'from .*\b<name>\b'` across the vocabulary pulled from signals 1 and 2, counting hits per name. Names with many hits are confirmed; single-hit names are probably cosmetic.
4. **Frontmatter / config keys** in added YAML (e.g. `coworker-types.yaml`, `project: <name>`). The `project:` key is authoritative when present.

Produce a candidate bucket list:

- Exactly one `neutral` bucket. Default-name it from the commit (e.g. the commit's topic prefix + `-base`, or `<base-branch>-base` if the commit has no clear topic). Do not use the literal name of any detected project.
- One `specialized` bucket per distinct project signal, named after the signal. The marker patterns are pre-filled with the signals used to detect that project.

### 1c. Confirm the proposed buckets

Present the proposed list to the user, each bucket showing:

- Proposed name
- Role (neutral / specialized)
- Auto-detected marker patterns
- Example files from the source commit that matched

Use `AskUserQuestion` per bucket to accept / rename / drop, and offer a free-text follow-up to add buckets the detector missed. Also ask whether any specialized bucket depends on another (default: each specialized bucket depends only on the neutral bucket).

Echo the final plan back as a table. Wait for explicit confirmation before any filesystem changes.

## 2. Inventory the source

```bash
git diff --name-status <source>^ <source>
```

First-pass classify each file into one of:

- **pure-neutral** — no bucket-specific references
- **pure-<bucket>** — entire file is specific to one bucket (filename, imports, stated purpose)
- **mixed** — spans multiple buckets; needs content-level splitting

For mixed files, flag whether the bucket references are:

- **structural** — imports, code paths, env-gated branches, real dependencies → must split out
- **cosmetic** — mock fixture names, doc examples, comment labels → can stay in neutral

Write the classification to `/tmp/split-plan-<source-short-sha>.md` so later steps can re-read without recomputing.

## 3. Confirm the classification

Show the user the bucketed inventory. For every `mixed` file and every ambiguous case, present the judgment with surrounding context and `AskUserQuestion` for the final bucket assignment. Rewrite the plan file with the user's answers.

## 4. Create the neutral worktree + branch

```bash
git worktree add ../<repo>-<neutral-bucket> -b <neutral-bucket> <base_branch>
```

Bring the source commit's tree into the neutral worktree, then:

- Delete `pure-<specialized>` files.
- For each `mixed` file, strip the bucket-specific sections. Prefer rewriting with generic placeholders over deleting, so neutral readers still understand the feature.
- Leave cosmetic references alone unless the user flagged them as needing generalization.

Stage only neutrally-classified content. Commit with a message that names the neutral base. Run the test command. Do not proceed until tests pass. If a test fails, fix it in the neutral worktree before moving on — do not paper over a failure by shifting content into a specialized bucket just to make the test pass.

## 5. Create each specialized worktree + branch

For each specialized bucket, in dependency order (buckets with no `depends_on` first, then buckets depending on them, etc.):

```bash
# If depends_on is <other-bucket>, branch off that. Otherwise branch off the neutral bucket.
git worktree add ../<repo>-<bucket> -b <bucket> <parent-branch>
```

Then:

- Copy in the bucket's `pure` files from the source commit.
- For each `mixed` file, apply only this bucket's content diff on top of the parent version.
- Stage only this bucket's content. Verify no sibling-bucket files leak in (`git status` should show only what this bucket owns).
- Commit. Run the test command. Must pass before moving to the next bucket.

## 6. Verify the sum

Prove the split is lossless. From the original repo directory (not any worktree):

```bash
git checkout -b split-verify <base_branch>
git merge --no-ff <neutral-bucket> <bucket-1> <bucket-2> ... <bucket-N>
git diff split-verify <source>
```

The diff must be empty. If it is not:

- List each missing / extra hunk and its file.
- Re-classify the hunk — it belongs in exactly one branch.
- Apply to the correct branch in its worktree, re-run the test command for that branch.
- Re-run verification from scratch (delete `split-verify`, recreate).

Do not hand-edit the verify branch to force the diff to zero. Classification errors compound silently when patched over.

If verification fails twice in a row, stop and re-enter step 3: the classification itself is wrong. Re-bucket and re-apply cleanly rather than chasing hunks.

## 7. Cleanup + summary

```bash
git branch -D split-verify
git worktree list
```

Tell the user:

- The worktree paths for each bucket branch.
- The branch names.
- Per-branch test status (pass / fail).
- Verification result (diff empty / non-empty).
- Next suggested action — typically "open PRs in dependency order: neutral first, then each specialization".

Do not delete the bucket worktrees. The user reviews, rebases, and pushes from them.

## Classification rules

Apply in order; the first rule that matches wins.

1. **Structural dependency** — if code imports bucket-specific modules, calls bucket-specific APIs, or declares bucket-specific interfaces, it's in that bucket even if the file is otherwise generic.
2. **Environment-gated code** — code that only executes when a bucket-specific env var / config is set belongs to that bucket.
3. **User-visible behavior** — removing the line changes the neutral branch's runtime behavior (e.g. an import that self-registers a channel) → specialized bucket.
4. **Mock / fixture / example strings** — a project-named label (e.g. `'<project>-mcp'`) used as an arbitrary fixture inside a generic test is *not* a dependency. Keep in neutral; the test is exercising general logic.
5. **Documentation examples** — prose using bucket-specific names as illustrations → rewrite with generic examples in the neutral branch; let the specialized branch reintroduce concrete examples.

## Amending neutral after specialized branches exist

Verification or late user feedback often surfaces a generic file sitting in a specialized branch (or a generic change needed on neutral after specialized branches were already committed). Relocating it requires a cascade:

1. Edit in the neutral worktree. `git add` + `git commit --amend --no-edit`. Neutral's SHA changes.
2. For each specialized branch, record the old neutral SHA it was stacked on, then:
   ```bash
   git stash push -u -m "wip"                 # if anything uncommitted
   git rebase --onto <neutral-branch> <old-neutral-sha>
   git stash pop
   git add -u && git commit --amend --no-edit  # fold the stashed work in
   ```
   `--onto <neutral> <old-neutral-sha>` tells git: "drop the commit at `<old-neutral-sha>` and replay what follows on top of `<neutral>`." Without the third argument, git replays the *old* neutral commit too, producing a duplicate and pointless conflicts.
3. Files like `vitest.config.ts` commonly conflict here — neutral adds a generic change (e.g. `testTimeout`), specialized branch added its own entry to the same list (e.g. `include` glob). Keep both sides.
4. If you use a file-edit tool that re-reads before writing, and the underlying file changed between read and write (normal during conflict resolution), the write can fail silently and leave conflict markers committed. Always `cat` the resolved file before `git add`.
5. Re-run tests on each specialized branch. Re-run verification (step 6) from scratch.

## Troubleshooting & recurring pitfalls

- **Parallel-only test failures.** A test that fails in `npm test` but passes when you run just its file is thread-contention on per-test sqlite/migration setup, not a split regression. Confirm with `npm test -- --no-file-parallelism` — if the full suite passes sequentially, bump `testTimeout` on neutral (and cascade per the section above). Do not reshuffle test content between buckets to paper over this.

- **Multi-bucket test files.** A single test file covering install permutations ("scenario 1: plain; scenario 2: +A; scenario 3: +A+B; scenario 4: typed") is a common mixed case. Partition at the `describe` / `it` level: scenarios that only touch neutral stay in neutral; scenarios depending on project-specific skills or registered types move to that project's branch. Keep shared imports in whichever branch still needs them.

- **Residual-diff categories during verification.** When `git diff split-verify <source>` is non-empty, residuals usually fall into:
  - *Project content leaked into neutral* — strip from neutral, restore on the project branch.
  - *Generic content missing from neutral* — port to neutral (this triggers the cascade above).
  - *Test coverage lost in the split* — source had describes/its that got dropped when a file was partitioned; diff the test file per branch against source and restore.

- **False positives for "project-specific".** These stay neutral despite looking specialized:
  - Architecture docs using a project as the illustrative example. If removing examples leaves the doc unreadable, it's about *how the system works*, not about the project.
  - Fixture strings inside generic tests (e.g. `'<project>-compiler'` as a test-identifier where the logic exercised is generic extends-chain resolution).
  - Comment labels listing a project as one of several examples — replace with a placeholder (`<type>`) only if the sentence still parses.

- **Generic functionality always flows to neutral.** When the user says "this is generic" about content in a specialized branch, treat it as a classification error: re-enter step 3 and re-apply, don't hand-edit the diff.

## Independent vs stacked topology

When the user says specialized branches should be **independent** (each forks from neutral, not from each other), extra discipline is required.

### Why it matters

If branch A and B are independent:
```
neutral → branch-A
neutral → branch-B
```
Merging both into neutral must produce zero conflicts. Each branch carries ONLY its own files. Neither branch inherits the other's content.

If they're stacked:
```
neutral → branch-A → branch-B
```
branch-B includes everything from A. Merging B alone brings A's content too. This is simpler but means B can't be adopted without A.

### Creating independent branches from a stacked source

When the source was stacked (e.g. `nv-slang` was on top of `nv-dashboard`), **`git merge --squash` from the stacked branch brings in ALL ancestor content** — not just that branch's own files. You MUST manually extract only the branch-owned files:

```bash
# WRONG — brings in dashboard files too:
git merge --squash origin/nv-slang

# RIGHT — cherry-pick only slang-owned files:
git checkout origin/nv-slang -- container/skills/slang-* coworkers/ src/slang-*
```

### Shared infrastructure files (register.ts, index.ts, package.json)

These are owned by the neutral branch. Specialized branches should NOT modify them. If a specialized branch needs changes to shared files (e.g. dashboard needs `startDashboardIngress` added to `src/index.ts`), those changes must be **additive** — they add new lines but don't change existing ones.

**The merge-override trap:** When a specialized branch includes a copy of a shared file, `git merge` may silently take the specialized version over the neutral one. This loses neutral-only fixes (e.g. register.ts flags that were added after the specialized branch was created).

**Prevention:** After creating a specialized branch via `merge --squash`, restore all shared infrastructure files from neutral:

```bash
git checkout origin/<neutral-branch> -- setup/register.ts package.json src/index.ts
git add -u
git commit --amend --no-edit
```

### Verification for independent topology

After pushing, verify that merging ALL specialized branches onto neutral produces the expected tree:

```bash
git checkout <neutral> && git checkout -b verify
git merge <branch-A> --no-edit
git merge <branch-B> --no-edit
# Check: all specialized content present, all neutral fixes preserved
grep <critical-fix> <shared-file>  # must show neutral's version, not stale
```

If a shared file shows the specialized branch's stale version, the branch needs to be rebuilt with the neutral version of that file.

### Squash workflow for independent skill branches

1. Create worktree from neutral: `git worktree add /tmp/sq <neutral>`
2. For each specialized branch:
   a. `git checkout <neutral>` (reset to base)
   b. `git checkout -b squashed-<branch>`
   c. Cherry-pick ONLY branch-owned files from the source
   d. Restore shared files from neutral: `git checkout <neutral> -- setup/ package.json src/index.ts`
   e. Commit with descriptive message
   f. Push
3. Verify: merge all branches onto neutral, check no regressions
