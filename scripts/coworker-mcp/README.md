# coworker-mcp

A dependency-free MCP server that lets an MCP client (Claude Desktop, Claude Code, …) **talk to your NanoClaw coworkers** and inspect their cost. Each tool is one HTTP call to the **local dashboard** (`/api/*`), which ensures wiring and wakes a cold container via the host router — so replies come back through the normal session flow.

- **Node stdlib only** — no dependencies, no install; deploy by copying one file.
- **Transport:** stateless Streamable-HTTP MCP (JSON-RPC over POST). Works with mainstream MCP clients; no SSE/session-id required.
- **On-box + loopback:** calls `127.0.0.1:<dashboard>`, so no dashboard auth is needed. Put a real auth boundary (SSO / reverse proxy) in front of the MCP port for remote access.

## Run

```bash
node scripts/coworker-mcp/coworker-mcp.mjs
# → coworker-mcp v0.3.0 on http://127.0.0.1:8830/mcp -> http://127.0.0.1:3838 (11 tools)
```

### Env

| Var | Default | Purpose |
|---|---|---|
| `NANOCLAW_DASH_URL` | `http://127.0.0.1:3838` | Dashboard base URL (the `/api/*` surface). |
| `COWORKER_MCP_HOST` | `127.0.0.1` | Bind host. **Non-loopback requires `COWORKER_MCP_TOKEN`** (fail-closed). |
| `COWORKER_MCP_PORT` | `8830` | Listen port for the MCP endpoint (`/mcp`). |
| `COWORKER_MCP_TOKEN` | *(unset)* | Optional Bearer required on `/mcp`. Off by default (front with SSO). |
| `NANOCLAW_DASHBOARD_SECRET` | *(unset)* | Forwarded as `Authorization: Bearer` to the dashboard if set. |
| `NCL_BIN` | `ncl` | Path to `ncl` for the cost tools. **Point at the running host's checkout** (`<repo>/bin/ncl`) so cost reads hit the live DB. |
| `COWORKER_MCP_ALLOWED_ORIGINS` | *(none)* | Comma list of allowed `Origin` headers (browsers only; MCP clients send none). |

## Tools (11)

| Tool | Wraps | Notes |
|---|---|---|
| `list_coworkers` | `GET /api/coworkers` | folder = coworker id |
| `talk_to_coworker` | `POST /api/chat/send` | wakes a cold container; async reply |
| `wait_for_reply` | `GET /api/messages` (poll) | blocks server-side until a new `outgoing` msg |
| `read_replies` | `GET /api/messages` | recent transcript (both directions) |
| `list_sessions` | `GET /api/sessions` | |
| `talk_to_session` | `POST /api/chat/send-to-session` | reply into a specific session |
| `cost_status` | `ncl cost-cap status --session` | live cost state for one session |
| `list_stopped_sessions` | `ncl cost-cap stopped --json` | the LIVE currently-blocked set (status=`stopped` right now), deduped per session — same source as the dashboard |
| `list_cost_escalations` | `ncl cost-cap escalations --json` | append-only HISTORY ledger of every cap/ceiling trip (NOT "blocked now" — use `list_stopped_sessions` for that) |
| `cost_per_coworker` | `ncl cost-cap coworkers --json` | exact per-coworker $ from the inference gateway (litellm capture) |
| `continue_session` | `POST /api/cost-override` | resume a cost-stopped session |
| `resolve_approval` | `POST /api/approvals/action` | |
| `answer_question` | `POST /api/questions/respond` | |

Replies are **async** — `talk_to_coworker` returns immediately; use `wait_for_reply` (bounded server-side poll) or `read_replies`.

## Connect from Claude Desktop

The MCP port is loopback; reach it over a tunnel (or your SSO ingress), then bridge with `mcp-remote`:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "coworkers": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8830/mcp", "--allow-http"]
    }
  }
}
```

Tunnel example (Brev): `brev port-forward <instance> -p 8830:8830`.

## Run as a service (systemd --user)

```ini
[Unit]
Description=NanoClaw coworker MCP
After=network.target

[Service]
Type=simple
Environment=NANOCLAW_DASH_URL=http://127.0.0.1:3838
Environment=COWORKER_MCP_HOST=127.0.0.1
Environment=COWORKER_MCP_PORT=8830
Environment=NCL_BIN=%h/<checkout>/bin/ncl
ExecStart=/usr/bin/node %h/<checkout>/scripts/coworker-mcp/coworker-mcp.mjs
Restart=on-failure
KillMode=mixed

[Install]
WantedBy=default.target
```

## Security

Loopback + no token by default (SSO/tunnel is the boundary). Hardening built in: fail-closed when bound non-loopback without a token, `Origin` rejection (CSRF/DNS-rebinding), `application/json`-only, 1 MiB body cap, constant-time token compare, per-IP rate limits (stricter for mutating tools), and sanitized errors.
