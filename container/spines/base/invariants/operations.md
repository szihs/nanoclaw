### Message formatting

Standard Markdown + Unicode emoji (`✅ ❌ ⚠️`). No `:emoji:` shortcodes.

### Packages & MCP

- `install_packages` (apt/npm) — admin approval → rebuild + restart bundled.
- `add_mcp_server` — admin approval → restart only (bun runs TS directly).
- `pnpm install` in `/workspace/agent/` — persists on disk, not on PATH.
- `request_restart` — refresh CLAUDE.md, no approval needed.

### Date and time

Run `date` before claiming current day/time. LLM temporal arithmetic is unreliable.
