#!/bin/bash
# PostToolUse hook (matcher: mcp__codex__codex|mcp__codex__codex-reply):
# every successful codex MCP call counts as a critique round, regardless of
# whether it was invoked directly from the parent (Option A) or via a legacy
# Agent subagent. SubagentStart-based tracking was unreliable (agent_type field
# not always populated) and obsolete with Option A.
# Stdin: JSON with tool_name, tool_input, tool_response.
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

IS_CRITIQUE=false
case "$TOOL" in
  mcp__codex__codex|mcp__codex__codex-reply) IS_CRITIQUE=true ;;
esac

[ "$IS_CRITIQUE" = "false" ] && exit 0

# Only count successful codex calls (errors don't reset the gate).
RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty')
if echo "$RESPONSE" | grep -qE '"error":|"is_error":\s*true|"timed out"'; then
  exit 0
fi

mkdir -p "$(dirname "$STATE")"

if [ -f "$STATE" ]; then
  ROUNDS=$(jq '.critique_rounds // 0' "$STATE")
  NEW_ROUNDS=$((ROUNDS + 1))
  # Bump rounds AND clear edits counter; do NOT bump critique_recorded_for_round —
  # critique-record-gate.sh enforces that the agent writes the verdict before
  # further edits. The agent's Write tool_use into /workspace/agent/critiques/
  # is what bumps critique_recorded_for_round (via plan-tracker.sh).
  jq --argjson r "$NEW_ROUNDS" \
    '.critique_rounds = $r | .critique_required = false | .edits_since_critique = 0' \
    "$STATE" > "${STATE}.tmp" \
    && mv "${STATE}.tmp" "$STATE"
else
  NEW_ROUNDS=1
  jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{task_id: "unknown", plan_written: false, plan_path: null, plan_stale: false, edits_since_plan: 0, critique_required: false, critique_rounds: 1, critique_round_at_flag: 0, critique_recorded_for_round: 0, edits_since_critique: 0, started_at: $ts}' \
    > "$STATE"
fi

# Reset denial counter so next critique denial is verbose again
DENIAL_COUNT_FILE="/workspace/.claude/denial-counts.json"
if [ -f "$DENIAL_COUNT_FILE" ]; then
  jq '.critique_required = 0' "$DENIAL_COUNT_FILE" > "${DENIAL_COUNT_FILE}.tmp" \
    && mv "${DENIAL_COUNT_FILE}.tmp" "$DENIAL_COUNT_FILE"
fi

# Output context reminder about the 3-round protocol + the disk-write requirement.
jq -n --argjson round "$NEW_ROUNDS" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("Critique round " + ($round | tostring) + " of 3 recorded. REQUIRED next steps before continuing: (1) write the full verdict to /workspace/agent/critiques/<slug>-round-" + ($round | tostring) + ".md, (2) broadcast a mcp__nanoclaw__send_message with file:line bullets for each must-fix item. After 3 rounds with unresolved must-fix items, escalate to the user.")
  }
}'

exit 0
