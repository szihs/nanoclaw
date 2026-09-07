---
name: hermes-spec-requirement
type: workflow
description: 'Turn one requirement row (FR-x / SR-x / PR-x / NF-x) from the shared Hermes requirements matrix into a classification (PORT-as-plugin | CORE-CHANGE | not-needed), an ADR + runnable acceptance test, a gated [Spec handoff] report up to the orchestrator, then an unmarked handoff to hermes-builder, and a forwarded resolution. Extends triage-issue; the input is not a GitHub issue and this role performs no GitHub writes.'
extends: triage-issue
requires: [issues.read, code.read]
uses:
  skills: [hermes-code-reader, hermes-github]
  workflows: [hermes-plan]
overrides:
  read: |
    **Read the issue** — There is no GitHub issue: the input is one **requirement row** from the shared Hermes requirements matrix, dispatched by the orchestrator. Do not run `gh issue view`.

    Find the row in the dispatch message itself, in an attachment under `/workspace/inbox/<msg-id>/`, or in `/workspace/shared/hermes-requirements.md` (read-only). Record `<orchestrator-inbound-id>` — every upstream report on this requirement replies to it. Extract:

    - **id** — `FR-x` (functional) | `SR-x` (security/safety) | `PR-x` (port/parity) | `NF-x` (non-functional). Wherever an inherited step says `<number>` or `{{vars.repo}}#<number>`, write this id (`FR-3`, not `{{vars.repo}}#FR-3`). The memo path is `/workspace/agent/memory/triage-<req-id>.md`; the canonical thread is `hermes-<req-id>`.
    - **title** and **requirement text verbatim**; the **acceptance criteria** — the list of separately testable observable behaviours the row demands (derive the ones it only implies and label each derived). One sentence is the summary that goes in the ADR's `## Requirement`; the list is what becomes the ADR's `## Acceptance criteria` table with ids `AC-<req-id>-<n>`. Split on behaviour, not on grammar: two things a test asserts separately are two criteria, and `works correctly` / `no regressions` is not a criterion at all.
    - **priority / wave**, **dependencies** on other requirement ids, and whether another id already covers it (duplicate).
    - **what nanoclaw behaviour is being PORTED** (nanoclaw file pointers are context for the design, never citations — citations come only from `{{vars.release_tree}}`).
    - **target surface**: CLI, messaging gateway, desktop + `hermes serve`, cron, subagents, profiles/distributions, tests/docs.

    Ambiguous row → state your interpretation in the memo and proceed; never pause for confirmation. Nothing here writes to GitHub or to the fork.
  research: |
    **Research** — Fan out via subagents; cost is your context, not wall clock. Three pillars, in authority order:

    1. **Release tree — authoritative, the ONLY citation source.** `{{vars.release_tree}}` is a read-only mount of {{vars.repo}} at exactly `{{vars.release_tag}}`; cite everything as `{{vars.release_tree}}/<file>:<line>`. Spawn an `Agent` subagent:
       > Explore `{{vars.release_tree}}` (read-only; Grep/Glob/Read only) for requirement <req-id>: <requirement text>. Answer: (a) which plugin surface covers it — hook name(s) in `VALID_HOOKS` and/or `PluginContext.register_*` method(s) in `hermes_cli/plugins.py`, manifest `kind`, quoting the defining line; cross-check the surface table in `website/docs/developer-guide/plugins/index.md`; (b) the closest bundled plugin to copy the shape from under `plugins/` (e.g. `plugins/platforms/a2a/` for peer wiring, `plugins/disk-cleanup/` for hook-only) with its `plugin.yaml` fields; (c) the existing tests that exercise that surface (`tests/hermes_cli/test_plugin_api_compat.py`, `tests/hermes_cli/test_plugin_dev.py`, `tests/plugins/`); (d) whether stock Hermes at this tag ALREADY satisfies the requirement (quote the line); (e) anything that would FORCE an edit outside `plugins/**`, `website/docs/**`, `tests/**` — quote the exact blocking line, or state 'no core edit needed'; (f) `AGENTS.md`/`CONTRIBUTING.md` rules that constrain the design (footprint ladder, no new HERMES_* env for non-secret config, behavior-contract tests, profile-safe paths, dependency pinning). Return facts as `<path>:<line> — <quote>`; label anything inferred as a hypothesis.
    2. **DeepWiki — advisory only.** `mcp__deepwiki__ask_question("NousResearch/hermes-agent", "<architecture/flow question>")`. It indexes a moving `main`, not `{{vars.release_tag}}`: every claim is a hypothesis until confirmed at a release-tree `file:line`; the tree wins every disagreement, and each disagreement is recorded verbatim (it becomes the ADR's `## DeepWiki disagreements`). Never cite DeepWiki alone.
    3. **Prior art (read-only `gh`).** `gh search issues --repo {{vars.repo}} "<keywords>"`, `gh search prs --repo {{vars.repo}} "<keywords>"`, `gh pr view <n> --repo {{vars.repo}}` — duplicates, merged approaches, maintainer decisions to respect (intentional omissions are design, not bugs). The fork at `/workspace/agent/hermes-agent` (if mounted) may be read for in-flight work; it is not a citation source.

    Merge before mapping the solution space. Stay read-only throughout.
  classify: |
    **Classify + persist** — Classify the requirement and write the memo the builder will read.

    **Classification (exactly one):**

    | Class | Meaning | Must name |
    |---|---|---|
    | **PORT-as-plugin** (default) | Met entirely by a Hermes plugin — directory plugin (`plugin.yaml` `manifest_version: 1` + `__init__.py register(ctx)`) or portable Agent Plugins v1 (`plugin.json` package) — touching only `plugins/**`, `website/docs/**`, `tests/**`. | The plugin surface (hook(s) from `VALID_HOOKS` / `register_*` method / `kind`) with its `{{vars.release_tree}}/hermes_cli/plugins.py:<line>`; the plugin key (`<name>` or `<category>/<name>`); the bundled plugin used as template. |
    | **CORE-CHANGE** | A plugin cannot meet it on the stock tree. | The blocking `{{vars.release_tree}}/<file>:<line>` and the minimal GENERIC widening (new hook / `ctx` method / config key) — never a special case for this plugin in core. No citation → the class is invalid; go back to Research. |
    | **not-needed** | Already satisfied by stock Hermes at `{{vars.release_tag}}`, or superseded by another requirement id. | The `file:line` that proves it (or the superseding id) and a one-command smoke check the reviewer can run. |

    Plus: **severity/priority** (from the row's priority/wave), **component** (plugin system / gateway / CLI / desktop+serve / cron / profiles / tests / docs), **duplicate** (other requirement id or `none`).

    **Artifacts.** PORT-as-plugin and CORE-CHANGE require the ADR at `/workspace/agent/reports/<slug>.md` and the acceptance test at `/workspace/agent/reports/<slug>-acceptance_test.py` — produced by the **hermes-plan** workflow (mode = plan; run it now if the solution-space step skipped it as trivial; its Handoff step returns here without dispatching). not-needed requires only the memo and the smoke check.

    **[MUST] Handoff-readiness: the ADR carries `## Acceptance criteria`.** Before this requirement leaves your session, that section exists in the ADR, uses the header `| id | criterion | how it will be verified |` verbatim, and holds one row per testable criterion with a contiguous `AC-<req-id>-<n>` id from 1 — the shape hermes-plan's Synthesize step specifies. Check it, don't assume it:

    ```bash
    grep -n '^## Acceptance criteria' /workspace/agent/reports/<slug>.md
    grep -c '^| AC-<req-id>-' /workspace/agent/reports/<slug>.md          # = number of criteria
    grep -c 'def test_ac_' /workspace/agent/reports/<slug>-acceptance_test.py   # = the same number
    ```

    Missing or short → go back to hermes-plan (mode = plan) and finish the table before the report step; never hand off an ADR without it and never let the builder or the tester "fill it in". You are the ONLY role in this chain permitted to mint an `AC-` id: `hermes-tester` emits one `## Results` row per id and fails its whole report when the ADR has none, `hermes-reviewer` cross-walks one row per id, and the Orchestrator's merge gate joins the two on those ids — so an ADR without the table cannot be verified, reviewed or merged, and the requirement stalls with nobody able to unblock it. Ids are stable for the life of the requirement: never renumbered, never reused, a withdrawn criterion keeps its id. Then write the memo via heredoc (the file is new; `Write` requires Read-first):

    ```bash
    mkdir -p /workspace/agent/memory && cat > /workspace/agent/memory/triage-<req-id>.md <<'EOF'
    # <req-id> — <title>
    - Classification: PORT-as-plugin | CORE-CHANGE | not-needed  · severity/priority: <…> · component: <…> · duplicate: <id|none>
    - Requirement (verbatim): <…>
    - Acceptance criterion: <one sentence> (derived: yes|no)
    - Acceptance criteria (ADR ## Acceptance criteria — ids are stable, never renumbered):
      - AC-<req-id>-1 — <criterion verbatim> → tests/plugins/test_<plugin>_acceptance.py::test_ac_<req_id>_1
      - AC-<req-id>-2 — <criterion verbatim> → tests/plugins/test_<plugin>_acceptance.py::test_ac_<req_id>_2
    - Plugin surface: <hook/register_*/kind> — {{vars.release_tree}}/hermes_cli/plugins.py:<line>; key <name|category/name>; template plugins/<…>/
    - CORE-CHANGE: none | {{vars.release_tree}}/<file>:<line> — <blocking reason> → <generic widening>
    - Approaches: <name> (<file:line>) — <delta> — <tradeoffs> — <risk>  (×2–3)
    - Recommended: <name> — <why>
    - ADR: /workspace/agent/reports/<slug>.md · Acceptance test: /workspace/agent/reports/<slug>-acceptance_test.py → tests/plugins/test_<plugin>_acceptance.py
    - DeepWiki disagreements: <…|none>
    - Prior art: <gh URLs|none>
    EOF
    ```
    The fixer reads this; don't skip. Nothing in this step touches GitHub or the fork. Note: this heredoc is a Bash `>` write — it bumps `edits_since_critique`, so the report step MUST re-run `OUTPUT_REVIEW` before its gated send.
  report: |
    **Report up to parent** — This is the gated **`[Spec handoff]`**: the architect's terminal report UP to the orchestrator and the ONLY send on a requirement that carries the `Spec handoff` marker. It goes out BEFORE the delegation to {{vars.fixer}} — the builder receives nothing until this send has been accepted, so the spec passes DIAGNOSIS_REVIEW / PLAN_REVIEW / OUTPUT_REVIEW before anyone builds on it.

    1. **Run `/codex-critique` with `STAGE: OUTPUT_REVIEW` immediately before the send** — ARTIFACTS: the memo (`/workspace/agent/memory/triage-<req-id>.md`), the ADR, the acceptance test, and the exact `[Spec handoff]` text below. The classify step's memo heredoc is a Bash `>` write, so `edits_since_critique` is non-zero since hermes-plan's OUTPUT_REVIEW round and the critique gate would deny this send as stale (`track-edits.sh` counts every Bash `>`/`>>` write regardless of path; `gate-critique-on-deliver.sh` denies a marked send while `edits_since_critique > 0`). Must-fix → revise the artifact, re-run OUTPUT_REVIEW. Touch no file between the approve and the send.
    2. **Send `[Spec handoff]` as a reply on the orchestrator edge** — `in_reply_to=<orchestrator-inbound-id>` (the requirement dispatch; the always-on chain-routing gate refuses a marker-prefixed send without it) — and attach the artifacts with the same `in_reply_to`:
       ```
       send_message(to="parent", in_reply_to=<orchestrator-inbound-id>, text="[Spec handoff] <req-id>: <title>\n- **Classification:** <PORT-as-plugin | CORE-CHANGE | not-needed> / <severity-priority> / <component> / duplicate: <id|none>\n- **Plugin surface:** <hook/register_*/kind> — {{vars.release_tree}}/hermes_cli/plugins.py:<line>; key <name|category/name>; template plugins/<…>/\n- **CORE-CHANGE:** none | {{vars.release_tree}}/<file>:<line> — <blocking reason> → <generic widening>\n- **Acceptance criteria:** <n> ids — AC-<req-id>-1 … AC-<req-id>-<n> (ADR §Acceptance criteria, one test_ac_<req_id>_<n> each) — the join key the tester rows, the reviewer cross-walks and your merge gate reads\n- **ADR / acceptance test:** attached — /workspace/agent/reports/<slug>.md, /workspace/agent/reports/<slug>-acceptance_test.py (not-needed: proof <file:line> + smoke check instead)\n- **Routing:** forwarding to {{vars.fixer}} on thread hermes-<req-id> | not-needed — nothing to build")
       send_file(to="parent", in_reply_to=<orchestrator-inbound-id>, path="/workspace/agent/memory/triage-<req-id>.md")
       send_file(to="parent", in_reply_to=<orchestrator-inbound-id>, path="/workspace/agent/reports/<slug>.md")
       send_file(to="parent", in_reply_to=<orchestrator-inbound-id>, path="/workspace/agent/reports/<slug>-acceptance_test.py")
       ```
    3. Denied → fix exactly what the gate names (missing `in_reply_to`, missing or stale critique stage) and re-send. Never strip the marker to slip past the gate, never substitute an ungated `[Report]` for this handoff, and never run the forward step while this send is denied.
  forward: |
    **Forward to {{vars.fixer}} — always** — Runs ONLY after the gated `[Spec handoff]` above was accepted (the send returned without a gate denial). This is the UNMARKED fresh delegation DOWN: {{vars.fixer}} has never written to you on this requirement, so there is no inbound to reply to, and the always-on chain-routing gate denies a marker-prefixed send without `in_reply_to`. The first line must not begin with `[`; explicit `thread_id` = the canonical requirement thread you were dispatched on, propagated unchanged:

    ```
    send_message(to="{{vars.fixer}}", thread_id="hermes-<req-id>", text="Spec handoff <req-id>: <title>\nPriority: <pri> | Component: <comp>\n- **Requirement:** <one-line acceptance criterion>\n- **Plugin surface:** <hook/register_* method; plugin key>\n- **CORE-CHANGE:** none | {{vars.release_tree}}/<file>:<line>\n- **Acceptance criteria:** AC-<req-id>-1 … AC-<req-id>-<n> — ADR §Acceptance criteria; one test_ac_<req_id>_<n> per id. hermes-tester emits one Results row per id and FAILs the report if one is missing; do not renumber or add ids — ask me\n- **Acceptance test:** attached — copy to tests/plugins/test_<plugin>_acceptance.py; must fail before, pass after\n- **ADR + memo:** attached — alternatives, repro, risks in the memo")
    send_file(to="{{vars.fixer}}", thread_id="hermes-<req-id>", path="/workspace/agent/memory/triage-<req-id>.md")
    send_file(to="{{vars.fixer}}", thread_id="hermes-<req-id>", path="/workspace/agent/reports/<slug>.md")
    send_file(to="{{vars.fixer}}", thread_id="hermes-<req-id>", path="/workspace/agent/reports/<slug>-acceptance_test.py")
    ```
    Don't gate on "if actionable" — the fixer decides whether and how to build and may bounce back; forward anyway and let the parent escalate. The `[Triage handoff]` marker is used only when REPLYING (`in_reply_to=<builder-msg-id>`) to a builder inbound (bounce-back, question) — never on this fresh delegation. Exception: classification **not-needed** → skip this step (nothing to build); the resolution goes up in the forward-up step.
  post-issue-comment: |
    **Post the triage outcome on the issue** — There is no issue and this role holds no GitHub-writable state: **no `gh` write of any kind.** The resumable artifact is a row in the shared requirements ledger. `/workspace/shared` is mounted read-only for coworkers, so fall back to the group reports dir when it is not writable:

    ```bash
    LEDGER=/workspace/shared/hermes-requirements-ledger.md
    [ -w "$(dirname "$LEDGER")" ] || LEDGER=/workspace/agent/reports/hermes-requirements-ledger.md
    mkdir -p "$(dirname "$LEDGER")"
    [ -f "$LEDGER" ] || printf '| updated | req | class | plugin surface | CORE-CHANGE | ADR | acceptance test | status |\n|---|---|---|---|---|---|---|---|\n' > "$LEDGER"
    ROW="| $(date -u +%Y-%m-%dT%H:%MZ) | <req-id> | <PORT-as-plugin|CORE-CHANGE|not-needed> | <surface; key> | <none|file:line> | /workspace/agent/reports/<slug>.md | tests/plugins/test_<plugin>_acceptance.py | <status> |"
    if grep -q "^| [^|]* | <req-id> |" "$LEDGER"; then      # edit-if-exists, else append — one row per requirement id
      awk -v row="$ROW" -F'|' '$3 ~ /^ <req-id> $/ {print row; next} {print}' "$LEDGER" > "$LEDGER.tmp" && mv "$LEDGER.tmp" "$LEDGER"
    else
      echo "$ROW" >> "$LEDGER"
    fi
    ```
    `<status>` values: `triaged → handed to {{vars.fixer}}` right after the handoff; `fix in draft PR <url>, reviewer <verdict>` when the `[Fix Report]` lands; `blocked: <reason>` / `not-needed: <proof>` otherwise. Re-run this step whenever the state changes (the forward-up step calls back here), always updating the existing row rather than adding a second one. Send the ledger path in your upstream reports so the orchestrator can `send_file` it into the shared tree.

    **This write stales the critique gate.** `track-edits.sh` counts the `printf >` / `echo >>` / `awk > … && mv` above as edits (any Bash `>`/`>>`, regardless of path), so `edits_since_critique` is non-zero afterwards and `gate-critique-on-deliver.sh` denies the next marked send. Re-run `/codex-critique` with `STAGE: OUTPUT_REVIEW` before any marked send that follows this step (`[Triage Resolution]` in the forward-up step; `[Spec handoff]` in the report step if you ever re-run this step before it).
  forward-up: |
    **Forward resolution upstream** — Run `/codex-critique` with `STAGE: OUTPUT_REVIEW` on the memo, ledger row and the resolution text immediately before this send (the ledger/memo writes since the last round make the gate stale: `track-edits.sh` counts every Bash `>`/`>>` write regardless of path, and `gate-critique-on-deliver.sh` denies a marked send while `edits_since_critique > 0`). Order is therefore: re-run the ledger step (post-issue-comment) with the final status → OUTPUT_REVIEW → send; touch no file in between.

    When `[Fix Report]` lands, compile the [Triage Resolution] 5-bullet. For partial/blocked, still forward — substitute `blocked: <reason>`. Per `### Chain communication` in your spine: close every chain explicitly. Re-run the ledger step to reflect the final verdict (edit the existing row per that step's rule) — including when a fix is in flight, since the resolving PR is a draft in the fork until a human merges it; there is no GitHub issue to post on, so the ledger row is the only resumable artifact. Classification **not-needed** skips the wait: ledger row → OUTPUT_REVIEW → this send, right after the `[Spec handoff]`.

    **This message is the Orchestrator's merge-gate trigger, and it is the ONLY one.** The Orchestrator has no edge to {{vars.fixer}} — its single edge into this chain is the requirement dispatch you are replying to — so the builder's terminal `[Fix Report]` stops with you. On `Outcome: fixed` you therefore append a `## Merge gate` block carrying the builder's locators forward verbatim. Without it the PR stalls with nobody merging.

    **Locators only — you are relaying, not attesting.** Copy the values out of the builder's `[Fix Report]`; do not retype the reviewer's verdict, the tester's `## Results` rows, or the criteria table. The Orchestrator reads those originals out of the reviewer's and tester's own sessions. Anything you cannot copy because the `[Fix Report]` did not carry it goes in the block as `MISSING: <field>` — never as a blank, never as a value you inferred, and never as a value you fetched yourself. A `[Fix Report]` with `Blocker: mismatch: …` is `Outcome: partial` with no `## Merge gate` block: a contradiction the builder flagged is not a merge request.

    ```
    send_message(to="parent", in_reply_to=<orchestrator-inbound-id>, text="[Triage Resolution] <req-id>: <title>\n\n- **Outcome:** <fixed / partial / blocked / abandoned / not-needed>\n- **Draft PR:** <fork url-or-'patch only, no PR'-or-'none (not-needed)'>\n- **Review:** <APPROVE / REQUEST_CHANGES / N findings — top concern>\n- **Tests:** <acceptance PASS/FAIL>; doctor <OK/FAIL>; broader suite <result>\n- **Next human action:** <merge gate (no human needed) / address review / coordinate / close as not-needed>\n\n## Merge gate\n- **PR:** <fork-slug>#<N> — <url> (draft)\n- **Head SHA:** <full 40-char sha>\n- **Base:** release/<tag>-e2e-fixed (manifest tag <tag>)\n- **Thread:** hermes-<req-id>\n- **Reviewer:** hermes-reviewer — [Review Verdict] APPROVE, msg <verdict-msg-id>, review round <k>/2, head <sha7>\n- **Tester:** hermes-tester — [Test Report] PASS, msg <test-report-msg-id>, test round <k>/2, head <sha7>, file test-report-<sha7>.md\n- **Acceptance criteria:** <n> ids AC-<req-id>-1 … AC-<req-id>-<n> — ADR §Acceptance criteria, attached to my [Spec handoff] in your inbox\n- **CORE-CHANGE:** none | {{vars.release_tree}}/<file>:<line>\n- **Evidence:** read the originals from the reviewer's and tester's own sessions; these are locators, not findings")
    ```
    Omit the whole `## Merge gate` block for any outcome other than `fixed` — an absent block is how the Orchestrator tells a status report from a merge request.
---

# hermes-spec-requirement

## Hermes deltas

- **Input.** A requirement row, not an issue: `<number>` in the inherited steps means `<req-id>` (`FR-x`/`SR-x`/`PR-x`/`NF-x`); write `<req-id>` where a step says `{{vars.repo}}#<number>`. The canonical thread is `hermes-<req-id>` — the one you were dispatched on; propagate it unchanged.
- **Citations** come only from `{{vars.release_tree}}` ({{vars.repo}} @ `{{vars.release_tag}}`, read-only). DeepWiki is advisory; disagreements are recorded in the ADR. No GitHub writes anywhere in this workflow; you are read-only on the fork (never `git push`, never open a PR).
- **Acceptance-criterion ids are minted here and nowhere else.** The ADR's `## Acceptance criteria` table (header `| id | criterion | how it will be verified |`, one row per testable behaviour, contiguous `AC-<req-id>-<n>` from 1, one `test_ac_<req_id>_<n>` node id per row) is a **handoff-readiness condition**: no table → no `[Spec handoff]`, no forward to `{{vars.fixer}}`. `hermes-tester` fails its whole report on an ADR without it, `hermes-reviewer` must-changes the PR, and the Orchestrator's merge gate joins verdict to report on those ids — none of them may invent one. Ids never move: not renumbered between rounds, not reused, a withdrawn criterion keeps its id.
- **Handoff ordering: report UP first, then forward DOWN.** The architect's gated terminal is `[Spec handoff]` — sent UP to the orchestrator in the report step as a reply (`in_reply_to=<orchestrator-inbound-id>`), after a fresh `OUTPUT_REVIEW` (the classify memo heredoc stales the gate). Only after it is accepted does the forward step delegate DOWN to `{{vars.fixer}}`, as UNMARKED text (first line `Spec handoff <req-id>: <title>`) with explicit `thread_id="hermes-<req-id>"` plus `send_file` of the memo, the ADR and the acceptance test. The always-on chain-routing gate refuses any `send_message` whose text starts with a delivery marker (`[Spec handoff]`, `[Triage handoff]`, …) unless the call carries `in_reply_to`, and a fresh delegation has none — so the delegation can never be marked and the marker rides the report up. Use `[Triage handoff]` only when replying (`in_reply_to`) to a builder inbound. The hermes-plan workflow, when nested under the solution-space step, never dispatches — this workflow owns the single handoff (yaml `delivery_markers`, README §Marker routing and these steps agree).
- **Critique freshness.** `track-edits.sh` counts every Bash `>`/`>>` write (the classify memo heredoc, the ledger `printf`/`echo`) toward `edits_since_critique`, regardless of path, and `gate-critique-on-deliver.sh` denies a marked send while it is non-zero. Re-run `/codex-critique` with `STAGE: OUTPUT_REVIEW` immediately before each gated send — `[Spec handoff]` (report step) and `[Triage Resolution]` (forward-up step) — and write no file between the approve and the send.
- **The merge gate answers on this edge, and you relay it down.** After the `[Triage Resolution]`, the Orchestrator runs its merge gate (`context/merge-gate.md`) and replies to that message — unmarked plain text, either a merge notice or `blocked: P<n> — <what disagreed> — <what has to happen>`. It has no builder edge, so **you** forward the blocked line to {{vars.fixer}} as an unmarked fresh send on `thread_id="hermes-<req-id>"` (first line must not begin with `[`), verbatim plus the requirement id, and you update the ledger row's `status` to `blocked: P<n> — <reason>`. `blocked: P5 — ADR has no enumerated ## Acceptance criteria table` is yours to fix, not the builder's: mint the missing ids in the ADR (never renumbering an existing one), re-send the ADR to both the Orchestrator and {{vars.fixer}}, and say which ids are new. When the builder lands a new head and a new `[Fix Report]`, re-run the ledger step → `OUTPUT_REVIEW` → a fresh `[Triage Resolution]` with an updated `## Merge gate` block. Never merge, ready, or re-target the PR yourself — `no-push.md` covers you too.
- **Waiting.** The builder's `[Fix Report]` arrives only after `hermes-reviewer` returned `[Review Verdict] APPROVE`. The reviewer is wired to the builder, not to you; if a reviewer message reaches you anyway (the a2a lineage rule lets a grandchild reply to an ancestor), treat it as a peer inbound — do not act on it as a verdict, do not fold it into your report unless it is a blocker; the builder owns the review loop.
- **Closing.** `[Triage Resolution]` goes up on the orchestrator edge with `in_reply_to`, after the ledger row is updated with the final status and a fresh `OUTPUT_REVIEW` (ledger row → OUTPUT_REVIEW → send); the ledger step replaces the GitHub issue comment.
