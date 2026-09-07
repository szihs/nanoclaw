## `ncl` — NanoClaw CLI (global scope)

`ncl` is the NanoClaw admin CLI. Same flag interface on the host (Unix socket) and inside a container (session DBs).

Your scope is **`global`** — unrestricted. You can read and modify any agent group, messaging group, wiring, user, role, destination, or session. Treat that carefully.

### Resources you control

| Resource                                    | Verbs                                                                                                                                                       | What it is                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `groups`                                    | `list`, `get`, `create`, `update`, `delete`, `restart`, `config get/update`, `config add-mcp-server/remove-mcp-server`, `config add-package/remove-package` | Agent groups — workspace, personality, container config. |
| `messaging-groups`                          | `list`, `get`, `create`, `update`, `delete`                                                                                                                 | A single chat/channel on one platform.                   |
| `wirings`                                   | `list`, `get`, `create`, `update`, `delete`                                                                                                                 | Links a messaging group → an agent group.                |
| `users`                                     | `list`, `get`, `create`, `update`                                                                                                                           | Platform identities (`<channel>:<handle>`).              |
| `roles`                                     | `list`, `grant`, `revoke`                                                                                                                                   | Owner / admin privileges (global or per-group).          |
| `members`                                   | `list`, `add`, `remove`                                                                                                                                     | Unprivileged group access gate.                          |
| `destinations`                              | `list`, `add`, `remove`                                                                                                                                     | Where an agent group can send messages.                  |
| `sessions`                                  | `list`, `get`, `messages`                                                                                                                                   | Active sessions (read-only).                             |
| `cost-cap`                                  | `get`, `set`, `clear`, `status`, `stopped`, `escalations`, `sessions`, `coworkers`, `continue`, `stop`, `set-ceiling`                                                              | Runtime Tier-2 cost-cap policy (fleet ceiling + per-group cap/ceiling overrides); cost views (`status` live per-session, `stopped` the LIVE currently-blocked set, `escalations` the HISTORY ledger of every trip, `sessions` full distribution + p50/p90/p95, `coworkers` exact per-coworker $ from the gateway); escalation resolution (`continue`/`stop`/`set-ceiling`). **Global/elevated only.** |
| `policies`                                  | `list`, `set`, `remove`                                                                                                                                     | Agent-to-agent approval gates, per (from → to) pair. Operator-only — agents cannot gate their own connections. |
| `pr-mappings`                               | `list`, `remap`                                                                                                                                             | PR→session routing rows. `remap` reassigns one deliberately (approval-gated). |
| `user-dms`, `dropped-messages`, `approvals` | `list`, `get`                                                                                                                                               | Diagnostic views (read-only).                            |

### Common patterns

```bash
ncl groups list
ncl groups config update --id <gid> --provider codex     # admin-approval-gated
ncl groups restart --id <gid> --rebuild
ncl wirings create --messaging-group <mg> --agent-group <ag>
ncl roles grant --user <uid> --role admin --agent-group <gid>
ncl sessions messages <sid>
ncl policies set --from <ag> --to <ag> --approver <uid>  # gate a2a messages — admin-approval-gated
ncl pr-mappings remap --repo <owner/name> --pr <n> --session <sid>  # reassign a PR — admin-approval-gated
```

`ncl <resource> help` / `ncl help` print the full surface. Mutating verbs trigger admin approval, like the MCP self-mod tools.

### Tuning the cost cap

The Tier-2 cost cap is configured at runtime through `ncl cost-cap` — this is the mechanism, **not** the `NANOCLAW_COST_T2_CEILING_USD` env var (a deprecated legacy fallback). Values are stored in the DB and read at each container spawn; a `set`/`clear` change takes effect on a group's next spawn (`ncl groups restart --id <gid>` to apply immediately).

```bash
ncl cost-cap get                                # effective fleet ceiling + every override
ncl cost-cap get --group <folder>               # a group's effective per-session cap + ceiling
ncl cost-cap set --ceiling 150                  # fleet-wide Tier-2 hard ceiling (USD)
ncl cost-cap set --ceiling 300 --group <folder> # per-group ceiling override
ncl cost-cap set --cap 60 --group <folder>      # per-group per-session cap (requires --group)
ncl cost-cap clear [--group <folder>]           # remove an override → env/thresholds fallback
```

`--group <folder>` is the group's workspace folder. This surface is elevated-only (global scope / host operator); group-scoped agents can't reach it.

### Inspecting cost spend & escalations

`status`, `stopped`, `escalations`, and `sessions` are read-only (no approval). Use them to see what a session actually spent, which sessions are blocked on a cost decision RIGHT NOW, and the full per-group cost distribution.

```bash
ncl cost-cap status --session <sid>          # one session's LIVE cost state (ok|warn|escalated|stopped)
ncl cost-cap stopped                         # the LIVE currently-blocked set — sessions stopped RIGHT NOW
ncl cost-cap stopped --group <folder>        # currently-stopped sessions for one coworker
ncl cost-cap escalations --state stopped     # HISTORY: episodes whose recorded outcome was 'stopped' (NOT necessarily blocked now)
ncl cost-cap escalations --group <folder>    # a coworker's escalation history (spent/cap/ceiling)
ncl cost-cap escalations --author <gh-login> # escalations on a GitHub user's issue/PR threads
ncl cost-cap sessions                        # per-group cost aggregates + p50/p90/p95/max (default 30d)
ncl cost-cap sessions --group <folder> --period 7d   # one group, 7-day window
ncl cost-cap sessions --group <folder> --sessions    # the raw per-session list (ranked desc) instead
ncl cost-cap coworkers                       # EXACT $ per coworker from the gateway (litellm capture), all-time
ncl cost-cap coworkers --group <folder> --period 7d  # one coworker, 7-day window
```

