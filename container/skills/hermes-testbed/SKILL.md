---
name: hermes-testbed
description: "Hermetic verification harness for Hermes Agent plugin PRs (release v2026.8.31 = 0.21.0): temp-HERMES_HOME testbed with loopback-only sockets and a fake container runtime, the T1–T12 acceptance suite, `hermes plugins doctor --ci` + `hermes approvals test --json` oracles, web-UI parity via `hermes dashboard`/`hermes serve` + agent-browser screenshots, the phase-gated apps/desktop Electron Playwright tier under xvfb-run, and the test-report-<sha7>.md `## Results` rows the reviewer audits — the fixed tier rows plus one AC-<req-id>-<n> row per ADR acceptance criterion, emitted by one test per criterion named test_ac_<req_id>_<n> so the reviewer and the merge gate can join criteria to tests mechanically. Load from the hermes-verify workflow when a [Fix Report] names a PR head, when the orchestrator dispatches a nightly regression run against the fork's main, or when writing/extending T-suite or desktop e2e tests."
provides: [test.run, test.gen]
allowed-tools: Bash(git:*), Bash(uv:*), Bash(hermes:*), Bash(.venv/bin/hermes:*), Bash(scripts/run_tests.sh:*), Bash(bash:*), Bash(curl:*), Bash(npm:*), Bash(npx:*), Bash(xvfb-run:*), Bash(agent-browser:*), Bash(dpkg:*), Bash(node:*), Bash(python3:*), Agent, Read, Write, Grep, Glob, mcp__nanoclaw__send_file
---

# Hermes Testbed (hermes-tester)

You verify; you never build the plugin and you never push. The `hermes-verify` workflow owns intake, checkout, routing and rounds; this skill owns the **mechanisms**: the hermetic harness, the T1–T12 suite, the oracles, the UI and desktop tiers, and the artifact/report shape. The reviewer reads the diff plus your report and re-runs nothing, so every row you write must carry an exit code, a log path, and a command the builder can paste.

Every `file:line` below is relative to the read-only release tree `/workspace/extra/hermes-release` (tag `v2026.8.31`; `pyproject.toml:3` = `0.21.0`). Never invent a flag — the parser files are cited; re-grep them if the fork drifts.

| What | Where |
|---|---|
| Release tree (RO — cite from here; never build, `npm ci`, or `uv sync` inside it) | `/workspace/extra/hermes-release` |
| Fork checkout (shared; never commit on it) | `/workspace/agent/hermes-agent` |
| YOUR worktree at the PR head (hermes-verify step 1; reused across rounds) | `/workspace/agent/wt-verify-<N>` (nightly: `wt-verify-nightly-<date>`) |
| Base-tree worktree for the negative control (no venv of its own) | `/workspace/agent/wt-verify-<N>-base` |
| Testbed root for this thread (`TB`) | `/workspace/agent/testbed/<thread-id>/` |
| Temp `HERMES_HOME` (inside the harness) | `$TB/home` |
| Artifacts + report | `/workspace/agent/reports/<thread-id>/` — `test-report-<sha7>.md`, `artifacts/`, `rounds.log`, `state.md` |

`<thread-id>` is the chain's `thread_id` (normally `hermes-<req-id>`; nightly `hermes-nightly-<YYYY-MM-DD>`), propagated unchanged. NanoClaw gives each thread its own container and network namespace, so a fixed loopback port (`9119`) never collides with another thread's run; the only collision source is a leftover server in THIS container (`hermes serve --status` / `--stop`, `hermes_cli/subcommands/dashboard.py:75-84`).

## 1. Prerequisites (from hermes-verify step 1 — do not redo them here)

`$WT=/workspace/agent/wt-verify-<N>` exists at the head SHA; `$WT/.venv` was synced in an `Agent` subagent (`uv sync --locked --python /usr/bin/python3 --extra dev`, outside `scripts/run_tests.sh`, which `exec env -i`s away the proxy env, `scripts/run_tests.sh:169-183`; never `uv python install`); `/workspace/agent/reports/<thread-id>/artifacts/changed-files.txt` holds `git diff --name-only origin/<BASE>...HEAD`. `[MUST NOT]` touch any sibling `wt-*`.

```bash
THREAD=<thread-id>; N=<pr-or-nightly-date>; TB=/workspace/agent/testbed/$THREAD; WT=/workspace/agent/wt-verify-$N
ART=/workspace/agent/reports/$THREAD/artifacts
mkdir -p $TB/{home/plugins,empty-bundled,bin,kanban,logs,pyguard,fixtures} $ART
```

## 2. Hermetic harness (Step 5 / P2)

The harness is a directory plus one env file. Everything under test runs as `( source $TB/harness.env && cd $WT && <cmd> )` — a **subshell**, never `export`ed into your main shell (it overrides the OneCLI proxy env; your own `gh`/`git` must keep working).

