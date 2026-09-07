#!/bin/bash
# PostToolUse hook (matcher: Bash):
# Auto-detects PR creation from gh CLI or curl output.
# Outputs a hookSpecificOutput that instructs the agent to call report_pr_created.
#
# Stdin: JSON with tool_name, tool_input, tool_response.
set -euo pipefail

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null)

# Only check PR-creating commands
IS_PR_CREATE=false
case "$COMMAND" in
  *"gh pr create"*) IS_PR_CREATE=true ;;
esac
# curl POST to pulls API
if echo "$COMMAND" | grep -qP '(POST|post).*(/repos/|api\.github).*(/pulls)'; then
  IS_PR_CREATE=true
fi
if echo "$COMMAND" | grep -qP '(/repos/|api\.github).*(/pulls).*(POST|post)'; then
  IS_PR_CREATE=true
fi
[ "$IS_PR_CREATE" = "false" ] && exit 0

# Extract PR URL: https://github.com/<owner>/<repo>/pull/<number>
PR_URL=$(echo "$RESPONSE" | grep -oP 'https://github\.com/[^/]+/[^/]+/pull/\d+' | head -1)

if [ -z "$PR_URL" ]; then
  PR_URL=$(echo "$RESPONSE" | jq -r '.html_url // empty' 2>/dev/null | grep -oP 'https://github\.com/[^/]+/[^/]+/pull/\d+' || true)
fi

[ -z "$PR_URL" ] && exit 0

REPO=$(echo "$PR_URL" | grep -oP 'github\.com/\K[^/]+/[^/]+')
PR_NUM=$(echo "$PR_URL" | grep -oP '/pull/\K\d+')

[ -z "$REPO" ] || [ -z "$PR_NUM" ] && exit 0

# Output instruction for the agent: (1) claim the PR for webhook routing,
# (2) produce the HTML explanation that accompanies every PR we open
# (container/skills/explain-diff-html — in base-common, so every project
# spine has it). The hookSpecificOutput.additionalContext is injected into
# the agent's next turn.
jq -nc --arg repo "$REPO" --arg pr "$PR_NUM" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("PR created: " + $repo + "#" + $pr + ". IMPORTANT: Call report_pr_created(repo=\"" + $repo + "\", pr_number=" + $pr + ") now so webhook events for this PR route to your session. Then run /explain-diff-html for " + $repo + "#" + $pr + ": write the self-contained HTML under /workspace/agent/reports/pr-explanations/, deliver it with send_file to the thread that asked for this PR, and list its path in the review request or report that follows. Do not post it to GitHub.")
  }
}'

exit 0
