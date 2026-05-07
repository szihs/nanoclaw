#!/bin/bash
# PostToolUse hook (matcher: Edit|Write): count non-allowlisted edits and trigger
# critique-required / plan-stale thresholds.
# Stdin: JSON with tool_name, tool_input.file_path, tool_response, etc.
# Exit 0 always (PostToolUse cannot block).
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# --- Bash tool: only count if it writes files ---
if [ "$TOOL" = "Bash" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  [ -z "$CMD" ] && exit 0
  IS_WRITE=false
  if echo "$CMD" | grep -qP '(^|\s|\|)(>|>>)\s'; then
    IS_WRITE=true
  elif echo "$CMD" | grep -qP '\b(tee|sed\s+-i|patch\s|git\s+apply|git\s+am|dd\s)\b'; then
    IS_WRITE=true
  fi
  [ "$IS_WRITE" = "false" ] && exit 0
else
  # --- Edit/Write tool: file path checks ---
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  [ -z "$FILE" ] && exit 0

  # Plan writes reset counters (handled by plan-tracker.sh, but skip here)
  case "$FILE" in
    /workspace/agent/plans/*) exit 0 ;;
  esac

  # Allowlist: workspace bookkeeping files don't count toward edit thresholds
  case "$FILE" in
    /workspace/agent/reports/*) exit 0 ;;
    /workspace/agent/memory/*) exit 0 ;;
    /workspace/agent/conversations/*) exit 0 ;;
    /workspace/agent/fixes/*) exit 0 ;;
    /workspace/agent/reviews/*) exit 0 ;;
    /workspace/agent/critiques/*) exit 0 ;;
    /workspace/agent/CLAUDE.local.md) exit 0 ;;
    /workspace/.claude/*) exit 0 ;;
  esac

  # Allow .md and .json directly under /workspace/agent/ (bookkeeping, not source)
  DIR=$(dirname "$FILE")
  EXT="${FILE##*.}"
  if [ "$DIR" = "/workspace/agent" ] && { [ "$EXT" = "md" ] || [ "$EXT" = "json" ]; }; then
    exit 0
  fi
fi

# This is a substantive edit — increment counters
[ ! -f "$STATE" ] && exit 0
mkdir -p "$(dirname "$STATE")"

PLAN_LIMIT="${PLAN_EDIT_LIMIT:-15}"
CRITIQUE_LIMIT="${CRITIQUE_EDIT_LIMIT:-3}"

EDITS_PLAN=$(jq '.edits_since_plan // 0' "$STATE")
EDITS_CRIT=$(jq '.edits_since_critique // 0' "$STATE")
NEW_EDITS_PLAN=$((EDITS_PLAN + 1))
NEW_EDITS_CRIT=$((EDITS_CRIT + 1))

UPDATES=".edits_since_plan = $NEW_EDITS_PLAN | .edits_since_critique = $NEW_EDITS_CRIT"

if [ "$NEW_EDITS_PLAN" -ge "$PLAN_LIMIT" ]; then
  UPDATES="$UPDATES | .plan_stale = true"
fi
if [ "$NEW_EDITS_CRIT" -ge "$CRITIQUE_LIMIT" ]; then
  CRIT_REQ=$(jq -r '.critique_required // false' "$STATE")
  if [ "$CRIT_REQ" != "true" ]; then
    ROUNDS=$(jq '.critique_rounds // 0' "$STATE")
    UPDATES="$UPDATES | .critique_required = true | .critique_round_at_flag = $ROUNDS"
  fi
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
UPDATES="$UPDATES | .last_activity_at = \"$NOW\""
jq "$UPDATES" "$STATE" > "${STATE}.tmp" && mv "${STATE}.tmp" "$STATE"

# Surface context to the agent when approaching or hitting thresholds
CRIT_WARN_AT=$(( CRITIQUE_LIMIT - 3 ))
PLAN_WARN_AT=$(( PLAN_LIMIT - 5 ))
MSG=""

if [ "$NEW_EDITS_CRIT" -eq "$CRITIQUE_LIMIT" ]; then
  MSG="⚡ CRITIQUE GATE TRIGGERED: $NEW_EDITS_CRIT edits since last critique. Your next Edit/Write will be blocked until you spawn codex-critique. Send a status update via mcp__nanoclaw__send_message before proceeding."
elif [ "$NEW_EDITS_CRIT" -ge "$CRIT_WARN_AT" ] && [ "$NEW_EDITS_CRIT" -lt "$CRITIQUE_LIMIT" ]; then
  REMAINING=$(( CRITIQUE_LIMIT - NEW_EDITS_CRIT ))
  MSG="⚠️ Critique gate in $REMAINING edits ($NEW_EDITS_CRIT/$CRITIQUE_LIMIT). Plan your critique spawn."
elif [ "$NEW_EDITS_PLAN" -eq "$PLAN_LIMIT" ]; then
  MSG="⚡ PLAN STALE GATE TRIGGERED: $NEW_EDITS_PLAN edits since last plan. Your next Edit/Write will be blocked until you write a fresh plan. Send a status update via mcp__nanoclaw__send_message."
elif [ "$NEW_EDITS_PLAN" -ge "$PLAN_WARN_AT" ] && [ "$NEW_EDITS_PLAN" -lt "$PLAN_LIMIT" ]; then
  REMAINING=$(( PLAN_LIMIT - NEW_EDITS_PLAN ))
  MSG="⚠️ Plan refresh gate in $REMAINING edits ($NEW_EDITS_PLAN/$PLAN_LIMIT)."
fi

if [ -n "$MSG" ]; then
  jq -n --arg msg "$MSG" --argjson ep "$NEW_EDITS_PLAN" --argjson ec "$NEW_EDITS_CRIT" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $msg
    }
  }'
fi

exit 0
