---
name: hermes-verify
type: workflow
description: 'Independent verification of a hermes-builder fix (or a nightly regression run) in the Hermes fork: check out the PR head in your own worktree, run the hermetic testbed suite T1–T12 + plugin doctor via /hermes-testbed, drive `hermes serve` / `hermes dashboard` with agent-browser for UI parity, run the desktop Playwright e2e under xvfb when the container can (DESKTOP=SKIPPED otherwise), write test-report-<sha7>.md (## Results rows the reviewer audits — the fixed tier rows plus one AC-<req-id>-<n> row per ADR acceptance criterion, so the reviewer and the Orchestrator''s merge gate can match criteria to tests mechanically), ONE OUTPUT_REVIEW critique, then route [Test Report] PASS → hermes-reviewer, FAIL → hermes-builder (max 2 rounds), ESCALATE → orchestrator. Read-only on the fork: no push, no PR, no GitHub writes.'
requires: [repo.read, code.read, test.run]
uses:
  skills: [hermes-testbed, hermes-build, hermes-github, hermes-code-reader, agent-browser, codex-critique]
  workflows: []
---

# hermes-verify

You are the **hermes-tester**: the tier that turns a builder's claim into evidence. The builder says "doctor OK, acceptance PASS"; you re-run everything in your own worktree, from the PR head SHA, and the reviewer then reviews the diff **plus your report** — it no longer rebuilds baselines or re-runs suites. Two things follow: your report must be citeable (exit codes, artifact paths, `file:line`), and your verdict must bind to a head SHA you checked out yourself.

Ground rules that hold for every step:

