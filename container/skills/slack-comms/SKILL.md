---
name: slack-comms
description: Communicate with the team via Slack channels. Send status updates, ask questions, and share findings.
allowed-tools: Bash(slack-comms:*)
---

# Slack Communication

## Sending Messages

Use the NanoClaw MCP tool to send messages to Slack channels:

```
mcp__nanoclaw__send_message(text: "Your message here")
```

This sends to the current channel (the one that triggered this coworker).

### Message Formatting

Slack supports mrkdwn formatting:
- `*bold*` for emphasis
- `_italic_` for subtle emphasis
- `` `code` `` for inline code
- ` ```code block``` ` for multi-line code
- `> quote` for blockquotes
- `• ` for bullet points

### Status Updates

When working on a long task, send periodic updates:

```
mcp__nanoclaw__send_message(text: "Working on IR analysis for generics lowering. Found 3 key files so far. Will report back in ~5 min.")
```

### Sharing Findings

For detailed findings, use code blocks:

```
mcp__nanoclaw__send_message(text: "*Investigation: Generics in IR*\n\nKey files:\n• `slang-ir-generics.cpp` — specialization logic\n• `slang-lower-generics.cpp` — lowering pass\n\nThe generics system uses witness tables for interface conformance.\n\n```\n// Key pattern found in slang-ir-generics.cpp:123\nIRInst* specialize(IRGeneric* generic, IRType* args[])\n```")
```

## When to Send Messages

- **Acknowledge**: When you start a task, send a brief acknowledgment
- **Progress**: For tasks >5 minutes, send progress updates
- **Findings**: When you discover something important
- **Blockers**: When you need human input or hit an obstacle
- **Completion**: When the task is done, summarize results

## Channel Context

Your messages go to the channel that initiated your task. If you need to communicate across channels, use the `send_message` tool with appropriate context — the orchestrator (main group) can route messages to different channels.
