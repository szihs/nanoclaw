# NanoClaw Update & Debug Checklist (Instance-Aware)

All commands below use variables auto-detected from `.env`. Run Phase 1 first to populate them.

---

## Phase 1: Identify Current User / Tree / Version

### 1a. Detect instance from `.env`

```bash
# Run from your NanoClaw repo root
REPO_ROOT=$(pwd)
source <(grep -E '^(CONTAINER_PREFIX|CONTAINER_IMAGE|DASHBOARD_PORT|DASHBOARD_INGRESS_PORT|MCP_PROXY_PORT|TZ)=' "$REPO_ROOT/.env")

echo "Repo root:        $REPO_ROOT"
echo "Container prefix:  $CONTAINER_PREFIX"
echo "Container image:   $CONTAINER_IMAGE"
echo "Dashboard port:    $DASHBOARD_PORT (ingress: $DASHBOARD_INGRESS_PORT)"
echo "MCP proxy port:    $MCP_PROXY_PORT"
echo "Timezone:          $TZ"
```

### 1b. Match systemd services

```bash
MAIN_SERVICE=""
DASH_SERVICE=""
for f in ~/.config/systemd/user/nanoclaw-*.service; do
  WD=$(grep -oP 'WorkingDirectory=\K.*' "$f" 2>/dev/null)
  [ "$WD" = "$REPO_ROOT" ] || continue
  NAME=$(basename "$f" .service)
  case "$NAME" in *-dashboard) DASH_SERVICE="$NAME" ;; *) MAIN_SERVICE="$NAME" ;; esac
done
# Fallback: check if this is prod (nanoclaw.service)
if [ -z "$MAIN_SERVICE" ]; then
  WD=$(grep -oP 'WorkingDirectory=\K.*' ~/.config/systemd/user/nanoclaw.service 2>/dev/null)
  if [ "$WD" = "$REPO_ROOT" ]; then
    MAIN_SERVICE="nanoclaw"; DASH_SERVICE="nanoclaw-dashboard"
  fi
fi
echo "Main service:      $MAIN_SERVICE"
echo "Dashboard service:  $DASH_SERVICE"
```

### 1c. Git state

```bash
echo "Branch:   $(git branch --show-current)"
echo "HEAD:     $(git log -1 --oneline)"
echo "Dirty:    $(git status --short | wc -l) files"
echo "Ahead of origin/nv-coworkers: $(git rev-list origin/nv-coworkers..HEAD --count) commits"
```

### 1d. Service & container state

```bash
systemctl --user is-active $MAIN_SERVICE 2>/dev/null && echo "Main: running" || echo "Main: stopped"
systemctl --user is-active $DASH_SERVICE 2>/dev/null && echo "Dashboard: running" || echo "Dashboard: stopped"
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep "$CONTAINER_PREFIX"
```

### 1e. Known instances reference

| Instance | CONTAINER_PREFIX | DASHBOARD_PORT | Service name | Repo root |
|----------|-----------------|----------------|--------------|-----------|
| prod | `nc-prod` | 3737 | `nanoclaw` | `/home/ubuntu/slang-coworkers-prod/nanoclaw` |
| haaggarwal-lego | `nc-lego` | 3838 | `nanoclaw-haaggarwal-lego` | `/home/ubuntu/haaggarwal/lego-nanoclaw` |
| haaggarwal-dev | `nc-dev` | 4141 | `nanoclaw-haaggarwal-dev` | `/home/ubuntu/haaggarwal/slang-coworkers-nanoclaw` |

**Confirm with user before proceeding.**

---

## Phase 2: Backup (Mandatory — do not skip)

### 2a. Stash uncommitted work

```bash
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash save "pre-update-${TIMESTAMP}"
  echo "Stashed as: pre-update-${TIMESTAMP}"
else
  echo "Working tree clean — no stash needed."
fi
```

### 2b. Back up database

```bash
if [ -f "$REPO_ROOT/data/v2.db" ]; then
  cp "$REPO_ROOT/data/v2.db" "$REPO_ROOT/data/v2.db.bak-${TIMESTAMP}"
  ls -lh "$REPO_ROOT/data/v2.db.bak-${TIMESTAMP}"
fi
```

### 2c. Record rollback point

```bash
OLD_HEAD=$(git rev-parse HEAD)
echo "Rollback: git checkout -B nv-coworkers $OLD_HEAD"
```

