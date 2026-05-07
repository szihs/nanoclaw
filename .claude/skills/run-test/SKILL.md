---
name: run-test
description: "Comprehensive NanoClaw integration test runner. Auto-detects the instance, verifies build/services/dashboard, runs vitest + bun, walks the full test matrix (100+ tests across refactor, hooks, MCP, scheduler, session persistence, subagents, channels, credentials, security, approvals, provider parity, container lifecycle, observability, multi-instance, migrations, dashboard features, webhooks, self-modification), and opens a task for every failure found. Use after /update-nanoclaw-instance or when you need end-to-end verification."
---

# Run Test

Full integration test runner for a NanoClaw instance. Every failure becomes a tracked task; nothing is silently skipped. Do not paraphrase the check commands — run them verbatim so failures are reproducible.

## When to run

- After `/update-nanoclaw-instance` (verify merges + rebuild + restart are healthy).
- After a composer or rendering change (regression guard).
- Before/after any refactor PR.
- When a user reports "it broke" and you need a structured sweep.

## Operating principles

- **Auto-detect, confirm, then act.** Read `.env` + systemd, show the instance, `AskUserQuestion` before proceeding.
- **Fail loudly.** Every failure → `TaskCreate` with subject `<ID>: <short reason>`.
- **Real commands, not mocks.** `pnpm`, `bun`, `curl`, `agent-browser`, direct SQLite reads.
- **Dynamic type discovery.** Never hardcode `slang-*`/`nanoclaw-*`/`slangpy-*`. Inspect `readCoworkerTypes()`.
- **Mandatory cleanup.** `test-*`-prefixed coworkers + DB rows + group dirs at end.

---

## Phase 1 — Identify + confirm

```bash
REPO_ROOT=$(pwd)
[ -f "$REPO_ROOT/.env" ] || for d in .. ../..; do
  [ -f "$REPO_ROOT/$d/.env" ] && grep -q CONTAINER_PREFIX "$REPO_ROOT/$d/.env" && REPO_ROOT="$(cd "$REPO_ROOT/$d" && pwd)" && break
done
source <(grep -E '^(CONTAINER_PREFIX|CONTAINER_IMAGE|DASHBOARD_PORT|DASHBOARD_INGRESS_PORT|MCP_PROXY_PORT|TZ)=' "$REPO_ROOT/.env")
MAIN_SERVICE=""; DASH_SERVICE=""
for f in ~/.config/systemd/user/nanoclaw-*.service ~/.config/systemd/user/nanoclaw.service; do
  [ -f "$f" ] || continue
  WD=$(grep -oP 'WorkingDirectory=\K.*' "$f"); [ "$WD" = "$REPO_ROOT" ] || continue
  NAME=$(basename "$f" .service); case "$NAME" in *-dashboard) DASH_SERVICE="$NAME";; *) MAIN_SERVICE="$NAME";; esac
done
```

Use `AskUserQuestion` to confirm the detected instance. Abort if the user says no.

---

## Phase 2 — Build + service health (T06–T16)

