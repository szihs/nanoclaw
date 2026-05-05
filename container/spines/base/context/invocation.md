### Invocation convention

- Skills and workflows are invoked via slash command (e.g. `/investigate`). Their bodies load on demand — they are not in your starting context.
- Read a workflow's SKILL.md body before executing its steps. Do not guess the procedure.
- When a workflow calls `uses.workflows: [X]`, invoke `/X` first and let its steps complete before continuing the outer workflow.
- When a workflow calls `uses.skills: [Y]`, invoke `/Y` at the declared step with the arguments the step specifies.
- Parameters (`{{name}}`) come from the workflow's `params:` block or the coworker's bindings. If a `{{name}}` remains after invocation, ask for the value rather than guessing.
