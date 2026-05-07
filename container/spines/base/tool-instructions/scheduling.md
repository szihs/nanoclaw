## Task scheduling (`schedule_task`)

Recurring tasks survive across sessions and restarts. Inspect with `list_tasks`; manage with `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel+reschedule.

Frequent recurring tasks consume API credits and can hit rate limits. When possible, guard the task with a `script` so the agent only wakes when there's something to do:

1. Provide a bash `script` + the `prompt`.
2. On each fire, the script runs first.
3. Script prints `{ "wakeAgent": true|false, "data": {...} }`.
4. `false` → skip this fire. `true` → agent wakes with `data` + `prompt`.

Test your script directly before scheduling. If a task requires judgment every fire (briefings, reports), skip the script.

### `new_session` — default is true

Each fire runs in a fresh session by default — the cached system prompt is reused, but prior fires' conversation history is discarded. This is what you want for heartbeat/cron tasks: cost stays flat, context doesn't drift.

Opt out with `new_session: false` only when a multi-fire workflow genuinely relies on in-conversation memory across fires. If the state can live in files (`CLAUDE.local.md`, `/workspace/agent/`, shared learnings), keep the default. Toggle on existing tasks with `update_task({ taskId, new_session: false })`.
