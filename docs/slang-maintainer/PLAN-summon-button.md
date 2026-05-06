# Plan: "Get Bot Help" Summon Button in #slang-support

## Status: Draft — stored for later discussion

## Concept

Every new forum post in #slang-support automatically gets a small bot message with a "Get Bot Help" button. If the OP clicks it, the bot researches the question and replies directly in that thread.

## Flow

1. User creates a new forum post in #slang-support
2. Feedback collector detects via `on_thread_create` event
3. Bot auto-posts in the thread: *"Need help? Click below for a bot-assisted answer."* with a **"Get Bot Help"** button
4. If OP clicks → bot researches (DeepWiki + GitHub source) and replies **in the same thread**
5. Reply includes feedback buttons (Resolved / Helpful / Not Helpful)
6. If nobody clicks → nothing happens

## Requirements

### Feedback Collector Changes
- Add `on_thread_create` listener for #slang-support forum (`1313936640661524601`)
- New `SummonView` class with "Get Bot Help" button (OP-only, same pattern as FeedbackView)
- On button click: save summon request to `memory/feedback/summon_requests.jsonl`

### Permission Changes
- Add `1313936640661524601` (#slang-support) to `DISCORD_ALLOWED_SEND_FORUMS` in `.env`
- Currently only `1494023079666647200` (#slang-support-bot) is allowed

### Agent Trigger
- **Option A (simple)**: Save request to file, agent picks up on next heartbeat (up to 10 min delay)
- **Option B (responsive)**: Button click writes an IPC message that wakes the agent immediately

### Coworker CLAUDE.md
- Add workflow for handling summon requests from #slang-support
- Same guardrails as #slang-support-bot (Slang-only topics, refuse off-topic)

## Open Questions

- Response time: next heartbeat vs immediate? (trade-off: simplicity vs responsiveness)
- Should the summon message be ephemeral (only visible to OP) or visible to everyone?
- Should there be a rate limit on summons per user/channel?
- Should #slang-support-bot become purely internal testing, or keep both active?

## Security Considerations

- Bot gains write access to #slang-support — a public channel. Guardrails critical.
- Only OP can click the summon button (same _check_op pattern)
- Scope guardrails already in CLAUDE.md restrict answers to Slang topics only
