## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### `new_session` — fresh-session-per-fire is the default

Scheduled tasks default to running each fire in a fresh Claude session. You don't need to set anything for the common case:

```json
{ "prompt": "...", "processAfter": "...", "recurrence": "*/5 * * * *" }
```

Each fire starts without resuming prior fires' conversation — the cached system prompt is still reused, so cost stays flat instead of growing with every fire. This prevents the cost-growth-and-compaction-churn behavior that accumulating continuations produce for heartbeat / cron tasks.

### Opt out with `new_session: false`

Only the rare multi-fire workflow that genuinely relies on in-conversation memory across fires should opt out:

```json
{ "prompt": "...", "processAfter": "...", "recurrence": "0 */6 * * *", "new_session": false }
```

Reasons to opt out:

- The task builds up chat-style state that later fires read back from conversation history (rather than from files on disk).
- The agent needs to see past tool-call results from earlier fires to decide what to do next.

If the state can live in files (`memory/`, shared learnings, `/workspace/agent/*.md`), keep the default — it's cheaper and more robust.

### Toggling on an existing task

Use `update_task({ taskId, new_session: false })` to opt out of an already-scheduled recurring task, or `new_session: true` to explicitly persist the default.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