### 2d. Verification gate

- [ ] Stash created (or working tree was clean)
- [ ] `data/v2.db.bak-*` exists and is non-zero
- [ ] `OLD_HEAD` recorded

**Stop here if any backup failed. Do not proceed without confirmed backups.**

---

## Phase 3: Split-Commit — Audit & Fix Cross-Branch Leakage

### 3a. List local-only commits

```bash
git log --oneline origin/nv-coworkers..HEAD --no-merges
```

### 3b. Classify each commit

For each non-merge commit, determine the correct `nv-*` branch:

| Signal | Target branch |
|--------|--------------|
| Message contains `(nv-main)` | nv-main |
| Message contains `(nv-dashboard)` | nv-dashboard |
| Message contains `(nv-slang)` | nv-slang |
| Message contains `(nv-slangpy)` | nv-slangpy |
| Message contains `(nv-nanoclaw)` | nv-nanoclaw |
| Touches `dashboard/` only | nv-dashboard |
| Touches `container/skills/slang-*` | nv-slang |
| Touches `container/skills/*slangpy*` | nv-slangpy |
| Touches `lego/` or `container/skills/nanoclaw-*` (no slang) | nv-nanoclaw |
| Touches `src/`, `container/agent-runner/`, `setup/`, `Dockerfile` | nv-main |
| Everything else / mixed | nv-coworkers (keep) |

```bash
# Helper: show files per commit for classification
for SHA in $(git rev-list origin/nv-coworkers..HEAD --no-merges); do
  echo "=== $(git log -1 --oneline $SHA) ==="
  git diff-tree --no-commit-id --name-only -r $SHA | head -10
  echo ""
done
```

### 3c. Build classification table

Fill in this table for each commit:

```
SHA      Message                                  Detected Branch   Currently On       Action
──────── ──────────────────────────────────────── ───────────────── ────────────────── ──────────
e6389e6  feat(nv-nanoclaw): add lego skeleton     nv-nanoclaw       origin/nv-nanoclaw  OK
90ef72d  Add GPU passthrough                      nv-main           nv-coworkers only   CHERRY-PICK
516d5a8  Fix container timeout ceiling             nv-main           nv-coworkers only   CHERRY-PICK
```

### 3d. Fix misplaced commits (interactive)

For each commit that needs to move:

```bash
# 1. Create fix branch from correct nv-* base
git checkout -b fix/<short-description> origin/<correct-nv-branch>

# 2. Cherry-pick the misplaced commit
git cherry-pick <SHA>

# 3. If conflict: resolve, then git add + git cherry-pick --continue

# 4. Push for PR
git push origin fix/<short-description>

# 5. Return to integration branch
git checkout nv-coworkers
```

For complex splits (one commit touches multiple branches), use the `/split-commit` skill.

### 3e. Verify no remaining leakage

```bash
# After cherry-picks, re-check: all remaining local commits should be
# either merge commits or nv-coworkers-appropriate
git log --oneline origin/nv-coworkers..HEAD --no-merges
```

---

## Phase 4: (Reserved)

---

## Phase 5: Run Update via Skill

Use the `/update-nanoclaw-instance` skill, which automates:

1. Fetch origin
2. Check for changes (stop early if up-to-date)
3. Stop services (`$MAIN_SERVICE`, `$DASH_SERVICE`)
4. Reset to `origin/nv-coworkers`
5. Merge in order: `nv-main` → `nv-dashboard` → `nv-slang` → `nv-slangpy` → `nv-nanoclaw`
6. Cherry-pick user commits back
7. Rebuild (pnpm install, build, container, clear caches)
8. Restart services
9. Run tests

```bash
# Or run manually step by step:

# Fetch
git fetch origin

# Check which branches have new commits
for branch in origin/nv-coworkers origin/nv-main origin/nv-dashboard origin/nv-slang origin/nv-slangpy origin/nv-nanoclaw; do
  git merge-base --is-ancestor $branch HEAD 2>/dev/null || echo "New commits on $branch"
done

# Stop services
systemctl --user stop $MAIN_SERVICE $DASH_SERVICE

# Reset
git checkout -B nv-coworkers origin/nv-coworkers

# Merge in order
git merge origin/nv-main --no-edit
git merge origin/nv-dashboard --no-edit
git merge origin/nv-slang --no-edit
git merge origin/nv-slangpy --no-edit
git merge origin/nv-nanoclaw --no-edit
```

