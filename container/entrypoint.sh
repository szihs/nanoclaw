#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

cat > /tmp/input.json

# Rewrite github.com HTTPS URLs to embed placeholder credentials.
# The OneCLI proxy intercepts the Basic auth header and injects the real token.
git config --global "url.https://x-access-token:placeholder@github.com/.insteadOf" "https://github.com/" 2>/dev/null || true

exec bun run /app/src/index.ts < /tmp/input.json
