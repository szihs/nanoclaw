---
name: discord-comms
description: Communicate with the team via Discord channels. Send status updates, ask questions, and share findings.
allowed-tools: Bash(discord-comms:*)
---

# Discord Communication

## Sending Messages

Use the NanoClaw MCP tool to send messages to Discord channels:

```
mcp__nanoclaw__send_message(text: "Your message here")
```

This sends to the current channel (the one that triggered this coworker).

### Message Formatting

Discord uses markdown:
- `**bold**` for emphasis
- `*italic*` for subtle emphasis
- `` `code` `` for inline code
- ` ```cpp\ncode\n``` ` for syntax-highlighted code blocks
- `> quote` for blockquotes
- `- ` for bullet points

### Status Updates

When working on a long task, send periodic updates:

```
mcp__nanoclaw__send_message(text: "**Status**: Analyzing SPIRV emission pipeline. Traced through 4 passes so far. ETA ~5 min.")
```

### Sharing Findings

For detailed findings:

```
mcp__nanoclaw__send_message(text: "**Investigation: SPIRV Codegen**\n\nKey files:\n- `slang-emit-spirv.cpp` — main emission\n- `slang-emit-spirv-ops.cpp` — SPIRV op mapping\n\n```cpp\n// Pattern found in slang-emit-spirv.cpp:456\nvoid emitSPIRVInst(IRInst* inst) {\n    // ...\n}\n```")
```

## When to Send Messages

- **Acknowledge**: When you start a task, send a brief acknowledgment
- **Progress**: For tasks >5 minutes, send progress updates
- **Findings**: When you discover something important
- **Blockers**: When you need human input or hit an obstacle
- **Completion**: When the task is done, summarize results

## Channel Context

Your messages go to the Discord channel that initiated your task. If you need cross-channel communication, the orchestrator (main group) can route messages to different channels.
