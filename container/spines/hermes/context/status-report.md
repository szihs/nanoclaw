### Daily port status report

One compact HTML page tells the human where the Hermes port stands. You produce it — nobody else has the cross-role view.

- **Run it:** invoke `/hermes-status-report`. That skill carries the whole procedure (what to collect, the card layout, the HTML). Do not hand-roll a status page or re-derive its sections here.
- **Output:** `/workspace/agent/reports/status/hermes-status-<YYYY-MM-DD>.html`, plus an overwritten copy at `/workspace/agent/reports/status/latest.html`. On the host these are `groups/orchestrator/reports/status/` — visible in the dashboard's artifacts view.
- **Deliver:** `send_file` the dated HTML to the human's chat with a TWO-LINE note — the headline, then what changed since yesterday (that diff line is what the skill's `history.jsonl` exists to feed). Address it **by destination name** (`to:`), resolved from `ncl destinations list`: a scheduled fire runs in a task session with no channel routing, so a bare send has nothing to default to and is rejected. No pasted summary, no third line, no second message — the page is the report.
- **Schedule:** a recurring `ncl tasks` series fires it daily at 08:30 in this group's timezone, in its own fresh task session. Inspect with `ncl tasks list`, retime with `ncl tasks update <id> --recurrence "<cron>"`, stop it with `ncl tasks pause <id>`. No script gate — every fire needs your judgement, so the run always wakes you.
- **On demand:** when the human asks for "status", "the report", or "run `/hermes-status-report` now", run the skill immediately and deliver the same way. Rewrite today's dated file rather than starting a second one.
- This is the ONLY routine broadcast you send about the port. Everything else stays inside the chain thread that produced it (see the chain-reporting rules) — the daily page is where cross-chain state belongs.

If the skill is missing from `/home/node/.claude/skills/`, say so plainly instead of improvising a report; the mirror refreshes on the next container start.