---

## Phase 6: Port User Work onto Latest nv-* Branches

After merging the latest `origin/nv-*`, re-apply user-specific commits.

### 6a. Cherry-pick user commits

```bash
# From the classification table in Phase 3, cherry-pick commits that belong on nv-coworkers
for SHA in <user-commit-SHAs>; do
  git cherry-pick $SHA || echo "Conflict on $SHA — resolve manually"
done
```

### 6b. Push fix branches for PR

```bash
# For any fix/ branches created in Phase 3
git push origin fix/<branch-1> fix/<branch-2> ...
```

### 6c. Verify final tree

```bash
# The diff between old HEAD and new HEAD should only contain upstream additions
git diff $OLD_HEAD HEAD --stat
```

### 6d. Rebuild and restart

```bash
cd $REPO_ROOT
pnpm install && pnpm run build
npm run rebuild:claude 2>/dev/null || true

# Clear stale caches
rm -rf data/v2-sessions/*/agent-runner-src/
rm -rf /tmp/tsx-1000/

# Rebuild container
IMAGE_TAG=$(echo $CONTAINER_IMAGE | cut -d: -f2)
./container/build.sh $IMAGE_TAG

# Restart
systemctl --user start $MAIN_SERVICE $DASH_SERVICE
```

---

## Phase 7: Run Tests per Checklist

### Quick Smoke (run first — 2 min)

```bash
cd $REPO_ROOT

# Build clean?
npm run build 2>&1 | tail -3

# Tests pass?
npm test 2>&1 | tail -10

# Services running?
systemctl --user is-active $MAIN_SERVICE
systemctl --user is-active $DASH_SERVICE

# Dashboard reachable?
curl -sf http://localhost:$DASHBOARD_PORT/ > /dev/null && echo "Dashboard: OK" || echo "Dashboard: FAIL"

# No FATAL errors?
grep FATAL $REPO_ROOT/logs/nanoclaw.error.log 2>/dev/null | tail -3 || echo "No FATAL errors"

# Container image exists?
docker images --format '{{.Repository}}:{{.Tag}}' | grep "$(echo $CONTAINER_IMAGE | cut -d: -f1)"
```

### Test Coworker Convention

All test coworkers use a `test-` prefix so they can be identified and cleaned up. Record their IDs as you create them:

```bash
TEST_IDS=()  # append each created coworker ID here
```

### Full Integration Test Matrix

All commands below use `$DASHBOARD_PORT` and `$REPO_ROOT` from Phase 1. Replace `PORT` references in the original checklist with `$DASHBOARD_PORT`.

#### Setup & Bootstrap

- [ ] **T01** `bash setup.sh` — STATUS: success, DEPS_OK/NATIVE_OK/NODE_OK all true
- [ ] **T06** `npm run build` — compiles clean
- [ ] **T07** `npm test` — all pass, 0 failures
- [ ] **T08** `npm run validate:templates` — all leaf types compose clean
- [ ] **T09** `npm run rebuild:claude` — CLAUDE.md files regenerated
- [ ] **T10** Container image built — `docker images | grep $(echo $CONTAINER_IMAGE | cut -d: -f1)`

#### Services

- [ ] **T12** Main service active — `systemctl --user is-active $MAIN_SERVICE`
- [ ] **T13** Dashboard service active — `systemctl --user is-active $DASH_SERVICE`
- [ ] **T14** Dashboard ingress listening — `grep 'Dashboard ingress listening' $REPO_ROOT/logs/nanoclaw.log | tail -1`
- [ ] **T15** MCP tools discovered — `grep 'MCP tool discovery' $REPO_ROOT/logs/nanoclaw.log | tail -1`
- [ ] **T16** No FATAL in error log — `grep FATAL $REPO_ROOT/logs/nanoclaw.error.log` (should be empty)

#### Orchestrator (use existing — do not create a test Orchestrator)

- [ ] **T19** Existing Orchestrator has `is_admin=1, coworker_type='main'` in DB
- [ ] **T23** Send "ping" to Orchestrator → agent responds (not "Invalid API key")
- [ ] **T24** Orchestrator CLAUDE.md present and well-formed

#### Typed Coworker (test-prefixed — will be cleaned up)

