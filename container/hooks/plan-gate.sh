#!/bin/bash
# PreToolUse hook (matcher: Edit|Write|Bash): block source code edits until a
# plan exists, require periodic critique, and detect file writes via Bash.
# Stdin: JSON with tool_name, tool_input.file_path or tool_input.command, etc.
# Exit 0 = allow, exit 2 = deny (stderr shown to agent).
set -euo pipefail

STATE="/workspace/.claude/workflow-state.json"
DENIAL_COUNT_FILE="/workspace/.claude/denial-counts.json"
INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# --- Bash tool: heuristic write-pattern detection ---
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

  # Allowlist: workspace files that don't need a plan
  case "$FILE" in
    /workspace/agent/plans/*) exit 0 ;;
    /workspace/agent/reports/*) exit 0 ;;
    /workspace/agent/memory/*) exit 0 ;;
    /workspace/agent/conversations/*) exit 0 ;;
    /workspace/agent/fixes/*) exit 0 ;;
    /workspace/agent/reviews/*) exit 0 ;;
    /workspace/agent/critiques/*) exit 0 ;;
    /workspace/agent/CLAUDE.local.md) exit 0 ;;
    /workspace/.claude/*) exit 0 ;;
  esac

  DIR=$(dirname "$FILE")
  EXT="${FILE##*.}"
  if [ "$DIR" = "/workspace/agent" ] && { [ "$EXT" = "md" ] || [ "$EXT" = "json" ]; }; then
    exit 0
  fi
fi

# --- Helper: track denial counts to shorten repeated messages ---
increment_denial() {
  local key="$1"
  mkdir -p "$(dirname "$DENIAL_COUNT_FILE")"
  if [ -f "$DENIAL_COUNT_FILE" ]; then
    COUNT=$(jq --arg k "$key" '.[$k] // 0' "$DENIAL_COUNT_FILE")
  else
    COUNT=0
    echo '{}' > "$DENIAL_COUNT_FILE"
  fi
  NEW_COUNT=$((COUNT + 1))
  jq --arg k "$key" --argjson v "$NEW_COUNT" '.[$k] = $v' "$DENIAL_COUNT_FILE" > "${DENIAL_COUNT_FILE}.tmp" \
    && mv "${DENIAL_COUNT_FILE}.tmp" "$DENIAL_COUNT_FILE"
  echo "$NEW_COUNT"
}

# --- Shared enforcement checks ---

HAS_PLAN="${OVERLAY_HAS_PLAN:-1}"

if [ "$HAS_PLAN" = "1" ]; then
  # Plan gate: require a plan before any source edits
  if [ ! -f "$STATE" ] || [ "$(jq -r '.plan_written // false' "$STATE")" != "true" ]; then
    N=$(increment_denial "plan_required")
    if [ "$N" -le 1 ]; then
      cat >&2 << 'DENIAL'
PLAN REQUIRED: Write a plan before editing source code.

HOW TO PROCEED:
1. Send: mcp__nanoclaw__send_message("🟡 Plan gate — writing plan.")
2. Write plan to /workspace/agent/plans/<target-slug>.md (files, approach, verification).
3. Spawn codex-critique to review the plan (up to 3 rounds).
4. Record verdict at plan top. Then edit source code following the plan.
DENIAL
    else
      echo "PLAN REQUIRED: Write a plan to /workspace/agent/plans/ before editing. (Repeated denial #$N)" >&2
    fi
    exit 2
  fi

  # Plan staleness
  PLAN_STALE=$(jq -r '.plan_stale // false' "$STATE")
  if [ "$PLAN_STALE" = "true" ]; then
    EDITS=$(jq '.edits_since_plan // 0' "$STATE")
    N=$(increment_denial "plan_stale")
    if [ "$N" -le 1 ]; then
      echo "PLAN STALE: $EDITS edits since last plan. Write an updated plan to /workspace/agent/plans/ then continue. Send: mcp__nanoclaw__send_message('📝 Plan refresh — $EDITS edits.')" >&2
    else
      echo "PLAN STALE: Refresh your plan in /workspace/agent/plans/ before continuing. ($EDITS edits, denial #$N)" >&2
    fi
    exit 2
  fi
fi

# Critique enforcement
CRIT_REQ=$(jq -r '.critique_required // false' "$STATE" 2>/dev/null)
if [ "$CRIT_REQ" = "true" ]; then
  ROUNDS=$(jq '.critique_rounds // 0' "$STATE")
  FLAGGED_AT=$(jq '.critique_round_at_flag // 0' "$STATE")
  if [ "$ROUNDS" -le "$FLAGGED_AT" ]; then
    EDITS=$(jq '.edits_since_critique // 0' "$STATE")
    N=$(increment_denial "critique_required")
    if [ "$N" -le 1 ]; then
      cat >&2 << DENIAL
CRITIQUE REQUIRED: $EDITS edits without review. Spawn codex-critique before further edits.

HOW TO PROCEED:
1. Send: mcp__nanoclaw__send_message("🔴 Critique gate — spawning review.")
2. Spawn codex-critique with: Problem, Changes, Thoughts.
3. If must-fix → fix → re-spawn (up to 3 rounds). Escalate after 3.
4. Once approved, send: mcp__nanoclaw__send_message("✅ Critique approved.")
DENIAL
    else
      echo "CRITIQUE REQUIRED: Spawn codex-critique before further edits. ($EDITS edits, denial #$N)" >&2
    fi
    exit 2
  fi
fi

exit 0
