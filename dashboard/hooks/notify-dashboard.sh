#!/usr/bin/env bash
#
# Claude Code hook script for NanoClaw Dashboard integration.
# Sends tool-use and notification events to the dashboard server.
#
# Install by adding to .claude/settings.json:
# {
#   "hooks": {
#     "PostToolUse": [{ "command": "/path/to/notify-dashboard.sh PostToolUse" }],
#     "Notification": [{ "command": "/path/to/notify-dashboard.sh Notification" }],
#     "Stop": [{ "command": "/path/to/notify-dashboard.sh Stop" }]
#   }
# }
#
# Environment variables (set by Claude Code):
#   CLAUDE_TOOL_NAME - name of tool used (PostToolUse)
#   CLAUDE_NOTIFICATION - notification text (Notification)
#   NANOCLAW_GROUP_FOLDER - set by container-runner
#   DASHBOARD_URL - defaults to http://host.docker.internal:3737

DASHBOARD_URL="${DASHBOARD_URL:-http://host.docker.internal:3737}"
GROUP="${NANOCLAW_GROUP_FOLDER:-unknown}"
EVENT_TYPE="${1:-unknown}"

# Read from stdin (Claude Code pipes event JSON to hooks)
INPUT=""
if [ -t 0 ]; then
  INPUT="{}"
else
  INPUT=$(cat)
fi

# Extract tool name and enriched data from input JSON
TOOL_NAME=""
MESSAGE=""
TOOL_INPUT=""
TOOL_RESPONSE=""
SESSION_ID=""
AGENT_ID=""
AGENT_TYPE=""
if command -v jq &>/dev/null; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // empty' 2>/dev/null)
  MESSAGE=$(echo "$INPUT" | jq -r '.message // .notification // empty' 2>/dev/null)
  # Extract enriched debug data (truncate large fields to 500 chars)
  TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null | head -c 500)
  TOOL_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null | head -c 500)
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
  AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null)
  AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)
else
  # Bash-only fallback: extract values from flat JSON without jq
  # Handles {"tool_name":"Read"} style (no nested objects/escaped quotes)
  _extract_json_val() {
    local json="$1" key="$2"
    echo "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
  }
  TOOL_NAME=$(_extract_json_val "$INPUT" "tool_name")
  [ -z "$TOOL_NAME" ] && TOOL_NAME=$(_extract_json_val "$INPUT" "toolName")
  MESSAGE=$(_extract_json_val "$INPUT" "message")
  [ -z "$MESSAGE" ] && MESSAGE=$(_extract_json_val "$INPUT" "notification")
  SESSION_ID=$(_extract_json_val "$INPUT" "session_id")
  AGENT_ID=$(_extract_json_val "$INPUT" "agent_id")
  AGENT_TYPE=$(_extract_json_val "$INPUT" "agent_type")
  # tool_input/tool_response skipped in bash fallback (may contain nested JSON)
fi

# Build event payload (use jq if available for safe JSON, fallback to escaped string)
if command -v jq &>/dev/null; then
  PAYLOAD=$(jq -n \
    --arg group "$GROUP" \
    --arg event "$EVENT_TYPE" \
    --arg tool "${TOOL_NAME:-$CLAUDE_TOOL_NAME}" \
    --arg message "${MESSAGE:-$CLAUDE_NOTIFICATION}" \
    --arg tool_input "$TOOL_INPUT" \
    --arg tool_response "$TOOL_RESPONSE" \
    --arg session_id "$SESSION_ID" \
    --arg agent_id "$AGENT_ID" \
    --arg agent_type "$AGENT_TYPE" \
    '{group: $group, event: $event, tool: $tool, message: $message,
      tool_input: $tool_input, tool_response: $tool_response,
      session_id: $session_id, agent_id: $agent_id, agent_type: $agent_type}')
else
  # Escape double quotes in values for safe JSON
  esc_group="${GROUP//\"/\\\"}"
  esc_event="${EVENT_TYPE//\"/\\\"}"
  esc_tool="${TOOL_NAME:-$CLAUDE_TOOL_NAME}"
  esc_tool="${esc_tool//\"/\\\"}"
  esc_msg="${MESSAGE:-$CLAUDE_NOTIFICATION}"
  esc_msg="${esc_msg//\"/\\\"}"
  esc_sid="${SESSION_ID//\"/\\\"}"
  esc_aid="${AGENT_ID//\"/\\\"}"
  esc_atype="${AGENT_TYPE//\"/\\\"}"
  PAYLOAD="{\"group\":\"$esc_group\",\"event\":\"$esc_event\",\"tool\":\"$esc_tool\",\"message\":\"$esc_msg\",\"session_id\":\"$esc_sid\",\"agent_id\":\"$esc_aid\",\"agent_type\":\"$esc_atype\"}"
fi

# Fire and forget — don't block the agent
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "${DASHBOARD_URL}/api/hook-event" \
  --connect-timeout 1 \
  --max-time 2 \
  >/dev/null 2>&1 &

exit 0
