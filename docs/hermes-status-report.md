# Hermes port — daily status report

One HTML page, one screen, no scrolling: where the Hermes port stands. Produced
by the **Orchestrator** (`main`) of the `nemoclaw-coworkers` instance, which
invokes the `/hermes-status-report` container skill
(`container/skills/hermes-status-report/`).

## What it contains

Six small cards on a dark palette, modelled on `reports/hermes-port-status.html`:
team + chain (architect → builder → tester → reviewer), milestones as
done/in-flight/queued dots, desktop e2e numbers, the pinned baseline (tag/commit
from `RELEASE_MANIFEST.json` + fork branch), cost posture, next three moves.
Every number is first-party: `ncl sessions|tasks|cost-cap`, the requirements ledger the
merge gate writes (`/workspace/shared/hermes-requirements-ledger.md`, falling back to
`/workspace/agent/reports/hermes-requirements-ledger.md`), the requirements matrix that
supplies the denominator (`/workspace/shared/hermes-requirements.md`, the 61 rows), `gh` on
the fork.

## Where it lands

| Inside the container | On the host |
|---|---|
| `/workspace/agent/reports/status/hermes-status-<YYYY-MM-DD>.html` | `groups/orchestrator/reports/status/hermes-status-<YYYY-MM-DD>.html` |
| `/workspace/agent/reports/status/latest.html` (overwritten each run) | `groups/orchestrator/reports/status/latest.html` |

Both show up in the dashboard's artifacts view. The Orchestrator `send_file`s the dated HTML
to the human's chat — addressed **by destination name**, since a task fire has no session
routing to default to — with a two-line note: the headline, then what changed since
yesterday. The page is the report; the note is the diff.

## How it is scheduled

Scheduling here is `ncl tasks` — the old `schedule_task` MCP surface is gone
(`docs/ncl-tasks-migration.md`). The Orchestrator runs this once from inside its
container, where `--group` is auto-filled:

```bash
ncl tasks create --name "hermes status report" \
  --recurrence "30 8 * * *" \
  --prompt "Produce today's Hermes port status report: run /hermes-status-report, write /workspace/agent/reports/status/hermes-status-<YYYY-MM-DD>.html and refresh latest.html, then send_file the dated HTML to the human's chat destination BY NAME (resolve it with ncl destinations list — a task fire has no session routing, so a bare send fails) with a two-line note: the headline, then what changed since yesterday. Collect the numbers first-party (ncl sessions/tasks/cost-cap, the requirements ledger, /workspace/shared/hermes-requirements.md, RELEASE_MANIFEST.json, gh on slang-coworkers/hermes-agent); if a source is unreachable, say so on the card instead of guessing."
```

Host-side equivalent (`--group` is required off-box):

```bash
./bin/ncl tasks create --group <orchestrator-agent-group-id> \
  --name "hermes status report" --recurrence "30 8 * * *" --prompt "<same prompt>"
```

Notes (verified in `src/cli/resources/tasks.ts`, `src/modules/scheduling/create.ts`):

- **Cron is wall-clock in the group's effective timezone** — `resolveGroupTimezone`
  (group override → install `TZ`, `Asia/Kolkata` on this install). `"30 8 * * *"`
  is 08:30 local; there is no timezone field in the expression. Retime the group
  with `ncl groups config update --id <gid> --timezone <IANA>` if it drifts.
- **Fresh session per fire is inherent** — each series runs in its own per-group
  system session, so there is no `new_session` flag to pass.
- **No `--script` gate**, deliberately: a briefing needs judgement every fire, and
  1 fire/day is under the 4-fires/day ungated limit (`MAX_DAILY_FIRES`).

## Change the time, pause, run once

```bash
ncl tasks list                                   # find the series id (hermes-status-report-<hex>)
ncl tasks get <id>                               # schedule, run count, failures, run log
ncl tasks update <id> --recurrence "0 9 * * *"   # retime (pause → update → resume if update is refused)
ncl tasks pause <id>                             # stop firing (resume with: ncl tasks resume <id>)
ncl tasks run <id>                               # fire once now, schedule untouched
ncl tasks cancel <id>                            # stop for good (prefer over delete)
```

Same flags from the host (prefix `./bin/`) and from the Orchestrator. For an
out-of-band report that leaves the schedule alone, message the Orchestrator:
**"run /hermes-status-report now"**.