| ID | Check | Pass criteria |
|---|---|---|
| T06 | `pnpm run build` | Exit 0 |
| T07 | `pnpm test` | All pass (except known drift tests if groups/* is install-dependent) |
| T08 | `pnpm exec tsx scripts/validate-templates.ts` | All leaf types `ok` or `skip` |
| T09 | `pnpm exec tsx scripts/rebuild-claude-md.ts --check` | Exit 0 (no drift) |
| T10 | `docker images \| grep "$(echo $CONTAINER_IMAGE \| cut -d: -f1)"` | Image present |
| T12 | `systemctl --user is-active $MAIN_SERVICE` | `active` |
| T13 | `systemctl --user is-active $DASH_SERVICE` | `active` |
| T14 | `grep "Dashboard ingress listening" $REPO_ROOT/logs/nanoclaw.log \| tail -1` | Non-empty |
| T15 | `grep "MCP tool discovery complete" $REPO_ROOT/logs/nanoclaw.log \| tail -3` | Non-empty per server |
| T16 | `grep FATAL $REPO_ROOT/logs/nanoclaw.error.log` after last restart | Empty |

---

## Phase 3 — Unit + contract tests (100% — do not skip)

```bash
cd $REPO_ROOT
pnpm test                                                    # full vitest
pnpm exec vitest run src/claude-composer-refactor.test.ts    # R-tests
cd container/agent-runner && bun test && cd $REPO_ROOT       # agent-runner
```

Each failure → `TaskCreate` with the assertion message.

---

## Phase 4 — Refactor contract (R01–R12)

The R-tests live in `src/claude-composer-refactor.test.ts` (run as part of Phase 3). Verify they cover:

| ID | Contract |
|---|---|
| R01 | Composed CLAUDE.md embeds full workflow step body |
| R02 | Overlay body inlined at each anchor as `⟐ NAME GATE` block |
| R03 | Extends + override: child override replaces parent step body |
| R04 | No `WORKFLOW.md`/`OVERLAY.md` under `container/skills/` |
| R05 | No `type: workflow|overlay` in `container/skills/*/SKILL.md` |
| R06 | Every `container/spines/*/coworker-types.yaml` uses `container/spines/*` paths |
| R07 | Rebuild idempotency — compose twice = byte-identical |
| R08 | Overlay `## X` headings demoted below `####` gate header |
| R09 | No trailing `## Gates` section |
| R10 | `## How to Work` lists every workflow (no category dedup) |
| R11 | Mount/copy code never pulls workflows/overlay-bodies/spines into containers |
| R12 | Backticked `/workflow` refs → section refs; `/overlay` → Task subagent; `/skill` literal |

---

## Phase 5 — Hook enforcement (H01–H05)

```bash
# Find a coworker with a live container; trigger an Edit without writing a verdict file; expect denial.
```

| ID | Check |
|---|---|
| H01 | `critique-record-gate` PreToolUse hook denies `Edit`/`Write` when `/workspace/agent/critiques/<slug>-round-N.md` is missing |
| H02 | Hook denial surfaces a structured error to the agent (not silent pass) |
| H03 | Hook script crash logs error, does NOT hang the turn |
| H04 | `grep "hook-event" $REPO_ROOT/logs/nanoclaw.log` shows events streaming (within 2s of fire) |
| H05 | `.workflow-state.json` `.critique_rounds` increments per gate |

---

## Phase 6 — MCP round-trip (M01–M06)

| ID | Check |
|---|---|
| M01 | Agent calls `mcp__nanoclaw__send_message` → destination `outbound.db` has the row |
| M02 | Agent calls `mcp__nanoclaw__schedule_task` → row in `scheduled_tasks` table |
| M03 | Agent calls `mcp__nanoclaw__append_learning` → `/workspace/agent/learnings.md` appended |
| M04 | Disallowed MCP tool (in `disallowedMcpTools`) → invocation error |
| M05 | Kill MCP server with `docker kill $(docker ps -q -f name=slang-mcp)` → next tool call succeeds after restart |
| M06 | `curl -k --cacert $CA https://api.github.com/meta` from within container via OneCLI proxy → HTTP 200 |

---

## Phase 7 — Scheduled tasks (SC01–SC07)

| ID | Check |
|---|---|
| SC01 | POST a schedule for T+60s → task fires within 70s → sends message |
| SC02 | Pause task → does NOT fire at scheduled time |
| SC03 | Resume → next fire at next interval |
| SC04 | Cancel → row deleted, no future fires |
| SC05 | Recurring (every 5m) fires N times across 25m window |
| SC06 | Task persists across `systemctl --user restart $MAIN_SERVICE` |
| SC07 | Two tasks due at same second both fire |

---

## Phase 8 — Session persistence & cursor safety (SP01–SP05)

| ID | Check |
|---|---|
| SP01 | Messages queued during container-idle period are processed on next spawn |
| SP02 | Container exits mid-turn → cursor does NOT advance past un-responded message (Issue #3) |
| SP03 | `cp data/v2.db.bak-<stamp> data/v2.db` → restart → all groups visible |
| SP04 | `inbound.db` + `outbound.db` retention policy (`ls data/v2-sessions/*/sess-*` old session pruning) |
| SP05 | Edit `.instructions.md` → next wake regenerates CLAUDE.md with new content |

---

## Phase 9 — Sub-agent / Task tool (A01–A04)

| ID | Check |
|---|---|
| A01 | Agent invokes `Task(subagent_type='codex-critique', ...)` → sub-agent runs with its `agent.md` system prompt |
| A02 | Sub-agent result streams back as tool result |
| A03 | Sub-agent inherits read-only mounts (cannot write to parent workspace) |
| A04 | Sub-agent disallowed tools (`Write`, `Edit`) return error |

---

## Phase 10 — Channel adapters (CA01–CA05)

| ID | Check |
|---|---|
| CA01 | For each channel in `channel-registry`, `start()` returns OK (graceful skip on missing creds) |
| CA02 | Inbound webhook POST to `/api/dashboard/inbound` → row in group's `inbound.db` |
| CA03 | Outbound to two destinations: response reaches both dashboard + CLI simultaneously |
| CA04 | Unknown sender (`unknown_sender_policy=strict`) → message rejected |
| CA05 | CLI channel: stdin → agent response to stdout, with correct session isolation |

---

## Phase 11 — Credentials / OneCLI (CR01–CR05)

| ID | Check |
|---|---|
| CR01 | Credential prompt arrives in dashboard as card with input field |
| CR02 | Submit credential → value reaches OneCLI vault, NOT written to any file |
| CR03 | Reject credential → agent turn continues with graceful error |
| CR04 | Run `~/.config/nanoclaw/refresh-gh-tokens.sh` → old token fails, new token works on next container spawn |
| CR05 | CA cert: `curl --cacert <proxy-ca> https://api.github.com` from container → HTTP 200 |

---

## Phase 12 — Security / isolation (SE01–SE08)

| ID | Check |
|---|---|
| SE01 | Coworker A can NOT read `groups/<other>` — mount isolation |
| SE02 | `/workspace/project` mounted RO → `echo x > /workspace/project/test` fails with EROFS |
| SE03 | Agent cannot `docker exec` or access host socket (no `/var/run/docker.sock` in container) |
| SE04 | Agent calling tool not in `allowedMcpTools` → error |
| SE05 | With `DASHBOARD_SECRET` set: `POST /api/coworkers` without Bearer → 401 |
| SE06 | Cross-origin POST without Origin allowlist → 403 |
| SE07 | Rate limit on `/api/chat/send` (if implemented) — 100 req/s burst → 429 after limit |
| SE08 | Agent response containing `<script>` in message body → rendered as `&lt;script&gt;` in DOM |

---

## Phase 13 — Approval flow (AP01–AP07)

| ID | Check |
|---|---|
| AP01 | Agent `install_packages` MCP tool → row in `pending_approvals` |
| AP02 | `GET /api/approvals` returns the pending item |
| AP03 | `POST /api/approvals/action {approvalId, decision:'Approve'}` → agent turn resumes |
| AP04 | Reject → turn resumes with approval=false, packages NOT installed |
| AP05 | `decision: 'approve'` (lowercase) works identically |
| AP06 | Approval with `expires_at` in the past → auto-rejected |
| AP07 | `ask_user_question` card: options rendered, click → `selectedOption` routed back |

---

## Phase 14 — Provider parity (PR01–PR06)

| ID | Check |
|---|---|
| PR01 | Coworker with `agent_provider: codex` spawns Codex runner |
| PR02 | Codex provider enumerates `.claude/skills/*/SKILL.md` at startup; skill bodies injected |
| PR03 | Codex receives identical composed CLAUDE.md as Claude Code SDK |
| PR04 | Missing `CODEX_MODEL`/`CODEX_BASE_URL`/`CODEX_MODEL_PROVIDER`/`CODEX_REASONING_EFFORT` → startup error (Issue #8) |
| PR05 | `agent_provider: ollama` routes through `ollama serve` (http://localhost:11434) |
| PR06 | `agent_provider: opencode` starts with OpenRouter creds from OneCLI |

---

## Phase 15 — Container lifecycle edge cases (CL01–CL07)

| ID | Check |
|---|---|
| CL01 | `IDLE_TIMEOUT < CONTAINER_TIMEOUT` — idle kill fires first (Issue #2) |
| CL02 | Two messages to same coworker → FIFO, no race |
| CL03 | `wakePromises` dedup: two simultaneous `wakeContainer` → ONE container spawned |
| CL04 | Container repeatedly exits 1 → circuit breaker opens → next message returns error without respawn |
| CL05 | Touch `groups/<name>/CLAUDE.md` → sweep detects stale → kill + respawn with fresh compose |
| CL06 | N+1 concurrent spawns (N = MAX_CONCURRENT) → last one queued |
| CL07 | OOM (`stress --vm 1 --vm-bytes 4G`) → container exits 137 → graceful dashboard update, no hang |

---

## Phase 16 — Observability / health (OB01–OB05)

| ID | Check |
|---|---|
| OB01 | Log line has `sessionId`, `agentGroup`, `containerName`, `messageId` fields |
| OB02 | `curl $DASHBOARD_PORT/api/health` returns 200 + `{ok:true}` (or dashboard-level equivalent) |
| OB03 | Dashboard coworker tile shows error count per coworker |
| OB04 | `logs/nanoclaw.log` rotation: file size cap OR daily rotate |
| OB05 | Circuit breaker state visible (failure count + last failure timestamp) |

---

## Phase 17 — Multi-instance (MI01–MI03)

| ID | Check |
|---|---|
| MI01 | Starting a second instance against same `data/v2.db` → FATAL `Another NanoClaw instance is already running` (PID file) |
| MI02 | Parallel read-while-write on DB → WAL mode, no `SQLITE_BUSY` |
| MI03 | Two instances on different prefix/port → coexist without cross-talk (`nc-lego-*` vs `nc-prod-*`) |

---

## Phase 18 — Data migration (MG01–MG03)

| ID | Check |
|---|---|
| MG01 | Run migration 016 again → idempotent (no duplicate columns/rows) |
| MG02 | `git checkout -B nv-coworkers $OLD_HEAD` + restore DB backup → previous state restored |
| MG03 | v1→v2 migration on a legacy instance (`scripts/migrate-v1-to-v2.ts`) |

---

## Phase 19 — Dashboard UI via agent-browser (B01–B18, BX01–BX08)

If `agent-browser` not installed → mark SKIPPED with task.

```bash
agent-browser open http://localhost:$DASHBOARD_PORT
agent-browser wait --load networkidle
```

**Core B-tests:**

| ID | Check |
|---|---|
| B01 | `#pixel-office` present (canvas or DOM element) |
| B02 | DOM contains `"Connected"` |
| B03 | Status bar `Actors N` with N > 0 |
| B04 | `Coworkers` tab → `.cw-item` lists real coworkers |
| B05 | Click coworker → detail pane opens |
| B06 | Chat input `#chat-input` present |
| B07 | Send ping via API (not UI — React hooks bypass) → response visible in `/api/messages` |
| B08 | XSS payload in user input → `&lt;script&gt;` in DOM, no live tag |
| B09 | `ask_user_question` card renders with option buttons |
| B10 | Click option → `selectedOption` routes back, card shows `(answered)` |
| B11 | `install_packages` → PENDING ACTIONS card with Approve/Reject |
| B12 | Click Approve → rebuild triggers, no duplicate submissions |
| B13 | `+ New` modal: `Create Coworker` heading |
| B14 | Modal: type checkboxes grouped by project |
| B15 | Modal: agent provider selector visible |
| B16 | `test-internal` coworker: Send disabled, placeholder explains routing |
| B17 | Detail panel shows Status, Type, Trigger (no `\b`), clean JID |
| B18 | Detail panel lists MCP Tools, Recent Events clickable |

**Extended BX-tests:**

| ID | Check |
|---|---|
| BX01 | Timeline panel streams tool events in real time via SSE |
| BX02 | Admin panel → logs viewer shows tail of `nanoclaw.log` |
| BX03 | Metrics panel shows token/cost per coworker |
| BX04 | Export coworker → delete → import → identical state |
| BX05 | `POST /api/messages/attachment` → file stored, downloadable via GET |
| BX06 | Memory browser: view/edit `.instructions.md` for a coworker |
| BX07 | SSE reconnect after network blip → no duplicate events |
| BX08 | Long-running turn: SSE preserves message order under load |
| BX09 | Seamless peer refresh: create a new coworker via dashboard `POST /api/coworkers` while the admin agent has an active container session — the row appears in the admin session's `inbound.db::destinations` **without a container restart**. See below for the shell check. |

**BX09 — seamless peer refresh:**

```bash
ADMIN_AG=$(sqlite3 data/v2.db "SELECT id FROM agent_groups WHERE is_admin=1 LIMIT 1;")
ADMIN_SESSION=$(sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='$ADMIN_AG' AND status='active' ORDER BY created_at DESC LIMIT 1;")
SESSION_DB="data/v2-sessions/$ADMIN_AG/$ADMIN_SESSION/inbound.db"

before=$(sqlite3 "$SESSION_DB" "SELECT COUNT(*) FROM destinations;")
# Create a new coworker via the dashboard API (use your auth token if set).
curl -fsSL -X POST "http://localhost:$DASHBOARD_PORT/api/coworkers" \
  -H 'content-type: application/json' \
  -d '{"name":"BX09Temp","folder":"bx09-temp","routing":"internal"}'
after=$(sqlite3 "$SESSION_DB" "SELECT COUNT(*) FROM destinations;")
test "$after" -gt "$before" || { echo "BX09 FAIL: destinations not refreshed"; exit 1; }
# Cleanup
curl -fsSL -X DELETE "http://localhost:$DASHBOARD_PORT/api/coworkers/bx09-temp"
```

This proves the `refreshDestinationsForAgentGroup` projection fires from the dashboard POST path. Pre-fix, `after == before` until the admin container restarts.

Save screenshot to `/tmp/nanoclaw-test-$(date +%Y%m%d_%H%M%S).png`.

---

## Phase 20 — GitHub webhook (GW01–GW03)

| ID | Check |
|---|---|
| GW01 | POST to webhook path with valid signature → inbound message to correct coworker |
| GW02 | Invalid signature → 401 |
| GW03 | Replayed webhook (same `delivery-id`) → deduped |

---

## Phase 21 — Self-modification (SM01–SM02)

| ID | Check |
|---|---|
| SM01 | `/self-customize` invocation creates user-scoped customization without touching core |
| SM02 | `/update-nanoclaw` does NOT run against a prod instance without explicit confirmation |

---

## Phase 22 — DB schema invariants (S23, S26, S28)

```bash
python3 -c "
import sqlite3
c = sqlite3.connect('data/v2.db')
cols = [r[1] for r in c.execute('PRAGMA table_info(agent_groups)').fetchall()]
assert 'routing' in cols, 'S23: routing column missing'
sql = c.execute(\"SELECT sql FROM sqlite_master WHERE name='messaging_groups'\").fetchone()[0]
assert 'UNIQUE(channel_type, platform_id)' in sql, 'S26: UNIQUE constraint missing'
# S28: bidirectional destinations — orchestrator <-> every typed coworker
orch = c.execute(\"SELECT id FROM agent_groups WHERE folder='orchestrator'\").fetchone()[0]
fw = {r[0] for r in c.execute('SELECT target_id FROM agent_destinations WHERE agent_group_id=? AND target_type=\"agent\"', (orch,)).fetchall()}
for cid in fw:
    back = c.execute('SELECT COUNT(*) FROM agent_destinations WHERE agent_group_id=? AND target_id=?', (cid, orch)).fetchone()[0]
    assert back > 0, f'S28: missing back-edge from {cid} to orchestrator'
print('S23/S26/S28 OK')
"
```

---

## Phase 23 — Cleanup (mandatory)

```bash
# Track TEST_FOLDERS as you create test coworkers above.
for folder in "${TEST_FOLDERS[@]}"; do
  curl -s -X DELETE "http://localhost:$DASHBOARD_PORT/api/coworkers/$folder" > /dev/null
done
python3 -c "
import sqlite3
c = sqlite3.connect('data/v2.db')
ids = [r[0] for r in c.execute(\"SELECT id FROM agent_groups WHERE folder LIKE 'test-%'\").fetchall()]
for tid in ids:
    c.execute('DELETE FROM agent_destinations WHERE agent_group_id=? OR target_id=?', (tid, tid))
    c.execute('DELETE FROM agent_groups WHERE id=?', (tid,))
c.execute(\"DELETE FROM messaging_groups WHERE platform_id LIKE 'dashboard:test-%'\")
c.commit()
"
rm -rf $REPO_ROOT/groups/test-* $REPO_ROOT/data/v2-sessions/test-*
```

Verify zero residual:

```bash
[ -z "$(ls $REPO_ROOT/groups/test-* 2>/dev/null)" ] || echo "FAIL: test dirs remain"
python3 -c "import sqlite3; r=sqlite3.connect('data/v2.db').execute(\"SELECT COUNT(*) FROM agent_groups WHERE folder LIKE 'test-%'\").fetchone(); assert r[0]==0"
```

---

## Phase 24 — Summary

Produce a structured report:

```
Instance:      $MAIN_SERVICE ($REPO_ROOT)
HEAD:          <git log --oneline -1>
Build:         <pass|fail>
Unit tests:    <N pass / M fail / K skip>
Bun tests:     <N pass / M fail>
Phase results:
  Refactor (R01-R12):        <pass|fail count>
  Hooks (H01-H05):           <pass|fail count>
  MCP (M01-M06):             <pass|fail count>
  Scheduler (SC01-SC07):     <pass|fail count>
  Session (SP01-SP05):       <pass|fail count>
  Subagent (A01-A04):        <pass|fail count>
  Channels (CA01-CA05):      <pass|fail count>
  Credentials (CR01-CR05):   <pass|fail count>
  Security (SE01-SE08):      <pass|fail count>
  Approvals (AP01-AP07):     <pass|fail count>
  Providers (PR01-PR06):     <pass|fail count>
  Lifecycle (CL01-CL07):     <pass|fail count>
  Observability (OB01-OB05): <pass|fail count>
  Multi-instance (MI01-MI03): <pass|fail count>
  Migration (MG01-MG03):     <pass|fail count>
  UI (B01-B18):              <pass|fail count or SKIPPED>
  UI extended (BX01-BX08):   <pass|fail count or SKIPPED>
  Webhook (GW01-GW03):       <pass|fail count>
  Self-mod (SM01-SM02):      <pass|fail count>
  DB schema (S23/S26/S28):   <pass|fail>
Cleanup:       <N coworkers deleted, 0 residual>
Screenshot:    <path or SKIPPED>
Tasks opened:  <count>
```

List each failing item with its task id.

---

## Known footguns

- **Project-specific coworker types** (`slang-triage`, `nanoclaw-writer`, `slangpy-writer`) exist only on merged sibling branches. Always discover dynamically.
- **`mcpToolCount=0`** on first spawn after restart is a transient MCP-discovery race. Flag only if it persists across a second spawn.
- **Stale FATAL** in error log may predate current restart — compare timestamps against `ActiveEnterTimestamp`.
- **`dashboard-admin`** is a sender id, not a coworker.
- **`DELETE /api/coworkers/<folder>`** can return `{ok:true, dataDeleted:false}`; manual cleanup required.

## References

- `docs/lego-coworker-workflows.md` — composer + registry model
- `docs/USAGE.md` — operator guide
- `.claude/skills/setup/SKILL.md` — prerequisite installation
- `.claude/skills/debug/SKILL.md` — when tests fail with ambiguous symptoms
- `.claude/skills/update-nanoclaw-instance/SKILL.md` — run before `/run-test` when pulling upstream
