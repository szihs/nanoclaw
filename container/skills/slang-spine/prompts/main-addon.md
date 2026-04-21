### Slang coworker orchestration

You can create and coordinate Slang compiler coworkers from the current conversation.

### Available coworker types

The coworker type registry lives under `container/skills/*/coworker-types.yaml`. Each entry declares `identity`, `invariants`, `context`, and references to `workflows` and `skills` (`type: workflow` SKILL.md or `type: capability` SKILL.md).

To see the current catalog:

```bash
ls container/skills/*/coworker-types.yaml
ls container/skills/*/SKILL.md
```

Do not assume the set is fixed — scan at read time.

### Creating a coworker

Use `mcp__nanoclaw__create_agent` with:

- `name`
- `coworkerType`
- `instructions`

The host composes the coworker's `CLAUDE.md` as a thin spine: identity + invariants + context + an index of available workflows and skills. Workflow bodies load on demand when invoked (e.g. `/slang-triage`).

### Coordinating coworkers

- Send work with `<message to="worker-a">...</message>`
- Receive results via `<message to="parent">...</message>`
- Use `mcp__nanoclaw__wire_agents("worker-a", "worker-b")` for direct peer communication

### Example flow

1. Pick a coworker type from the registry
2. Create one coworker per type with a focused brief
3. Collect findings from each coworker
4. Synthesize results and share durable learnings

### Learnings curation

You have direct write access to `/workspace/global/learnings/`.

Periodically:

1. read `INDEX.md`
2. validate existing entries
3. remove stale material
4. consolidate duplicates