```bash
# (a) plugin under test → user plugin dir of the temp home; bundled dir EMPTY so a stock tree is proven
#     (discovery order + opt-in list: hermes_cli/plugins.py:5-17, 649-670 — the same shape doctor builds, plugin_dev.py:36-73)
PLUGIN=<name>; KEY=<key>                       # key = manifest `name` (flat) or `<cat>/<name>` (plugins.py:4658-4667)
rm -rf "$TB/home/plugins/$PLUGIN" && cp -r "$WT/plugins/$PLUGIN" "$TB/home/plugins/$PLUGIN"
cat > $TB/home/config.yaml <<EOF
plugins:
  enabled: [$KEY]
EOF

# (b) fake container runtime — HERMES_DOCKER_BINARY must be an EXISTING EXECUTABLE FILE (tools/environments/docker.py:324-328)
cat > $TB/bin/fake-docker <<'EOF'
#!/usr/bin/env bash
# Records every invocation; never reaches a daemon. Extend the case table only from what
# $TB/logs/docker-calls.log shows the code under test actually calls — read
# tools/environments/docker.py for the exact probe before faking its output.
echo "$(date -u +%FT%TZ) $*" >> "${HERMES_TESTBED_DIR:?}/logs/docker-calls.log"
case "$1" in
  version|--version) echo "Docker version 99.0.0-testbed"; exit 0 ;;
  run|create)        echo "fake$(date +%s%N | tail -c 13)"; exit 0 ;;
  *)                 exit 0 ;;
esac
EOF
chmod +x $TB/bin/fake-docker

# (c) loopback-only socket guard for every PYTHON process in the harness
#     (same patch points as plugin doctor, hermes_cli/plugin_dev.py:75-77, but loopback is allowed)
cat > $TB/pyguard/sitecustomize.py <<'EOF'
import ipaddress, os, socket
def _ok(addr):
    if not isinstance(addr, tuple):            # AF_UNIX path
        return True
    host = str(addr[0])
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return False                           # DNS names other than localhost: deny, no lookup
def _guard(fn):
    def w(self, addr, *a, **k):
        if not _ok(addr):
            with open(os.environ["HERMES_TESTBED_NETLOG"], "a", encoding="utf-8") as f:
                f.write(f"DENY {addr!r}\n")
            raise OSError(101, f"testbed: non-loopback connect denied: {addr!r}")
        return fn(self, addr, *a, **k)
    return w
socket.socket.connect = _guard(socket.socket.connect)
socket.socket.connect_ex = _guard(socket.socket.connect_ex)   # socket.create_connection routes through connect
EOF

# (d) the env file
cat > $TB/harness.env <<EOF
export HERMES_TESTBED_DIR=$TB
export HERMES_HOME=$TB/home                          # temp home; \`-p <bot>\` re-points it to \$HERMES_HOME/profiles/<bot> (hermes_cli/main.py:521-522, 565)
export HERMES_BUNDLED_PLUGINS=$TB/empty-bundled      # plugins.py:83-93 — stock tree, nothing bundled
export HERMES_ENABLE_PROJECT_PLUGINS=0               # no ./.hermes/plugins pickup (plugins.py:5-17)
export HERMES_PLUGINS_DEBUG=1                        # skip reasons in \`plugins list\` (plugins.py:114-124)
export HERMES_DISABLE_LAZY_INSTALLS=1                # no mid-run pip (tests/conftest.py:545)
export HERMES_SKIP_NODE_BOOTSTRAP=1                  # no node auto-install (hermes_cli/main.py:2434-2435)
export HERMES_TEST_ISOLATION=$TB/home                # state-DB guard treats us as a test run: opening a production ~/.hermes state.db is REFUSED (hermes_state.py:759-767, 846)
export HERMES_KANBAN_HOME=$TB/kanban                 # kanban_db.py:582-584
export HERMES_DOCKER_BINARY=$TB/bin/fake-docker      # docker.py:324-328
export HERMES_DASHBOARD_SESSION_TOKEN=testbed-$THREAD   # pins the loopback session token (web_server.py:589-593)
export HERMES_TESTBED_NETLOG=$TB/logs/net-denials.log
export PYTHONPATH=$TB/pyguard                        # loads sitecustomize (c) into every python child
export http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9
export no_proxy=127.0.0.1,localhost,::1 NO_PROXY=127.0.0.1,localhost,::1
export PATH=$WT/.venv/bin:\$PATH
EOF
cp $TB/harness.env $ART/harness.env                  # the exact environment that produced the results
```

**What the network block does and does not enforce — say this plainly in the report:**

| Layer | Mechanism | Enforced? |
|---|---|---|
| Python processes (hermes CLI, `serve`/`dashboard`, cron tick, kanban, plugin code, the §3a stubs) | `sitecustomize` socket guard (c): non-loopback `connect` raises `OSError(101)` and appends to `net-denials.log` | **Yes** — hard fail, logged |
| `hermes plugins doctor` | its own patch: ALL connects raise (plugin_dev.py:75-77) | **Yes** (stricter than ours) |
| `scripts/run_tests.sh` | re-execs under `env -i` forwarding only PATH/HOME/TZ/LANG/`HERMES_TEST_*` (run_tests.sh:169-183) → PYTHONPATH and proxy vars are **dropped**; conftest sandboxes HERMES_HOME but does not block sockets | **No** — pytest rows are sandboxed, not offline; never claim otherwise |
| Proxy-honouring non-Python clients (npm, curl, Chromium under agent-browser) | `*_proxy=http://127.0.0.1:9` (nothing listens → immediate refuse) + `no_proxy` for loopback | **Best-effort** — only if the client reads proxy env |
| Raw sockets from node / Electron / Chromium | nothing — `unshare -rn`, iptables, CAP_NET_ADMIN are not available in the coworker container | **Not enforceable** — report `network: python-guarded, proxy-pinned; non-python best-effort` |

Hermes ships no offline switch (grep of `HERMES_(OFFLINE|NO_NETWORK)` over the tree: none); the knobs above are the complete set the release supports.

**Fake `api_server` peer (for T5 transport rows).** A remote Hermes exposes the `api_server` platform (OpenAI-compatible, default port 8642, `gateway/platforms/api_server.py:266`). Stand in for it with a loopback Python `http.server` at `$TB/bin/peer-stub.py` bound to `127.0.0.1:0` that logs every request body to `$TB/logs/peer-calls.log` and answers only the routes the plugin under test calls — read the plugin's transport code for those routes, never guess the peer's schema. Point the plugin's peer config at `http://127.0.0.1:<port>`.

**Oracles.**

```bash
( source $TB/harness.env && cd $WT
  hermes plugins doctor plugins/$PLUGIN --ci | tee $ART/doctor.log ; echo doctor_exit=${PIPESTATUS[0]}     # subcommands/plugins.py:161-174; exit 1 iff an error-level finding (plugins_cmd.py:3059-3060)
  hermes plugins list --json > $ART/plugins-list.json                                                       # subcommands/plugins.py:95-121 — assert $KEY present, enabled, no error
  hermes approvals test --env-type local --json -- <command> > $ART/approvals-<n>.json ; echo exit=$?        # subcommands/approvals.py:84-113; exit 0 allow / 2 ask-approval / 3 deny (approvals_test.py:159-180)
)
```

`approvals test` evaluates the REAL guards in runtime order — hardline → sudo-stdin → user `approvals.deny` → yolo/off → `command_allowlist` → dangerous patterns — without executing anything (approvals_test.py:49-143). Always `--env-type local`: `docker`/`singularity`/`modal`/`daytona`/`vercel_sandbox` skip every guard and answer `allow` (tools/approval.py:4084-4086), which makes a policy plugin look right when it is not. Assert on the JSON `verdict` and `rule` fields, never on the prose `detail`.

