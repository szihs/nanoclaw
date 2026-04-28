#!/bin/bash
# UserPromptSubmit hook: reset workflow state when a new task arrives.
# Stdin: JSON with hook_event_name, prompt text, etc.
# A new task resets plan_written/critique_rounds so old plans don't satisfy the gate.
#
# Guard: do NOT reset if the agent is mid-workflow (plan already written or
# critique in progress). Follow-up messages within a turn should not wipe state.
# Only reset when no state file exists (first task) or when the previous task
# has been idle for >10 minutes (stale task, new work arriving).
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
[ -z "$PROMPT" ] && exit 0

# Skip /clear and system messages
echo "$PROMPT" | grep -qi '^/clear' && exit 0
echo "$PROMPT" | grep -qi '^<context' && {
  echo "$PROMPT" | grep -qi '<message' || exit 0
}

# Guard: if state file exists and work is in progress, don't reset.
# "In progress" = plan_written is true OR critique_rounds > 0.
if [ -f "$STATE" ]; then
  PLAN=$(jq -r '.plan_written // false' "$STATE")
  ROUNDS=$(jq -r '.critique_rounds // 0' "$STATE")
  if [ "$PLAN" = "true" ] || [ "$ROUNDS" -gt 0 ] 2>/dev/null; then
    exit 0
  fi
  # Also skip reset if the task started less than 10 minutes ago
  STARTED=$(jq -r '.started_at // empty' "$STATE")
  if [ -n "$STARTED" ]; then
    START_EPOCH=$(date -d "$STARTED" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    AGE=$(( NOW_EPOCH - START_EPOCH ))
    if [ "$AGE" -lt 600 ]; then
      exit 0
    fi
  fi
fi

mkdir -p "$(dirname "$STATE")"
TASK_ID="task-$(date +%s)-$RANDOM"
jq -n \
  --arg id "$TASK_ID" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{task_id: $id, plan_written: false, plan_path: null, critique_rounds: 0, started_at: $ts}' \
  > "$STATE"

exit 0
