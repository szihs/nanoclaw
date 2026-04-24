### Workspace layout

- `/workspace/agent/` — persistent per-coworker directory. Write durable notes, reports, and state here.
- `/workspace/agent/reports/` — investigation reports. Append to `index.md` when adding a new one.
- `/workspace/agent/fixes/` — implementation logs, one per target.
- `/workspace/agent/reviews/` — review logs.
- `/workspace/global/` — shared across coworkers (learnings, read-only references).
- `/workspace/project/` — project source tree. **Read-only.** Do not write here.

### Resumability

When a session ends mid-task, leave a note under `/workspace/agent/` describing what is done, what is pending, and any blockers. The next session starts by reading it.

### Shared learnings

**IMPORTANT:** After solving a problem, finding a workaround, or discovering non-obvious behavior, share it via `mcp__nanoclaw__append_learning` so other coworkers benefit on their next session. Include a one-line summary, the evidence, and the file/path that proves it.

- **Read from**: `/workspace/global/learnings/INDEX.md` (start here each session)
- **Write via**: `mcp__nanoclaw__append_learning` (see `/base-nanoclaw` for usage details)

When you produce a result other agents might need (reports, findings, issue lists), also save it to `/workspace/agent/memory/` so they can read it directly from your group folder.