## 3. Suite T1–T12

Ids are the plan's (v1 §5, carried into v2 P2) — never renumber, never add `T13`. Results vocabulary: `PASS | FAIL | SKIPPED(<reason>) | ADVISORY-FAIL`. `tier`: `none` = zero model calls (always runs); `cheap`/`opus` = needs a model → runs against the loopback stub (§3a) by default, the real provider only when the dispatch says `tier=live`; when no stub is available for the row, `SKIPPED(no-provider)` — listed, never counted as PASS. Each row logs to `$ART/T<nn>.log` and appends `id<TAB>result<TAB>exit<TAB>log` to `$ART/results.tsv`.

| id | Proves | Command (inside `source $TB/harness.env`) | Pass criterion | tier |
|---|---|---|---|---|
| T1 | Install @ pinned ref | `hermes --version` (`_parser.py:151`) after the §1 sync | exit 0; output contains `0.21.0` (pyproject.toml:3) — or the fork's version if the PR bumps it; record which | none |
| T2 | Gateway + UI handshake | `hermes serve --host 127.0.0.1 --port 9119 --isolated > $ART/serve.log 2>&1 &` (dashboard.py:26-31, 51-60, 136-170); wait for `HERMES_BACKEND_READY port=9119` (web_server.py:19932) or `Hermes backend listening on` (19948); `curl -fsS http://127.0.0.1:9119/api/health` (web_server.py:3680); `python -c` with `websockets` (pinned, pyproject.toml:125) to `ws://127.0.0.1:9119/api/ws?token=$HERMES_DASHBOARD_SESSION_TOKEN` (route 17618-17624; loopback accepts `?token=`, 16406; HTTP `_require_token` routes take the `X-Hermes-Session-Token` header, 593, 742) | health `ok:true`, `auth_required:false` (loopback → no gate, web_server.py:798-803); WS upgrade accepted; `GET /` is NOT the SPA (`serve` sets HERMES_SERVE_HEADLESS=1, main.py:12203-12206) | none |
| T3 | Team constructed | per fixture bot: `hermes profile install $TB/fixtures/<bot> --name <bot> -y` (subcommands/profile.py:153-180; local dir with `distribution.yaml` at root, 157-159) — or `hermes profile create <bot> --no-alias` (29-64) when no distribution exists; then mark it Bot-Mode-managed the way the desktop's hermes-bots plugin does through the `profiles.configure` RPC (tui_gateway/methods_profiles.py:749, 780-782 — merges `ui_meta` key-wise into `profile.yaml`): `python3 -c` that `yaml.safe_load`s `$HERMES_HOME/profiles/<bot>/profile.yaml` (or `{}`), sets `ui_meta: {hermes-bots: {title: <bot>}}` (block shape: tests/tools/test_bot_mode_probe.py:24-27) and `yaml.safe_dump`s it back. **No CLI writes this block** — `profile install` / `profile create` never do, and `profile.yaml` is not distribution-owned (profile_distribution.py:88-95), so the fixture step is the only hermetic way to get a bot-managed roster. Finally `hermes profile list` | `$HERMES_HOME/profiles/<bot>/` exists per bot and `hermes profile list` names each; `SOUL.md` bytes ≡ fixture (`cmp`); `profile.yaml` carries the `ui_meta.hermes-bots` block; AFTER that step `python -c "from tools.bot_mode_probe import get_bot_mode_protocol_section as g; print(g('$HERMES_HOME'))"` (bot_mode_probe.py:288) names every bot — before it the probe returns `""` by design (`_build_section` :242-248 needs ≥1 bot-managed profile, `_is_bot_managed` :60-76), which is not a team failure; log both outputs to `T03.log` | none |
| T4 | Model call works | `hermes -p <bot> -z 'say hi'` (`_parser.py:154-155`; `-p` pre-parsed, main.py:521-522) against the §3a stub | exit 0; transcript contains the stub's canned reply; `net-denials.log` unchanged | cheap (stub) |
| T5 | A2A delegation (transport) | one-shot DM from bot A to bot B through the plugin's transport, peer = the §2 fake `api_server` stub or B's own `hermes serve`; then `python -c` over `$HERMES_HOME/profiles/<B>/state.db` (join sessions/messages) | a reply row exists in B's `state.db` for the dispatched message id; `peer-calls.log` shows exactly the expected calls | cheap (stub) |
| T5b | A2A via `message_agent` (tool path) | orchestrator bot prompted to use the tool; completion notification lands | advisory, model-dependent → `SKIPPED(tier=live)` unless dispatched live; a live miss is `ADVISORY-FAIL` | opus |
| T6 | Topology fence | ask bot A to contact a bot outside its wiring → expect refusal | advisory, LLM-judged → `SKIPPED(tier=live)` unless dispatched live. The hard fence is the sandbox port (P4), not this row | opus |
| T7 | Kanban DAG | seed a board under `$HERMES_KANBAN_HOME`; `hermes kanban dispatch --dry-run --json` (kanban.py:790-802; root override kanban_db.py:582-584) | JSON shows parents gating the child; after marking parents done the child is promoted; zero model calls; nothing written outside `$TB/kanban` | none |
| T8 | Cron bot routines | `hermes cron add '<schedule>' '<prompt>' --deliver bot-chat:<bot>` (cron.py:27-44); `hermes cron tick` (cron.py:328) or `hermes cron run <job_id>` (268-270) | job present in `$HERMES_HOME/cron/jobs.json` (no `--json` on `cron list`, cron.py:23); tick exits 0 and the run is recorded | cheap (stub) |
| T9 | Restart recovery | `kill -TERM <serve-pid>`; wait for exit; relaunch `hermes serve` as in T2 | fresh ready line; the T4/T5 sessions still resolve by title (session list or `state.db`); transcripts byte-identical before/after | none |
| T10 | UI: sidebar/profile rail shows the team | §4 on `hermes dashboard`; `agent-browser snapshot -i` | every T3 bot name in the rail; `$ART/ui-T10-home.png` | none |
| T11 | UI: New-Agent-via-UI creates a working bot | §4: drive the new-agent flow by `@ref`; `hermes profile list` | new profile dir under `$HERMES_HOME/profiles/`; a `-z` one-shot against it exits 0 (stub); `$ART/ui-T11-new-agent.png` | cheap (stub) |
| T12 | UI: Bot Chat thread renders | §4: open the bot's chat, send one message, wait (bounded) for the reply | reply visible in `snapshot`; no `[role="alert"]`; `$ART/ui-T12-bot-chat.png` | cheap (stub) |

