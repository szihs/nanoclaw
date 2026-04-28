---
name: create-nv-branch
description: "Rebase a lego-* branch onto upstream/main as a single squashed nv-* commit. Handles conflict analysis, pre-rebase cleanup (removing features already in upstream), migration renumbering, and conflict resolution patterns."
---

# Create nv-* Branch from lego-*

Creates a clean `nv-<name>` branch that is `upstream/main` + all of `lego-<name>`'s unique work squashed into **1 commit**. The `lego-*` branches are preserved untouched.

## When to use

Run this when you want to ship a `lego-*` feature branch on top of the latest upstream NanoClaw. The `nv-*` naming convention signals "NV-customized, rebased on upstream tip."

Current nv-* branches: `nv-coworkers`, `nv-main`, `nv-slang`, `nv-slangpy`, `nv-dashboard`.

---

## Pre-flight

### 1. Ensure upstream remote exists

```bash
git remote -v | grep upstream
```

If missing:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw
git fetch upstream
```

### 2. Fix system clock (sandbox only)

If running in a sandbox, the clock may be wrong. Fix it so commit timestamps are correct:
```bash
sudo date -s "YYYY-MM-DD HH:MM:SS"
```

---

## Phase 1: Common Ancestor & Scale Analysis

```bash
ANCESTOR=$(git merge-base origin/lego-<name> upstream/main)
echo "Ancestor: $ANCESTOR"
git log --oneline $ANCESTOR..origin/lego-<name> | wc -l   # lego commits
git log --oneline $ANCESTOR..upstream/main | wc -l        # upstream commits
git diff --name-only $ANCESTOR..origin/lego-<name> | wc -l  # files lego touches
```

Find files touched by BOTH sides (potential conflicts):
```bash
git diff --name-only $ANCESTOR..origin/lego-<name> | sort > /tmp/lego_files.txt
git diff --name-only $ANCESTOR..upstream/main | sort > /tmp/upstream_files.txt
comm -12 /tmp/lego_files.txt /tmp/upstream_files.txt
```

For each overlapping file, check scale of changes:
```bash
for f in <overlapping files>; do
  echo "=== $f ==="
  git diff --stat $ANCESTOR..origin/lego-<name> -- "$f"
  git diff --stat $ANCESTOR..upstream/main -- "$f"
done
```

---

## Phase 2: Redundancy Audit

Before squashing, check whether lego's features are already in upstream. For each major feature lego adds, run:

```bash
# Does upstream/main already have this file?
git show upstream/main:<path/to/file> 2>/dev/null | head -20

# Does upstream have a skill that installs it instead?
git show upstream/main:.claude/skills/<name>/SKILL.md 2>/dev/null | head -30

# Is there a skill branch for it?
git branch -r | grep -i <feature>
```

### Known patterns for nv-* branches

| lego feature | upstream status | Action |
|---|---|---|
| Codex provider (`providers/codex.ts`) | Upstream `/add-codex` skill + `providers` branch | **Remove** — use skill |
| OpenCode provider | Upstream `/add-opencode` skill | **Remove** — use skill |
| Host sweep | Identical in upstream | **Remove** from squash — upstream's is authoritative |
| `resolveProviderName` (2-tier) | Upstream has 3-tier with containerConfig | **Drop lego's** — use upstream's |
| Poll-loop single-key continuations | Upstream has per-provider keying | **Drop lego's** — upstream fixes a bug |
| `agent-route.ts` without file handling | Upstream has file-attachment forwarding | **Drop lego's** — upstream is a superset |
| Migration numbers colliding with upstream | Check upstream's highest migration number | **Renumber** lego's to avoid collision |

### Migration number check

```bash
git ls-tree -r upstream/main --name-only | grep "migrations/" | sort
```

Upstream currently goes up to `013-approval-render-metadata`. Lego migrations must not reuse that number. If lego has `013-*`, rename to `014-*`, and shift any `014-*` to `015-*`:

```bash
git mv src/db/migrations/013-<name>.ts src/db/migrations/014-<name>.ts
git mv src/db/migrations/014-<name>.ts src/db/migrations/015-<name>.ts
```

Lego uses dynamic `fs.readdirSync` discovery so renaming is sufficient — no registry to update.

---

## Phase 3: Create the Squash Commit

```bash
# Create nv-<name> at the common ancestor (clean base, no conflicts)
git checkout -b nv-<name> $ANCESTOR

