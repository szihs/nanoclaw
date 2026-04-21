### Workspace layout

- `/workspace/group/` — persistent per-coworker directory. Write durable notes, reports, and state here.
- `/workspace/group/reports/` — triage reports. Append to `index.md` when adding a new one.
- `/workspace/group/fixes/` — fix logs, one per target.
- `/workspace/group/reviews/` — review logs.
- `/workspace/group/sweeps/` — periodic sweep reports. Append to `index.md`.
- `/workspace/global/` — shared across coworkers (learnings, read-only references).
- `/workspace/project/` — project source tree. **Read-only.** Do not write here.

### Resumability

When a session ends mid-task, leave a note under `/workspace/group/` describing what is done, what is pending, and any blockers. The next session starts by reading it.
