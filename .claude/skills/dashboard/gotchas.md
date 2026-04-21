# Gotchas

Known issues and fixes for the dashboard.

## Connection

- **Dashboard not receiving events**: Hook callbacks POST to `http://127.0.0.1:3737/api/hook-event` — a socat proxy inside the container forwards this to the host gateway. If using a non-default port, set `DASHBOARD_PORT` env var before starting NanoClaw. Also check that the container has host gateway access.
- **SSE disconnects**: The browser reconnects automatically via `EventSource`. If events stop arriving, check the dashboard server process is still running.
- **CORS**: The dashboard server serves its own static files — no CORS issues. If you embed the dashboard in another app, you'll need to add CORS headers.

## Pixel Office

- **Characters not appearing**: Characters are assigned when agents send hook events. No events = no characters. Start an agent task to populate.
- **Layout reset**: Custom layout is saved to `dashboard/public/assets/default-layout-1.json`. If the file is deleted or corrupted, the dashboard falls back to auto-layout.
- **Sprite rendering**: Uses `image-rendering: pixelated` CSS. If sprites look blurry, ensure the browser supports this (all modern browsers do).

## Timeline

- **Events not showing**: Hook events are persisted to a SQLite `hook_events` table (with WAL mode) and survive dashboard restarts. A live ring buffer of the 200 most recent events is also kept in memory for the `/api/hook-events` endpoint. Historical data is served from the DB via `/api/hook-events/history`.
- **Large event volume**: With many agents and frequent tool calls, the timeline can accumulate thousands of entries. The UI virtualizes rendering but the SSE stream can lag. Consider filtering by group.
- **Session flow view**: Clicking "Session" on a timeline entry opens the flow view. If no session_id is present in hook data, the entry won't be linkable.

## Performance

- **Memory**: The in-memory ring buffer is capped at 200 entries (`MAX_HOOK_EVENTS`). All events are persisted to SQLite with a configurable retention period (`HOOK_RETENTION_DAYS`, default 7). Memory growth from hook events is bounded.
- **SQLite locking**: Dashboard reads messages from the main NanoClaw DB (opened readonly). The dashboard's own `hook_events` table uses WAL mode. If the main DB is locked, API calls may timeout. This is rare.
- **Port conflict**: Default port 3737. If another process uses it, set `DASHBOARD_PORT=3738` or similar.
