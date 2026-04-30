#!/bin/bash
# UserPromptSubmit hook: classify user intent and recommend a workflow.
# Uses a small/fast LLM call (Haiku) to read the user's message and the
# available workflows, then outputs additionalContext with a routing
# recommendation the agent sees at the top of its turn.
#
# Requires: ANTHROPIC_API_KEY or OneCLI proxy for API access.
# Falls back gracefully (no-op) if the API call fails.
set -euo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
[ -z "$PROMPT" ] && exit 0

# Skip slash commands (already routed) and pure-system context injections.
# Dashboard/A2A user messages are wrapped as `<context ...><message>...</message>`,
# so only skip when the payload has `<context>` but NO `<message>` — those are
# system-only injections (e.g. session restore, timezone bump) with no user text.
echo "$PROMPT" | grep -qP '^\s*/' && exit 0
if echo "$PROMPT" | grep -q '<context' && ! echo "$PROMPT" | grep -q '<message'; then
  exit 0
fi

# Strip the wrapping tags so the LLM classifies the actual user text, not the
# envelope. Multi-line safe via Perl. Falls back to raw prompt if no <message>.
UNWRAPPED=$(echo "$PROMPT" | perl -0777 -ne 'print $1 if /<message[^>]*>(.*?)<\/message>/s')
[ -n "$UNWRAPPED" ] && PROMPT="$UNWRAPPED"

# Available workflows are injected by container-runner.ts as an env var.
# Format: "investigate:Investigation/triage;implement:Code change/fix;document:Doc update;review:Review"
WORKFLOWS="${OVERLAY_WORKFLOWS:-}"
[ -z "$WORKFLOWS" ] && exit 0

# Build the classification prompt
CLASSIFY_PROMPT="You are a workflow router. Given the user's message and the available workflows, output ONLY a JSON object with two fields:
- \"workflow\": the workflow name to invoke (or \"none\" if it's a simple chat/question)
- \"reason\": one sentence explaining why

Available workflows:
$(echo "$WORKFLOWS" | tr ';' '\n' | while IFS=: read -r name desc; do
  echo "- /$name: $desc"
done)

Rules:
- If the user asks to fix, implement, or change code → the implement workflow
- If the user asks to investigate, triage, research, or understand → the investigate workflow
- If the user asks to update docs or write documentation → the document workflow
- If the user asks to review a PR/MR or code change → the review workflow
- If the user asks a simple question or chats → \"none\"
- If the task requires investigation BEFORE implementation, route to investigate first

User message:
$PROMPT

Respond with ONLY the JSON object, no markdown, no explanation."

# Use Haiku for speed — this should complete in <2s
MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-claude-haiku-4-5-20251001}"
API_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
API_KEY="${ANTHROPIC_API_KEY:-}"

[ -z "$API_KEY" ] && exit 0

RESPONSE=$(curl -sf --max-time 5 \
  "$API_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d "$(jq -n \
    --arg model "$MODEL" \
    --arg prompt "$CLASSIFY_PROMPT" \
    '{model: $model, max_tokens: 100, messages: [{role: "user", content: $prompt}]}')" \
  2>/dev/null) || exit 0

# Extract the text response
TEXT=$(echo "$RESPONSE" | jq -r '.content[0].text // empty' 2>/dev/null || true)
[ -z "$TEXT" ] && exit 0

# Haiku sometimes wraps the JSON in ```json ... ``` markdown fences. Strip them
# (and any leading/trailing whitespace) before parsing, so jq doesn't choke.
TEXT=$(echo "$TEXT" | sed -E 's/^[[:space:]]*```(json)?[[:space:]]*//; s/```[[:space:]]*$//')

# Parse the JSON from the response. `|| true` so set -e doesn't kill us when
# the response wasn't valid JSON — we'll exit cleanly via the empty-check below.
WORKFLOW=$(echo "$TEXT" | jq -r '.workflow // "none"' 2>/dev/null || true)
REASON=$(echo "$TEXT" | jq -r '.reason // empty' 2>/dev/null || true)

# Strip a leading slash if Haiku returned `/investigate` instead of `investigate`,
# so the AUTO-ROUTE template doesn't end up with `Start with //investigate`.
WORKFLOW="${WORKFLOW#/}"

[ "$WORKFLOW" = "none" ] && exit 0
[ -z "$WORKFLOW" ] && exit 0

# Output the routing recommendation as additionalContext
jq -n \
  --arg wf "$WORKFLOW" \
  --arg reason "$REASON" \
  '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: ("AUTO-ROUTE: Start with /" + $wf + ". Reason: " + $reason + ". Invoke Skill(/" + $wf + ") before using Edit/Write/Bash on source files.")
    }
  }'

exit 0
