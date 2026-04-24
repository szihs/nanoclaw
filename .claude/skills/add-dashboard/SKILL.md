---
name: add-dashboard
description: Add Pixel Office dashboard for real-time agent observability. Isometric pixel-art office visualization with live tool use indicators, activity timelines, memory browser, and hook event streaming. Triggers on "add dashboard", "pixel office", "agent dashboard", "observability dashboard".
---

# Add Pixel Office Dashboard

This skill adds the Pixel Office dashboard — a real-time observability UI that shows your NanoClaw agents as pixel-art characters in an isometric office.

## Phase 1: Pre-flight

### Check if already applied

```bash
ls dashboard/server.ts 2>/dev/null && echo "ALREADY_APPLIED" || echo "NEEDS_INSTALL"
```

If `ALREADY_APPLIED`, skip to Phase 3 (Configure). The code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure slang remote

```bash
git remote -v
```

If `slang` remote is missing, add it:

```bash
git remote add slang https://github.com/slang-coworkers/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch slang skill/v2_dashboard
git merge slang/skill/v2_dashboard || {
  # Resolve package-lock.json conflicts if any
  git checkout --theirs package-lock.json 2>/dev/null && git add package-lock.json
  git merge --continue
}
```

This merges in:
- `dashboard/` — Full dashboard server and client (server.ts, public/app.js, public/index.html, sprites.js, 60+ pixel art assets, tests)
- `.claude/skills/dashboard/` — Setup instructions, integration guide, gotchas
- `container/skills/dashboard-base/` — lego-spine addon (`coworker-types.yaml` + `prompts/formatting.md`) that appends the dashboard formatting block to the `main` and `global` flat types
- Runtime wiring: `src/channels/dashboard.ts`, `src/dashboard-ingress.ts`, `src/db/migrations/012-hook-events.ts`, and `src/index.ts` integration
- `package.json` — `dashboard` script added

### Prompt layering

The base `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` stay on `v2_main` — they are regenerated from the lego spine, not hand-edited. No direct edits to `groups/main/CLAUDE.md` or `groups/global/CLAUDE.md` are needed.

This skill installs `container/skills/dashboard-base/`. The composer scans every `container/skills/*/coworker-types.yaml` and merges duplicate type entries, so `dashboard-base` appends its formatting block to the `main` and `global` flat types without touching `nanoclaw-base`. To reflect it in the checked-in prompts:

```bash
npm run rebuild:claude
```

### Validate code changes

```bash
npm run rebuild:claude
npm install
npm run build
npx vitest run
```

All tests must pass, including dashboard-specific tests (`dashboard/server.test.ts`) which are self-contained.

## Phase 3: Register Dashboard Group

The dashboard needs at least one registered group to route messages to. Register an admin group with a `dashboard:*` platform ID:

```bash
npx tsx setup/index.ts --step register -- \
  --platform-id "dashboard:orchestrator" \
  --name "Orchestrator" \
  --folder "orchestrator" \
  --trigger "@Orchestrator" \
  --channel dashboard \
  --no-trigger-required \
  --is-admin \
  --assistant-name "Orchestrator"
```

This creates:
- An admin group that responds to all messages (no trigger prefix needed)
- The group folder `groups/orchestrator/` with the agent's memory and workspace
- The agent gets the project mounted read-only and uses the host's v2 management tools for orchestration

## Phase 4: Configure

### Set dashboard host (Linux — required for hooks)

On Linux, the dashboard must bind to `0.0.0.0` so containers can reach it via `host.docker.internal` for hook events. Without this, the timeline and live status will be empty.

Add to `.env`:
```
DASHBOARD_HOST=0.0.0.0
```

On macOS (Docker Desktop), this is not needed — `host.docker.internal` works with the default `127.0.0.1`.

### Set dashboard port (optional)

The dashboard runs on port 3737 by default. To change:

Add to `.env`:
```
DASHBOARD_PORT=3737
```

The host-side dashboard chat ingress listens on port 3738 by default. To change:

Add to `.env`:
```
DASHBOARD_INGRESS_PORT=3738
```

### Dashboard authentication (optional)

By default the dashboard is open (no auth). To require a secret for admin mutations:

Add to `.env`:
```
DASHBOARD_SECRET=your-secret-here
```

When `DASHBOARD_SECRET` is set, the browser prompts for it on first load and
the dashboard stores an auth session cookie so SSE/live updates continue to
work without custom headers.

### Rebuild and restart

```bash
npm run build
./container/build.sh  # rebuilds container with dashboard hooks
```

Restart the service:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 5: Verify

### Start the dashboard

```bash
npm run dashboard
```

### Open in browser

Navigate to `http://localhost:3737` (or your configured port).

You should see:
- An isometric pixel office
- Agent characters appear when coworkers are active
- Live tool use indicators and status badges
- Activity timeline on the right panel

### Test hook events

Send a message to any registered chat. The dashboard should show:
- The agent character animating
- Tool use events appearing in the timeline
- Status changing from idle → thinking → working

## Troubleshooting

### Dashboard shows no agents

- Ensure NanoClaw service is running
- Check that `store/messages.db` exists (created on first run)
- Verify registered groups: `node -e "console.table(require('better-sqlite3')('store/messages.db',{readonly:true}).prepare('SELECT * FROM registered_groups').all())"`

### Hook events not arriving

1. **Verify dashboard reachable from containers:**
```bash
docker run --rm --add-host=host.docker.internal:host-gateway --entrypoint bash nanoclaw-agent:latest \
  -c "curl -sf http://host.docker.internal:${DASHBOARD_PORT:-3737}/api/auth/status"
```
If this fails, set `DASHBOARD_HOST=0.0.0.0` in `.env` (required on Linux).

2. **Check hook format in settings.json:**
```bash
cat data/v2-sessions/<agent-group-id>/.claude-shared/settings.json | python3 -c "
import sys,json; s=json.load(sys.stdin)
h = s.get('hooks',{}).get('PreToolUse',[])
print(h[0] if h else 'NO HOOKS')
"
```
Hooks should use `type: "command"` with `curl --proxy ''` (not `type: "http"`).

3. **Check proxy bypass:** Hooks must use `--proxy ''` to bypass OneCLI HTTPS_PROXY.

4. **Check management token:** The host and dashboard must share the same token file at `data/.mcp-management-token` (not `~/.config/nanoclaw/` which is shared across dev installs).

### Connection refused

- Dashboard must be running separately from the main NanoClaw service
- Dashboard chat requires the main NanoClaw host process (ingress bridge)
- Check port: `ss -tlnp | grep ${DASHBOARD_PORT:-3737}`
- On shared machines, check for port collision with other dev instances

## Removal

To remove the dashboard:

```bash
# Find the merge commit
git log --merges --oneline | grep dashboard

# Revert it
git revert -m 1 <merge-commit>

# Rebuild
npm run build
```
