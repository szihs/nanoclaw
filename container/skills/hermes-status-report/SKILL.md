---
name: hermes-status-report
license: MIT
description: One compact HTML briefing per day on the Hermes port — six cards on one screen (team/chain, milestones, the 61 requirement rows, verification health, pinned baseline, cost posture) assembled from read-only ncl / requirements-ledger / requirements-matrix / RELEASE_MANIFEST / gh probes, rendered deterministically by render_status.py, written to reports/status/ and sent to the human's dashboard chat as a file plus a two-line note. Orchestrator-only, read-only, budgeted to under 5 minutes and ~$2. Triggers on "hermes status", "daily hermes briefing", "status report", "where does the port stand".
allowed-tools: Bash(ncl:*), Bash(gh:*), Bash(python3:*), Bash(date:*), Bash(mkdir:*), Bash(cp:*), Bash(ls:*), Bash(cat:*), Bash(head:*), Bash(tail:*), Bash(grep:*), Bash(wc:*), Bash(awk:*), Bash(sed:*), Read, Write, mcp__nanoclaw__send_file, mcp__nanoclaw__send_message
---

# /hermes-status-report — the daily one-screen Hermes briefing

> **Scope:** the **Orchestrator** of the `nemoclaw-coworkers` instance, and nothing else.
> Everything this skill does is **read-only**: it probes `ncl`, a few files, and `gh`, then
> writes exactly three artifacts under `/workspace/agent/reports/status/` and sends one
> message. It never merges, never dispatches work, never edits the ledger, never touches
> the fork. It is the *reporting* counterpart to the merge gate that already lives in your
> always-in-context spine (`merge-gate.md`) — that one decides, this one summarises.

**The product is one screen.** Six small cards, dark palette, coloured dots, short notes
carrying real numbers, no scrolling. A human should be able to open it, spend fifteen
seconds, and know where the port stands before the 61 requirement rows start moving. If
the report needs a scrollbar it has failed; cut notes, not cards.

### Why this is a skill and not a workflow

Your coworker type is `main`, declared `flat: true` in
`container/spines/base/coworker-types.yaml`. `src/claude-composer/resolve.ts` returns early
for a flat type with `workflows: []` and `skills: []`, so a WORKFLOW.md — or a `skills:`
entry naming this skill — attached to `main` would be **silently discarded**: no error, no
red check, no slash command. What *does* reach you is the mirror:
`resolveMirroredSkillScope` fails open for a flat type (`dirs: null` = mirror all), so
`src/group-init.ts` copies **every** `container/skills/<name>/` into
`.claude-shared/skills/`, which the container mounts at `/home/node/.claude/skills/`. That
is why `/hermes-status-report` exists as a command for you, and why the generator sits at:

```
/home/node/.claude/skills/hermes-status-report/render_status.py
```

---

## 0. Budget and guards — read before you run anything

This runs **daily, unattended**. It must be boring and cheap.

| Guard | Rule |
|---|---|
| Wall clock | **Under 5 minutes.** |
| Spend | **~$2.** If `ncl cost-cap status --session $NANOCLAW_SESSION_ID` reads `warn` or worse mid-run, stop collecting and render with what you have. |
| Scope | Every `ncl cost-cap` verb needs `cli_scope=global` (`cost-cap` is not in `GROUP_SCOPE_RESOURCES`). If `ncl cost-cap get` comes back with a **scope denial** rather than a verb failure, the Cost card carries one `bad` row `cost-cap needs cli_scope=global` and this budget guard falls back to the tool-call cap alone. Do not retry the other cost verbs — they will all deny. |
| Tool calls | **Collect in ≤ 15 Bash calls.** Batch related probes into one call with `;` separators. Hit 15 → stop, render, mark the unfinished card. |
| Never | Read a session transcript in full (`--full` is banned here). Run tests, `doctor`, `run_tests.sh`, or any suite. Clone or fetch a repo. Read a diff. Spawn a subagent or a peer dispatch. Run `/codex-critique` — nothing here is a gated action. |
| Bounded reads | Any file read is `head -c 4000` or a `grep -m<N>`, never a whole report. |
| Retries | **One** retry per failing command, then take the fallback and move on. |
| Degrade, don't fail | Every probe in §1 has a fallback. A missing source costs **one card**, never the report. A card built on a failed probe carries a `bad`-state row naming the probe — a silently-omitted card reads as "nothing to say", which is a lie. |

