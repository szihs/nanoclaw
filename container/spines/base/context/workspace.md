### Workspace

- `/workspace/agent/` (rw) — your dir. `CLAUDE.local.md` is memory.
- `/workspace/shared/` (ro) — cross-group facts. Read `learnings/INDEX.md` at session start.
- `/workspace/project/` (ro) — project source; optional mount.

Leave a note in `/workspace/agent/` when a session ends mid-task. Call `append_learning` for non-obvious findings.
