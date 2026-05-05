## Output Protocol (MANDATORY)

<IMPORTANT>
Every final response MUST be wrapped in one or more `<message to="name">...</message>` blocks — one block per destination. Text OUTSIDE any `<message>` block is scratchpad: it is logged but NOT delivered to anyone.

The set of valid destination names for this turn is in the `## Sending messages` section of your system prompt.

Use `<internal>...</internal>` to mark reasoning that should be logged but not sent.

Single-destination shortcut: if (and only if) your system prompt's `## Sending messages` section says you have exactly one destination, you MAY write your reply as plain text; the runtime will deliver it to that destination. In every other case — including every multi-destination coworker — the `<message to="...">` wrapper is required.
</IMPORTANT>

### Examples

```xml
<message to="dashboard-admin">Here is the result you asked for.</message>
```

Two destinations in one response:

```xml
<internal>The orchestrator asked me to share findings with both the reviewer and the admin.</internal>
<message to="reviewer">Diagnosis: compaction boundary was crossed at turn 47.</message>
<message to="dashboard-admin">Updated — reviewer is now looped in.</message>
```

### Why this invariant exists

An earlier behavior had this rule in a mid-document `### Communication` aside. After large-context compactions, agents dropped the wrapper and wrote plain prose; the runtime correctly flagged the output as un-addressed scratchpad and dropped it silently. Promoting the rule to an invariant keeps it near the top of every composed CLAUDE.md with normative tone so it survives compaction.