```bash
# Create test coworker
RESULT=$(curl -s -X POST http://localhost:$DASHBOARD_PORT/api/coworkers \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-triage","folder":"test-triage","types":["slang-triage"]}')
TEST_TRIAGE_ID=$(echo $RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
TEST_IDS+=($TEST_TRIAGE_ID)
echo "Created test-triage (id=$TEST_TRIAGE_ID)"
```

- [ ] **T27** test-triage created — API returns id and coworker_type='slang-triage'
- [ ] **T29** Send message to test-triage → agent responds with type-appropriate content
- [ ] **T30** test-triage CLAUDE.md composed with ## Identity, ## Invariants, ## Workflows

#### Routing Tests (test-prefixed — will be cleaned up)

```bash
# Direct routing test coworker
RESULT=$(curl -s -X POST http://localhost:$DASHBOARD_PORT/api/coworkers \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-direct","folder":"test-direct","types":["slang-triage"],"routing":"direct"}')
TEST_DIRECT_ID=$(echo $RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
TEST_IDS+=($TEST_DIRECT_ID)

# Internal routing test coworker
RESULT=$(curl -s -X POST http://localhost:$DASHBOARD_PORT/api/coworkers \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-internal","folder":"test-internal","types":["slang-triage"],"routing":"internal"}')
TEST_INTERNAL_ID=$(echo $RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
TEST_IDS+=($TEST_INTERNAL_ID)
```

- [ ] **T101** test-direct has routing='direct' in DB, own dashboard channel created
- [ ] **T102** test-internal has routing='internal' in DB, wired into admin channel
- [ ] **T103** test-internal — Send button disabled in dashboard, placeholder shows routing message

#### Approval Flow (use existing coworkers — no creation needed)

- [ ] **T42** Agent triggers approval → card renders in dashboard at `http://localhost:$DASHBOARD_PORT`
- [ ] **T43** Click Approve → packages approved
- [ ] **T127** Approval is case-insensitive

#### Container Lifecycle (use existing coworkers)

- [ ] **T93** Container spawns on message — `grep 'Spawning container' $REPO_ROOT/logs/nanoclaw.log | tail -3`
- [ ] **T94** Container idles after processing
- [ ] **T95** Sweep detects stale containers — `grep 'sweep' $REPO_ROOT/logs/nanoclaw.log | tail -3`

#### Agent-to-Agent (use existing coworkers)

- [ ] **T51** Orchestrator creates sub-agent via MCP tool
- [ ] **T53** Message routed between agents (bidirectional destinations)
- [ ] **T111** Orchestrator can reach all coworkers by name

#### Dashboard UI (browser at http://localhost:$DASHBOARD_PORT)

- [ ] **T80** Pixel Office renders — test-* coworkers visible alongside real ones
- [ ] **T82** Chat panel — messages load, send works
- [ ] **T84** SSE connection indicator green
- [ ] **T146** XSS: `<script>alert(1)</script>` renders escaped

#### DB Schema

- [ ] **S23** Migration 014 applied — `routing` column exists on agent_groups
- [ ] **S26** `messaging_groups` UNIQUE(channel_type, platform_id) enforced
- [ ] **S28** `agent_destinations` has bidirectional entries for all admin↔coworker pairs

#### Browser UI Tests (agent-browser on http://localhost:$DASHBOARD_PORT)

These tests use `agent-browser` to validate DOM rendering, interactions, and XSS protection. Do NOT skip these — API tests alone do not verify that the UI works.

##### Setup

```bash
agent-browser open http://localhost:$DASHBOARD_PORT
agent-browser wait --load networkidle
agent-browser snapshot -i
```

##### Pixel Office & Layout

```bash
# T80: Pixel Office renders with coworker characters
agent-browser snapshot -s "#pixel-office"
# Verify: agent name labels visible, character sprites rendered
# test-* coworkers should appear alongside real ones

# T84: SSE connection indicator
agent-browser get text "[data-testid='connection-status']" 2>/dev/null || agent-browser find text "Connected"
# Verify: green / connected state

# T142: Status bar counts
agent-browser snapshot -s "[data-testid='status-bar']" 2>/dev/null || agent-browser snapshot -s "header"
# Verify: Actors count includes test-* coworkers
```

- [ ] **B01** Pixel Office renders — all agents visible with name labels
- [ ] **B02** SSE connection indicator shows connected (green)
- [ ] **B03** Status bar shows correct Actors count

