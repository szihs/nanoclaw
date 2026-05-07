---
name: dashboard
description: Pixel office dashboard for NanoClaw. Real-time visualization of coworker agents, hook event timeline, and observability. Use for setup, troubleshooting, or extending the dashboard. Triggers on "dashboard", "pixel office", "observability", "agent dashboard".
---

# NanoClaw Dashboard

Four-tab real-time dashboard:
- **Tab 1 — Pixel Office**: Interactive isometric pixel art office. Each agent is a character. Click to see status, memory, hook log, subagents.
- **Tab 2 — Coworkers**: Manage coworker agents — create, edit, delete, inspect containers and files.
- **Tab 3 — Timeline**: Chronological event stream with stats, sparklines, session flow drilldown.
- **Tab 4 — Admin**: Configuration, debug info, infrastructure, logs, skills, and chat.

```
┌─────────────────────────────────────────────────────┐
│  Container (agent)                                   │
│  └── Hook callbacks POST to dashboard               │
└──────────────────┬──────────────────────────────────┘
                   │ HTTP POST /api/hook-event
                   ▼
┌─────────────────────────────────────────────────────┐
│  Dashboard Server (dashboard/server.ts)              │
│  ├── REST API (/api/state, /api/messages, etc.)     │
│  ├── SSE stream (/api/events)                        │
│  └── Static files (pixel art office UI)              │
└─────────────────────────────────────────────────────┘
```

## File Structure

```
.claude/skills/dashboard/
├── SKILL.md                  # This file
├── dashboard-channel.ts      # Virtual channel (reference copy; live version at src/channels/dashboard.ts)
└── gotchas.md                # Known issues and fixes

dashboard/                    # The dashboard itself (copied by setup)
├── server.ts                 # HTTP server (2366 lines)
├── server.test.ts            # Tests (354 lines)
└── public/
    ├── index.html            # UI (four tabs: pixel office, coworkers, timeline, admin)
    ├── app.js                # Frontend logic (SSE, state, rendering)
    ├── sprites.js            # Pixel art sprite engine
    └── assets/               # Characters, furniture, floors, walls
```

## Setup

All integration patches (channel registration, container-runner hooks, package.json script, vitest config) are already applied on this branch. To run:

```bash
npm run build
npm run dashboard        # Starts on port 3737
# Open http://localhost:3737
```

### Verify

1. Dashboard loads at `http://localhost:3737`
2. Pixel office shows with default layout
3. When an agent runs, events appear in the timeline
4. Click a character to see its detail panel

## Quick Reference

**Core**

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Dashboard UI |
| `GET /api/state` | Current agent states (live hook + subagent state) |
| `GET /api/events` | SSE stream for real-time updates |
| `POST /api/hook-event` | Receive hook events from agents |
| `GET /api/overview` | Summary stats (groups, messages, sessions) |

**Messages & Sessions**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/messages` | Message history (`?group=X&limit=N&before=T`) |
| `GET /api/sessions` | List agent sessions |
| `DELETE /api/sessions/:folder` | Delete sessions for a group |

**Hook Events**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/hook-events` | Recent hook events (live buffer) |
| `GET /api/hook-events/history` | Historical hook events from DB (`?group=X&since=T&before=T&limit=N`) |
| `GET /api/hook-events/sessions` | Hook event sessions (`?group=X`) |
| `GET /api/hook-events/session-flow` | Session flow drilldown (`?group=X&session_id=Y`) |

**Coworkers**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/groups/detail` | Registered groups with session counts |
| `GET /api/types` | Coworker type registry |
| `POST /api/coworkers` | Create a new coworker |
| `PUT /api/coworkers/:folder` | Update coworker settings |
| `DELETE /api/coworkers/:folder` | Delete a coworker |
| `GET /api/coworkers/:folder/container` | Container status |
| `POST /api/coworkers/:folder/exec` | Execute command in container |
| `GET /api/coworkers/:folder/files` | List files in group folder |
| `GET /api/coworkers/:folder/browse` | Browse container filesystem |
| `GET /api/coworkers/:folder/read` | Read file from container |
| `GET /api/coworkers/:folder/download/...` | Download file from container |

**Tasks**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tasks` | List scheduled tasks |
| `POST /api/tasks/:id/pause` | Pause a task |
| `POST /api/tasks/:id/resume` | Resume a task |
| `DELETE /api/tasks/:id` | Delete a task |

**Memory & Config**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/memory/:folder` | Read group memory (CLAUDE.md) |
| `PUT /api/memory/:folder` | Update group memory |
| `GET /api/config` | NanoClaw configuration |
| `GET /api/config/claude-md` | Read main CLAUDE.md |
| `PUT /api/config/claude-md` | Update main CLAUDE.md |

**Skills**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/skills` | List available container skills |
| `GET /api/skills/:name` | Get skill details |
| `POST /api/skills` | Create a skill |
| `PUT /api/skills/:name` | Update a skill |
| `DELETE /api/skills/:name` | Delete a skill |
| `POST /api/skills/:name/toggle` | Enable/disable a skill |

**Infrastructure & Debug**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/channels` | Active channels |
| `GET /api/logs` | Application logs (`?source=X&group=X&search=X&limit=N`) |
| `GET /api/debug` | Debug info (DB stats, paths) |
| `GET /api/infrastructure` | Infrastructure status |
| `POST /api/chat/send` | Send a message via channel |
| `POST /api/mcp-control` | MCP server control |
