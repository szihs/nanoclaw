#!/bin/bash
# UserPromptSubmit hook: reset workflow state when a new task arrives.
# Stdin: JSON with hook_event_name, prompt text, etc.
# A new task resets plan_written/critique_rounds so old plans don't satisfy the gate.
#
# Detection strategy (ordered by reliability):
# 1. Router envelope (<context> + <message>) — always a new routed task → full reset
# 2. Workflow invocation (/implement, /investigate, /document, /review) → full reset
# 3. Idle timer (>10min since last activity) → full reset
# 4. Otherwise — follow-up message within same task → no reset
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
INPUT=$(cat)

PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
[ -z "$PROMPT" ] && exit 0

# Skip /clear — it's a context wipe, not a new task
echo "$PROMPT" | grep -qi '^/clear' && exit 0

do_reset() {
  mkdir -p "$(dirname "$STATE")"
  TASK_ID="task-$(date +%s)-$RANDOM"
  jq -n \
    --arg id "$TASK_ID" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{task_id: $id, plan_written: false, plan_path: null, plan_stale: false, edits_since_plan: 0, critique_required: false, critique_rounds: 0, critique_round_at_flag: 0, edits_since_critique: 0, started_at: $ts, last_activity_at: $ts}' \
    > "$STATE"
  exit 0
}

# Signal 1: NanoClaw router envelope — always a new task
if echo "$PROMPT" | grep -q '<context' && echo "$PROMPT" | grep -q '<message'; then
  do_reset
fi

# Signal 2: Workflow invocation at the start of the prompt
if echo "$PROMPT" | grep -qP '^\s*/(implement|investigate|document|review)\b'; then
  do_reset
fi

# If no state file exists, create fresh state for the first task
[ ! -f "$STATE" ] && do_reset

# Signal 3: Idle timer — if no activity for >10min, reset.
# Prefer last_activity_at (updated by edit-counter.sh) over started_at.
LAST_ACTIVE=$(jq -r '.last_activity_at // .started_at // empty' "$STATE")
if [ -n "$LAST_ACTIVE" ]; then
  ACTIVE_EPOCH=$(date -d "$LAST_ACTIVE" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  IDLE=$(( NOW_EPOCH - ACTIVE_EPOCH ))
  if [ "$IDLE" -ge 600 ]; then
    do_reset
  fi
fi

# Follow-up message within the same task — no reset
exit 0
