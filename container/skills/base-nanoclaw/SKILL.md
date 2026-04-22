---
name: base-nanoclaw
description: NanoClaw host tools — send messages, schedule tasks, ask the user questions, append durable learnings. Trigger whenever you need to communicate mid-work, schedule recurring checks, or record something for other coworkers.
provides: []
allowed-tools: mcp__nanoclaw__send_message, mcp__nanoclaw__schedule_task, mcp__nanoclaw__list_tasks, mcp__nanoclaw__pause_task, mcp__nanoclaw__resume_task, mcp__nanoclaw__cancel_task, mcp__nanoclaw__ask_user_question, mcp__nanoclaw__send_card, mcp__nanoclaw__append_learning
---

# NanoClaw Host Tools

Cross-cutting tools every coworker can use for status updates, scheduling, elicitation, and durable learning capture.

## When to use each

| Tool | Use when |
|------|----------|
| `mcp__nanoclaw__send_message` | Mid-work progress update on a long-running task |
| `mcp__nanoclaw__schedule_task` | Recurring sweep, periodic check, deferred action |
| `mcp__nanoclaw__list_tasks` / `pause_task` / `resume_task` / `cancel_task` | Manage your own scheduled tasks |
| `mcp__nanoclaw__ask_user_question` | Bounded user decision (multiple choice) |
| `mcp__nanoclaw__send_card` | Structured status panel clearer than prose |
| `mcp__nanoclaw__append_learning` | Durable discovery that future coworkers should reuse |

## Conventions

- Keep `send_message` updates to meaningful milestones. Do not narrate every tool call.
- Use `<internal>...</internal>` for scratchpad reasoning that should not be shipped to the user.
- For `append_learning`, include a one-line summary, the evidence, and the file/path that proves it.
