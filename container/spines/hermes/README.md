# spine-hermes

Hermes Agent project spine under the lego coworker model, for the **meta team that ports NanoClaw coworker capabilities into Hermes as Hermes plugins** (PORT, not bridge). Target: `NousResearch/hermes-agent` at release tag `v2026.8.31` (v0.21.0), mounted read-only at `/workspace/extra/hermes-release`; implementation happens in a fork at `/workspace/agent/hermes-agent` with one git worktree per target.

Provides identity, invariants, context, and coworker types:

| Type | Extends | Role |
|------|---------|------|
| `hermes-common` | `base-common` | identity, `public-api` + `plugin-first` invariants, `layout` + `testbed` context, `vars` (`repo`, `project`, `fixer`, `release_tag`, `release_tree`), DeepWiki (advisory) |
| `hermes-reader` | `hermes-common` | read-only: `hermes-plan` |
| `hermes-writer` | `hermes-common` | `hermes-plan` + `hermes-implement`, `hermes-code-writer`, `hermes-docs` |
| `hermes-architect` | `hermes-reader` | ADR + runnable acceptance test per requirement (`hermes-spec-requirement`); `no-push`; stages `DIAGNOSIS_REVIEW, PLAN_REVIEW, OUTPUT_REVIEW`; novel marker `[Spec handoff]` |
| `hermes-builder` | `hermes-writer` | implements the plugin in the fork worktree, tests + `doctor --ci`, draft PR to the fork, `peer-review` invariant; stages `PLAN_REVIEW, CODE_REVIEW, OUTPUT_REVIEW` |
| `hermes-reviewer` | `hermes-reader` | adversarial re-run of acceptance test + doctor in its own container (`hermes-review`); `no-push` + `code-changes`; stages `CODE_REVIEW, OUTPUT_REVIEW` |

Wiring is architect ↔ builder ↔ reviewer/tester (`wire_agents`), plus `orchestrator → tester`; the orchestrator drives requirement rows to the architect. Overlays (`critique-gate`, `plan-gate`), `cli_scope`, apt packages, and the release mount are per-group settings, not type keys.

## Merge authority (there is no orchestrator ↔ builder edge)

The orchestrator (`main`, `cli_scope: global`) is the sole merge authority and the only role that may run `gh pr merge --squash`. Its gate lives in `context/merge-gate.md`, contributed to the `main` type as a **context fragment** — `main` is `flat: true`, so a workflow or skill attached to it is silently discarded and only `identity` + `context` compose.

Its one edge into this chain is the requirement dispatch it sends the architect, so:

- **The gate fires on the architect's `[Triage Resolution]`**, whose `## Merge gate` block carries the builder's locators forward (PR number, full head SHA, `$BASE`, thread, the reviewer's and tester's message ids + rounds). It is a pointer sheet, never evidence.
- **A red precondition is answered on the architect's edge** (`in_reply_to=<the [Triage Resolution]>`); the architect relays it down to the builder. The orchestrator never opens a builder edge — that would skip a tier.
- **First-party evidence is read, not forwarded.** The reviewer's `[Review Verdict]` and the tester's `[Test Report]` are pulled out of those roles' own sessions (`ncl groups list` → `ncl sessions list --agent-group-id … --thread-id hermes-<req-id>` → `ncl sessions messages … --full --reverse`), because the builder is the party being gated. The tester's canonical report **file** is requested over the `orchestrator → tester` edge as an unmarked fresh dispatch.
- **Attachment paths are never built from a message id.** `send_file` writes its own message with its own id, so a file lands under `inbox/<the file message's id>/`, not under the id of the text that mentions it. Read the `saved to` path the formatter prints, or locate the file by name and verify its contents.

`pr_command_patterns: ['gh pr merge', 'gh pr ready']` + `required_critique_stages: [OUTPUT_REVIEW]` on `main` route the merge decision through one codex round; the same two patterns on `hermes-builder` are the data-level backstop for the one role holding fork write credentials (the gate's built-in floor covers PR *creation* only).

## Marker routing (why `[Spec handoff]` goes up, not down)

The always-on chain-routing gate denies any delivery-marker-prefixed send that lacks `in_reply_to`. A fresh delegation to a peer carries `thread_id` and no `in_reply_to`, so it can never be marked. Therefore the architect's gated terminal `[Spec handoff]` is its report **up** to the orchestrator, sent as a reply (`in_reply_to=<the requirement dispatch>`), and the delegation **down** to `hermes-builder` is an **unmarked** fresh message (`to="hermes-builder", thread_id="hermes-<req-id>"`) plus `send_file` of the ADR and acceptance test. Send the gated `[Spec handoff]` first; delegate only after it is accepted.

Spine fragments are not `{{vars.*}}`-substituted (only workflow bodies are), so the fragments spell paths out literally; workflows use `{{vars.release_tree}}` etc.
