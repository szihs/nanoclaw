#!/bin/bash
# PostToolUse hook (matcher: Write): detect plan file writes and update state.
# Stdin: JSON with tool_name, tool_input.file_path, tool_response, etc.
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Only track writes to the plans directory
case "$FILE" in
  /workspace/agent/plans/*) ;;
  *) exit 0 ;;
esac

mkdir -p "$(dirname "$STATE")"

if [ -f "$STATE" ]; then
  jq --arg path "$FILE" \
    '.plan_written = true | .plan_path = $path | .plan_stale = false | .edits_since_plan = 0' \
    "$STATE" > "${STATE}.tmp" \
    && mv "${STATE}.tmp" "$STATE"
else
  jq -n --arg path "$FILE" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{task_id: "unknown", plan_written: true, plan_path: $path, plan_stale: false, edits_since_plan: 0, critique_required: false, critique_rounds: 0, critique_round_at_flag: 0, edits_since_critique: 0, started_at: $ts}' \
    > "$STATE"
fi

# Reset denial counters so next denial is verbose again
DENIAL_COUNT_FILE="/workspace/.claude/denial-counts.json"
if [ -f "$DENIAL_COUNT_FILE" ]; then
  jq '.plan_required = 0 | .plan_stale = 0' "$DENIAL_COUNT_FILE" > "${DENIAL_COUNT_FILE}.tmp" \
    && mv "${DENIAL_COUNT_FILE}.tmp" "$DENIAL_COUNT_FILE"
fi

exit 0
