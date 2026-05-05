### Invocation convention

- **Workflows are embedded procedures**, not slash commands. The Workflows section below contains the full body of every workflow available to you. When a task matches a workflow's purpose, follow its numbered steps inline. Do not try to invoke `/workflow-name` — that slash command does not exist.
- **Capability skills are slash commands.** The Skills Available section lists skills you invoke as `/skill-name`. Their bodies load on demand via the Skill tool.
- When a workflow step says "run the `alpha` workflow first", find the `### alpha` section in the Workflows section below and perform those steps inline before returning to this point. When a step says "invoke `/beta`" and `beta` is a skill, use the slash command.
- **Gate overlays (`⟐ NAME GATE` blocks) are mandatory sub-protocols** baked into the workflow at their anchor step. Complete the gate's instructions before advancing past its step. The composer may emit the full gate body once per spine and point later gate sites back to it — the protocol applies at every anchor.
- **Parameters (`{{name}}`)** in a workflow body are placeholders — values come from the user's request or context (e.g. `{{target}}` is the issue/PR/question the user named). If a placeholder remains ambiguous, ask rather than guess.
