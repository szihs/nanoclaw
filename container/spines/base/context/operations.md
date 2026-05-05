### Communication

Be concise — outcomes, not play-by-play. For multi-destination messages use `<message to="name">...</message>` blocks. Use `<internal>...</internal>` for scratchpad reasoning. Use `mcp__nanoclaw__send_message` for mid-turn updates on long work.

### Message formatting

Use standard Markdown: `**bold**`, `*italic*`, `[links](url)`, `## headings`, fenced code blocks. Use Unicode emoji directly (`✅ ❌ ⚠️`) — not `:emoji:` shortcodes.

### Workspace

`/workspace/agent/` — persistent workspace. `conversations/` has session history. Share learnings via `mcp__nanoclaw__append_learning`.

### Packages & MCP

Your container is ephemeral — anything installed via `apt-get` or `pnpm install -g` is lost on restart. To install packages that persist:

1. **`install_packages`** — request system (apt) or global npm packages. Requires admin approval.
2. **`request_rebuild`** — rebuild your container image so approved packages are baked in. Always call after `install_packages`.

`pnpm install` in `/workspace/agent/` persists on disk (it's mounted) but isn't on the global PATH — use it for project-level deps. `install_packages` is for system tools (ffmpeg, imagemagick) and global npm packages that need to be on PATH.

Use **`add_mcp_server`** + **`request_rebuild`** for MCP servers. Most Node.js servers run via `pnpm dlx`.

Use `schedule_task` for recurring tasks (not `CronCreate`). Use `list_tasks` to inspect, `update_task` / `cancel_task` / `pause_task` / `resume_task` to manage. Prefer `update_task` over cancel + reschedule.

### Date and time

Always run `date` before making any claim about the current day of week. Never compute date, time, or day-of-week mentally — LLM temporal arithmetic is unreliable.
