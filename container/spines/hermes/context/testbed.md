### Hermes testbed — where things live and how to run them

**Trees.**
- `/workspace/extra/hermes-release` — read-only mount of `NousResearch/hermes-agent` at the pinned tag recorded in `/workspace/extra/hermes-release/RELEASE_MANIFEST.json` (fallback: the spine's `vars.release_tag` in `coworker-types.yaml`). The ONLY citation source (`file:line` relative to it). Never edit it, never build or test inside it.
- **Cite the tag from the manifest, never from memory:** read `tag` + `commit` out of `RELEASE_MANIFEST.json` (`python3 -c 'import json;m=json.load(open("/workspace/extra/hermes-release/RELEASE_MANIFEST.json"));print(m["tag"],m["commit"])'`) at the start of every ADR / report / review and quote those two values; the operator re-pins with `scripts/hermes-pin.sh`, so the tag can move between containers without the spine changing.
- `/workspace/agent/hermes-agent` — the fork checkout (rw, persists across containers). Bring-up once: `git clone <fork-url> /workspace/agent/hermes-agent`, then `git remote add upstream https://github.com/NousResearch/hermes-agent.git && git fetch upstream --tags`. Never commit on this main checkout.
- `/workspace/agent/wt-<target-slug>` — one git worktree per target: `git worktree add /workspace/agent/wt-<target-slug> -b plugin/<name> <pinned-tag>` where `<pinned-tag>` is the `tag` field of `/workspace/extra/hermes-release/RELEASE_MANIFEST.json` (base on the fork's default branch instead if it has moved past the tag). All edits, env, tests, and commits happen there. Never read, write, or remove a sibling `wt-*`.
- `/workspace/agent/.hermes-testbed` — `HERMES_HOME` for `hermes` CLI smoke runs (`hermes plugins doctor | list | enable | install`, `hermes serve` smoke). Set it explicitly: `export HERMES_HOME=/workspace/agent/.hermes-testbed`. pytest does NOT need it — `tests/conftest.py` sandboxes its own `HERMES_HOME` per test and refuses a production `~/.hermes`.
- `/workspace/agent/reports/<target-slug>.md` (ADR) + `/workspace/agent/reports/<target-slug>-acceptance_test.py` — the architect's artifacts. The builder copies them here from `/workspace/inbox/<msg-id>/` before touching source (that write is what opens the plan gate). `/workspace/agent/reviews/<pr>.md` — the reviewer's artifacts.

**Environment — once per worktree, always in an `Agent` subagent, never inline and never `run_in_background`.**
```bash
cd /workspace/agent/wt-<target-slug>
python3 --version                                            # must be 3.11–3.13 (pyproject.toml:15)
uv sync --locked --python /usr/bin/python3 --extra dev       # creates .venv/ — scripts/run_tests.sh auto-detects it
```
`uv` is preinstalled. Never `uv python install` (it downloads an interpreter). Run `uv sync` OUTSIDE `scripts/run_tests.sh` — the runner re-execs under `env -i` and strips the proxy/CA env that `uv` needs. `--locked` fails on a stale `uv.lock`: fix the lock in the PR (`uv lock`), don't drop the flag. CI's fuller form is `uv sync --locked --python 3.11 --extra all --extra dev …` (`.github/workflows/tests.yml:83`); add an extra only when a test you run imports it.

**Plugin validation.**
```bash
source .venv/bin/activate                          # or prefix each command with `uv run`
export HERMES_HOME=/workspace/agent/.hermes-testbed
hermes plugins doctor plugins/<name> --ci          # exit 1 on any error-level finding
HERMES_PLUGINS_DEBUG=1 hermes plugins list         # resolved key / name / kind / source + skip reasons
hermes plugins enable <key>                        # plugins are opt-in (plugins.enabled in config.yaml)
```
Doctor loads the plugin through the real scanner and registration under a temporary `HERMES_HOME` with `HERMES_BUNDLED_PLUGINS=<empty>`, `HERMES_ENABLE_PROJECT_PLUGINS=0`, and socket connects patched to raise (`hermes_cli/plugin_dev.py:36-77`). Errors: non-list `provides_*`, unknown hook, callback without `**kwargs`, import/registration failure; warnings: declared-vs-registered drift. It is a validator, not a sandbox.

**Tests — always `scripts/run_tests.sh`, never bare `pytest`.**
```bash
scripts/run_tests.sh tests/plugins/test_<plugin>.py          # the acceptance test (file-granular; add -k <name> for one test)
scripts/run_tests.sh tests/hermes_cli/ tests/plugins/        # plugin-system chunk
scripts/run_tests.sh tests/agent/ tests/gateway/             # broader chunks, one directory group per call
```
Per-file subprocess isolation, `TZ=UTC`, credential vars scrubbed, one auto-retry per file (pass-on-retry prints a `FLAKY` section — a bug, not a pass). The runner `exec env -i`s forwarding only `PATH HOME TZ LANG LC_ALL PYTHONHASHSEED PYTHONUTF8` plus `HERMES_TEST_*` knobs (`scripts/run_tests.sh:169-183`), so nothing else from your shell reaches the tests. Chunk the suite by directory and run each chunk in an `Agent` subagent with an explicit Bash `timeout` sized to the chunk: the host's kill ceiling is max(CONTAINER_TIMEOUT, your declared timeout) and the heartbeat only ticks on tool events, so a silent long run without a declared timeout gets killed mid-way. The whole suite is ~3.5k test files / ~37k test functions (126 s on CI's 96 cores; expect far longer here) — never run it as a single call.

**Lint / hygiene.** `uv run ruff check plugins/<name> tests/<paths>` — blocking rules are `PLW1514` (explicit `encoding=`; `plugins/**` and `tests/**` exempt) and `ASYNC210/220/221/251` (no blocking HTTP / subprocess / sleep inside `async def`; applies to `plugins/**` in full) (`pyproject.toml:650-660`). `python scripts/check-windows-footguns.py` before a PR.

**Container gaps.** Relative to Hermes' own `Dockerfile:73` the coworker image lacks `ripgrep ffmpeg make python3-dev libffi-dev procps xz-utils` (`gcc`, `g++`, `cmake`, `git`, `curl`, `python3`, `python3-venv`, `uv` are present). If a step needs a missing package, report `blocked` naming it — durable installs are operator actions (`ncl groups config add-package` or `install_packages`, both admin-approved) — rather than working around it. `df -h /workspace/agent` before adding a worktree (each `.venv` is ~1 GB); remove only your own worktrees when a target closes.