# Squash all lego-<name> changes into staging (may report conflicts)
git merge --squash origin/lego-<name>

# If conflicts: resolve them (Phase 4), then:
git add -A

# Commit as 1 squash with today's timestamp
GIT_COMMITTER_DATE="$(date -R)" git commit \
  --date="$(date -R)" \
  -m "feat(nv-<name>): squash full lego-<name> infrastructure"
```

At this point `nv-<name>` is 1 commit on top of `$ANCESTOR`, containing all lego changes.

---

## Phase 3.5: Remove nv-main Duplicates (project-specific branches only)

**Skip this phase for `nv-main` itself.** For all other project branches (`nv-slang`, `nv-slangpy`, `nv-dashboard`, etc.), the lego squash brings in nv-main infrastructure that must NOT be duplicated. Remove it before committing:

```bash
git rm -r \
  container/skills/spine-base/ \
  container/skills/nanoclaw-base/ \
  container/skills/base-nanoclaw/ \
  container/skills/base-plan/ \
  container/skills/codex-critique/ \
  container/skills/critique-overlay/ \
  container/skills/deep-research/ \
  container/skills/document-workflow/ \
  container/skills/implement-workflow/ \
  container/skills/investigate-workflow/ \
  container/skills/plan-overlay/ \
  container/skills/review-workflow/ \
  src/db/migrations/006-coworker-fields.ts \
  src/db/migrations/014-hook-events.ts \
  src/db/migrations/015-agent-routing.ts \
  2>/dev/null; true
```

Also remove cross-project skill references that don't belong:
- `add-slang/SKILL.md` from non-slang branches
- `container/skills/spine-slang/context/layout.md` from non-slang branches
- `container/agent-runner/src/providers/codex.ts` + its `import './codex.js'` line from all project branches (covered by upstream's `/add-codex` skill)

Check after removal — **keep** any `<project>-*` prefixed variants (e.g. `slang-document-workflow/` in nv-slang). Only the generic unprefixed versions are nv-main's.

Then verify and commit:
```bash
# Verify nothing project-specific was accidentally removed
git diff --cached --name-only | head -40

git add -A
GIT_COMMITTER_DATE="$(date -R)" git -c user.name="Harsh Aggarwal" -c user.email="haaggarwal@nvidia.com" commit \
  --date="$(date -R)" \
  -m "feat(nv-<name>): squash full lego-<name> infrastructure"
