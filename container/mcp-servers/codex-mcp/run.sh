#!/bin/bash
# Codex MCP server — runs OpenAI Codex as a stdio MCP server.
# Supergateway wraps this into HTTP on a loopback port.
#
# Model and reasoning config come from env vars set in .env:
#   CODEX_MODEL, CODEX_BASE_URL, CODEX_REASONING_EFFORT
exec codex \
  -m "${CODEX_MODEL:-openai/openai/gpt-5.5}" \
  -c "model_reasoning_effort=${CODEX_REASONING_EFFORT:-high}" \
  mcp-server
