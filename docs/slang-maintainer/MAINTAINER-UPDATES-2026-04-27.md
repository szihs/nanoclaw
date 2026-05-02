# Slang Maintainer — Updates 2026-04-27

Changes made after `MAINTAINER-UPDATES-2026-04-22.md`.

## Summon Button Model

### Concept
Replaced auto-reply behavior with consent-based "summon" model. The bot only answers in forum threads when explicitly requested via a button click.

### Flow (zero tokens until step 5)
1. **New thread created** → Python sidecar posts "Need help?" message with "Get Bot Help" button (no tokens)
2. **OP clicks button** → Sidecar saves summon request to `summon_requests.jsonl`, button changes to "Bot summoned!" (no tokens)
3. **Human replies captured** → Sidecar logs all replies to `thread_replies.jsonl` (no tokens)
4. **Heartbeat fires** → Bash pre-check script detects new Discord activity (no tokens)
5. **Agent wakes** → Reads summon request, researches via DeepWiki + GitHub, replies in thread with feedback buttons (**tokens consumed here only**)

### Components

**Feedback collector** (`feedback_collector.py`) — Python sidecar, handles everything except the LLM reply:
- `on_thread_create` listener: auto-posts summon button on new forum threads
- `SummonView`: "Get Bot Help" button (OP-only, persistent `custom_id`)
- `FeedbackView`: Resolved/Helpful/Not Helpful toggle buttons (unchanged)
- `on_message` listener: captures human replies (unchanged)

**Coworker workflow** (CLAUDE.md Step 3):
- Changed from "reply to all human posts" to "only reply to threads with summon requests"
- Reads `summon_requests.jsonl`, checks against `summon_handled.jsonl`
- Only processes unhandled summon requests

**Heartbeat prompt**:
- Section 3 changed from "Reply to human posts" to "Handle summon requests"
- Only replies to threads listed in `summon_requests.jsonl`

### Data Files
| File | Contents |
|------|----------|
| `memory/feedback/summon_requests.jsonl` | `{type, thread_id, thread_name, parent_id, message_id, timestamp}` |
| `memory/feedback/summon_handled.jsonl` | Thread IDs the agent has already replied to |
| `memory/feedback/feedback.jsonl` | Button clicks (unchanged) |
| `memory/feedback/thread_replies.jsonl` | Human messages (unchanged) |

### Security
- Only thread OP can click the summon button (same `_check_op` pattern)
- Bot never replies unsolicited — requires explicit consent
- Scope guardrails in CLAUDE.md restrict answers to Slang topics only

## Privacy: Username Removal

- Removed `user` field from feedback collector — both button clicks and thread replies
- Cleaned existing data files to strip usernames
- `message_id` preserved for Discord lookup if ever needed
- Log output also anonymized

## Files Changed
| File | Change |
|------|--------|
| `container/mcp-servers/slang-mcp/src/discord/feedback_collector.py` | Added SummonView, on_thread_create listener, removed usernames |
| `groups/slang_maintainer/CLAUDE.md` | Changed to summon-based workflow, added scope guardrails |
| Heartbeat prompt (in DB) | Section 3 updated for summon requests |

## Scope Guardrails Added

Added to coworker CLAUDE.md to restrict bot responses:
- Only answers Slang ecosystem topics (compiler, SlangPy, RHI, build, GPU programming)
- Refuses off-topic questions, code execution outside Slang, system prompt disclosure
- Ignores prompt injection attempts in Discord messages
- Channel restriction: can only post to #slang-support-bot threads
