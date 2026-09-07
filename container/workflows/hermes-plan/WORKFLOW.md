---
name: hermes-plan
type: workflow
description: 'Plan, investigate, review, or research Hermes Agent tasks. Augments the base plan workflow with release-tree-first research (DeepWiki advisory only), an ADR + runnable acceptance test as the plan deliverable, and a routing-gate-safe handoff to hermes-builder.'
extends: plan
requires: [issues.read, code.read, doc.read]
uses:
  skills: [hermes-code-reader, hermes-github]
  workflows: []
overrides:
  research: |
    **Research** — Gather evidence from the pinned Hermes release tree first; everything else is advisory.

    Send `mcp__nanoclaw__send_message(to="parent")` with a one-line status at the start (use `send_message`, not `<message>`, which only dispatches from the final response).

    **Path A — release tree (authoritative, the ONLY citation source).** `{{vars.release_tree}}` is a read-only mount of {{vars.repo}} at exactly `{{vars.release_tag}}`. Every fact you state must be cited as `{{vars.release_tree}}/<file>:<line>` (path relative to that mount). Spawn an `Agent` subagent so the exploration stays out of your context:

    > Explore `{{vars.release_tree}}` (read-only) for <target>. Use Grep, Glob, Read only. Cover, in this order: (1) the plugin contract — `hermes_cli/plugins.py` (`PluginManager`, `PluginContext.register_*`, `VALID_HOOKS`, discovery precedence bundled → `$HERMES_HOME/plugins` → project → pip entry points, `plugins.enabled` opt-in), `hermes_cli/plugin_dev.py` (`doctor_plugin`), `hermes_cli/agent_plugins.py` (portable Agent Plugins v1), `website/docs/developer-guide/plugins/index.md` (the surface table: hooks, `register_tool/hook/command/cli_command/platform/middleware/system_prompt_section/skill/terminal_environment_provider/secret_source/approval_transport`, manifest fields, `plugin_storage`); (2) the closest bundled plugin to copy the shape from under `plugins/` (e.g. `plugins/platforms/a2a/` for gateway/peer wiring, `plugins/disk-cleanup/` for hook-only plugins); (3) the core code path the requirement touches (`run_agent.py`, `toolsets.py`, `gateway/`, `agent/shell_hooks.py`, `hermes_cli/config.py`, `cron/`, `tui_gateway/`) — only to learn WHERE a plugin hooks in, not to plan an edit there; (4) existing tests of that surface (`tests/hermes_cli/test_plugin_api_compat.py`, `tests/hermes_cli/test_plugin_dev.py`, `tests/plugins/`); (5) `AGENTS.md` and `CONTRIBUTING.md` rules that constrain the surface (footprint ladder, no new HERMES_* env for non-secret config, behavior-contract tests, profile-safe paths). Return: findings as `<path>:<line> — <quoted line or one-line paraphrase>`, the candidate plugin surface(s), and anything that would FORCE an edit outside `plugins/**`, `website/docs/**`, `tests/**` (quote the exact blocking line).

    **Path B — DeepWiki (advisory, never a citation).** DeepWiki indexes a moving `main`, not `{{vars.release_tag}}`:
    ```
    mcp__deepwiki__ask_question("NousResearch/hermes-agent", "<question about target derived from the task>")
    ```
    Every DeepWiki claim is a hypothesis until confirmed at a release-tree `file:line`. Where DeepWiki and the tree disagree, the tree wins; record the disagreement verbatim under a `DeepWiki disagreements` heading in your notes (it goes into the ADR). Never cite DeepWiki alone.

    **Path C — prior art (read-only).** `gh search issues --repo {{vars.repo}} "<keywords>"` and `gh search prs --repo {{vars.repo}} "<keywords>"` for duplicates, merged approaches, and maintainer decisions; `/hermes-github` for CI history. The fork checkout at `/workspace/agent/hermes-agent` (if present) may be read for in-flight work but is never a citation source.

    Merge A/B/C before Synthesize. Stay read-only throughout — no edits to the release tree (it is mounted ro anyway), the fork, or the shared mount.
  diagnose: |
    **Synthesize** — The plan deliverable for Hermes is an ADR plus a runnable acceptance test; other modes keep the base shape (**investigate** = classify + facts vs hypotheses; **review** = findings by severity with file:line; **research** = answer with evidence).

    **ADR skeleton (mode = plan).** Draft with exactly these sections, in order:

    1. `# ADR: <req-id> — <title>`
    2. `## Context` — the requirement text verbatim, who asked, what nanoclaw behaviour is being PORTED (nanoclaw pointers are context, not citations).
    3. `## Requirement` — id (`FR-x` | `SR-x` | `PR-x` | `NF-x`) and the acceptance criterion in one testable sentence.
    4. `## Acceptance criteria` — **required; an ADR without it is not handoff-ready.** A markdown table with this header, character for character:

       ```markdown
       | id | criterion | how it will be verified |
       |---|---|---|
       | AC-<req-id>-1 | <one observable behaviour, testable as written> | tests/plugins/test_<plugin>_acceptance.py::test_ac_<req_id>_1 — <what it asserts> |
       | AC-<req-id>-2 | <…> | tests/plugins/test_<plugin>_acceptance.py::test_ac_<req_id>_2 — <…> |
       ```

       One row per **testable** criterion, in a fixed order, ids `AC-<req-id>-<n>` with `<n>` 1-based and contiguous from 1 (`AC-FR-3-1`, `AC-SR-2-4`). Split the `## Requirement` sentence into the behaviours a test can assert separately: one observable behaviour per row, never two joined by "and", never `works correctly` / `no regressions` / `is documented` (unfalsifiable rows are the failure this table exists to prevent — a doc requirement becomes a criterion only when a test can read the rendered page). Derive a criterion the requirement row only implies, and mark it `(derived)` in the criterion cell. The `how it will be verified` cell names the pytest **node id** the acceptance test will carry — `test_ac_<req_id>_<n>`, the id lowercased with `-`→`_` — plus one clause naming the assertion; a criterion this ADR does not intend to test yet still gets a row, with `how it will be verified` = `no test — criterion unimplemented`, and the builder must close it before the tester can report PASS.

       **These ids are the chain's join key, and nothing downstream may mint one.** `hermes-tester` emits exactly one `AC-<req-id>-<n>` row per id in its `## Results` table (a criterion with no test is a `FAIL` row, never an omission); `hermes-reviewer`'s `## Acceptance criteria` cross-walk carries one row per id and reads the cited test body to confirm it exercises the criterion; the Orchestrator's merge gate joins the `[Review Verdict]` to the `[Test Report]` on these ids and refuses to merge on an unmapped one. So: never renumber, never reuse, never re-order across rounds — a criterion dropped in a later round keeps its id with `WITHDRAWN — <why>` in the criterion cell, and a criterion added in a later round takes the next unused `<n>`. An ADR that ships without this table deadlocks the round trip at the tester (report verdict `FAIL`, `ADR has no enumerated acceptance criteria`), and no role downstream is permitted to unblock it by inventing ids.
    5. `## Plugin surface` — chosen from the plugin docs table (`{{vars.release_tree}}/website/docs/developer-guide/plugins/index.md`) and pinned to code: the hook name(s) from `VALID_HOOKS` and/or the `PluginContext.register_*` method(s), the manifest `kind` if any, cited as `{{vars.release_tree}}/hermes_cli/plugins.py:<line>`. State the plugin shape: directory plugin (`plugin.yaml` with `manifest_version: 1`, `name`, `version`, `description`, `provides_tools`, `provides_hooks` + `__init__.py` exposing `register(ctx)`) or portable Agent Plugins v1 (`plugin.json` + `skills/<name>/SKILL.md` [+ `mcp.json`]). Give the plugin key (`<name>` flat under `plugins/`, or `<category>/<name>`) and note that it must be listed in `plugins.enabled` to load.
    6. `## Design` — files under `plugins/<name>/` (or `plugins/<category>/<name>/`), config keys under `plugins.entries.<id>.settings` (never a new `HERMES_*` env var for non-secret config), durable state via `plugins.plugin_storage.plugin_data_dir(<name>)`, paths via `get_hermes_home()`, cross-platform notes.
    7. `## Alternatives` — at least two, each with the footprint-ladder rung (extend existing → CLI + skill → `check_fn` tool → plugin → MCP → core tool) and the constraint that ruled it out. If only one is viable, name the constraint — that is load-bearing.
    8. `## CORE-CHANGE` — default text: `none — all edits under plugins/**, website/docs/**, tests/**`. If ANY edit outside those three trees is required, this section must cite the exact `{{vars.release_tree}}/<file>:<line>` that blocks a plugin and describe the minimal GENERIC widening (a new hook, a new `ctx` method, a new config key) — never a special case for this plugin in core. Without that citation the builder must refuse the core edit and the reviewer must-changes the PR.
    9. `## DeepWiki disagreements` — each DeepWiki claim that the tree contradicted, with the tree's `file:line`; `none` if none.
    10. `## Acceptance test` — target path `tests/plugins/test_<plugin>_acceptance.py`, **one test function per `## Acceptance criteria` id** named `test_ac_<req_id>_<n>` (the id lowercased, `-`→`_`) with the criterion text as the docstring's first line, what each proves, and why the file must FAIL on the stock `{{vars.release_tag}}` tree. That naming is the whole mechanism by which a criterion id resolves to a pytest node id without anyone reading prose — keep it mechanical.
    11. `## References` — release-tree `file:line` list; `gh` URLs for prior art.

    **Acceptance-test spec (mode = plan).** Mirror `{{vars.release_tree}}/tests/hermes_cli/test_plugin_api_compat.py` exactly in shape: `tmp_path`-rooted `hermes_home`; copy the plugin directory into `<hermes_home>/plugins/<key>`; write `<hermes_home>/config.yaml` with `plugins: {enabled: [<key>]}`; create an EMPTY bundled dir and `monkeypatch.setenv` `HOME`, `HERMES_HOME`, `HERMES_BUNDLED_PLUGINS`; `manager = PluginManager(); manager.discover_and_load()`; `loaded = manager._plugins[<key>]`; assert `loaded.enabled is True`, `loaded.error is None`, `loaded.module is not None`, and the declared hooks/tools are in `loaded.hooks_registered` / registered tools; then DRIVE the behaviour (`manager.invoke_hook(<hook>, ..., future_additive_field=...)`, or the tool handler / `ctx.dispatch_tool`) and assert the OUTCOME from the acceptance criterion. **One `def test_ac_<req_id>_<n>(...)` per `## Acceptance criteria` row, same order, docstring line 1 = the criterion text**: each asserts its own criterion's observable behaviour and nothing else — a test that only imports the plugin, asserts `True`, or re-proves that discovery loaded the key is a row the reviewer must-changes, because it is the shape that lets an unmet criterion read as PASS. Shared setup goes in a fixture, not in a criterion test. Rules: behavior contract, not a snapshot — no model lists, version literals, enumeration counts; never read source files in the test; no network; nothing written under `~/.hermes`; hook callbacks under test accept `**kwargs`; tool handlers return a JSON string. The test must fail on the stock tree (plugin absent → `KeyError`/not enabled) and pass once the plugin exists — that asymmetry is what makes it an acceptance test.

    When the reading is settled — surface chosen, CORE-CHANGE flag decided — run `/codex-critique` with `STAGE: DIAGNOSIS_REVIEW` (artifacts: your notes with the `file:line` pointers; state the surface and the CORE-CHANGE decision in WHAT I DID). Must-fix → re-read, don't argue.
  deliver: |
    **Deliver** — Write both artifacts, then critique them before anything leaves this session.

    1. ADR → `/workspace/agent/reports/{{target_slug}}.md` (heredoc — the file is new; `Write` requires Read-first). Non-plan modes write the mode-appropriate report to the same path (status/verdict/conclusion, facts, hypotheses, next, references).
    2. Acceptance test → `/workspace/agent/reports/{{target_slug}}-acceptance_test.py` (mode = plan). Syntax-check it: `python3 -m py_compile /workspace/agent/reports/{{target_slug}}-acceptance_test.py`. Do NOT try to run it here — you have no Hermes venv and no write access to the fork; the builder proves it fails, then passes.
    3. **Handoff-readiness check, before the critique:** `grep -n '^## Acceptance criteria' /workspace/agent/reports/{{target_slug}}.md` and read the table back — it must exist, carry contiguous `AC-<req-id>-<n>` ids from 1, and name one `test_ac_<req_id>_<n>` node id per row that the acceptance-test file actually defines (`grep -c 'def test_ac_' /workspace/agent/reports/{{target_slug}}-acceptance_test.py` equals the row count). A missing or short table is not a nit to fix later: it is the single input `hermes-tester` and `hermes-reviewer` fail closed on, so fix it here rather than shipping the ADR.
    4. `/codex-critique` with `STAGE: PLAN_REVIEW` — ARTIFACTS = both file paths (codex reads them itself; the `### Attested` hashes bind the review to these exact files). Must-fix → revise both files, re-run PLAN_REVIEW (3 rounds max, per the skill — round 3 must converge; escalate to parent only if a correctness/safety must-fix survives the round-3 challenge, rather than shipping a disputed spec).
    5. `/codex-critique` with `STAGE: OUTPUT_REVIEW` on the final pair plus the handoff text you are about to send. Any edit to either file after this round invalidates the attested hashes — re-run OUTPUT_REVIEW before Handoff.

    Send `mcp__nanoclaw__send_message(to="parent")` with a one-line status when done.
  handoff: |
    **Handoff** — Post a ≤5-bullet summary linking the report, then route by how you were invoked.

    **Nested (invoked from the hermes-spec-requirement workflow's solution-space step):** return to that workflow — it owns classify / report / forward. Do NOT dispatch to hermes-builder from here (double dispatch = two builder sessions on one requirement).

    **Standalone, `mode` = plan, `hermes-builder` in your destinations:** two sends, in this order — the gated report UP first, the unmarked delegation DOWN second. The always-on chain-routing gate refuses any `send_message` whose text starts with a delivery marker (`[Spec handoff]`, `[Triage handoff]`, …) unless the call carries `in_reply_to`; a fresh delegation to the builder has no inbound to reply to, so it can never be marked — which is why `[Spec handoff]` is the report to the orchestrator, not the delegation.

    1. **Gated `[Spec handoff]` — reply on the parent edge** (`in_reply_to=<orchestrator-inbound-id>`, the inbound that dispatched this task). The OUTPUT_REVIEW from Deliver step 4 must still be fresh: no file writes since that round (any Bash `>`/`>>` write or Edit/Write bumps `edits_since_critique`, and the critique gate then denies the send as stale — re-run OUTPUT_REVIEW if you touched anything).
       ```
       send_message(to="parent", in_reply_to=<orchestrator-inbound-id>, text="[Spec handoff] <req-id>: <title>\n- **Classification:** PORT-as-plugin | CORE-CHANGE\n- **Plugin surface:** <hook/register_* method; plugin key> — {{vars.release_tree}}/hermes_cli/plugins.py:<line>\n- **CORE-CHANGE:** none | {{vars.release_tree}}/<file>:<line>\n- **Acceptance criteria:** AC-<req-id>-1 … AC-<req-id>-<n> (<n> ids, ADR §Acceptance criteria) — the ids the tester rows, the reviewer cross-walk and your merge gate join on\n- **ADR / acceptance test:** attached — /workspace/agent/reports/{{target_slug}}.md, /workspace/agent/reports/{{target_slug}}-acceptance_test.py\n- **Routing:** forwarding to hermes-builder on thread hermes-<req-id>")
       send_file(to="parent", in_reply_to=<orchestrator-inbound-id>, path="/workspace/agent/reports/{{target_slug}}.md")
       send_file(to="parent", in_reply_to=<orchestrator-inbound-id>, path="/workspace/agent/reports/{{target_slug}}-acceptance_test.py")
       ```
       Denied → fix exactly what the gate names (missing `in_reply_to`, missing or stale critique stage) and re-send; never strip the marker, never substitute an ungated `[Report]`, and do not delegate while this send is denied.
    2. **Unmarked delegation to `hermes-builder` — only after step 1 was accepted.** The first line must not begin with `[`; explicit stable `thread_id` = the requirement key you were dispatched on (`hermes-<req-id>`), propagated unchanged:
       ```
       send_message(to="hermes-builder", thread_id="hermes-<req-id>", text="Spec handoff <req-id>: <title>\n- **Requirement:** <one-line acceptance criterion>\n- **Plugin surface:** <hook/register_* method; plugin key>\n- **CORE-CHANGE:** none | {{vars.release_tree}}/<file>:<line>\n- **Acceptance criteria:** AC-<req-id>-1 … AC-<req-id>-<n> — ADR §Acceptance criteria, one test_ac_<req_id>_<n> per id; hermes-tester emits one Results row per id and fails the report if any is missing\n- **Acceptance test:** attached — copy to tests/plugins/test_<plugin>_acceptance.py; must fail before, pass after\n- **ADR:** attached")
       send_file(to="hermes-builder", thread_id="hermes-<req-id>", path="/workspace/agent/reports/{{target_slug}}.md")
       send_file(to="hermes-builder", thread_id="hermes-<req-id>", path="/workspace/agent/reports/{{target_slug}}-acceptance_test.py")
       ```
    3. **Builder bounce-back or question later** (a builder inbound now exists): answer as a marked, linked reply — `send_message(in_reply_to=<builder-msg-id>, text="[Triage handoff] <req-id>: <title>\n…same bullets as step 2…")` plus `send_file(in_reply_to=<builder-msg-id>, path=…)` for anything re-attached. Never re-dispatch a fresh delegation for the same requirement (double dispatch = two builder sessions).

    Never send a marker-prefixed fresh delegation — it is refused three times and then thrashes your turn budget. After step 2, end the turn — there is no separate `[Report]`: the gated `[Spec handoff]` IS the report up. The builder's `[Fix Report]` arrives later (30–90 min) — don't poll, don't re-dispatch, don't answer status echoes.

    **`mode` = review / research / investigate, or `hermes-builder` not in your destinations:** post the 5-bullet up (`to="parent"`, `in_reply_to` the inbound you are answering) and stop. You are read-only on the fork: never `git push`, never open a PR, never edit `{{vars.release_tree}}`.
---

# hermes-plan

## Hermes deltas

- `{{vars.release_tree}}` (ro, {{vars.repo}} @ `{{vars.release_tag}}`) is the only citation source. DeepWiki is advisory and every disagreement with the tree is recorded in the ADR. Never cite DeepWiki alone.
- The plan deliverable is two files: the ADR (`/workspace/agent/reports/<slug>.md`) and the acceptance test (`/workspace/agent/reports/<slug>-acceptance_test.py`) in the `tests/hermes_cli/test_plugin_api_compat.py` shape. Both are critiqued (`PLAN_REVIEW`, then `OUTPUT_REVIEW`) before they leave the session.
- **The ADR mints the acceptance-criterion ids and is the only place they are minted.** `## Acceptance criteria` (header `| id | criterion | how it will be verified |`) carries one row per testable behaviour with a contiguous `AC-<req-id>-<n>` id, and the acceptance test carries one `def test_ac_<req_id>_<n>` per row. `hermes-tester` emits one `## Results` row per id, `hermes-reviewer` cross-walks one row per id, and the Orchestrator's merge gate joins the two on those ids — so an ADR without the table cannot be verified, cannot be reviewed and cannot be merged, and no downstream role is allowed to invent the missing ids. Never renumber or reuse an id across rounds.
- Every capability is a Hermes plugin. Any edit outside `plugins/**`, `website/docs/**`, `tests/**` needs the ADR's `## CORE-CHANGE` section citing the blocking `{{vars.release_tree}}/<file>:<line>`; the reviewer must-changes a PR without it.
- Handoff shape is dictated by the always-on chain-routing gate (marker-prefixed send without `in_reply_to` → denied): the gated `[Spec handoff]` is the report UP to the orchestrator, sent FIRST as a reply (`in_reply_to=<orchestrator-inbound-id>`) with the OUTPUT_REVIEW still fresh; the delegation DOWN to hermes-builder is unmarked text with explicit `thread_id="hermes-<req-id>"`, sent only after the `[Spec handoff]` was accepted; there is no separate `[Report]`. `[Triage handoff]` is used only when replying to a builder inbound. Nested under hermes-spec-requirement, this workflow does not dispatch at all (yaml `delivery_markers`, README §Marker routing and this step agree).
