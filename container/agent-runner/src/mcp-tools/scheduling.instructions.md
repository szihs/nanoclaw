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

### `new_session: true` for stateless recurring tasks

For recurring heartbeat / cron tasks where each fire does NOT need to reference prior fires' conversation history, pass `new_session: true` when scheduling:

```json
{ "prompt": "...", "processAfter": "...", "recurrence": "*/5 * * * *", "new_session": true }
```

Each fire then runs in a fresh Claude session against the cached system prompt — prior fires' conversation isn't resumed. Use when:

- The task is a periodic check (heartbeat, CI babysitter, queue sweep) whose state lives in files on disk (`memory/`, shared learnings) rather than conversation memory.
- You don't want the recurring-task conversation to grow indefinitely (with frequent compactions driving repeated cache-creation cost).

Do NOT use when:

- The task genuinely benefits from remembering what it did in prior fires via in-conversation memory (rare — usually file-based state is cleaner anyway).
- The task is one-shot (non-recurring) — the flag is only meaningful for recurring tasks.

Toggle on an existing recurring task via `update_task({ taskId, new_session: true })`.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
