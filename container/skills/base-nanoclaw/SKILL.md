---
name: base-nanoclaw
license: MIT
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

## Nuance beyond the MCP schemas

- **send_message pacing.** Short turn (1-2 tool calls): don't narrate. Longer turn: send a one-line acknowledgment early. Long-running: periodic updates at meaningful transitions (not every tool call), especially before slow operations.
- **send_file** (`mcp__nanoclaw__send_file({ path, text?, filename?, to? })`) — deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`. Use for artifacts (charts, PDFs, reports) instead of dumping contents into chat.
- **add_reaction** (`{ messageId, emoji }`) — `messageId` is the numeric `#N` (integer, not string). `emoji` is the shortcode name (`thumbs_up`, `heart`, `eyes`).
- **ask_user_question vs send_card.** `ask_user_question` **blocks** your turn until the user picks an option (default 300s timeout) — use only when you genuinely cannot proceed without the decision. `send_card` **returns immediately** — use for structured status panels or read-only info. For free-text input, send a normal message and wait for their reply.
- **schedule_task script gate.** For frequent recurring tasks (more than a few a day), attach a bash `script` that prints `{ wakeAgent: true|false, data: {...} }`. The agent only wakes when the script returns `true`, saving API credits.
- **schedule_task `new_session`.** Default is `true` — each fire runs in a fresh session (cached system prompt reused, conversation history discarded). Opt out (`false`) ONLY when a multi-fire workflow genuinely needs in-conversation memory across fires.
- **append_learning.** Include a one-line summary, the evidence, and the file/path that proves it.