Do not delegate any of this. Judgement is required every fire (which milestone is really
"in flight", what the headline should be), so this is a briefing you write, not a script
that writes itself — hence no `script` gate on the cron in §5.

---

## 1. COLLECT — the probes, each with its fallback

Set the run variables first (one call). **Write them to `.run-env` and `source` that file at
the top of every later block** — do not assume the Bash tool hands you the same shell twice.
An unset `$OUT` in §3 silently renders to an empty path:

```bash
DIR=/workspace/agent/reports/status
mkdir -p "$DIR"
cat > "$DIR/.run-env" <<EOF
DAY=$(date +%F)
DIR=$DIR
SKILL=/home/node/.claude/skills/hermes-status-report
OUT=$DIR/hermes-status-$(date +%F).html
FORK=slang-coworkers/hermes-agent
EOF
. "$DIR/.run-env"; echo "$DAY $OUT"
```

### 1.0 Where the report goes → needed by §4, so resolve it first

A scheduled fire runs in a per-group **system session with no channel routing**, so a bare
`send_file` with no `to` cannot fall back to "the current conversation" — it hits the
multiple-destinations error and the briefing is rendered but never delivered. Name the
destination explicitly, every run — on this install it is the dashboard channel named `orchestrator` (the human's chat; the other destinations are coworker edges):

```bash
ncl destinations list --json
```

Pick the row whose `target_type` is `channel` (the human's chat) — **not** the `agent` rows,
which are the four coworker a2a hops. Its `local_name` is the `to` you pass in §4. If more
than one `channel` row exists, prefer the one the human actually talks to you in (match
`display_name`); append `TO=<local_name>` to `$DIR/.run-env` so §4 cannot lose it.

*Fallback:* no `channel` destination resolves → still render and still write both files, then
say so in the run output (`destination unresolved — <path> written, not delivered`) rather
than dropping the briefing silently. Never guess a destination name.

### 1.1 Pinned baseline → the *Pinned baseline* card

```bash
for f in /workspace/shared/hermes/RELEASE_MANIFEST.json /workspace/extra/hermes-release/RELEASE_MANIFEST.json; do [ -f "$f" ] && python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m["tag"],m["commit"][:7],m.get("previous_tag",""))' "$f" && break; done   # shared copy first: the Orchestrator has no /workspace/extra mount
```

*Fallback:* manifest missing/unreadable → use `v2026.8.31` and add the card note
`manifest unreadable — tag from spine fallback`. Never quote a tag from memory without
saying which source it came from.

### 1.2 The team and who is awake → the *Team / chain* card

```bash
ncl groups list --json ; ncl sessions list --status active --json
```

Match the five roles by group `folder` / `name`: `hermes-architect`, `hermes-builder`,
`hermes-tester`, `hermes-reviewer`, plus yourself. For each, take `container_status` and
`last_active` from the newest session row (`ncl sessions list --agent-group-id <id>
--limit 5 --json` if the unfiltered list is ambiguous).

*Fallback:* `ncl` unreachable → render the chain from the spine's fixed topology
(architect → builder → tester → reviewer → builder → you) and add one `bad` row
`ncl unreachable — liveness unknown`.

### 1.3 The 61 requirement rows → the *61 rows* card

The ledger is the status source; the requirements matrix is the denominator.

Requirement ids come in **four** families — `FR-` functional, `SR-` security/safety, `PR-`
port/parity, `NF-` non-functional (`container/workflows/hermes-spec-requirement/WORKFLOW.md`).
Ids are `<FAMILY>-F<NN>` (RT-F01, ISO-F10, …); a family-specific pattern silently drops rows,
which understates the denominator *and* hides merged work.

```bash
. /workspace/agent/reports/status/.run-env
LEDGER=/workspace/agent/reports/ledger.md                                   # the Orchestrator's work-item ledger (authoritative)
[ -f "$LEDGER" ] || LEDGER=/workspace/shared/hermes-requirements-ledger.md   # architect's requirements ledger
[ -f "$LEDGER" ] || LEDGER=/workspace/agent/reports/hermes-requirements-ledger.md
GAP=/workspace/shared/hermes-requirements.md
[ -f "$GAP" ] || GAP=/workspace/shared/hermes/gap-matrix.md
ls -l "$LEDGER" "$GAP" 2>&1 | head -5
grep -cE '^\| *[A-Z]+-F[0-9]+' "$GAP" 2>/dev/null   # ids are <FAMILY>-F<NN>
```

Then bucket the ledger's **last column** (`status`, the one the merge gate edits in place)
in a single pass. Take `$NF`, and only fall back to `$(NF-1)` when the row ends in a trailing
`|` (which makes `$NF` empty) — a row without one would otherwise be read one column early:

```bash
awk -F'|' 'NF>2 && $2 ~ /[A-Z]+-F[0-9]+/ {                                   # gap-matrix ids are <FAMILY>-F<NN> (RT-F01, ISO-F10, ...)
  s=$NF; if (s ~ /^[ \t]*$/) s=$(NF-1);
  gsub(/^[ \t]+|[ \t]+$/,"",s);
  if (s ~ /^merged/) d++;
  else if (s ~ /^blocked/) b++;
  else if (s == "" || s ~ /^(not started|queued|-)$/) t++;
  else a++;
} END { printf "done=%d active=%d blocked=%d todo=%d\n", d+0, a+0, b+0, t+0 }' "$LEDGER"
```

*Fallbacks, in order:* both denominator paths missing → total `61` with the note
`row source unavailable — 61 from the plan`. Ledger missing **but the denominator parsed** →
this is the normal day-1 shape, not a failure: render `progress {done: 0, active: 0, todo: <N>}`
with the note `ledger not created yet — merge gate has not landed`. Ledger missing **and** the
denominator unknown → then and only then a single `bad` row `ledger not found at either path`
with no progress bar (do **not** invent counts). A ledger whose status column does not parse →
count what parses and note `N rows unparsed`.

### 1.4 Verification health → the *Verification* card

Read only the **headers** of the newest Test Reports you were sent — never a whole report,
never a re-run.

```bash
ls -t /workspace/inbox/*/test-report-*.md 2>/dev/null | head -3
# for the newest one only:
grep -m1 -E '^\*\*Verdict:\*\*' <that-file>
grep -m1 -E 'head [0-9a-f]{7}' <that-file>
grep -cE '^\| *(DOCTOR|ACCEPTANCE|NEGATIVE-CONTROL|RUFF|FOOTGUNS|SUITE T[0-9]+|UI|DESKTOP) ' <that-file>
grep -coE '\| *(PASS|FAIL|SKIPPED) *\|' <that-file>
```

Test reports route builder → tester → **reviewer**, so one may never be attached to a
message *you* received. Expect this probe to come up empty on an unattended run and take
the fallback without treating it as an error.

*Fallback:* no report in `/workspace/inbox/` → read the tail of the **chat** thread. Not
`$NANOCLAW_SESSION_ID`: under `ncl tasks` a fire runs in a per-group *system* session
(`system:tasks:…`) that contains only the task prompt — no `[Test Report]`, no
`[Review Verdict]`. Resolve the chat session first, then read it (`sessions messages` is
cross-session for a `cli_scope=global` caller; this is the **only** sanctioned
`sessions messages` call in this skill, and it is deliberately not `--full`):

```bash
ncl sessions list --agent-group-id <your own group id> --status active --limit 5 --json
# take the newest session whose id does NOT start with system:tasks: —
ncl sessions messages <that session id> --limit 40 --reverse --json \
  | grep -oE '\[(Test Report|Review Verdict|Fix Report|Spec handoff)\][^"]{0,110}' | head -5
```

Still nothing → one `todo` row `no test report since <date of last one you know>`.

### 1.5 Fork state → feeds the *Milestones* card

Three `gh` calls, no more. `gh` works because OneCLI injects the credential.

```bash
TAG=<from 1.1>
gh pr list --repo "$FORK" --state open --limit 20 \
  --json number,title,isDraft,baseRefName,updatedAt
# the branch name contains a slash, so use the git/ref form — `branches/<name>` would
# split `release/…` across two path segments and 404
gh api "repos/$FORK/git/ref/heads/release/$TAG-e2e-fixed" --jq .ref
gh pr list --repo "$FORK" --state merged --limit 10 \
  --json number,title,mergedAt
```

*Fallback:* any `gh` failure (auth wall, rate limit, `api.github.com` unreachable) — retry
**once**, then a `bad` row `gh unavailable — PR state as of <yesterday's history line>`
built from `history.jsonl` (§1.8). Do not fall back to `git`; there is no clone budget here.

### 1.6 Cost posture → the *Cost* card

```bash
ncl cost-cap get --json
ncl cost-cap escalations --limit 20 --json
ncl cost-cap coworkers --period 24h --json
```

`get` gives the fleet ceiling plus every per-group override (the $150 cap/ceiling per
coworker). `escalations` is the tripped tail — count by `state`, and call out anything
`pending` or `stopped` **by coworker**, because a stopped coworker is a stalled chain.
`coworkers` is the gateway's exact per-request billing rolled up per group.

All four `cost-cap` verbs are **elevated** — they need `cli_scope=global` (see §0). A
`group`-scoped Orchestrator loses this entire card.

*Fallbacks:* a **scope denial** on `get` → the whole card is one `bad` row
`cost-cap needs cli_scope=global`; skip the other two verbs. `coworkers` returns
`configured:false` (capture flag unset) → drop that row, keep cap/ceiling/escalations, note
`per-coworker $ unavailable (gateway capture off)`. `escalations`/`get` failing for any
other reason → `bad` row naming the verb; never guess a dollar figure.

### 1.7 Scheduled work → one *Milestones* row

```bash
ncl tasks list --all --json
```

Surface only: this report's own task (is it still scheduled?) and any task in
`failed`/`paused` state. *Fallback:* skip the row.

### 1.8 Yesterday, for the "what changed" line

```bash
tail -1 /workspace/agent/reports/status/history.jsonl 2>/dev/null
```

*Fallback:* no file (first run) → the delivery message in §4 says `first briefing` instead
of a diff. Never fabricate a delta.

---

## 2. DERIVE — six cards and one headline

Exactly six cards, in this order. Every note must carry a **real number or a real
identifier** — a note with no number is filler; delete it.

| # | Card `title` | `kind` | What goes in it |
|---|---|---|---|
| 1 | `The team` | `chain` | The routing topology as 3–4 monospace lines (`Orchestrator → architect → builder`, `→ tester → reviewer`, `← fixes loop back (max 2)`). Note: which roles are awake right now and the count, from §1.2 — e.g. `5 wired · tester + builder running, 3 idle · forced A2A, critique gates on`. |
| 2 | `Milestones` | `rows` | 8–10 rows max, newest-relevant first. `ok` = landed (merged PR, closed milestone), `run` = in flight now (open non-draft PR, a live chain), `todo` = queued, `bad` = a real blocker. Each `note` is the short state (`merged`, `r2 running`, `queued`, `blocked P3`). Sources: §1.5 PRs, §1.7 tasks, your own ledger reading. |
| 3 | `61 requirement rows` | `progress` | `progress: {done, active, todo}` straight from §1.3 (fold `blocked` into `active` only if you also add a `bad` row naming the blocked ids). Note: the ledger path you actually read and the newest merged req-id — `ledger /workspace/shared/… · last merged FR-3 (sha 1a2b3c4)`. |
| 4 | `Verification` | `metric` | `metric: {value, label}` = the gate everyone trusts (`12 / 12`, `smoke — reliable gate`), plus 1–3 `rows` for the fuller picture (`Full suite`, `44 pass / 17 fail / 13 skip`; `DESKTOP`, `SKIPPED — install_packages`). Note: which head SHA the numbers are from and whether they came from one run or were assembled — say so if assembled. |
| 5 | `Pinned baseline` | `chain` | 3–4 lines from §1.1 + §1.5: `release tree  <tag> (read-only mount)`, `fork branch   release/<tag>-e2e-fixed`, `commit        <sha7>`. Note: whether the base branch resolved on the fork, and that PRs target the baseline, not fork `main`. |
| 6 | `Cost posture` | `rows` | Dot-less rows (`text` + `note`, no `state`) exactly like the reference: `Cap / ceiling per coworker` → `$150`; `Escalations pending` → count; `Spend last 24h` → `$N` from §1.6; `Costliest coworker` → `<folder> $N`. Use a `bad` state **only** for a stopped/pending escalation, since that one blocks a chain. |

**The headline** is one sentence, ≤ 140 characters, and it must answer *"do I need to do
anything today?"*. Lead with the blocker if there is one. It carries at least one number.

- Good: `Round 5 running; 4/61 rows merged, PR #12 waiting on P3 (tester FAIL at 9a1c2d4).`
- Good: `Nothing blocked — 6/61 merged, 2 chains in flight, $84 spent in 24h, no escalations.`
- Bad: `Work continues on the Hermes port.` (no number, no decision)

Ordering rule: if any card would be built entirely from fallbacks, keep the card, keep its
position, and put the `bad` row first inside it.

---

## 3. RENDER — build JSON, call the generator

**Do not hand-write HTML.** The layout is the contract; you supply facts. Write the payload
with the Write tool (so quoting is not a shell problem), then run the generator.

```bash
. /workspace/agent/reports/status/.run-env
python3 "$SKILL/render_status.py" "$OUT" < "$DIR/payload-$DAY.json"
```

Payload shape (`render_status.py`'s module docstring is the authority; every field except
`cards` is optional):

```json
{
  "generated_at": "2026-09-07T05:12:00Z",
  "title": "Hermes port · nemoclaw-coworkers",
  "subtitle": "7 Sep 2026 · box slang-cpu-coworkers · dashboard :3937",
  "headline": "Round 5 running; 4/61 rows merged, PR #12 waiting on P3 (tester FAIL at 9a1c2d4).",
  "cards": [
    { "title": "The team", "kind": "chain",
      "chain": ["Orchestrator → architect → builder", "              → tester → reviewer"],
      "note": "5 wired · tester + builder running · forced A2A, critique gates on" },
    { "title": "Milestones", "kind": "rows",
      "rows": [ { "state": "ok", "text": "hermes-tester role · PR #1425", "note": "merged" },
                { "state": "run", "text": "Round 5 · one clean full suite", "note": "running" },
                { "state": "todo", "text": "P2 · T1–T12 fixtures", "note": "queued" } ] },
    { "title": "61 requirement rows", "kind": "progress",
      "progress": { "done": 4, "active": 2, "todo": 55 },
      "note": "ledger /workspace/shared/… · last merged FR-3 (1a2b3c4)" },
    { "title": "Verification", "kind": "metric",
      "metric": { "value": "12 / 12", "label": "smoke — reliable gate" },
      "rows": [ { "text": "Full suite", "note": "44 pass / 17 fail / 13 skip" } ],
      "note": "head 9a1c2d4 · one serialized run, JSON reporter" },
    { "title": "Pinned baseline", "kind": "chain",
      "chain": ["release tree  v2026.8.31 (read-only mount)",
                "fork branch   release/v2026.8.31-e2e-fixed"],
      "note": "PRs target the baseline, never fork main." },
    { "title": "Cost posture", "kind": "rows",
      "rows": [ { "text": "Cap / ceiling per coworker", "note": "$150" },
                { "text": "Escalations pending", "note": "0" },
                { "text": "Spend last 24h", "note": "$84" } ] }
  ]
}
```

Contract notes worth knowing before you build the dict:

- `kind` must be one of `rows` | `chain` | `metric` | `progress`. Anything else renders as
  an HTML comment and **the card vanishes** — check your spelling.
- Row `state` must be `ok` | `run` | `todo` | `bad`. Omit `state` for a plain label/value
  row (that is how the cost card gets its dot-less look).
- Every string is HTML-escaped by the generator, so put raw text in the JSON — never
  entities, never tags. `→` and `←` inside `chain` get the accent colour automatically.
- A card may carry more than its `kind`'s element (a `metric` card can also carry `rows`
  and a `note`); the `kind` only picks what renders first.
- Missing fields are omitted, not errors. Junk counts in `progress` floor to 0.

Sanity-check before delivering — the generator prints the card count to stderr, and the
file must be small enough to be one screen:

```bash
. /workspace/agent/reports/status/.run-env
grep -c '<div class="card">' "$OUT"     # must be 6
wc -c "$OUT"                            # ~6–12 KB; > 40 KB means you wrote an essay
```

If the count is not 6, a `kind` was misspelled or a card raised — fix the payload and
re-run the generator. Do not patch the HTML.

---

## 4. DELIVER — dated file, stable copy, one short message, one history line

```bash
. /workspace/agent/reports/status/.run-env
cp "$OUT" "$DIR/latest.html"
```

Host-side these land in `groups/orchestrator/reports/status/`, readable from the
dashboard's artifacts view.

Then **one** `send_file` to the human's dashboard chat with a **≤ 2-line** message —
UNMARKED plain text (this is a fresh send with no inbound to answer, and the always-on
chain-routing gate denies a marker-prefixed send that carries no `in_reply_to`).

**`to` is mandatory here.** Pass the `local_name` you resolved in §1.0. Omitting it works
only when a human asked for the report in chat; on a cron fire the session has no routing
and the send fails with `You have multiple destinations — specify "to"`, so the report is
rendered and never seen:

```
mcp__nanoclaw__send_file({
  to: "<the channel destination's local_name from §1.0>",
  path: "/workspace/agent/reports/status/hermes-status-<DAY>.html",
  text: "<the headline sentence>\nSince yesterday: <what moved, with numbers — or 'first briefing'>."
})
```

If §1.0 resolved no `channel` destination, do **not** retry with a guessed name and do not
drop the briefing: both files are already written, so report the path in your run output and
say the delivery failed.

Line 2 is the diff against `history.jsonl`'s last line: rows merged, PRs opened/merged,
escalations opened/closed, suite delta. If literally nothing moved, say
`Since yesterday: no change.` — that is useful information, not a reason to skip the send.
No play-by-play, no list of the commands you ran, no third line.

Then append **one** line for tomorrow's diff (append, never rewrite the file):

Values that were unavailable go in as the literal string `null`, not as a guess — the `n()`
coercer below turns it into JSON `null`. Without it, a bare `int("null")` raises `ValueError`
and the append is lost, which silently leaves tomorrow's "since yesterday" diff with no
baseline. A field you had to fall back on must not read like a measurement.

```bash
. /workspace/agent/reports/status/.run-env
python3 -c 'import json,sys
n=lambda s,c: None if s=="null" else c(s)
print(json.dumps({
  "day": sys.argv[1], "headline": sys.argv[2],
  "rows": {"done": n(sys.argv[3],int), "active": n(sys.argv[4],int), "todo": n(sys.argv[5],int)},
  "open_prs": n(sys.argv[6],int), "escalations_pending": n(sys.argv[7],int),
  "tag": sys.argv[8], "spend_24h_usd": n(sys.argv[9],float)
}))' "$DAY" "<headline>" 4 2 55 1 0 v2026.8.31 84.0 >> "$DIR/history.jsonl"
```

---

## 5. Run it daily — the cron

Scheduling is `ncl tasks`. The old `schedule_task` / `list_tasks` / `update_task` MCP tools
**do not exist** (`docs/ncl-tasks-migration.md`); calling one is acknowledged in-container and
then dropped by the host as `Unknown system action`, so the task looks scheduled and never
fires. There is likewise no `new_session` flag to pass — a fresh session per fire is
**inherent**: each series runs in its own per-group system session.

A briefing needs judgement every fire, so **no `--script` gate** (a gate is for tasks that
are usually a no-op; this one always has something to say, even if that something is "no
change"), and 1 fire/day is well under the ungated `MAX_DAILY_FIRES` limit.

> **CODE-ONLY NOTE:** an operator applies this **once**, after approval. Registering the
> series is not part of a daily run — a fire that re-registers gives you two series.

Run from inside your container, where `--group` auto-fills:

```bash
ncl tasks create --name "hermes status report" \
  --recurrence "30 8 * * *" \
  --prompt "DAILY HERMES BRIEFING. Load /hermes-status-report and follow it end to end: resolve the human's channel destination with ncl destinations list, collect the read-only probes (ncl groups/sessions/tasks/cost-cap, the requirements ledger + denominator, RELEASE_MANIFEST.json, the newest test-report header in /workspace/inbox, gh open+merged PRs on slang-coworkers/hermes-agent), derive the six cards and ONE headline, build the JSON payload and render it with render_status.py, then send_file the HTML to that destination BY NAME with a two-line note (headline + what changed since yesterday) and append one line to reports/status/history.jsonl. Budget: under 5 minutes and ~\$2 — no full transcripts, no test runs, no clones. Any probe that fails takes its documented fallback and the affected card carries a bad-state row naming the probe; never skip a card silently and never invent a number."
```

From the host, `--group <orchestrator-agent-group-id>` is required.

Cron is wall-clock in the group's effective timezone; there is no timezone field in the
expression. `30 8 * * *` puts it in the human's inbox before the day starts. Manage it with:

```bash
ncl tasks list                                   # is the series still registered?
ncl tasks get <id>                               # schedule, run count, failures, run log
ncl tasks update <id> --recurrence "0 9 * * *"   # retime (pause → update → resume if refused)
```

Retime rather than cancel+recreate. If a previous fire failed, fix the cause — do not
schedule a second series.

---

## Notes / limits

- **Read-only by construction.** The only writes are `reports/status/hermes-status-<day>.html`,
  `latest.html`, `payload-<day>.json`, the scratch `.run-env`, and one appended line of
  `history.jsonl`. Nothing
  under `/workspace/shared`, the fork, or another group is touched — the ledger is written
  by the merge gate, never by the briefing.
- **Idempotent within a day.** Re-running overwrites the dated file and `latest.html`. It
  also appends a second `history.jsonl` line; that is intentional (the diff reads only the
  last line) but do not re-run casually — each run costs the daily budget again.
- **The generator is the layout's source of truth.** Change the palette or the card grid in
  `render_status.py`, not in a payload; `test_render_status.py` pins the contract
  (escaping, unknown-kind skip, missing-field tolerance) and must stay green:
  `python3 -m unittest discover -s container/skills/hermes-status-report -p 'test_*.py' -v`.
- **Fallbacks are visible, not silent.** The rule this skill exists to enforce: a briefing
  that quietly drops a card teaches the reader to trust a report that is missing the one
  fact they needed. A `bad` row naming the dead probe costs one line and keeps the report
  honest.
