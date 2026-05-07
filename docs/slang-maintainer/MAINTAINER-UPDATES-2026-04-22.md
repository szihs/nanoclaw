# Slang Maintainer — Updates 2026-04-22

Changes made after `MAINTAINER-UPDATES-2026-04-20-21.md`.

## Feedback Button Improvements

### Toggle Behavior
- Buttons are now toggleable — click to select, click again to deselect
- Multiple buttons can be active simultaneously (e.g., "Resolved" + "Helpful")
- OP can change feedback any number of times
- Each toggle logged to `feedback.jsonl` with `"action": "added"` or `"action": "removed"`

### Visual States
| State | Resolved | Helpful | Not Helpful |
|-------|----------|---------|-------------|
| Unselected | Grey | Grey | Grey |
| Selected | Green | Blue | Red |

### In-Memory State
- Active selections tracked per message in `_active_selections` dict
- Resets on service restart (buttons appear grey), but full history preserved in `feedback.jsonl`

### Files Changed
- `container/mcp-servers/slang-mcp/src/discord/feedback_collector.py` — replaced disable-after-click with toggle logic

## Commits

| Commit | Description |
|--------|-------------|
| (pending) | feat: toggle feedback buttons with multi-select support |