(v1 lists T10–T12 as one row; these are that row's three bullets. T10–T12 run in the UI tier, §4.)

### 3a. Loopback model stub (hermetic default for `cheap`/`opus` rows)

The desktop e2e ships the reference: a mock OpenAI-compatible inference server on `127.0.0.1` (apps/desktop/e2e/mock-server.ts:655) and the exact `config.yaml` shape that points Hermes at it (fixtures.ts:160-189: `model.default: mock-model`, `model.provider: mock`, `providers.mock.api: <url>/v1`, `api_mode: chat_completions`, `key_env: MOCK_API_KEY`, `models: {mock-model: {}}`; `.env` with `MOCK_API_KEY=...`, 195-198). Write the Python equivalent at `$TB/bin/model-stub.py` (`http.server`, `POST /v1/chat/completions` → one canned completion, bind `127.0.0.1:0`, print the port), append that provider block to `$TB/home/config.yaml`, write `$TB/home/.env`. The stub is Python, so it runs under the same socket guard. Never point the harness at a real provider unless `tier=live` was dispatched (§7).

**Live tier via OneCLI — a dummy key, never a real one.** When a dispatch says `tier=live` for a row that genuinely needs a real model (T5b, T6), the hermetic `config.yaml` may point at the real inference `base_url` with a **dummy** `api_key` (`key_env: LIVE_API_KEY`, `LIVE_API_KEY=unused-testbed` in `$TB/home/.env`). The container's egress goes through the OneCLI proxy, which injects the real credential per request from the vault — so a placeholder is all Hermes ever needs to hold, and the credential never enters the testbed, the config, the logs, the report, or an artifact. **Never write a real API key anywhere under `$TB`, `$WT`, or `$ART`**, never read one out of the environment to paste into a config, and never ask for one: a row that "needs the key" is a row you record as `SKIPPED(no-provider)`. Two harness knobs have to be relaxed for the call to leave the container, and both go in the report's `## Network` section for that run: the §2 socket guard must allow the inference host (add it to `_ok`'s allow-list explicitly, by host — never disable the guard), and the `*_proxy` pin must be dropped back to the container's own OneCLI proxy values instead of `127.0.0.1:9`. Do that in a separate `$TB/harness.live.env` used only by the live rows; the default `harness.env` stays offline, and every other row keeps running under it.

### 3b. Companion rows the reviewer's gate checks (same run, same harness)

```bash
( source $TB/harness.env && cd $WT
  scripts/run_tests.sh tests/plugins/test_<plugin>_acceptance.py > $ART/acceptance.log 2>&1 ; echo acceptance_exit=$?        # ACCEPTANCE — PASS
  uv run ruff check plugins/$PLUGIN tests/plugins/ > $ART/ruff.log 2>&1 ; echo ruff_exit=$?                                   # RUFF — clean (blocking in CI; pyproject.toml:624-660)
  python3 scripts/check-windows-footguns.py > $ART/footguns.log 2>&1 ; echo footguns_exit=$?                                # FOOTGUNS — clean
)
# NEGATIVE-CONTROL — the acceptance test must FAIL on the base tree (hermes-verify step 2h owns the exact recipe):
#   worktree wt-verify-<N>-base at origin/<BASE>, `.venv` SYMLINKED from $WT (runner probes <worktree>/.venv, run_tests.sh:54-75),
#   copy the acceptance test in, run it there → EXPECT non-zero. Exit 0 = the test does not test the plugin → row FAIL.
# FOCUSED-PYTEST — `scripts/run_tests.sh tests/plugins/ tests/hermes_cli/` in an `Agent` with explicit timeout; `⚠ FLAKY` = FAIL for that file.
```

### 3c. Acceptance-criterion rows `AC-<req-id>-<n>` — the `test.gen` contract

The `ACCEPTANCE` row above says "the acceptance file passed". That is not enough to merge on: nobody reads this diff, so the reviewer and the Orchestrator's merge gate need to see **each acceptance criterion individually satisfied by a named test**. The join is by id, and it is mechanical — there is no prose step where a human decides whether criterion 3 was "basically covered".

**The id.** The architect's ADR carries a `## Acceptance criteria` table with one row per criterion and a stable id `AC-<req-id>-<n>`: `AC-FR-3-1`, `AC-SR-2-4`. `<n>` is 1-based and ids are **never renumbered** — a criterion added in a later ADR revision takes the next free `<n>`, a dropped one leaves a hole. Round 2 reuses round 1's ids exactly.

**The rule.** `test.gen` emits **exactly one test function per criterion**, in `tests/plugins/test_<plugin>_acceptance.py`, named by lowercasing the id and replacing `-` with `_`:

```python
def test_ac_fr_3_1(tmp_path, monkeypatch):
    """AC-FR-3-1: a peer DM dispatched through the plugin lands as a reply row in the target profile's state.db."""
    ...
```

First docstring line = the criterion id + its text verbatim. One criterion may not be split across two tests (which one is the row?) and two criteria may not share one test (which one failed?); a criterion needing several assertions gets them inside its one function. Shape and rules are otherwise the ordinary ones — behaviour contracts, no snapshots, no source reading, nothing under `~/.hermes`, `tests/hermes_cli/test_plugin_api_compat.py:14-52` as the template — and the file still runs under `scripts/run_tests.sh`, never bare `pytest`.

**Harvesting the rows.**

```bash
( source $TB/harness.env && cd $WT
  scripts/run_tests.sh tests/plugins/test_<plugin>_acceptance.py > $ART/acceptance.log 2>&1 ; echo acceptance_exit=$?
  grep -n "^def test_ac_" tests/plugins/test_<plugin>_acceptance.py > $ART/ac-functions.txt   # ids that exist at this head
)
```

Then one `## Results` row per **ADR** id (never per test found):

| ADR id | test at this head | pytest outcome | row |
|---|---|---|---|
| present | present | passed | `PASS`, evidence = the node id |
| present | present | failed / errored | `FAIL`, evidence = node id + first assertion |
| present | present | skipped / deselected / not collected | `FAIL` — a criterion that was not exercised was not met; the skip reason goes in `## Skipped / advisory` |
| present | absent | — | `FAIL`, evidence = `no test — criterion unimplemented`, exit `–`, log `artifacts/ac-functions.txt` |
| absent | present | — | no row; list it in `## Skipped / advisory` as `orphan test id <name>` |

**A criterion with no test id is a `FAIL`, never a silent omission.** Do not fold it into `ACCEPTANCE`, do not record it as `SKIPPED`, do not drop it because the builder said it was out of scope, and never renumber ids so the two sets line up. Any non-`PASS` `AC-` row makes the report verdict `FAIL` (§6) — which is the point: an unimplemented criterion should stop the merge at the tester, not at a human who is not there.

**If you write the tests yourself** (§5): same rule, same naming, and the diff travels as `$ART/tests.patch` + `send_file` — you never push, and you never invent a criterion the ADR does not list (report the gap in `## Failures` and let the architect amend the ADR).

## 4. UI parity (T10–T12 and any UI-touching PR)

Parity = the stock UI still works with the plugin enabled (R4: zero UI-code changes). The visual baseline is the most recent nightly's `ui-*.png` (`ls -d /workspace/agent/reports/hermes-nightly-*/ | sort | tail -1`); no nightly yet → record `baseline: none`, screenshots stand alone. The release tree cannot host a baseline server: it is read-only, and `hermes dashboard` writes its Vite bundle to `hermes_cli/web_dist/` inside the tree (main.py:6141-6145; web/vite.config.ts:103) while `npm ci` writes `node_modules/`.

**One-time SPA build — network, so it runs in an `Agent` BEFORE any harness subshell, never inside one.** Reuse first: a dist built for an earlier head is valid while `git diff --quiet <dist-sha> HEAD -- web/ apps/shared/` holds; keep copies at `/workspace/agent/build/web_dist-<sha7>/` and hand one in via `HERMES_WEB_DIST` (honoured at main.py:12207; validated on the `--skip-build` path 12210-12215).

```
Agent(prompt="cd /workspace/agent/wt-verify-<N> && [ -d node_modules ] || npm ci --no-fund --no-audit > /workspace/agent/testbed/<thread-id>/logs/npm-ci.log 2>&1; echo npm_ci_exit=$?; npm run build --workspace web >> /workspace/agent/testbed/<thread-id>/logs/npm-ci.log 2>&1; echo web_build_exit=$?; ls hermes_cli/web_dist/index.html && cp -r hermes_cli/web_dist /workspace/agent/build/web_dist-$(git rev-parse --short=7 HEAD). Root workspaces: apps/*, web (package.json). Report both exit codes, last 20 log lines on failure.")
```

Then, hermetically (fixed port; `serve` from T2 must be down first — `hermes serve --status`):

```bash
( source $TB/harness.env && cd $WT
  export HERMES_WEB_DIST=/workspace/agent/build/web_dist-<sha7>          # or omit and drop --skip-build to let dashboard build (needs network → not inside the harness)
  hermes dashboard --host 127.0.0.1 --port 9119 --no-open --isolated --skip-build > $ART/dashboard.log 2>&1 &   # dashboard.py:26-31, 42-50, 51-60, 101-109
  echo $! > $TB/dashboard.pid
  timeout 300 bash -c "until grep -qE 'HERMES_DASHBOARD_READY port=|Hermes Web UI' $ART/dashboard.log; do sleep 2; done"   # web_server.py:19932, 19950 — bounded
  curl -fsS http://127.0.0.1:9119/api/health || { echo UI_NOT_READY; exit 1; }
)
```

`--isolated` (dashboard.py:51-60) is a no-op on a fresh home (active profile = default) and matters only when a named profile launched the server — kept so a `-p <bot>` launch is scoped to that profile instead of re-execing as the machine dashboard (main.py:12063-12091). `EADDRINUSE` → `hermes dashboard --stop`, retry once, then FAIL with the log. A fresh `HERMES_HOME` has no provider unless §3a configured one, so an onboarding overlay is an expected first screen — record what rendered.

**Drive with agent-browser** (headless Chromium is the image default, `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`; `no_proxy` keeps loopback off the dead proxy):

```bash
agent-browser open "http://127.0.0.1:9119/"
agent-browser wait --load networkidle
agent-browser snapshot -i                      # refs @eN for clicks/fills; re-snapshot after navigation or DOM changes
agent-browser screenshot $ART/ui-T10-home.png --full
# T11: click/fill by @ref through the new-agent flow → agent-browser screenshot $ART/ui-T11-new-agent.png
# T12: open the bot's chat, fill + press Enter, agent-browser wait --text "<canned stub reply>" → screenshot $ART/ui-T12-bot-chat.png
agent-browser close
kill -TERM $(cat $TB/dashboard.pid)
```

Naming: `artifacts/ui-T<nn>-<slug>.png`; multi-step rows add `-<step 2 digits>` (`ui-T11-02-form.png`). Compare with the same-named baseline when one exists (`python3 -c` PIL pixel diff if PIL imports, else `cmp -s` + note `byte-compare only`): a diff > 1 % of pixels is a **FAIL** for a PR that did not touch `web/**`/`apps/shared/**`, and a listed REVIEW-ITEM (not a failure) for one that did. Every wait is bounded (`agent-browser wait --text/--url/--load` under an outer `timeout`, `/agent-browser` rule); on timeout take one `snapshot -i` + screenshot, save both, FAIL the id, move on — never re-enter a wait.

## 5. Desktop / Electron tier (phase-gated; never fails the run on missing deps)

The human's order: **check desktop/electron works, then write the tests.** So: preflight → smoke one existing spec → only then run the set / add specs.

**Preflight (cheap, no installs):**

```bash
node --version; npm --version                  # apps/desktop engines: node ^22.22.0 || ^24.11.0 || >=26.0.0; npm <11.10.0 || >=11.17.0 (root package.json engines)
command -v xvfb-run xauth                      # e2e-desktop.yml:113 runs playwright under xvfb-run; xvfb-run shells out to xauth
for p in xvfb libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libdrm2 libgbm1 libasound2; do dpkg -s "$p" >/dev/null 2>&1 && echo "ok $p" || echo "MISSING $p"; done   # CI set e2e-desktop.yml:37-40 (Ubuntu spells it libasound2; the Debian image = libasound2)
ls $WT/node_modules/electron/dist/electron $WT/apps/desktop/node_modules/electron/dist/electron 2>/dev/null   # either layout (e2e/electron-binary.ts:30-38); the binary is downloaded by electron's postinstall during the §4 `npm ci` (e2e-desktop.yml:52-57)
```

The coworker image has chromium's share (`libgtk-3-0 libnss3 libdrm2 libgbm1 libasound2 libatk-bridge2.0-0`, nanoclaw `container/Dockerfile`) and **no `xvfb`**, so a fresh group's first run is expected to be SKIPPED.

**DESKTOP=SKIPPED rule.** Any preflight miss → the `DESKTOP` row reads `SKIPPED — install_packages: <only the missing apt names>`, the `## Skipped / advisory` section carries the request below verbatim, the run continues, and the verdict is decided by §3/§4 alone. You do not `apt-get`, do not `npm install -g electron`, do not patch `playwright.config.ts`, do not add `--no-sandbox` anywhere (the fixtures already pass it, fixtures.ts:316-320 — a code change is the builder's). The operator applies the request (`ncl groups config add-package`) or the orchestrator issues it as the agent tool call:

```
install_packages({ apt: ["xvfb", "xauth", "libnotify4", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0"], npm: [], reason: "hermes-tester: run apps/desktop Playwright e2e (Electron 40.10.2, @playwright/test 1.62.1) under xvfb-run for the Hermes desktop verification tier. Mirrors .github/workflows/e2e-desktop.yml:37-40; libgtk-3-0 libnss3 libdrm2 libgbm1 libasound2 are already in the image." })
```

Electron binary missing after a successful `npm ci` → `SKIPPED — electron-binary-missing (postinstall download blocked?)`, log path. Electron starting but dying on the sandbox helper / user namespaces → `SKIPPED — electron-sandbox: <first error line>`.

**Gates pass → build once, smoke, then run** (each in an `Agent` with explicit `timeout`; reuse `apps/desktop/dist` while `git diff --quiet <dist-sha> HEAD -- apps/` holds):

```
Agent(prompt="cd /workspace/agent/wt-verify-<N>/apps/desktop && npm run build > /workspace/agent/reports/<thread-id>/artifacts/desktop-build.log 2>&1; echo build_exit=$?; ls dist/electron-main.mjs dist/index.html. (`hermes desktop --source --build-only` is the CLI equivalent, subcommands/gui.py:15-34 — never plain `hermes desktop`, it launches and blocks.) Report exit + missing files.")
```

```bash
( source $TB/harness.env && cd $WT/apps/desktop
  export CI=true OPENROUTER_API_KEY= OPENAI_API_KEY= NOUS_API_KEY=                                   # e2e-desktop.yml:120-125 — no real keys reach the app
  # smoke: does Electron start at all under xvfb? (boot → backend spawn → chat; 90 s/test cap, playwright.config.ts:37)
  xvfb-run -a --server-args="-screen 0 1280x1024x24" npx playwright test e2e/boot.spec.ts e2e/mock-backend-setup.spec.ts e2e/chat.spec.ts --reporter=list > $ART/e2e-smoke.log 2>&1 ; echo smoke_exit=$?
  # PR set: the rest of e2e/ in a second chunk (serial — fullyParallel:false, playwright.config.ts:40); full e2e/ + --update-snapshots (into artifacts/ only) on the nightly
  PLAYWRIGHT_JUNIT_OUTPUT_NAME=$ART/junit-desktop.xml \
  xvfb-run -a --server-args="-screen 0 1280x1024x24" npx playwright test --reporter=list,junit > $ART/e2e.log 2>&1 ; echo e2e_exit=$?
  cp -r playwright-report $ART/playwright-report
)
```

Why this is hermetic enough: the fixtures sandbox `HERMES_HOME`, set `HERMES_DESKTOP_IGNORE_EXISTING=1` and `HERMES_DESKTOP_HERMES_ROOT=<repo root>` (fixtures.ts:239-243), so the app spawns `hermes serve` from YOUR worktree — the python probe tries `.venv/bin/python` before `venv/bin/python` (electron/main.ts:2422-2423; the root override wins, 4640-4648), so the uv venv is found; Electron launches with `--disable-gpu --no-sandbox` (fixtures.ts:316-320); the inference mock binds `127.0.0.1` (mock-server.ts:655). Electron and node are outside the Python socket guard (§2 table) — say so. No `*-snapshots` baselines exist in the fork, so visual diffs are surfaced, not failed (playwright.config.ts header); never `--update-snapshots` on a PR run. A desktop FAIL blocks the verdict only when `changed-files.txt` touches `apps/desktop/**`, `apps/shared/**`, `web/**`, or `tui_gateway/**`; otherwise check the fork's own `E2E Desktop` workflow (`gh run list --repo slang-coworkers/hermes-agent --workflow "E2E Desktop" --limit 3`) — the same spec failing on the default branch is `FAIL(pre-existing: <spec>)`, listed, non-blocking.

**Writing desktop tests (test.gen).** New specs go in `$WT/apps/desktop/e2e/<name>.spec.ts` on the shared fixtures (`fixtures.ts` `mockBackend` / `noProvider`, header 1-20) with `expectVisualSnapshot` from `visual-snapshot.ts` for screenshots; helper unit tests are `*.unit.test.ts` (vitest project, ignored by Playwright — playwright.config.ts:31-35). New T-suite tests go under `tests/plugins/` in the shape of `tests/hermes_cli/test_plugin_api_compat.py:14-52` and run via `scripts/run_tests.sh`. **Anything written for an acceptance criterion follows §3c**: one test per `AC-<req-id>-<n>`, named `test_ac_<req_id>_<n>`, criterion text as the first docstring line — including a desktop spec, where the criterion id goes in the `test(...)` title (`test('AC-FR-7-2: … ', …)`) so the node id still names it. You never push: `git -C $WT diff > $ART/tests.patch`, attach it; the builder commits.

## 6. Artifacts + `test-report-<sha7>.md`

```
/workspace/agent/reports/<thread-id>/
├── test-report-<sha7>.md      # one per head SHA (the reviewer globs test-report-*.md and rejects a SHA ≠ PR head); OUTPUT_REVIEW attests its hash
├── rounds.log · state.md      # round counter + resume state (hermes-verify steps 0/5)
├── artifacts-round<k>.tgz     # bulky logs bundled once per round
└── artifacts/
    ├── results.tsv · junit.xml           # T-suite rows; junit.xml generated from results.tsv by a ~20-line python3 helper (classname "hermes-testbed", one <testcase> per row id)
    ├── T01.log … T12.log · doctor.log · plugins-list.json · acceptance.log · negative-control.log · ruff.log · footguns.log · pytest-focused.log
    ├── serve.log · dashboard.log · docker-calls.log · peer-calls.log · net-denials.log · npm-ci.log · desktop-build.log · e2e-smoke.log · e2e.log · junit-desktop.xml
    ├── ui-T10-home.png · ui-T11-new-agent.png · ui-T12-bot-chat.png · playwright-report/
    ├── changed-files.txt · harness.env
    └── tests.patch                      # only when you wrote/changed tests (§5)
```

**Header:** `# Test Report — <fork-slug>#<N> — head <sha> — round <k>/2 — <PASS|FAIL>` (nightly: `# Test Report — nightly <date> — head <sha> — <PASS|FAIL>`), then the canonical path, PR URL, base SHA, requirement id, plugin key, ADR path, worktree, thread id.

**Sections, in order:** `## Verdict` (`PASS | FAIL`, plus `UI=<PASS|FAIL|SMOKE-ONLY>` and `DESKTOP=<PASS|FAIL|SKIPPED — …>`); `## Results` — **one row per tier, these ids verbatim** (the reviewer's gate checks them), opened by this **exact** header line and separator, five columns, no extras, no reordering:

```
| row | result | exit | log | evidence |
|---|---|---|---|---|
| DOCTOR | PASS | 0 | artifacts/doctor.log | "OK: runtime discovery, manifest parsing, import, and registration passed" |
| LIST | PASS | 0 | artifacts/plugins-list.json | <key> enabled, error null |
| ACCEPTANCE | PASS | 0 | artifacts/acceptance.log | tests/plugins/test_<plugin>_acceptance.py 3 passed |
| NEGATIVE-CONTROL | PASS | 1 | artifacts/negative-control.log | acceptance FAILS on origin/<BASE> (expected non-zero) |
| RUFF | PASS | 0 | artifacts/ruff.log | |
| FOOTGUNS | PASS | 0 | artifacts/footguns.log | |
| FOCUSED-PYTEST | PASS | 0 | artifacts/pytest-focused.log | tests/plugins + tests/hermes_cli; FLAKY: none |
| SUITE T1 | PASS | 0 | artifacts/T01.log | hermes --version → 0.21.0 |
| … one row per id through SUITE T12 (T5b/T6 as SKIPPED(tier=live) or ADVISORY-FAIL; T10–T12 point at ui-*.png) … |
| UI | PASS | 0 | artifacts/dashboard.log | /api/health ok; ui-T10/T11/T12 png; baseline <nightly-date|none>; diff <n>% |
| DESKTOP | SKIPPED — install_packages: xvfb xauth libnotify4 libxss1 libxtst6 xdg-utils libatspi2.0-0 | – | artifacts/desktop-preflight.log | see Skipped / advisory |
| AC-FR-3-1 | PASS | 0 | artifacts/acceptance.log | tests/plugins/test_a2a_acceptance.py::test_ac_fr_3_1 |
| AC-FR-3-2 | FAIL | 1 | artifacts/acceptance.log | tests/plugins/test_a2a_acceptance.py::test_ac_fr_3_2 — AssertionError: peer reply not recorded |
| AC-FR-3-3 | FAIL | – | artifacts/ac-functions.txt | no test — criterion unimplemented |
```

The `AC-<req-id>-<n>` rows come **last, in ADR order, one per criterion** (§3c). Their `result` cell is `PASS` or `FAIL` only — no `SKIPPED`, no `ADVISORY-FAIL`, no `N/A`, no `✅` — and their `evidence` cell is a pytest **node id** or the literal `no test — criterion unimplemented`. The reviewer's `## Acceptance criteria` cross-walk and the Orchestrator's merge gate join the ADR to this table by id, so a renamed header, a collapsed range row (`AC-FR-3-1..3 PASS`), a missing id, or an invented id breaks the merge silently.

then `## Network` — the §2 enforcement table with the line count of `net-denials.log`; `## Failures` — per failing row: command, exit, first failing assertion or last 30 log lines, and `reproduce with:` one paste-able line; `## Skipped / advisory` — reasons, the verbatim `install_packages` request when `DESKTOP=SKIPPED`, T5b/T6 outcomes, the negative-control caveat for CORE-CHANGE PRs; `## Environment` — `hermes --version`, `python3 --version`, `uv --version`, `node --version`, `npm --version`, container gaps; `## References` — release-tree `file:line` for every command relied on. Round 2 = a NEW `test-report-<newsha7>.md` with a `## Delta from round 1 (head <oldsha7>)` section; rows not re-run are copied with `(round 1)` in the evidence column.

**Verdict rule.** `PASS` iff `DOCTOR`, `ACCEPTANCE`, `NEGATIVE-CONTROL`, `RUFF`, `FOOTGUNS`, `FOCUSED-PYTEST` all PASS **and every `AC-<req-id>-<n>` row is PASS** **and** every non-advisory, non-skipped `SUITE` row is PASS **and** `UI` is PASS or SMOKE-ONLY **and** `DESKTOP` is not a blocking FAIL. Advisory rows and SKIPPED rows never flip the verdict — and never hide: every SKIPPED carries its reason. `AC-` rows have no advisory or skipped state; one non-`PASS` criterion is a `FAIL` report.

**`[Test Report]` message** (marker-prefixed → always a reply, `in_reply_to=<intake-id>` — the builder's Fix Report, the reviewer's re-run request, or the orchestrator's nightly dispatch; exact routing per hermes-verify step 7):

```
[Test Report] <fork-slug>#<N> (round <k>/2, head <sha7>)
- **Verdict:** PASS | FAIL | FAIL ×2 — ESCALATE
- **Matrix:** doctor OK|FAIL; acceptance PASS|FAIL; negative control FAILS-on-base|PASSES-on-base; T1–T9 <p>/<n> PASS (skipped: <ids|none>; advisory: <ids|none>); UI T10–T12 <PASS|FAIL|SMOKE-ONLY>; DESKTOP=<PASS|FAIL|SKIPPED — install_packages: <pkgs>>
- **Acceptance criteria:** <p>/<n> PASS — AC-<req-id>-1 … AC-<req-id>-<n> (ADR <path>); FAIL: <ids | none>
- **Network:** python-guarded + proxy-pinned; non-python best-effort; denials logged: <n>
- **Failing:** <row> — exit <code> — <first assertion> | none
- **Report:** attached — test-report-<sha7>.md (+ artifacts-round<k>.tgz)
- **Next-action:** hermes-reviewer reviews the diff against this report | builder fixes <rows> and re-requests (round <k+1>/2) | orchestrator decides (round cap)
- **Blocker:** none | <top failing row>
```

followed by `send_file(in_reply_to=<intake-id>, path="/workspace/agent/reports/<thread-id>/test-report-<sha7>.md")` — the file MUST travel as an attachment; the builder forwards it with its review request and the reviewer rejects a pasted or summarised report.

## 7. Cost rules

- **One `/codex-critique` per run, `STAGE: OUTPUT_REVIEW`, on `test-report-<sha7>.md` (attested) + the exact `[Test Report]` text, at the very end.** No per-row, per-tier, or per-step critique; never on logs or on the diff. Must-fix → edit the report → `codex-reply` on the same thread (3 rounds max). Write nothing under `reports/<thread-id>/` between the approve and the send — the gate re-hashes the attested file.
- **Never clone or copy the release tree.** Cite from `/workspace/extra/hermes-release`; build/test only in `wt-verify-<N>`. Never `uv python install`; never a second `uv sync` when `.venv` already imports `hermes_cli`; the negative control reuses the PR venv via symlink.
- **Reuse across rounds and nights:** the worktree, `.venv` (unless `uv.lock`/`pyproject.toml` changed), `node_modules` (unless `package-lock.json`/`apps/desktop/package.json` changed), `web_dist-<sha7>` (unless `web/`/`apps/shared/` changed), `apps/desktop/dist` (unless `apps/` changed), the nightly baseline screenshots. Never `rm -rf` a cache "to be safe".
- **Model calls:** the §3a stub by default; `tier=live` rows only when dispatched (T5b/T6 are the expensive ones). A live row uses the real `base_url` with a **dummy** key and lets the OneCLI proxy inject the credential (§3a) — a real key never touches the testbed, and a row you cannot run without one is `SKIPPED(no-provider)`.
- **Time caps — each chunk its own Bash call with a declared `timeout`, long ones inside `Agent`, never `run_in_background`, never an unbounded wait:** T-suite ≤ 30 min; focused pytest ≈ 1500000 ms per chunk; UI ≤ 15 min; desktop smoke ≤ 5 min, PR set ≤ 25 min. Full `scripts/run_tests.sh` and full desktop `e2e/` only for a CORE-CHANGE diff or the nightly.
- **Round cap:** 2 verification rounds per PR, then ESCALATE. Nightly: once per day against the fork's default branch, one report, no rounds.
- **No installs of any kind, no pushes, no PRs, no GitHub writes** (`no-push.md`); `DESKTOP=SKIPPED` with the verbatim `install_packages` request is the correct outcome for a missing dependency; tests you write travel as `tests.patch` + `send_file`.

## From project

- `hermes_cli/subcommands/dashboard.py:26-60, 75-84, 101-109, 136-170` (`dashboard`/`serve` flags); `hermes_cli/main.py:521-522, 565` (`-p` → HERMES_HOME), `:2434-2435`, `:6141-6145`, `:12063-12091`, `:12203-12215`; `hermes_cli/web_server.py:589-593, 742, 798-803, 3680, 16406, 17618-17624, 19932-19950`; `web/vite.config.ts:103`
- `hermes_cli/subcommands/approvals.py:84-113`; `hermes_cli/approvals_test.py:49-143, 159-180`; `tools/approval.py:4084-4086`
- `hermes_cli/subcommands/plugins.py:95-126, 161-174`; `hermes_cli/plugins_cmd.py:3059-3060`; `hermes_cli/plugin_dev.py:36-77`; `hermes_cli/plugins.py:5-17, 83-93, 114-124, 649-670, 4658-4667`
- `hermes_cli/subcommands/profile.py:29-64, 153-180`; `hermes_cli/profile_distribution.py:88-95` (DEFAULT_DIST_OWNED — no profile.yaml); `tui_gateway/methods_profiles.py:749, 780-782` (`profiles.configure` ui_meta writer); `tools/bot_mode_probe.py:60-76, 242-248, 288`; `tests/tools/test_bot_mode_probe.py:24-27` (ui_meta block shape); `hermes_cli/subcommands/cron.py:23, 27-44, 268-270, 328`; `hermes_cli/kanban.py:790-802`; `hermes_cli/kanban_db.py:582-584`; `hermes_cli/_parser.py:151, 154-155`; `hermes_cli/subcommands/gui.py:15-34`
- `tools/environments/docker.py:324-328`; `hermes_state.py:759-767, 846`; `tests/conftest.py:545`; `scripts/run_tests.sh:54-75, 169-183`; `gateway/platforms/api_server.py:266` (8642), `gateway/platforms/webhook.py:130` (8644); `pyproject.toml:3, 125, 624-660`
- `apps/desktop/playwright.config.ts:30-43`; `apps/desktop/e2e/fixtures.ts:1-20, 160-198, 239-243, 262-272, 314-320`; `apps/desktop/e2e/electron-binary.ts:30-38`; `apps/desktop/e2e/mock-server.ts:655`; `apps/desktop/electron/main.ts:2422-2423, 4640-4648`; `apps/desktop/scripts/assert-root-install.mjs:8-12`; `.github/workflows/e2e-desktop.yml:37-40, 52-57, 113-125`; root `package.json` (workspaces, engines); `apps/desktop/package.json` (electron 40.10.2, @playwright/test 1.62.1)
- Plan: `reports/nemoclaw-coworkers-port-plan.html` §5 (T1–T12), `-v2.html` P2 (harness spec); NanoClaw `container/Dockerfile` (image libs, no xvfb); workflow `hermes-verify` (intake, checkout, rounds, routing); skills `/hermes-build` (venv, run_tests.sh, doctor), `/agent-browser` (bounded waits), `/codex-critique` (OUTPUT_REVIEW + attestation)
