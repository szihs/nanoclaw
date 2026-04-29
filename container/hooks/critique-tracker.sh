#!/bin/bash
# SubagentStart hook: track critique agent spawns in workflow state.
# Stdin: JSON with agent_id, agent_type (SubagentStart schema — no tool_input).
# Outputs additionalContext to remind the agent of the 3-round protocol.
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

# SubagentStart provides agent_type (e.g., "codex-critique") and agent_id.
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')

IS_CRITIQUE=false
case "$AGENT_TYPE" in
  *codex-critique*|*critique*) IS_CRITIQUE=true ;;
esac

[ "$IS_CRITIQUE" = "false" ] && exit 0

mkdir -p "$(dirname "$STATE")"

if [ -f "$STATE" ]; then
  ROUNDS=$(jq '.critique_rounds // 0' "$STATE")
  NEW_ROUNDS=$((ROUNDS + 1))
  jq --argjson r "$NEW_ROUNDS" \
    '.critique_rounds = $r | .critique_required = false | .edits_since_critique = 0' \
    "$STATE" > "${STATE}.tmp" \
    && mv "${STATE}.tmp" "$STATE"
else
  NEW_ROUNDS=1
  jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{task_id: "unknown", plan_written: false, plan_path: null, plan_stale: false, edits_since_plan: 0, critique_required: false, critique_rounds: 1, critique_round_at_flag: 0, edits_since_critique: 0, started_at: $ts}' \
    > "$STATE"
fi

# Reset denial counter so next critique denial is verbose again
DENIAL_COUNT_FILE="/workspace/.claude/denial-counts.json"
if [ -f "$DENIAL_COUNT_FILE" ]; then
  jq '.critique_required = 0' "$DENIAL_COUNT_FILE" > "${DENIAL_COUNT_FILE}.tmp" \
    && mv "${DENIAL_COUNT_FILE}.tmp" "$DENIAL_COUNT_FILE"
fi

# Output context reminder about the 3-round protocol
jq -n --argjson round "$NEW_ROUNDS" '{
  hookSpecificOutput: {
    hookEventName: "SubagentStart",
    additionalContext: ("Critique round " + ($round | tostring) + " of 3. If must-fix items are returned, fix them and re-spawn critique. After 3 rounds with unresolved must-fix items, escalate to the user.")
  }
}'

exit 0
