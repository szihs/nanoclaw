#!/bin/bash
# PreToolUse hook (matcher: Edit|Write|MultiEdit|NotebookEdit): block source
# code edits that come AFTER a critique round but BEFORE the agent has written
# the verdict to /workspace/agent/critiques/<slug>-round-N.md.
#
# Enforces the critique-overlay protocol's "REQUIRED do both" clause:
#   1. Write the full verdict to disk
#   2. Broadcast a send_message with file:line bullets
# When critique-tracker.sh increments critique_rounds, it sets a flag
# `critique_recorded_for_round`. This gate blocks edits if that flag is
# behind critique_rounds (meaning the agent skipped the disk write).
#
# Stdin: JSON with tool_name, tool_input. Exit 0 = allow, exit 2 = deny.
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

[ ! -f "$STATE" ] && exit 0

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only Edit/Write tools trigger this; Bash/Read/etc are passthrough.
case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

# If the agent is writing INTO the critiques/ directory, that IS the disk write —
# allow unconditionally so this hook doesn't block the very thing it requires.
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
case "$FILE" in
  */workspace/agent/critiques/*) exit 0 ;;
esac

ROUNDS=$(jq '.critique_rounds // 0' "$STATE")
RECORDED=$(jq '.critique_recorded_for_round // 0' "$STATE")

if [ "$ROUNDS" -gt "$RECORDED" ]; then
  cat >&2 << EOF
CRITIQUE_VERDICT_NOT_RECORDED: round $ROUNDS critique completed but the verdict
has NOT been written to disk. Per critique-overlay protocol you MUST do both:

  1. Write the full verdict to /workspace/agent/critiques/<slug>-round-$ROUNDS.md
     (mkdir -p /workspace/agent/critiques first if needed). Include verdict label,
     every must-fix item with file:line + rationale, every should-fix, every note.

  2. Broadcast a mcp__nanoclaw__send_message summarizing the must-fix items as
     bullets (\`<file:line> — <issue>\`), not prose.

After both are done, retry this Edit. Source-file edits are blocked until the
verdict is recorded.
EOF
  exit 2
fi

exit 0