##### Sidebar & Navigation

```bash
# T143: Coworkers tab — all agents listed
agent-browser snapshot -i -s "[data-testid='sidebar']" 2>/dev/null || agent-browser snapshot -i -s "nav"
# Verify: test-triage, test-direct, test-internal all appear

# Click on test-triage to open chat
agent-browser find text "test-triage" click
agent-browser wait --load networkidle
agent-browser snapshot -i
```

- [ ] **B04** Sidebar lists all coworkers including test-* agents
- [ ] **B05** Click coworker opens chat panel

##### Chat — Send & Receive

```bash
# T145: Send "ping" to Orchestrator
agent-browser find text "Orchestrator" click 2>/dev/null || agent-browser find text "orchestrator" click
agent-browser wait 1000
agent-browser snapshot -i

# Find the message input and send
agent-browser find placeholder "Type a message" fill "ping"
agent-browser press Enter
agent-browser wait 15000
agent-browser snapshot -i
# Verify: agent response visible (e.g. "Pong" or any non-error response)
```

- [ ] **B06** Message input accepts text and sends on Enter
- [ ] **B07** Agent responds to "ping" (not "Invalid API key" or error)

##### XSS Protection

```bash
# T146: XSS payload renders as escaped text
agent-browser find placeholder "Type a message" fill "<script>alert(1)</script>"
agent-browser press Enter
agent-browser wait 5000

# Check the DOM — must be escaped, not executed
agent-browser eval "document.querySelector('[data-testid=\"chat-messages\"]')?.innerHTML || document.querySelector('.messages')?.innerHTML || 'NOT_FOUND'"
# Verify: contains &lt;script&gt; NOT <script>

agent-browser snapshot -i
# Verify: rendered as visible text, no alert dialog
```

- [ ] **B08** XSS payload renders as `&lt;script&gt;` in DOM, no JS execution

##### ask_user_question Card

```bash
# T149: If an ask_user_question card exists in chat history
agent-browser snapshot -i -s ".question-card" 2>/dev/null || agent-browser find text "option" snapshot -i
# Verify: clickable option buttons rendered

# T150: Click an option
# agent-browser click @<option-ref>
# agent-browser wait 5000
# Verify: card shows "(answered)"
```

- [ ] **B09** ask_user_question card renders with clickable option buttons
- [ ] **B10** Click option routes `selectedOption` back, card shows "(answered)"

##### Approval Card

```bash
# T151: If an install_packages approval card exists
agent-browser snapshot -i -s ".approval-card" 2>/dev/null || agent-browser find text "Approve" snapshot -i
# Verify: PENDING ACTIONS card with Approve/Reject buttons

# T152: Click Approve
# agent-browser find text "Approve" click
# agent-browser wait 10000
# Verify: "Package install approved" in logs
```

- [ ] **B11** install_packages renders as PENDING ACTIONS card
- [ ] **B12** Click Approve triggers rebuild, no duplicate submissions

##### "+New" Modal

```bash
# T156: Open the create modal
agent-browser find text "+New" click 2>/dev/null || agent-browser find text "New" click
agent-browser wait 1000
agent-browser snapshot -i

# Verify: routing dropdown, type checkboxes, instruction style, agent provider all visible
```

- [ ] **B13** "+New" modal opens with routing dropdown visible
- [ ] **B14** Type checkboxes grouped by project, abstract bases hidden
- [ ] **B15** Agent provider selector visible

##### Internal Agent — Send Disabled

```bash
# T157: Navigate to test-internal agent
agent-browser find text "test-internal" click
agent-browser wait 1000
agent-browser snapshot -i

# Verify: Send button disabled, placeholder shows routing message
agent-browser get attr "[data-testid='send-button']" disabled 2>/dev/null || agent-browser find placeholder "Internal agent" snapshot -i
```

- [ ] **B16** Internal agent (test-internal) — Send disabled, placeholder explains routing

##### Detail Panel

```bash
# T158: Open detail panel for test-triage
agent-browser find text "test-triage" click
agent-browser wait 1000
# Open detail/info panel (may be a tab or icon)
agent-browser find text "Details" click 2>/dev/null || agent-browser find text "Info" click 2>/dev/null
agent-browser snapshot -i

# Verify: Status, Type, Trigger (no \b), JID (clean platform_id), MCP Tools
```

