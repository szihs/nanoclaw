## Companion and collaborator agents (`create_agent`)

`mcp__nanoclaw__create_agent({ name, coworkerType, instructions })` spins up a new long-lived agent and wires it as a destination — bidirectional, so you can send it tasks and it can message you back.

**Always pass `coworkerType`.** It resolves to a registry leaf (`default`, `slang-reader`, `slang-writer`, …) that determines the agent's skills, MCP tool allowlist, and workflows. Omitting it falls back to `default` (base spine only) — rarely what you want. Ask the user which type to use when it isn't obvious from the task; the registry is assembled from `container/{spines,skills}/*/coworker-types.yaml` files.

### How it works

- Creates a new agent with its own container, workspace, and session. Your `instructions` string is written to the agent's `.instructions.md`, which the composer appends after its typed spine on every container wake — its starting role and domain-specific rules.
- The agent's `name` becomes a destination on both sides: you address it via `send_message({ to: "<name>", ... })`, and its replies arrive as inbound messages with `from="<name>"`.
- Each agent has its own persistent workspace under `groups/<folder>/` — memory, conversation history, and notes all survive across sessions. This is a full standalone agent, not a stateless sub-query.
- **Fire-and-forget:** the call returns immediately without waiting for the agent to confirm it's ready. Messages you send will queue until it's up.

### When to use

- **Companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling, an assistant that knows your preferences and history.
- **Collaborators** — a parallel specialist that works independently and reports back: a `Builder` handling code edits while you stay in conversation, a `Reviewer` running checks in the background.

The right frame is: does this agent need its own memory and context that builds over time, or does it need to work independently without blocking your turn? Either is a good reason to spawn one.

### When NOT to use

- **One-off lookups or short tasks** — use the SDK `Agent` tool instead. It's stateless, spins up and completes in one shot, and leaves no persistent footprint.
- **Work that finishes before the user's next message** — agents persist indefinitely. Don't create one for something you could do inline.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones for long work?), and any domain-specific rules. Don't restate NanoClaw base behavior or the coworker type's skills — the shared base and typed spine are already loaded on the agent's end.