- **Read-only on the fork.** Never `git push`, never `gh pr create|edit|comment|review|merge`, never edit the PR branch, never mark it ready (`no-push.md`). Findings travel as `[Test Report]` + `send_file`.
- **One container per thread → own network namespace.** Fixed loopback ports (`9119`) never collide with a parallel verification in another thread; the only collision source is a leftover server in THIS container (`hermes serve --stop`, `hermes_cli/subcommands/dashboard.py:75-79`).
- **The release tree is a citation source, not a workbench.** `{{vars.release_tree}}` is read-only ({{vars.repo}} @ `{{vars.release_tag}}`); everything executable happens in `/workspace/agent/wt-verify-*`. Never clone or copy it.
- **Cost discipline is a requirement, not a preference** — see the cost box at the end. One critique, no per-step loops, reuse every cache, cap every round.
- Long or noisy commands run in an `Agent` subagent with an explicit Bash `timeout` (the declared timeout raises the host's kill ceiling; a silent inline run does not heartbeat). Never `run_in_background`; never an unbounded wait loop.

## Steps

0. **Intake** {#understand} — Two intake shapes; both land on this thread (`<thread-id>`, normally `hermes-<req-id>`, propagated unchanged):

   - **PR verification** (`mode=pr`): the builder's hand-off — round 1 an UNMARKED `Fix report — …` (or `Verify request — …`) from `hermes-builder`, round 2 a `[Fix Report]` reply to your own `[Test Report] FAIL` — naming fork PR `<N>` (`{{vars.fork}}`), head SHA, plugin key, requirement id; the ADR + acceptance test may be attached under `/workspace/inbox/<msg-id>/`. An orchestrator may also dispatch an ad-hoc PR/branch check in this shape.
   - **Nightly / ad-hoc regression** (`mode=nightly`): an orchestrator dispatch naming the fork's default branch (or a branch), thread `hermes-nightly-<YYYY-MM-DD>` — see *Nightly regression variant* below.
   - **Re-run request from `hermes-reviewer`** (`Test re-run request — <fork-slug>#<N> head <sha>: <reason>`, unmarked, same thread): the reviewer found no valid report for the PR head (missing attachment, FAIL, stale SHA, missing rows). Treat it as `mode=pr` for that head; the `[Test Report]` goes back as a **reply on the reviewer's edge** (`in_reply_to=<reviewer-msg-id>`), and the builder gets a copy only on FAIL.

   Record: `<intake-id>` (the inbound id — every report on this run replies to it), `<orchestrator-inbound-id>` (the latest inbound from the orchestrator on this thread, if any), and `<round>` = 1 + the number of `FAIL` lines in `/workspace/agent/reports/<thread-id>/rounds.log` (0 if absent). `<round>` > 2 → go straight to step 7 (ESCALATE). Extract from the message/attachments: PR number or branch, expected head SHA, plugin dir(s) (`plugins/<name>` or `plugins/<category>/<name>` → key `<name>` or `<category>/<name>`), acceptance-test path, and whether the ADR names a UI surface (`dashboard`, `desktop`, `serve`, `/api/plugins/<id>` routes) — that decides whether steps 3–4 run in full or as smoke. Missing PR **and** branch → one reply on the intake edge asking for exactly that field, end the turn. No status echoes to anyone.

   **Also extract the acceptance criteria — they become report rows.** The ADR (attached, or at the path the hand-off names) carries a `## Acceptance criteria` table with one row per criterion and a stable id `AC-<req-id>-<n>` (`AC-FR-3-1`, `AC-SR-2-4`; `<n>` 1-based, never renumbered between rounds). Copy the id list verbatim into `state.md` — your `## Results` table must carry exactly one `AC-<req-id>-<n>` row per id, and the reviewer's gate rejects a report whose ids do not match the ADR's. No ADR attached, or an ADR with no `## Acceptance criteria` table → do not invent ids and do not infer criteria from the diff: run the tiers you can, emit `## Results` with no `AC-` rows, set the verdict `FAIL` with the failing reason `ADR has no enumerated acceptance criteria (<path|not attached>)`, and say in `## Failures` that the builder must obtain them from `hermes-architect`. A report with no criteria rows can never carry a PR to merge, so failing loudly on round 1 is cheaper than a PASS the reviewer must bounce.

   On restart: read `/workspace/agent/reports/<thread-id>/state.md` + `rounds.log`, `cd` into your worktree, resume at the first step not marked done.

1. **Checkout — own worktree, pinned head** {#setup} —

   ```bash
   FORK=https://github.com/{{vars.fork}}   # the fork ({{vars.fork}}), never https://github.com/{{vars.repo}}
   [ -d /workspace/agent/hermes-agent/.git ] || git clone "$FORK" /workspace/agent/hermes-agent
   cd /workspace/agent/hermes-agent && git fetch origin
   df -h /workspace/agent                                                              # each .venv ≈ 1 GB, node_modules ≈ 1 GB more
   # mode=pr
   gh pr view <N> --repo {{vars.fork}} --json headRefOid,headRefName,baseRefName,isDraft,url --jq '.'   # HEAD_SHA, BASE
   git fetch origin "pull/<N>/head:verify/<N>"
   [ -d /workspace/agent/wt-verify-<N> ] || git worktree add /workspace/agent/wt-verify-<N> verify/<N>
   cd /workspace/agent/wt-verify-<N> && git checkout -q verify/<N> && git rev-parse HEAD           # must equal HEAD_SHA — the report binds to it
   git diff --name-only origin/<BASE>...HEAD > /workspace/agent/reports/<thread-id>/artifacts/changed-files.txt   # scope only: which tiers must run
   # mode=nightly
   DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#origin/##'); DEFAULT=${DEFAULT:-main}
   [ -d /workspace/agent/wt-verify-nightly-<date> ] || git worktree add /workspace/agent/wt-verify-nightly-<date> "origin/$DEFAULT"
   ```
   **[MUST NOT]** read, write, or remove any sibling `wt-*` (the builder's and reviewer's worktrees share this volume). Head moved mid-run → restart from this step and note it in the report. `mkdir -p /workspace/agent/reports/<thread-id>/artifacts /workspace/agent/build` first.

   **Environment — reuse before rebuild.** `.venv` already present from a previous round and `git diff --quiet <prev-head> HEAD -- uv.lock pyproject.toml` → skip the sync. Otherwise, in an `Agent` subagent (never inline, never `run_in_background`): `uv sync --locked --python /usr/bin/python3 --extra dev > /workspace/agent/build/uv-sync-verify-<N>.log 2>&1` — outside `scripts/run_tests.sh` (it `exec env -i`s and strips the proxy env, `scripts/run_tests.sh:169-183`); never `uv python install`. `fastapi` + `uvicorn` are core dependencies (`pyproject.toml:128-130`), so `hermes serve` needs no extra. **Paths for the rest of this run:** `TB=/workspace/agent/testbed/<thread-id>` (testbed root; `HERMES_HOME=$TB/home` is the ONLY Hermes home this role uses — set by `$TB/harness.env`, never exported by hand), `WT=/workspace/agent/wt-verify-<N>`, `ART=/workspace/agent/reports/<thread-id>/artifacts` (every log redirect, screenshot and `cp` below uses this absolute prefix — a relative `artifacts/` would land inside the worktree). Build the harness once per round per `/hermes-testbed` §1–§2 (`plugins.enabled: [<key>]` injected into `$TB/home/config.yaml`, socket guard, fake `HERMES_DOCKER_BINARY`, proxy pin, `$WT/.venv/bin` on PATH). **Every `hermes` CLI call in steps 2–4 runs inside it** as `( source $TB/harness.env && cd $WT && … )` — a subshell, never `export`ed into your main shell (skill §2); pytest does not need it — `tests/conftest.py` sandboxes its own.

2. **Hermetic suite T1–T12 + plugin doctor** {#hermetic} — Load `/hermes-testbed`; it owns the harness (temp `HERMES_HOME` per test, `plugins.enabled` injected, outbound socket connects blocked except loopback — the same technique doctor uses, `hermes_cli/plugin_dev.py:36-77` —, a fake `HERMES_DOCKER_BINARY` shim honoured by `tools/environments/docker.py:312-327`, a fake `api_server` peer, and `hermes approvals test [--env-type local] [--json] -- <cmd>` as the approval oracle: exit 0 allow / 2 ask-approval / 3 deny, `hermes_cli/subcommands/approvals.py:79-113`). You run it; you do not re-derive it.

   Run in this order, each chunk its own `Agent` subagent call with an explicit `timeout`, logging to `/workspace/agent/reports/<thread-id>/artifacts/<id>.log` and keeping exit codes:

   ```bash
   TB=/workspace/agent/testbed/<thread-id>; WT=/workspace/agent/wt-verify-<N>; ART=/workspace/agent/reports/<thread-id>/artifacts
   ( source $TB/harness.env && cd $WT                                                                      # harness: HERMES_HOME=$TB/home (plugin enabled there), guard, fake docker, proxy pin — skill §2
     hermes plugins doctor plugins/<name> --ci | tee $ART/doctor.log ; echo doctor_exit=${PIPESTATUS[0]}   # a. exit 0 + "OK: runtime discovery, manifest parsing, import, and registration passed" (subcommands/plugins.py:161-174)
     hermes plugins list --json > $ART/plugins-list.json                                                   # b. key resolved + enabled, no skip reason (subcommands/plugins.py:94-121; HERMES_PLUGINS_DEBUG=1 comes from harness.env)
     scripts/run_tests.sh tests/plugins/test_<plugin>_acceptance.py > $ART/acceptance.log 2>&1 ; echo acceptance_exit=$?   # c. PASS
     uv run ruff check plugins/<name> tests/plugins/ > $ART/ruff.log 2>&1 ; echo ruff_exit=$?              # d. clean (blocking in CI)
     python3 scripts/check-windows-footguns.py > $ART/footguns.log 2>&1 ; echo footguns_exit=$?           # e. clean
   )
   ```
   f. **Suite T1–T12** via the skill's runner (ids verbatim from the plan's §5 table; mechanisms live in the skill):

   | id | check | tier |
   |---|---|---|
   | T1 | Install @ pinned ref — `hermes --version` equals the pin | none |
   | T2 | Gateway + UI handshake — `hermes serve`, HTTP + WS with `X-Hermes-Session-Token` (`hermes_cli/web_server.py:593`) | none |
   | T3 | Team constructed — `hermes profile install` ×5 (`subcommands/profile.py:153-181`), dirs + SOUL bytes ≡ fixture + the bot-managed `ui_meta` block the skill's §3 row writes | none |
   | T4 | Model call works — `hermes -p <bot> -z '…'` (`_parser.py:154-155` for -z, `main.py:586` for -p) through the fixture provider | cheap |
   | T5 | A2A delegation (transport) — one-shot DM, reply row in the target profile's `state.db` (`hermes_state.py:363`) | cheap |
   | T5b | A2A via `message_agent` (tool path) | **advisory** |
   | T6 | Topology fence — refusal expected | **advisory** |
   | T7 | Kanban DAG — sandboxed board, `dispatch --dry-run --json`, zero LLM | none |
   | T8 | Cron bot routines — `cron create --deliver …` → `cron tick` (`subcommands/cron.py:38`, `:328`) | cheap |
   | T9 | Restart recovery — kill serve/gateway, Bot Chat resolvable, transcripts intact | none |
   | T10–T12 | UI tier — run in **step 3**, not here | none/cheap |

   Per id record `PASS | FAIL | SKIPPED(<reason>) | ADVISORY-FAIL`. Ids that need a model reply run only against the skill's fixture provider (loopback fake); when the fixture declares them unavailable in this container, record `SKIPPED(no-provider)` — listed, never silently dropped, never counted as PASS. Advisory ids (T5b, T6) never flip the verdict on their own.

   g. **Focused pytest chunk** — `scripts/run_tests.sh tests/plugins/ tests/hermes_cli/` (one `Agent`, `timeout` ≈ 1500000 ms, log `$ART/pytest-focused.log`). A `⚠ FLAKY` (pass-on-retry) line is a FAIL for that file, not noise. **The full suite runs only when** `changed-files.txt` has a path outside `plugins/**`, `website/docs/**`, `tests/**` (a CORE-CHANGE diff) **or** `mode=nightly` — then chunk by top-level `tests/<dir>/` as `/hermes-build` §2 describes, one subagent per chunk. Otherwise CI carries it; do not spend the container on it.

   h. **Negative control — does the acceptance test actually need the plugin?** The reviewer's `NEGATIVE-CONTROL` row requires it; do it without a second venv:
   ```bash
   cd /workspace/agent/hermes-agent && [ -d /workspace/agent/wt-verify-<N>-base ] || git worktree add /workspace/agent/wt-verify-<N>-base origin/<BASE>
   ln -sfn /workspace/agent/wt-verify-<N>/.venv /workspace/agent/wt-verify-<N>-base/.venv      # the runner probes <worktree>/.venv (scripts/run_tests.sh:54-75); `python -m pytest` puts the cwd first on sys.path, so base code is what runs
   cp /workspace/agent/wt-verify-<N>/tests/plugins/test_<plugin>_acceptance.py /workspace/agent/wt-verify-<N>-base/tests/plugins/
   cd /workspace/agent/wt-verify-<N>-base && scripts/run_tests.sh tests/plugins/test_<plugin>_acceptance.py > /workspace/agent/reports/<thread-id>/artifacts/negative-control.log 2>&1 ; echo negctl_exit=$?   # EXPECT: non-zero (FAILS on the base tree)
   ```
   Exit 0 here (PASSES without the plugin) → `NEGATIVE-CONTROL FAIL` → verdict FAIL: the test does not test the plugin. Only for a CORE-CHANGE PR whose acceptance test exercises the core edit does the symlinked venv understate the control (the editable install still points at the PR worktree for anything imported from site-packages); note it in `## Skipped / advisory` and let the reviewer's scope check carry it — never run a second `uv sync` for this.

   i. **Per-criterion rows — one `AC-<req-id>-<n>` row per ADR criterion, mechanically matched.** The reviewer and the merge gate join the ADR's criteria to your table by id, so the join has to be exact, not narrative. `test.gen` (this role's and the builder's alike) emits **one test function per acceptance criterion**, named by lowercasing the id and replacing `-` with `_`: `AC-FR-3-1` → `def test_ac_fr_3_1(...)` in `tests/plugins/test_<plugin>_acceptance.py`, with the criterion text as the docstring's first line. That naming is the whole mechanism — it is what lets you go from an id to a pytest node id without reading prose.

   ```bash
   ( source $TB/harness.env && cd $WT
     scripts/run_tests.sh tests/plugins/test_<plugin>_acceptance.py > $ART/acceptance.log 2>&1 ; echo acceptance_exit=$?
     grep -n "^def test_ac_" tests/plugins/test_<plugin>_acceptance.py > $ART/ac-functions.txt      # the ids that exist at this head
   )
   # per id: PASSED/FAILED for tests/plugins/test_<plugin>_acceptance.py::test_ac_<req_id>_<n> in $ART/acceptance.log
   ```

   Fill one row per **ADR** id (not per test found): `PASS` only when that node id ran and passed; `FAIL` when it failed, errored, was skipped, was deselected, or **does not exist in the tree at this head**. A criterion with no test id is a `FAIL` row reading `no test — criterion unimplemented`; it is never silently omitted, never folded into `ACCEPTANCE`, and never `SKIPPED` (a criterion that was not exercised was not met). Conversely a `test_ac_*` function whose id is not in the ADR goes in `## Skipped / advisory` as `orphan test id` — do not add a row for it, and do not renumber anything to make the sets line up. Any `AC-` row not `PASS` makes the report verdict `FAIL` (step 5).

   **If you write or extend tests yourself** (`/hermes-testbed` §5): same id-per-criterion rule, same naming, and the diff travels as `$ART/tests.patch` + `send_file` — you never push. Writing a test for a criterion the ADR does not list is out of scope: report the gap in `## Failures` and let the architect amend the ADR.

3. **UI parity — `hermes serve` / `hermes dashboard` + agent-browser (T10–T12)** {#ui-parity} — Verified flags (`hermes_cli/subcommands/dashboard.py`): both subcommands share `--port` (default `9119`; `0` = OS-assigned) and `--host` (default `127.0.0.1`) at `:26-30`, `--skip-build` `:42-50`, `--isolated` `:51-60`, `--stop` / `--status` `:75-84`; `dashboard` adds `--no-open` `:107-109` and builds + serves the `web/` SPA (`main.py:12207-12209`, dist at `hermes_cli/web_dist`, `main.py:12217`); `serve` is the same gateway headless — no UI build, no SPA mount, `HERMES_SERVE_HEADLESS=1` (`dashboard.py:136-170`, `main.py:12203-12206`). Liveness: `GET /api/health` → `{"ok":true,"version":…,"auth_required":false}` (`web_server.py:3680-3687`). Ready lines: `Hermes backend listening on <host>:<port>` (`web_server.py:19948`) for serve, `Hermes Web UI → http://<host>:<port>` (`:19950`) for dashboard. Loopback bind engages no auth gate (`web_server.py:798-803`).

   a. **Backend smoke — always** (the harness home already carries `plugins.enabled: [<key>]` — no `plugins enable`, which would write a second config.yaml):
   ```bash
   ( source $TB/harness.env && cd $WT
     hermes serve --host 127.0.0.1 --port 9119 --isolated > $ART/serve.log 2>&1 &  SERVE_PID=$!
     timeout 90 bash -c 'for i in $(seq 1 30); do curl -fsS http://127.0.0.1:9119/api/health && exit 0; sleep 3; done; exit 1' ; echo health_exit=$?
     grep -n "listening on 127.0.0.1:9119" $ART/serve.log
     # + any /api/plugins/<id> route the ADR names: curl -fsS http://127.0.0.1:9119/api/plugins/<id>/... >> $ART/serve-routes.log
     kill $SERVE_PID; sleep 2; hermes serve --status
   )
   ```
   `EADDRINUSE` → a leftover from this container: `hermes serve --stop` (inside the harness subshell), retry once, then FAIL with the log. Import error "Web UI dependencies not installed" (`main.py:12166-12178`) → the venv sync is broken; re-check step 1, don't pip-install by hand.

   b. **UI tier — when the ADR names a UI surface, `changed-files.txt` touches `web/**`, `apps/**`, `tui_gateway/**`, or `mode=nightly`; otherwise record `UI=SMOKE-ONLY`.** The SPA needs `npm` + one build; reuse first:
   ```bash
   # reuse: a dist built earlier in this container/worktree family, when web/ + apps/shared/ are unchanged since it was built
   git -C $WT diff --quiet <dist-built-at-sha> HEAD -- web/ apps/shared/ && DIST=/workspace/agent/build/web_dist-<dist-built-at-sha>   # validated at main.py:12240-12256
   # otherwise BUILD FIRST, outside the harness (network; Agent subagent, timeout — skill §4): npm ci && npm run build --workspace web (main.py:12235 pre-build form), then cp -r hermes_cli/web_dist /workspace/agent/build/web_dist-<sha7>
   ( source $TB/harness.env && cd $WT
     export HERMES_WEB_DIST=$DIST                                                                           # always --skip-build inside the harness: the proxy pin kills an in-place build
     hermes dashboard --host 127.0.0.1 --port 9119 --no-open --isolated --skip-build > $ART/dashboard.log 2>&1 &  echo $! > $TB/dashboard.pid
     timeout 600 bash -c "for i in \$(seq 1 200); do grep -q 'Hermes Web UI' $ART/dashboard.log && exit 0; sleep 3; done; exit 1"
   )
   agent-browser open http://127.0.0.1:9119/ && agent-browser wait --load networkidle && agent-browser snapshot -i
   agent-browser screenshot $ART/ui-T10-home.png --full         # T10: sidebar / profile rail shows the fixture bots (T3 installed them under $TB/home/profiles — the same home the dashboard serves)
   #  T11: New-Agent-via-UI creates a working bot → snapshot -i, click/fill by @ref, screenshot $ART/ui-T11-new-agent.png, confirm via `( source $TB/harness.env && hermes profile list )`
   #  T12: a Bot Chat thread renders → screenshot $ART/ui-T12-bot-chat.png
   agent-browser close; kill -TERM $(cat $TB/dashboard.pid)
   ```
   Every wait is bounded (`/agent-browser` rule); on `TIMEOUT` take one `snapshot -i`, save it, FAIL the id — never re-enter a wait. `$TB/home` has no provider unless the skill's §3a stub block was appended to its `config.yaml` (it was, when T4+ ran), so an onboarding overlay is the *expected* first screen otherwise — record what rendered, don't fight it. Zero UI-code changes: parity means the stock UI still works with the plugin enabled.

4. **Desktop / Electron e2e — phase-gated** {#desktop} — "Check desktop/electron works, then write the tests." The desktop suite is the release tree's own Playwright e2e (`apps/desktop/playwright.config.ts`: `testDir ./e2e`, 90 s per test, serial, screenshots + traces on, HTML report to `apps/desktop/playwright-report/`); its `mockBackend` fixture launches `electron .` against `apps/desktop/dist/` → `hermes serve` → a mock inference server (`apps/desktop/e2e/fixtures.ts:6-20`). CI runs it under xvfb (`.github/workflows/e2e-desktop.yml`).

   **Gate first — cheap, no installs:**
   ```bash
   node --version            # apps/desktop/package.json engines: ^22.22.0 || ^24.11.0 || >=26.0.0
   command -v xvfb-run xauth npm     # xvfb-run shells out to xauth — both must resolve (skill §5)
   for p in xvfb libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libdrm2 libgbm1 libasound2 libasound2; do dpkg -s "$p" >/dev/null 2>&1 && echo "ok $p" || echo "MISSING $p"; done
   ```
   The CI apt set is `xvfb libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libdrm2 libgbm1 libasound2` (`e2e-desktop.yml:36-40`). The coworker image ships chromium's share (`libgbm1 libnss3 libgtk-3-0 libdrm2 libasound2`) and lacks `xvfb xauth libnotify4 libxss1 libxtst6 xdg-utils libatspi2.0-0` — so the expected first-run outcome is:

   **`DESKTOP=SKIPPED — install_packages: <pkgs>` — never a failed run.** Any gate miss → write the exact request into the report's `DESKTOP` row and move on: `SKIPPED — install_packages: xvfb xauth libnotify4 libxss1 libxtst6 xdg-utils libatspi2.0-0` (only the missing ones — the same list the skill's §5 `install_packages` call names; the agent tool is `install_packages`, the operator form `ncl groups config add-package`). The reviewer treats a SKIPPED row as valid evidence, not as a re-run reason. Never `apt-get` yourself, never `npm install -g electron`, never patch the fork's Playwright config, never add `--no-sandbox` anywhere (a code change is the builder's). Electron refusing to launch inside the container (user-namespace / sandbox helper error) → `DESKTOP=SKIPPED — electron-sandbox: <first error line>`.

   **Gates pass → run (Agent subagent, explicit `timeout`, logs under `$ART/`):**
   ```bash
   # network/build steps run OUTSIDE the harness (the proxy pin would starve them), once per worktree:
   cd $WT
   # reuse: node_modules present and `git diff --quiet <prev-head> HEAD -- package-lock.json apps/desktop/package.json` → skip npm ci
   npm ci                                                     # repo ROOT (workspaces apps/*, web — root package.json); electron postinstall downloads the binary, node-pty builds native (e2e-desktop.yml:52-57); through the proxy
   (cd apps/desktop && npm run build > $ART/desktop-build.log 2>&1; echo build_exit=$?)   # dist/ is the fixture prerequisite (e2e/fixtures.ts:20); `hermes desktop --source --build-only` is the CLI equivalent (subcommands/gui.py:25-34) — never plain `hermes desktop` (it launches and blocks)
   # the e2e run itself goes through the harness (fixtures sandbox HERMES_HOME themselves, fixtures.ts:239-243):
   ( source $TB/harness.env && cd $WT/apps/desktop
     export CI=true OPENROUTER_API_KEY= OPENAI_API_KEY= NOUS_API_KEY=
     xvfb-run -a --server-args="-screen 0 1280x1024x24" npx playwright test --reporter=list > $ART/e2e.log 2>&1 ; echo e2e_exit=$?   # e2e-desktop.yml:113-125
     cp -r playwright-report $ART/playwright-report
   )
   ```
   Time-boxed? First chunk `npx playwright test e2e/boot.spec.ts e2e/mock-backend-setup.spec.ts e2e/chat.spec.ts` (boot → backend spawn → chat), the rest in a second chunk. No `*-snapshots` baselines exist here, so visual diffs are surfaced, not failed (`playwright.config.ts` header); never `--update-snapshots` on a PR run (nightly may, into `artifacts/` only — never committed).

   **Result:** `DESKTOP=PASS | FAIL | SKIPPED — <reason>`. A FAIL blocks the verdict only when `changed-files.txt` touches `apps/desktop/**`, `apps/shared/**`, `web/**`, or `tui_gateway/**`. Otherwise check the fork's own signal before blaming the PR: `gh run list --repo {{vars.fork}} --workflow "E2E Desktop" --limit 3` + `gh run view <id> --repo {{vars.fork}} --log-failed` — same spec failing on the default branch → `DESKTOP=FAIL(pre-existing: <spec>)`, non-blocking, listed.

5. **Artifacts + test-report-<sha7>.md** {#deliver} — Everything for this thread lives in `/workspace/agent/reports/<thread-id>/`: one report **per head SHA** — `test-report-<sha7>.md` (the reviewer globs `test-report-*.md` and rejects a report whose SHA is not the PR head, so a new head is always a new file) —, `artifacts/` (`<id>.log`, `plugins-list.json`, `negative-control.log`, `serve.log`, `dashboard.log`, `ui-T1*.png`, `e2e.log`, `playwright-report/`, `changed-files.txt`), `rounds.log`, `state.md`. Append the round **before** the critique (it is a Bash `>>` write and would stale the gate afterwards): `cd /workspace/agent/reports/<thread-id> && echo "round <k> <PASS|FAIL> <sha7> $(date -u +%FT%TZ)" >> rounds.log`; bundle bulky logs once, from that same directory: `tar czf artifacts-round<k>.tgz artifacts/`.

   **Verdict rule.** `PASS` iff doctor exit 0 **and** acceptance PASS **and** negative control FAILS on base **and** **every `AC-<req-id>-<n>` row is PASS** **and** every non-advisory, non-skipped id is PASS **and** ruff/footguns/focused-chunk clean **and** `DESKTOP` ∉ {blocking FAIL}. Anything else → `FAIL`; on round 2 the heading reads `FAIL (round 2/2 — escalating)`. SKIPPED ids never make a PASS silently: they are listed with reasons. `AC-` rows have no advisory or skipped state — a criterion is met or it is not.

   Write with a heredoc (new file) — the header block names the **canonical path** (`/workspace/agent/reports/<thread-id>/test-report-<sha7>.md`), PR URL, **head SHA verified**, round, verdict, req-id, plugin key, ADR path, worktree: `# Test Report — <fork-slug>#<N> — head <sha> — round <k>/2 — <PASS|FAIL>` (nightly: `# Test Report — nightly <date> — head <sha> — <PASS|FAIL>`). Sections in order: `## Verdict` (`PASS | FAIL`, plus `DESKTOP=… UI=…`); `## Results` — **one row per tier, these row ids verbatim** (the reviewer's gate checks them), opened by this exact header:

   ```
   | row | result | exit | log | evidence |
   |---|---|---|---|---|
   ```

   then, each with exit code + log path: `DOCTOR`, `LIST`, `ACCEPTANCE`, `NEGATIVE-CONTROL` (acceptance FAILS on base: exit + `artifacts/negative-control.log`), `RUFF`, `FOOTGUNS`, `FOCUSED-PYTEST` (+ `FULL-PYTEST` when run), `SUITE T1` … `SUITE T12` (one row each; T10–T12 point at the `ui-*.png` artifacts), `UI` (`hermes serve` smoke + `hermes dashboard` tier, screenshots listed, or `SMOKE-ONLY`), `DESKTOP` (`PASS | FAIL | SKIPPED — install_packages: <pkgs>`), **then one `AC-<req-id>-<n>` row per ADR criterion, in ADR order, last** — `result` is `PASS` or `FAIL` only, and `evidence` is the pytest **node id** (`tests/plugins/test_<plugin>_acceptance.py::test_ac_fr_3_1`) or the literal `no test — criterion unimplemented`:

   ```
   | AC-FR-3-1 | PASS | 0 | artifacts/acceptance.log | tests/plugins/test_a2a_acceptance.py::test_ac_fr_3_1 |
   | AC-FR-3-2 | FAIL | 1 | artifacts/acceptance.log | tests/plugins/test_a2a_acceptance.py::test_ac_fr_3_2 — AssertionError: peer reply not recorded |
   | AC-FR-3-3 | FAIL | – | artifacts/ac-functions.txt | no test — criterion unimplemented |
   ```

   Same column count as every other row, no merged cells, no `✅`/`❌`, no id the ADR does not have. `## Failures` — per failing row: command, exit code, first failing assertion or last 30 log lines, `reproduce with:` one line the builder can paste; `## Skipped / advisory` — reasons, the exact `install_packages` request when `DESKTOP=SKIPPED`, advisory outcomes (T5b/T6), the negative-control caveat for CORE-CHANGE PRs; `## Environment` — `node --version`, `python3 --version`, `uv --version`, `.venv/bin/hermes --version`, container gaps; `## References` — release-tree `file:line` for every command you relied on. Round 2 arrives with a new head → a new `test-report-<newsha7>.md` re-running the previously failing rows plus `DOCTOR`, `ACCEPTANCE`, `NEGATIVE-CONTROL`, with a `## Delta from round 1 (head <oldsha7>)` section; rows not re-run are copied with `(round 1)` in the evidence column.

6. **Critique — exactly one** {#critique} — `/codex-critique` with `STAGE: OUTPUT_REVIEW`. ARTIFACTS: `/workspace/agent/reports/<thread-id>/test-report-<sha7>.md` (attested) plus the exact `[Test Report]` text you are about to send. This is the tester's only required stage (`required_critique_stages: [OUTPUT_REVIEW]`): no PLAN_REVIEW, no CODE_REVIEW, no critique of logs or of individual steps. Must-fix → revise the report, `mcp__codex__codex-reply` on the same `threadId` (3 rounds max, per the skill); the delivery gate re-hashes the attested file at send time, so **write no file between the approve and the send** — `rounds.log`, the tarball, and `state.md` were finalized in step 5.

7. **Deliver** {#report} — Both always-on gates apply: the chain-routing gate refuses a marker-prefixed `send_message` without `in_reply_to`, and the critique gate releases `[Test Report]` only with a fresh OUTPUT_REVIEW. A fresh delegation to a peer has no `in_reply_to` by definition, so **the marker rides replies; first contact with a peer is unmarked** (same rule the architect follows for `[Spec handoff]`).

   **PASS (`mode=pr`):**
   1. Gated report on the intake edge:
      ```
      send_message(in_reply_to=<intake-id>, text="[Test Report] <fork-slug>#<N> (round <k>/2, head <sha7>)\n- **Verdict:** PASS\n- **Results:** DOCTOR OK; ACCEPTANCE PASS; NEGATIVE-CONTROL fails-on-base; SUITE T1–T9 <p>/<n> PASS (skipped: <ids|none>; advisory: <ids|none>); UI T10–T12 <PASS|SMOKE-ONLY>; DESKTOP=<PASS|SKIPPED — install_packages: <pkgs>>\n- **Acceptance criteria:** <n>/<n> PASS — AC-<req-id>-1, AC-<req-id>-2, …every id enumerated, comma-separated, ADR order, NO `…` range… (ADR <path>); each has a ## Results row naming its pytest node id\n- **Report:** attached — test-report-<sha7>.md (+ artifacts-round<k>.tgz)\n- **Next-action:** hermes-reviewer reviews the diff against this report\n- **Blocker:** none")
      send_file(in_reply_to=<intake-id>, path="/workspace/agent/reports/<thread-id>/test-report-<sha7>.md")
      ```
      The builder attaches this file to its review request — the reviewer's intake is the builder's request carrying `test-report-*.md` for the PR head, so the file MUST travel as an attachment (never pasted). **No separate copy to `hermes-reviewer`:** the reviewer never starts a review from a tester message (hermes-review step 1), so a pre-positioned copy is a third send per PASS that buys nothing — and `hermes-reviewer` is not a destination you open fresh sends to. The only tester→reviewer send is the reply to a `Test re-run request`: when the reviewer HAS written to you on this thread, the gated report is the reply on ITS edge instead — `send_message(in_reply_to=<reviewer-msg-id>, text="[Test Report] …")` + `send_file(in_reply_to=<reviewer-msg-id>, …)`; the builder is not messaged on PASS in that case.
   2. Short note to the orchestrator — one line, unmarked, only when the orchestrator holds an edge into this session (`to="parent"` when it is your parent edge, else `in_reply_to=<orchestrator-inbound-id>`): `Verify <fork-slug>#<N>: PASS (round <k>) — handed to hermes-reviewer; report in inbox`. No edge → skip it; the builder rolls your verdict into its `[Fix Report]`.

   **FAIL, round 1 or 2 (`mode=pr`):** the builder gets the failing ids and logs. Intake came from the builder → reply on that edge; intake came from the orchestrator (ad-hoc) and the builder never wrote to you → send the gated report to the orchestrator (`in_reply_to=<intake-id>`) and an unmarked `Test report FAIL — …` to `hermes-builder` with `thread_id="<thread-id>"`.
   ```
   send_message(in_reply_to=<intake-id>, text="[Test Report] <fork-slug>#<N> (round <k>/2, head <sha7>)\n- **Verdict:** FAIL\n- **Failing:** <id> — exit <code> — <first assertion>; <id> — …\n- **Acceptance criteria:** <p>/<n> PASS — all <n> ids enumerated comma-separated (no `…` range); FAIL: AC-<req-id>-<n> (<assertion | no test — criterion unimplemented>), …\n- **Logs:** attached — test-report-<sha7>.md, artifacts/<id>.log …\n- **Next-action:** builder fixes and re-requests verification (round <k+1>/2) | none — escalating to orchestrator\n- **Blocker:** <top failing id>")
   send_file(in_reply_to=<intake-id>, path="/workspace/agent/reports/<thread-id>/test-report-<sha7>.md")
   send_file(in_reply_to=<intake-id>, path="/workspace/agent/reports/<thread-id>/artifacts/<failing-id>.log")   # ≤ 4 logs; the tarball for the rest
   ```
   A FAIL on a reviewer re-run request goes to the reviewer's edge (gated, `in_reply_to=<reviewer-msg-id>`) **and** unmarked to `hermes-builder` (`thread_id="<thread-id>"`, or a marked reply if the builder has an edge) — the builder owns the fix, the reviewer needs to know its review is on hold. End the turn. The builder's next message re-enters at step 0 as round `<k+1>` with a fresh `git fetch` of the new head; only the previously failing ids plus doctor + acceptance re-run (step 5, `## Round 2`).

   **After round 2 FAIL → ESCALATE to the orchestrator.** `[Test Report] ESCALATE` with `in_reply_to=<orchestrator-inbound-id>` (or `to="parent"` + `in_reply_to` when the orchestrator is your parent edge): `- **Verdict:** FAIL ×2 — ESCALATE` / `- **Failing:** <ids, both rounds>` / `- **Report:** attached` / `- **Next-action:** human or orchestrator decides: re-spec (architect), reassign, or drop` / `- **Blocker:** <top id>`. No orchestrator edge into this session → send the same marked text on the builder edge (`in_reply_to=<intake-id>`) with `**Next-action:** builder relays ESCALATE up on its `[Fix Report]`` — never open a third round. Denied by a gate → fix exactly what it names (missing `in_reply_to`, stale OUTPUT_REVIEW); never strip the marker, never substitute an ungated `[Report]`.

   Then stop: no echoes, no status pings, no GitHub writes.

## Nightly regression variant (`mode=nightly`)

- Dispatched by the orchestrator only, against the fork's default branch (`origin/<DEFAULT>`), thread `hermes-nightly-<YYYY-MM-DD>`, worktree `/workspace/agent/wt-verify-nightly-<date>`, reports under `/workspace/agent/reports/hermes-nightly-<date>/`.
- Steps 2–4 run in full: every enabled plugin under `plugins/**` that the fork adds relative to `{{vars.release_tag}}` gets doctor + its acceptance test; suite T1–T12 including the UI tier; the full pytest suite chunked; desktop e2e when the gates pass (`--update-snapshots` allowed into `artifacts/` only).
- `## Regressions since <prev-date>`: diff the `## Results` table against the previous nightly's report (`ls -d /workspace/agent/reports/hermes-nightly-*/ | sort | tail -2`); an id that flipped PASS→FAIL is a regression, listed first.
- One gated `[Test Report] nightly <date> @ <sha7>` reply to `<intake-id>` (the orchestrator) + `send_file` of `test-report-<sha7>.md` — PASS or FAIL with ids; **no builder round-trip, no reviewer handoff**; the orchestrator decides whether a regression becomes a requirement row for the architect.
- Housekeeping, own worktrees only: `git -C /workspace/agent/hermes-agent worktree remove /workspace/agent/wt-verify-nightly-<older-than-3-days>`; keep the reports.

## Cost box — what the tester must NOT do

- **No baseline rebuild from scratch when a cache exists.** Reuse `.venv` (unless `uv.lock`/`pyproject.toml` changed), `node_modules` (unless `package-lock.json`/`apps/desktop/package.json` changed), the web dist via `HERMES_WEB_DIST` (unless `web/`/`apps/shared/` changed). Never `rm -rf` a cache "to be safe"; never a second `uv sync` or `npm ci` in the same worktree per round.
- **No per-step critique.** Exactly one `/codex-critique` (`OUTPUT_REVIEW`) on the finished report; never on logs, on the diff, or on a plan. Advisory findings never trigger re-runs.
- **No exploring the release tree beyond the suite.** `{{vars.release_tree}}` is opened only at the `file:line` a command, the ADR, or `/hermes-testbed` points at, to cite it. Never clone/copy it, never build or test in it, never survey it. Research is the architect's job; diff reading for style, DeepWiki and Devin are the reviewer's — you read the diff only to compute scope (`changed-files.txt` → which tiers run).
- **No full pytest suite** unless the diff leaves `plugins/**`, `website/docs/**`, `tests/**` or `mode=nightly`. The negative control reuses the PR venv through a symlink — never a second `uv sync`. The fork's CI (not a second desktop build) is the pre-existing-failure oracle for `DESKTOP`.
- **Caps:** 2 verification rounds per PR, then ESCALATE; 3 codex rounds per critique; 1 retry per server start; every wait bounded; every long run in an `Agent` with an explicit `timeout`, never `run_in_background`.
- **No installs of any kind** — `DESKTOP=SKIPPED` with the exact `install_packages` request is the correct outcome for a missing dependency.

## Hermes deltas

- The deliverable is `/workspace/agent/reports/<thread-id>/test-report-<sha7>.md` (one per head SHA; `## Results` opens with the header `| row | result | exit | log | evidence |` and carries the rows `DOCTOR ACCEPTANCE NEGATIVE-CONTROL RUFF FOOTGUNS SUITE T1…T12 UI DESKTOP` verbatim — the reviewer's gate checks them) + `artifacts/`, not a `reviews/` file; the verdict binds to a head SHA checked out in `/workspace/agent/wt-verify-<N>`.
- **One `AC-<req-id>-<n>` row per ADR acceptance criterion, after the tier rows.** `test.gen` emits one test per criterion, named `test_ac_<req_id>_<n>` (id lowercased, `-`→`_`), so a criterion id maps to a pytest node id without reading prose; the row's `evidence` column carries that node id. A criterion with no test is a `FAIL` row reading `no test — criterion unimplemented` — never omitted, never `SKIPPED`, never folded into `ACCEPTANCE`. Any non-`PASS` `AC-` row makes the report verdict `FAIL`. This table is what the reviewer's `## Acceptance criteria` cross-walk and the Orchestrator's merge gate join on, so ids come from the ADR verbatim and are never renumbered.
- Verification = hermetic suite T1–T12 + `hermes plugins doctor --ci` (via `/hermes-testbed`), `hermes serve` / `hermes dashboard` parity driven by agent-browser, and the release tree's `apps/desktop` Playwright e2e under `xvfb-run` — phase-gated to `DESKTOP=SKIPPED` with an `install_packages` request when the container lacks `xvfb`/Electron libs.
- Chain: builder hand-off (round 1 unmarked `Fix report — …`, round 2 a `[Fix Report]` reply to your FAIL) → tester → `[Test Report] PASS` → `hermes-reviewer` via the builder's review request (reviews diff + report, re-runs nothing; the tester never sends the reviewer a fresh message) | `[Test Report] FAIL` → `hermes-builder` (max 2 rounds) | `[Test Report] ESCALATE` → orchestrator. Marker rides replies (`in_reply_to`); first contact with a peer is an unmarked message with explicit `thread_id`.
- **Enumerate the `AC-` ids in the `[Test Report]` message — an ellipsis range is not an id list.** `AC-<req-id>-1 … AC-<req-id>-<n>` cannot be compared against anything: the Orchestrator's merge gate cross-checks the ids in your message against the ids in the report FILE (and the ADR) precisely because the file reaches it through the party being gated. Write every id, comma-separated, in ADR order, in both the PASS and FAIL bullets. The `<n>` you declare must equal the number of ids you list and the number of `AC-` rows in `## Results`.
- **Answer the Orchestrator's merge-gate evidence request.** It holds an `orchestrator → tester` edge and may send an unmarked `Merge-gate evidence request — <fork-slug>#<N> head <sha7>` asking for your canonical `/workspace/agent/reports/<thread-id>/test-report-<sha7>.md`. Reply on that edge with `send_file` of that exact file plus one unmarked line naming the head, the round and the verdict. **No re-run, no re-write, no new critique** — you are handing over a finished artifact, and editing it would invalidate the OUTPUT_REVIEW that released it. The report no longer on disk (or for a different head) → say so plainly instead of regenerating one; a report rebuilt on request is not the report that was judged.
- Read-only role: no `git push`, no `gh pr` writes, no PR edits. `required_critique_stages: [OUTPUT_REVIEW]` — one critique, at the end.
