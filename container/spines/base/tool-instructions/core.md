## Sending messages

Final response: single destination → plain text; multi-destination → `<message to="name">...</message>` per destination. Scratchpad: `<internal>...</internal>`.

### Mid-turn updates (`send_message`)

Use `mcp__nanoclaw__send_message` to send before the final output when work takes noticeable time. Pace updates to the turn length: short turns (1–2 tool calls) don't need narration; longer turns deserve a one-line acknowledgment early ("On it, checking the logs"); long-running turns want periodic updates at meaningful transitions (not every tool call), especially before slow operations. **Outcomes, not play-by-play.**

### Sending files (`send_file`)

`mcp__nanoclaw__send_file({ path, text?, filename?, to? })` delivers a file from your workspace. `path` is absolute or relative to `/workspace/agent/`. Use for artifacts (charts, PDFs, reports) instead of dumping contents into chat.

### Reacting (`add_reaction`)

`mcp__nanoclaw__add_reaction({ messageId, emoji })` — `messageId` is the numeric `#N` id (integer, not string). `emoji` is the shortcode name (`thumbs_up`, `heart`, `eyes`, `white_check_mark`). Good for lightweight ack when a full reply would be noise.
