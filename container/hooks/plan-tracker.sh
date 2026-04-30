#!/bin/bash
# PostToolUse hook (matcher: Write): detect plan file writes and update state.
# Stdin: JSON with tool_name, tool_input.file_path, tool_response, etc.
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Tracks two kinds of writes:
#   /workspace/agent/plans/*    → marks plan_written, resets edits_since_plan
#   /workspace/agent/critiques/* → marks the active critique round as recorded
case "$FILE" in
  /workspace/agent/plans/*)
    mkdir -p "$(dirname "$STATE")"
    if [ -f "$STATE" ]; then
      jq --arg path "$FILE" \
        '.plan_written = true | .plan_path = $path | .plan_stale = false | .edits_since_plan = 0' \
        "$STATE" > "${STATE}.tmp" \
        && mv "${STATE}.tmp" "$STATE"
    else
      jq -n --arg path "$FILE" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{task_id: "unknown", plan_written: true, plan_path: $path, plan_stale: false, edits_since_plan: 0, critique_required: false, critique_rounds: 0, critique_round_at_flag: 0, critique_recorded_for_round: 0, edits_since_critique: 0, started_at: $ts}' \
        > "$STATE"
    fi
    ;;
  /workspace/agent/critiques/*)
    # Mark the latest critique round as recorded — clears critique-record-gate.
    [ ! -f "$STATE" ] && exit 0
    ROUNDS=$(jq '.critique_rounds // 0' "$STATE")
    jq --argjson r "$ROUNDS" \
      '.critique_recorded_for_round = $r' \
      "$STATE" > "${STATE}.tmp" \
      && mv "${STATE}.tmp" "$STATE"
    exit 0
    ;;
  *) exit 0 ;;
esac

# Reset denial counters so next denial is verbose again
DENIAL_COUNT_FILE="/workspace/.claude/denial-counts.json"
if [ -f "$DENIAL_COUNT_FILE" ]; then
  jq '.plan_required = 0 | .plan_stale = 0' "$DENIAL_COUNT_FILE" > "${DENIAL_COUNT_FILE}.tmp" \
    && mv "${DENIAL_COUNT_FILE}.tmp" "$DENIAL_COUNT_FILE"
fi

exit 0
