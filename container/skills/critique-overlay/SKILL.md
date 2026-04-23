---
name: critique-overlay
type: overlay
description: "Insert a critique gate after planning and after code changes. Spawns the codex-critique agent (fresh context + Codex MCP) for independent review. Blocks progress on must-fix items up to 3 rounds."
applies-to:
  workflows: [investigate, implement, document]
  traits: [plan.research, code.edit, test.gen, doc.write]
insert-after: [investigate, patch, draft]
uses:
  skills: [codex-critique]
---

**Critique** {#critique} — spawn the `codex-critique` agent to review the work so far. The agent has a **fresh context window**, **read-only tools**, and uses the **Codex MCP** for an independent external review.

**What to pass depends on the gate:**

- After `investigate` — pass: the problem statement, what you found, and the path to your report (`/workspace/group/reports/{{target_slug}}.md`). The agent will read the report itself.
- After `patch` — pass: the problem statement, what you changed (file list + one-line per file), and the branch name. The agent will run `git diff` itself.
- After `draft` — pass: the problem statement, what you documented, and the path to the draft. The agent will read it itself.

**How to invoke:** Spawn `codex-critique` agent with three things:

```
Problem: [what issue you're solving]
Changes: [what you changed and why]
Thoughts: [your reasoning, tradeoffs considered, anything you're unsure about]
```

The agent has file access — it will read the code, run diffs, and launch a Codex session for the external review.

**3-round protocol:**

1. Spawn `codex-critique` agent with the context above.
2. If `must-fix` items returned:
   - Fix each item, loop back to the step this overlay is attached to.
   - Re-spawn the critique agent with the updated state.
   - This is round 2.
3. Round 2 still has `must-fix`? Fix and re-spawn (round 3).
4. Round 3 still has `must-fix`? **Stop.** Report unresolved items and ask the user.
5. `should-fix` items may be declined with written justification in the log.
6. Record the final verdict before proceeding.

**Invariant:** Never proceed past a critique gate with unresolved `must-fix` items after 3 rounds. Escalate to the user instead.
