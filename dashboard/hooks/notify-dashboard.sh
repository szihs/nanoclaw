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

# Extract tool name from input JSON if available
TOOL_NAME=""
MESSAGE=""
if command -v jq &>/dev/null; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // empty' 2>/dev/null)
  MESSAGE=$(echo "$INPUT" | jq -r '.message // .notification // empty' 2>/dev/null)
fi

# Build event payload
PAYLOAD=$(cat <<EOF
{
  "group": "$GROUP",
  "event": "$EVENT_TYPE",
  "tool": "${TOOL_NAME:-$CLAUDE_TOOL_NAME}",
  "message": "${MESSAGE:-$CLAUDE_NOTIFICATION}"
}
EOF
)

# Fire and forget — don't block the agent
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "${DASHBOARD_URL}/api/hook-event" \
  --connect-timeout 1 \
  --max-time 2 \
  >/dev/null 2>&1 &

exit 0