```

If you already committed before realizing removals were needed, use `git rm` then `git commit --amend --no-edit`.

---

## Phase 4: Rebase onto upstream/main

```bash
git rebase --onto upstream/main $ANCESTOR nv-<name>
```

Expect conflicts only in files that both sides touched (from Phase 1). For each conflict:

```bash
grep -n "<<<<<<\|======\|>>>>>>" <file>
```

### Conflict resolution patterns

**Pattern A — Lego big rewrite, upstream small addition (e.g. `src/container-runner.ts`, `src/index.ts`)**
Take lego's version; cherry-pick upstream's addition manually.
```
<<<<<<< HEAD (upstream small change)
=======
(lego's larger rewrite)
```
→ Keep lego's version + add upstream's lines in the right place.

**Pattern B — Upstream has new function, lego has different new function (e.g. `src/container-runner.ts`)**
Keep BOTH functions — they're independent.

**Pattern C — Schema field renamed (e.g. `setup/register.ts`: `trigger_rules` → `engage_mode`)**
Upstream wins on schema. Remove lego's old field names, use upstream's. Also remove any duplicate fields lego added below the conflict block.
```
<<<<<<< HEAD
  engage_mode: engageMode,        ← upstream's new schema
  engage_pattern: engagePattern,
=======
  trigger_rules: triggerRules,    ← lego's old schema
  response_scope: 'all',
>>>>>>>
```
→ Take HEAD (upstream's schema).

**Pattern D — Dynamic vs static migration loader (e.g. `src/db/migrations/index.ts`)**
Lego's dynamic `fs.readdirSync` is the better design — it auto-discovers upstream's new migrations without registry edits. Take lego's version entirely. Remove all static imports and the static array from upstream's version.

**Pattern E — Provider resolution (e.g. `src/container-runner.ts`)**
Upstream has 3-tier `resolveProviderName(session, group, containerConfig)`. Lego has inline 2-tier. Use upstream's function but pass `undefined` for the containerConfig tier if containerConfig isn't wired yet:
```typescript
const provider = resolveProviderName(session.agent_provider, agentGroup.agent_provider, undefined);
```

**Pattern F — New field added by both (e.g. `src/router.ts`: `is_group` + `admin_user_id`)**
Keep both fields — they're independent additions:
```typescript
is_group: event.message.isGroup ? 1 : 0,  // upstream
admin_user_id: null,                        // lego
```

After resolving each conflict:
```bash
git add <file>
```

When all conflicts resolved:
```bash
GIT_COMMITTER_DATE="$(date -R)" \
  git -c user.name="Harsh Aggarwal" \
  -c user.email="haaggarwal@nvidia.com" \
  rebase --continue
```

---

## Phase 5: Verify & Push

Confirm 1 commit on top of upstream/main:
```bash
git log --oneline upstream/main..nv-<name>   # should show exactly 1 commit
git diff --stat upstream/main..nv-<name>     # review what changed
```

Confirm no conflict markers remain:
```bash
grep -r "<<<<<<\|======\|>>>>>>" src/ setup/ container/agent-runner/src/ --include="*.ts" | grep -v ".git"
```

Push:
```bash
git push origin nv-<name>
# or force-push if branch already exists:
git push --force-with-lease origin nv-<name>
```

---

## Phase 6: Update nv-* skill references

Two places to update:

### 6a. References inside the new nv-* branch

Check for any `lego-*` branch references in skill files that ship in the new branch:

```bash
grep -rn "lego-<name>" .claude/skills/ --include="*.md"
```

Replace `origin/lego-<name>` with `origin/nv-<name>` in each match.

### 6b. References in nv-main that point to the old lego-* branch

Other skills on nv-main may merge from `origin/lego-<name>` — update them to `origin/nv-<name>`:

```bash
# Common files to update when creating nv-slang:
#   .claude/skills/add-slang/SKILL.md  — git fetch/merge lines
#   .claude/skills/add-coworkers/SKILL.md  — description lines
#
# Common files to update when creating nv-dashboard:
#   .claude/skills/add-dashboard/SKILL.md  — git fetch/merge lines
#   .claude/skills/add-coworkers/SKILL.md  — description lines

grep -rn "lego-<name>" .claude/skills/ --include="*.md"
```

After editing, stage and amend the nv-main squash commit so all skill reference updates land in the same commit:

```bash
git add .claude/skills/
GIT_COMMITTER_DATE="$(date -R)" git commit --amend --no-edit --date="$(date -R)"
git push --force-with-lease origin nv-main
```

---

## Branch map (current state)

```
upstream/main (qwibitai/nanoclaw)
    │
    ├── nv-coworkers  ← upstream/main + add-coworkers skill entry point
    ├── nv-main       ← upstream/main + full lego infrastructure (composer, MCP, hooks, workflows,
    │                   spine-base, nanoclaw-base, all generic workflow skills, migrations 006/014/015)
    ├── nv-slang      ← upstream/main + spine-slang, slang-* skills, slang-mcp server, coworker YAMLs
    ├── nv-slangpy    ← upstream/main + spine-slangpy, slangpy-* skills, coworker YAMLs
    └── nv-dashboard  ← upstream/main + dashboard/ server + assets, src/channels/dashboard, dashboard-base skill

lego-* branches are preserved as-is (source of truth for lego work).
nv-* branches are always reconstructible from lego-* + this skill.
```

---

## Troubleshooting

**"Not a valid object name nv-coworkers"** — The branch is only on origin, not local. Use `origin/lego-<name>` in all git commands.

**Squash only shows 3-4 files changed** — `origin/nv-coworkers` is stale (the merged branch wasn't pushed). Use `origin/nv-main` as the source instead; it has the full infrastructure.

**Commit appears below upstream commits on GitHub** — Sandbox clock is wrong. Fix with `sudo date -s` and amend the commit:
```bash
GIT_COMMITTER_DATE="$(date -R)" git commit --amend --reset-author --no-edit --date="$(date -R)"
git push --force-with-lease origin nv-<name>
```

**Migration version duplicate error at runtime** — Two migration files share the same `version` number. Renumber lego's migrations as described in Phase 2.
