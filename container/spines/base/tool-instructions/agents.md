## Spawning coworkers (`create_agent`) and ephemeral subagents (`Agent`)

`create_agent` = long-lived coworker: own container/workspace/session surviving turns, `groups/<name>/` accumulates memory, persists until you clean it up. `Agent` = stateless SDK subagent: one result, no trace, free on return. **Default to `Agent` for one-offs**; reserve `create_agent` for multi-turn roles (Researcher, Builder, parallel Reviewer).

### `create_agent({ name, coworkerType, instructions, overlays? })`

- **Always pass `coworkerType`** — sets skills, MCP allowlist, workflows (from `container/{spines,skills}/*/coworker-types.yaml`). Omitting falls back to `default` (base spine only); ask the user when not obvious.
- `name` is a destination both ways: `send_message({ to: "<name>" })`; replies arrive `from="<name>"`.
- `instructions` → `groups/<name>/.instructions.md`, appended after the typed spine each wake. Cover role, who it takes tasks from (you, by name), how it reports back. Don't restate base/typed behavior.
- **Fire-and-forget:** returns immediately; the message is delivered when the recipient's container next wakes. A handoff is **not** a fire-and-*forget-about-it*: if a recipient turn errors on a transient auth/provider outage, the host redrives that handoff with bounded backoff and dead-letters it to escalation if it never succeeds — it does not silently vanish, but nor does it magically "self-heal." **Never tell yourself a stalled handoff is "queued / will self-heal on recovery" as a reason to stop driving it** — if you own a chain and the recipient went dark, that is yours to chase (a nudge or re-send), not a background process's.

### Fan-out: N independent items → N messages, N fresh threads

Emit **N separate `<message to="<name>">` blocks** in your final response, one per item.

**[MUST]** A fresh delegation needing its own sub-session must carry an explicit `thread_id="<task-key>"` on the `<message>` tag (e.g. `<message to="<peer>" thread_id="<task-key>">…</message>`); without it the runtime reuses the most recent inbound thread from that peer, piling every dispatch into one session. Make `thread_id` unique-per-task and _stable_ across retries — derive from task identity (issue/PR number, file path, ticket id), never random or last turn's.

Bundle items into one message **only when handled together** (same PR, ordered dependency) and say so (_"bundle into one PR"_, _"do A before B"_) — a prose blob defaults to sequential single-threaded handling.

Replying on an existing thread (peer conversation, reporting to parent): no new `thread_id` — `in_reply_to="<msg-id>"` carries context. See [chain-reporting](#chain-communication--the-rules).

### Build / compile / install — delegate to `Agent`, never run inline

cmake, make, cargo, pip/npm install, any compilation: use `Agent` (builds pollute context; it runs synchronously, returns a clean summary). Find exact commands in your project's build skill (`Skill`/`ToolSearch`) first.

```
Agent(prompt="Run the build: <build commands from project skill>. Log to /workspace/agent/build/build.log. Report: success/fail, errors, log path.")
```

**Never `run_in_background=True` for builds** — an `install_packages` approval rebuilds the container and kills background processes, losing the build with no recovery.

**Pre-build:** request all missing manifest packages in one `install_packages` call, wait for the rebuild, then delegate the build.