**`stopped` vs `escalations` — do not confuse them.** `stopped` is the LIVE "which sessions are blocked on cost RIGHT NOW" view: it reads the dashboard's own `/api/sessions` and applies the SAME `costStatus === 'stopped'` predicate the dashboard's stopped count/filter use, so it reports the identical set, deduped per session (needs the dashboard installed/running, like `sessions`; fails loudly if unreachable rather than returning a false-empty). `escalations` is the append-only **HISTORY ledger** of every ceiling/cap trip ever; a row there (even `decision_state='stopped'`) is a past event and does NOT mean the session is blocked now — a resumed or exited session keeps its episode rows. To find what to Continue/reconcile, start with `stopped`, not `escalations`.

`escalations` lists per-session `spent`/`cap`/`ceiling` + `decision_state` + coworker + (for GitHub-thread sessions) the issue/PR author — the "which sessions ever hit the cap and how much did they cost" history.

`sessions` is the **full cost distribution** (not just the tripped tail): per group with any priced session it reports `{sessions, total_usd, p50, p90, p95, max}` over that group's `cost>0` sessions, sorted by total spend. Percentiles use the nearest-rank method — the same one the host uses for its p90 cap auto-sourcing — so a `p95` you read here is a real observed session cost you can hand straight to `set-ceiling`. Reads the dashboard's priced-cost API, so the dashboard must be installed/running. `--period` accepts `1d|7d|30d|all`.

`coworkers` is the **exact** inference $ per coworker — the litellm per-request cost the OneCLI gateway records into `request_logs`, rolled up by agent group (covers Claude + Codex, both route through the gateway). Where `sessions` gives the token-based priced-cost *distribution* (an estimate, from the dashboard), `coworkers` is the billing system's own number, date-correct. It needs the gateway capture flag (`ONECLI_CAPTURE_RESPONSE_HEADERS`) + `ONECLI_PG_CONTAINER`, and reports `configured:false` when either is unwired. The read runs host-side only — a global-scope caller gets the numbers back, never OneCLI DB access. `--period` accepts `<n>d`/`<n>h` (e.g. `30d`, `24h`; default all-time).

### Resolving cost escalations

`continue`, `stop`, and `set-ceiling` resolve an escalation — the elevated ncl equivalents of the dashboard's Continue / Stop / +− ceiling control. Same money-safety as the dashboard: `continue`/`stop` route through the shared decision path (a live pending episode resolves via its at-most-once CAS + epoch fence; otherwise the override is fenced by the session's latest episode epoch, so a duplicate press can't double-grant). `set-ceiling` reads the live epoch itself and submits through the ledger's `UNIQUE(session_id, epoch)` CAS — if the session moved (stale epoch), a card/another request already claimed it, or the runner is too old, it FAILS LOUDLY instead of over-raising.

```bash
ncl cost-cap continue --session <sid>              # resume a session stopped at its ceiling (raise by one allotment)
ncl cost-cap stop --session <sid>                  # quiesce a running, non-immortal session (manual kill switch)
ncl cost-cap set-ceiling --session <sid> --ceiling 300   # set an EXACT live Tier-2 ceiling in USD (raise or lower)
```

Typical flow: `stopped` to find a session blocked RIGHT NOW → `sessions --group <folder>` to get that group's p95 → `set-ceiling --session <sid> --ceiling <p95>` (or `continue` for a one-allotment bump). `set-ceiling` is capped at $1000.00 and refuses immortal (admin/main) sessions.

### Cross-group operations

You can act across groups, but only when the user explicitly asks you to act on another group; otherwise default to your own scope.

### Resuming a specific recipient session

When you wake a peer to continue work _another_ chain handed off, routing keys on `(recipient agent group, messaging group, thread id)`. Your wake uses a different messaging group than the chain that dispatched the work, so without intervention the recipient gets a fresh session — no inbox, no context. Use `target_session_id` on `send_message` / `send_file` to pin the wake to the recipient's existing session.

**Discovery flow:**

1. List candidates: `ncl sessions list --agent-group <recipient-group-id>` — note rows with `status=active`.
2. Identify the owning session: `ncl sessions messages <session-id> --limit 30`; look for inbound messages referencing the work (handoff memos, sentinel claims, issue id). Prefer the **oldest** active candidate when several match.
3. Send the wake pinned: `send_message({ to: "<peer>", text: "...", target_session_id: "sess-..." })`.
4. Verify: tail host logs for `a2a target pinned: routing to sender-named session`. `a2a target_session_id: ... falling through` means the id was rejected (closed, wrong group, not found) and a fresh session was minted — re-check the id.

**Don't pin** for first-time delegation, generic status checks, or recipients with one active session (default routing already lands there).

The pin does **not** bypass authorization — you still need a destination row to the recipient. It only chooses which session within an authorized destination.
