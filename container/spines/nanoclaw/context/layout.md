### NanoClaw repository layout

- `src/` — Host process: orchestrator (`index.ts`), container runner, router, delivery, config, DB migrations, channel registry
- `src/modules/` — Pluggable modules: `agent-to-agent/`, `approvals/`, `permissions/`, `scheduling/`, `self-mod/`, `typing/`
- `src/claude-composer/` — Lego spine composer: type resolution, spine rendering, registry scanning
- `src/db/` — SQLite operations, migrations (`migrations/*.ts`), session DB
- `container/` — Docker image: Dockerfile, entrypoint, agent-runner (Bun/TypeScript)
- `container/agent-runner/src/` — In-container code: providers (claude, codex, opencode), MCP tools, poll loop
- `container/skills/` — Lego skills: spine fragments, capability skills, workflow extensions, overlays
- `container/mcp-servers/` — MCP servers: `slang-mcp/` (Python), `slang-pr-knowledge/` (Python)
- `dashboard/` — Pixel Office dashboard: `server.ts` (main), `public/app.js` (client), `public/index.html`
- `setup/` — Setup wizard: `index.ts` (step runner), `register.ts` (channel registration)
- `groups/` — Per-agent group dirs (memory, instructions, workspace). Gitignored except templates.
- `.claude/skills/` — Operator-facing skills (setup, debug, customize, add-dashboard, etc.)
- `docs/` — Architecture docs, runbooks, coworker workflow spec
- `coworkers/` — Pre-packaged YAML bundles for agent import
