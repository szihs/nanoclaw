# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Slang MCP Server — a Model Context Protocol (MCP) server that exposes GitHub, GitLab, Discord, and Slack APIs as tools for LLM agents. Built for the shader-slang/slang project's maintainer workflows.

## Build & Run

```bash
# Install dependencies (uses uv package manager)
uv sync

# Run server (stdio transport, default)
uv run slang-mcp-server

# Run server (SSE transport on custom port)
uv run slang-mcp-server --transport sse --port 8000

# Run as module
uv run python -m src
```

## Testing

```bash
# Run all tests
uv run pytest

# Run a single test file
uv run pytest test/test_github.py

# Run a specific test
uv run pytest test/test_github.py::test_get_issue -v
```

## Linting & Type Checking

```bash
uv run ruff check src/          # Lint
uv run ruff format src/         # Format
uv run pyright                  # Type check (strict mode, src/ only)
```

## Architecture

### Server (`src/server.py`)
Single-file MCP server using `mcp.server.lowlevel.Server`. Contains:
- Click CLI entry point (`main()`) with `--port` and `--transport` options
- Tool registration via `@app.call_tool()` and `@app.list_tools()` decorators
- Giant if/elif dispatch mapping tool names to handler functions
- Tool schema definitions are inline dicts (not generated from Pydantic models)
- Supports two transports: STDIO (via `anyio`) and SSE (via Starlette/uvicorn)

### Config (`src/config.py`)
- Pydantic models for API configs (`GitHubConfig`, `GitLabConfig`, `DiscordConfig`)
- `setup_environment()` loads `.env` and initializes global config singletons
- `github_request()` / `gitlab_request()` — authenticated async HTTP helpers using `httpx`
- Slack config is a plain dict via `get_slack_config()` (not a Pydantic model)
- SSL verification has platform-specific handling (Linux cert path)

### API Modules (`src/{github,gitlab,discord,slack}/`)
Each module follows the pattern:
- Pydantic `*Args` models for tool input validation
- Async functions that call the respective API and return `{"filtered": ..., "raw": ...}` dicts
- Rich console logging throughout

**GitHub** (`src/github/github.py`): Uses both REST API and GraphQL. GraphQL is used for `list_issues` (with pagination) and priority extraction from ProjectV2. Default owner/repo is `shader-slang/slang`.

**GitLab** (`src/gitlab/gitlab.py`): REST API via `gitlab_request()`. Returns raw `httpx.Response` objects (not dicts) from `gitlab_request()`, so callers must check `response.status_code` and call `response.json()`.

**Discord** (`src/discord/discord.py`): Uses `discord.py` library with a persistent bot client. Has `ensure_client_connected()` with health checks and reconnection logic. Supports TextChannel and ForumChannel message reading.

**Slack** (`src/slack/slack.py`): Uses `aiohttp` directly (not the official Slack SDK). Has its own `SlackClient` class managing sessions. Includes thread reply fetching with rate-limit retry logic.

### Key Patterns
- Tool arguments default owner/repo to `shader-slang`/`slang` in GitHub Args classes
- `IsDebug()` global flag controls whether raw API responses are included in output
- `filter_data()` in github.py extracts priority from GitHub ProjectV2 field values
- GitLab uses `encodeURIComponent()` helper for URL-encoding project IDs and file paths

## Environment Variables

Set in `.env` (see `.env.example`):
- `GITHUB_ACCESS_TOKEN` — GitHub PAT (required for GitHub tools)
- `DISCORD_BOT_TOKEN` — Discord bot token (optional; Discord tools unavailable if missing)
- `SLACK_BOT_TOKEN` + `SLACK_TEAM_ID` — Slack credentials (optional; Slack tools unavailable if missing)
- `GITLAB_ACCESS_TOKEN` + `GITLAB_API_BASE` — GitLab credentials (optional; GitLab tools unavailable if missing)

## Cursor Rules Context

The `.cursor/.cursorrules` file contains triage priority definitions (P0-P3) and file structure guidance specific to the shader-slang/slang repository. These inform how the MCP server's GitHub tools should interpret issue priorities.