- [ ] **B17** Detail panel shows Status, Type, Trigger (no `\b`), clean JID
- [ ] **B18** MCP Tools listed, Recent Events clickable

##### Screenshot for Record

```bash
# Save a full-page screenshot as test evidence
agent-browser screenshot --full /tmp/nanoclaw-test-$(date +%Y%m%d_%H%M%S).png
echo "Screenshot saved to /tmp/nanoclaw-test-*.png"
```

##### Cleanup browser

```bash
agent-browser close
```

---

### Phase 7b: Test Cleanup (Mandatory)

Delete all test coworkers created during the test run. This removes DB rows, messaging groups, destinations, sessions, and group files.

```bash
echo "Cleaning up ${#TEST_IDS[@]} test coworker(s)..."
for ID in "${TEST_IDS[@]}"; do
  echo -n "  Deleting id=$ID... "
  curl -s -X DELETE "http://localhost:$DASHBOARD_PORT/api/coworkers/$ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "FAIL"
done
```

If the DELETE endpoint is not available, clean up manually:

```bash
# List test coworkers in DB
sqlite3 $REPO_ROOT/data/v2.db "SELECT id, name, folder FROM agent_groups WHERE name LIKE 'test-%';"

# Delete by ID (replace <ID>)
sqlite3 $REPO_ROOT/data/v2.db "DELETE FROM agent_groups WHERE id = '<ID>';"
sqlite3 $REPO_ROOT/data/v2.db "DELETE FROM messaging_groups WHERE platform_id LIKE 'dashboard:test-%';"
sqlite3 $REPO_ROOT/data/v2.db "DELETE FROM agent_destinations WHERE agent_group_id = '<ID>' OR destination_agent_group_id = '<ID>';"

# Remove group files
rm -rf $REPO_ROOT/groups/test-*
rm -rf $REPO_ROOT/data/v2-sessions/test-*
```

#### Verify cleanup

```bash
# Should return 0 rows
sqlite3 $REPO_ROOT/data/v2.db "SELECT count(*) FROM agent_groups WHERE name LIKE 'test-%';"

# No test group directories remain
ls -d $REPO_ROOT/groups/test-* 2>/dev/null && echo "FAIL: test dirs remain" || echo "Clean"
```

- [ ] **TC01** All test-* coworkers deleted from agent_groups
- [ ] **TC02** No test-* messaging_groups remain
- [ ] **TC03** No test-* agent_destinations remain
- [ ] **TC04** No test-* group directories remain
- [ ] **TC05** No test-* session directories remain

---

## Quick Diagnostics Reference

These commands use the variables from Phase 1.

```bash
# Recent errors
grep -E 'ERROR|WARN' $REPO_ROOT/logs/nanoclaw.log | tail -20

# Channel connections
grep -E 'Connected|Connection closed|channel.*ready' $REPO_ROOT/logs/nanoclaw.log | tail -5

# Groups loaded
grep 'groupCount' $REPO_ROOT/logs/nanoclaw.log | tail -3

# Container timeouts
grep -E 'Container timeout|timed out' $REPO_ROOT/logs/nanoclaw.log | tail -10

# Messages flowing
grep 'New messages' $REPO_ROOT/logs/nanoclaw.log | tail -10

# Queue state
grep -E 'Starting container|Container active|concurrency limit' $REPO_ROOT/logs/nanoclaw.log | tail -10
```

---

## Known Issues Reference

See `DEBUG_CHECKLIST_LEGO.md` for the full known-issues catalogue (issues #1–#16) and the complete test matrix (T01–T160, S01–S30). This checklist is the operational workflow; that file is the historical record.

### Critical reminders

- **Issue #2**: IDLE_TIMEOUT must be shorter than CONTAINER_TIMEOUT (currently both are 10800000 in lego instance — fix if needed)
- **Issue #3**: Cursor advances before agent succeeds — messages lost on timeout
- **Issue #9**: Per-group `agent-runner-src/` is a persistent copy — always `rm -rf data/v2-sessions/*/agent-runner-src/` after code changes
- **Issue #10/#15**: tsx cache at `/tmp/tsx-1000/` — always clear after dashboard code changes
- **Issue #8**: Codex agents need `CODEX_MODEL`, `CODEX_BASE_URL`, `CODEX_MODEL_PROVIDER`, `CODEX_REASONING_EFFORT` in `.env`
