# NanoClaw v2 On-Call Runbook

## Where to Look

| What | Location | How to access |
|------|----------|---------------|
| Host logs | `logs/nanoclaw.log` | Dashboard: Admin > Logs > App Log |
| Host errors | `logs/nanoclaw.error.log` | Dashboard: Admin > Logs > Error Log |
| Dashboard logs | `logs/nanoclaw-dashboard.log` | Dashboard: Admin > Logs > Dashboard Log |
| Dashboard errors | `logs/nanoclaw-dashboard.error.log` | Dashboard: Admin > Logs > Dashboard Error Log |
| Container stdout | `docker logs <container-name>` | Dashboard: Admin > Logs > Container Log (select group) |
| Central DB | `data/v2.db` | `node -e "require('better-sqlite3')('data/v2.db')..."` |
| Session inbound DB | `data/v2-sessions/<ag-id>/sessions/<sess-id>/inbound.db` | Messages sent TO the agent |
| Session outbound DB | `data/v2-sessions/<ag-id>/sessions/<sess-id>/outbound.db` | Messages sent BY the agent |
| Hook events | `data/v2.db` table `hook_events` | Dashboard: Pixel Office timeline / Admin > Logs |
| Agent transcripts | Inside container: `/home/node/.claude/projects/.../*.jsonl` | `docker exec <name> ls /home/node/.claude/projects/` |
| Container settings | `data/v2-sessions/<ag-id>/.claude-shared/settings.json` | Hooks, env, MCP config |
| Agent runner source | `data/v2-sessions/<ag-id>/agent-runner-src/` | Per-group copy, bind-mounted at `/app/src` |

## Common Scenarios

### Dashboard not loading

1. Check service: `systemctl --user status nanoclaw-dev-dashboard`
2. Check port: `curl -s http://localhost:3838/api/coworkers | head -c 100`
3. Check dashboard error log: `tail -30 logs/nanoclaw-dashboard.error.log`
4. Restart: `systemctl --user restart nanoclaw-dev-dashboard`

### Coworker not responding to messages

1. Check container is running: `docker ps --filter name=ncdev-haaggarwal-<folder>`
2. If not running, check host log for spawn errors: `grep <folder> logs/nanoclaw.log | tail -20`
3. If running, check container logs: `docker logs <container-name> 2>&1 | tail -30`
4. Check inbound DB has the message: `node -e "const D=require('better-sqlite3'); const db=new D('data/v2-sessions/<ag-id>/sessions/<sess-id>/inbound.db',{readonly:true}); console.log(db.prepare('SELECT * FROM messages_in ORDER BY timestamp DESC LIMIT 5').all()); db.close();"`
5. Check if container is stuck: `docker exec <name> ps aux`
6. Force restart: `docker stop <container-name>` (host auto-respawns on next message)

### Container keeps restarting (exit 137)

Exit code 137 = SIGKILL (OOM or `docker stop`).

1. Check if it's OOM: `docker inspect <name> --format '{{.State.OOMKilled}}'`
2. Check host logs for deliberate stop: `grep "Container exited" logs/nanoclaw.log | grep <folder> | tail -5`
3. If OOM, consider adding memory limit: currently no `--memory` flag is set

### Approval not working

1. Check pending approvals: `node -e "const D=require('better-sqlite3'); const db=new D('data/v2.db',{readonly:true}); console.log(db.prepare('SELECT * FROM pending_approvals').all()); db.close();"`
2. Check outbound DB for the card message: look for `kind='card'` in outbound.db
3. Check dashboard server can reach host: `curl -s http://localhost:3839/api/dashboard/inbound` (should return method-not-allowed, not connection refused)
4. Check host error log for approval handler errors: `grep -i "approval\|question" logs/nanoclaw.error.log | tail -10`

### MCP tools not available

1. Check MCP registry is running: `curl -s http://localhost:8809/mcp/ | head -c 200`
2. Check which tools are blocked: `grep "Blocking.*MCP" <container-logs>`
3. Check container env: `docker exec <name> env | grep MCP`
4. Check settings.json for mcpServers: `cat data/v2-sessions/<ag-id>/.claude-shared/settings.json | python3 -m json.tool | grep -A5 mcpServers`

### Peer wiring (agent-to-agent) not working

1. Check destinations exist: `node -e "const D=require('better-sqlite3'); const db=new D('data/v2.db',{readonly:true}); console.log(db.prepare('SELECT * FROM agent_destinations').all()); db.close();"`
2. Verify bidirectional entries (source -> target AND target -> source)
3. Check host error log: `grep -i "destination\|wire\|unauthorized" logs/nanoclaw.error.log | tail -10`
4. Check the agent's destinations file: `cat data/v2-sessions/<ag-id>/sessions/<sess-id>/destinations.json`

### Channel (Slack/Discord/Telegram) not delivering

1. Check channel is registered: `grep -i "<channel-type>" logs/nanoclaw.log | head -5`
2. Check for delivery errors: `grep "delivery\|deliver" logs/nanoclaw.error.log | tail -10`
3. Check channel credentials via OneCLI: `onecli list`
4. Restart host service: `systemctl --user restart nanoclaw-dev`

### Disk space full

1. Check: `df -h /`
2. Prune docker: `docker system prune -f && docker builder prune -f`
3. Check image sizes: `docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' | sort -k2 -h`
4. Remove unused per-developer tags: `docker rmi nanoclaw-agent:<unused-tag>`
5. Check data directory size: `du -sh data/`

### Import/export failure

1. Export: `curl -s http://localhost:3838/api/export?group=<folder>` — check for error in response
2. Import: POST to `/api/import` — check dashboard error log for details
3. Common issue: YAML parse error — validate YAML syntax
4. Collision: import with `?mode=skip` or `?mode=overwrite`

## Service Management

```bash
# Dev services (haaggarwal)
systemctl --user status nanoclaw-dev
systemctl --user status nanoclaw-dev-dashboard
systemctl --user restart nanoclaw-dev
systemctl --user restart nanoclaw-dev-dashboard

# View logs live
journalctl --user -u nanoclaw-dev -f
journalctl --user -u nanoclaw-dev-dashboard -f

# Rebuild host after src/ changes
cd /home/ubuntu/haaggarwal/nanoclaw_v2 && npm run build && systemctl --user restart nanoclaw-dev nanoclaw-dev-dashboard
```

## Key DB Queries

```bash
# All active sessions
node -e "const D=require('better-sqlite3'); const db=new D('data/v2.db',{readonly:true}); console.log(db.prepare(\"SELECT s.id, g.folder, s.status FROM sessions s JOIN agent_groups g ON s.agent_group_id=g.id\").all()); db.close();"

# Recent hook events for a group
node -e "const D=require('better-sqlite3'); const db=new D('data/v2.db',{readonly:true}); console.log(db.prepare(\"SELECT event, tool, timestamp, created_at FROM hook_events WHERE group_folder='<folder>' ORDER BY created_at DESC LIMIT 10\").all()); db.close();"

# Container config (packages, MCP servers, image tag)
node -e "const D=require('better-sqlite3'); const db=new D('data/v2.db',{readonly:true}); const g=db.prepare(\"SELECT container_config FROM agent_groups WHERE folder='<folder>'\").get(); console.log(JSON.parse(g.container_config||'{}')); db.close();"
```
