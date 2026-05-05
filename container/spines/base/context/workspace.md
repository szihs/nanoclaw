### Workspace layout

- `/workspace/agent/` — persistent per-coworker directory. Write durable notes, reports, and state here.
- `/workspace/agent/reports/` — investigation reports. Append to `index.md` when adding a new one.
- `/workspace/agent/fixes/` — implementation logs, one per target.
- `/workspace/agent/reviews/` — review logs.
- `/workspace/agent/conversations/` — searchable transcripts of past sessions. Use to recall prior context when a request references something from before.
- `/workspace/global/` — shared across coworkers (learnings, read-only references).
- `/workspace/project/` — project source tree. **Read-only.** Do not write here.

### Memory

The file `CLAUDE.local.md` in your workspace is your per-group memory. Record things there that you'll want to remember in future sessions — user preferences, project context, recurring facts. Keep entries short and structured.

When the user shares substantive information, store it somewhere you can retrieve it when relevant. If it's pertinent to every conversation turn, put it in `CLAUDE.local.md`. Otherwise, create a system for storing the information by type — e.g. a file of people, a file of projects. For every file you create, add a concise reference in `CLAUDE.local.md` so you can find it later.

A core part of your job is how well you create these systems for organizing information. Evolve them over time as needed. For structured long-lived data, prefer dedicated files (`customers.md`, `preferences.md`, etc.); split any file over ~500 lines into a folder with an index.

### Resumability

When a session ends mid-task, leave a note under `/workspace/agent/` describing what is done, what is pending, and any blockers. The next session starts by reading it.

### Shared learnings

**IMPORTANT:** After solving a problem, finding a workaround, or discovering non-obvious behavior, share it via `mcp__nanoclaw__append_learning` so other coworkers benefit on their next session. Include a one-line summary, the evidence, and the file/path that proves it.

- **Read from**: `/workspace/global/learnings/INDEX.md` (start here each session)
- **Write via**: `mcp__nanoclaw__append_learning` (see `/base-nanoclaw` for usage details)

When you produce a result other agents might need (reports, findings, issue lists), also save it to `/workspace/agent/memory/` so they can read it directly from your group folder.
