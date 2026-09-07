# NanoClaw Daily Changelog (nv-* branches)

Auto-generated daily rollup of merged PRs across the five upstream branches that feed `nv-coworkers` via the merge train. For semver release notes, see [CHANGELOG.md](CHANGELOG.md).

For architectural context — spines, workflows, overlays, traits, bindings (the lego coworker composition system most of these PRs touch) — see [docs/lego-coworker-workflows.md](https://github.com/slang-coworkers/nanoclaw/blob/nv-main/docs/lego-coworker-workflows.md).

| Branch | Scope | Total merged |
|---|---|---:|
| `nv-main` | Host process, composer, base spines/workflows, CI | 545 |
| `nv-dashboard` | Pixel Office dashboard (standalone) | 238 |
| `nv-slang` | slang project spine, skills, workflows | 146 |
| `nv-slangpy` | slangpy project spine, skills, workflows | 77 |
| `nv-nanoclaw` | nanoclaw self-hosted project spine, skills, workflows | 56 |

Cap: ≤10 bullets per branch per day; on busy days, related PRs are grouped or remaining ones are summarized as a tail line. Entry shape: `**#NNN** title`. Today's section uses richer bullets with one-line context per PR. Dates in Asia/Kolkata (IST), newest first.

<!-- BEGIN AUTO -->

## 📅 2026-09-07

### nv-main (1 PRs)
- **#1448** `codex-critique: convergent review rounds — every must-fix carries an applicable fix`

## 📅 2026-09-04

### nv-main (1 PRs)
- **#1438** `Sync nv-main with upstream/main`

### nv-dashboard (1 PRs)
- **#1429** `Sync nv-dashboard with upstream/main`

### nv-slang (1 PRs)
- **#1430** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#1431** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#1432** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-09-03

### nv-main (7 PRs)
- **#1417** `Sync nv-main with upstream/main`
- **#1423** `fix(pr-guard): exempt *.patch from the whitespace/EOF check`
- **#1427** `ops(onecli): body usage tap — per-request token usage for STREAMED responses (fixes $0 cost capture)`
- **#1415** `composer: make the composed-document boundary a real seam (step 7)`
- **#1433** `feat(cost-cap): price coworkers from gateway body usage; UNKNOWN (never $0) for rows without usage`
- **#1434** `` feat(cost-cap): `history` verb — per-coworker cost over arbitrary date ranges (+ MCP cost_history) ``
- **#1436** `feat(cost-cap): v1 = transcript cost of record; gate OneCLI + ledger behind NANOCLAW_COST_V2`

### nv-dashboard (5 PRs)
- **#1424** `fix(dashboard): hide paused coworkers from the Sessions coworker dropdown`
- **#1426** `fix(dashboard): add the paused column to the /api/sessions test fixtures`
- **#1419** `Sync nv-dashboard with upstream/main`
- **#1435** `fix(dashboard): Sessions header shows total · attributed · skills/unattributed (Overview/Sessions cost mismatch)`
- **#1437** `feat(dashboard): /api/cost-history — per-coworker cost of record over arbitrary date ranges`

### nv-slang (1 PRs)
- **#1420** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#1421** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#1422** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-09-02

### nv-main (5 PRs)
- **#1406** `feat(cost-cap): coworkers verb — exact per-coworker $ from the OneCLI…`
- **#1407** `feat(supervise-issues): enrich cost-escalation notice with session-id + dashboard deep-link`
- **#1409** `feat(cost): cost_reconcile — set live enforcement spend to the transcript oracle (#1327)`
- **#1411** `feat(cost): ncl cost-cap reconcile --force — escape the #1327 card-decided deadlock`
- **#1412** `feat(cost-cap): live "currently-stopped" view — consistent across ncl, coworker-MCP, dashboard`

## 📅 2026-09-01

### nv-main (8 PRs)
- **#1396** `supervise-issues: raise worktree-GC pressure gate 25→150 GB (pooled-disk safety)`
- **#1398** `ops(metrics): restore the influx push pipeline + add cost metrics/panels`
- **#1399** `fix(runner): publish set-ceiling protocolVersion in the cost_cap blob`
- **#1401** `` feat(cost-cap): `ncl cost-cap escalations` — per-session cost + state list ``
- **#1400** `ops(launchable): add prod host-move tooling + crontab restore`
- **#1402** `feat(scripts): coworker-mcp — MCP server to talk to coworkers + inspect cost`
- **#1403** `ops(onecli): capture per-request cost into request_logs (cost-per-coworker input)`
- **#1404** `feat(cost-cap): coworker verbs — sessions distribution + escalation resolution`

## 📅 2026-08-31

### nv-main (3 PRs)
- **#1386** `fix(setup): make --step provider-auth codex work on this fork's tree`
- **#1393** `fix(drivers): route proxy-stub creds via contributedEnv so agent wakes pass the secret-shaped-env guardrail`
- **#1395** `fix(funnel): await initDb() so the funnel snapshot regenerates`

### nv-dashboard (3 PRs)
- **#1389** `Sync nv-dashboard with upstream/main`
- **#1385** `fix(dashboard): codex cache-read tokens read as 0 on ccusage 20.x (+ UTC day key)`
- **#1394** `fix(dashboard): filter running containers by nanoclaw-install label, not name prefix`

### nv-slang (1 PRs)
- **#1390** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#1391** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#1392** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-08-30

### nv-main (4 PRs)
- **#1378** `feat(setup): offer Dashboard at the channel step, pre-selected, merging nv-dashboard`
- **#1382** `test(cost): behavioral cost-accounting scenarios (gating, model-switch, restart, /clear, /compact)`
- **#1379** `sync: upstream/main 858421af into nv-main (42 commits, 19 conflicts resolved)`
- **#1384** `feat(cost): runner↔dashboard↔ccusage parity harness (#1375)`

### nv-dashboard (2 PRs)
- **#1366** `Sync nv-dashboard with upstream/main`
- **#1383** `feat(dashboard): period cost column + lifetime/ceiling cost-cap pill (#1334)`

### nv-slang (1 PRs)
- **#1367** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#1368** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#1369** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-08-28

### nv-main (8 PRs)
- **#1344** `Cap the composed document at 4 MiB, refusing rather than degrading`
- **#1345** `Emit per-MCP-server instructions into composed documents (GAP-4)`
- **#1346** `Sync nv-main with upstream/main`
- **#1336** `fix(cost-cap): stop transcript-retention data loss (cleanupPeriodDays unset)`
- **#1329** `fix(cost-cap): count Claude spend per message, and enforce codex tool spend`
- **#1361** `fix(cost): match runner codex normalizer to dashboard; harden + prune owners`
- **#1359** `feat(cost): durable per-session cost ledger — DUAL-RUN (#65)`
- **#1360** `fix(cost-cap): meter native-codex sessions (#1333/#1302)`

### nv-dashboard (3 PRs)
- **#1348** `Sync nv-dashboard with upstream/main`
- **#1355** `Sync nv-dashboard with upstream/main`
- **#1362** `fix(cost): align dashboard codex table with runner + harden drift guard`

### nv-slang (2 PRs)
- **#1349** `Sync nv-slang with upstream/main`
- **#1356** `Sync nv-slang with upstream/main`

### nv-slangpy (2 PRs)
- **#1350** `Sync nv-slangpy with upstream/main`
- **#1357** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (2 PRs)
- **#1351** `Sync nv-nanoclaw with upstream/main`
- **#1358** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-08-27

### nv-main (17 PRs)
- **#1326** `feat(agent-runner): archive conversations for every provider, not just Claude`
- **#1328** `fix: mark composed documents so CLAUDE.md is never mistaken for a persona`
- **#1331** `fix(memory): deliver memory to every provider, not just Claude`
- **#1335** `fix(compose): publish the composed CLAUDE.md atomically`
- **#1337** `fix(skills): restore the onecli-gateway container skill`
- **#1338** `refactor(compose): render the composed document through one seam`
- **#1339** `Wire the dead Claude memory-settings migration into /migrate-memory`
- **#1340** `Emit the runtime contract into composed documents (GAP-1)`
- **#1341** `Don't remove a group's only document before composing its replacement`
_+8 more: #1325, #1324, #1323, #1322, #1315, #1313, #1311, #1310_

### nv-dashboard (4 PRs)
- **#1138** `Sync nv-dashboard with upstream/main`
- **#1317** `Sync nv-dashboard with upstream/main`
- **#1330** `fix(dashboard): attribute subagent transcript cost to the parent session`
- **#1332** `feat(dashboard): count codex spend in the per-session cost column`

### nv-slang (2 PRs)
- **#1139** `Sync nv-slang with upstream/main`
- **#1318** `Sync nv-slang with upstream/main`

### nv-slangpy (2 PRs)
- **#1140** `Sync nv-slangpy with upstream/main`
- **#1319** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (2 PRs)
- **#1141** `Sync nv-nanoclaw with upstream/main`
- **#1320** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-08-26

### nv-main (11 PRs)
- **#1296** `test: clear nv-main's known test failures (4 of 6 red files)`
- **#1297** `refactor: one shared read-only /app/src, retiring the per-group runner copy`
- **#1301** `fix: await closeDb() — an unawaited teardown leaked the DB into the next test`
- **#1304** `fix(container-tests): unmask the container suite — 30 tests that never ran, and the ratchet they hid`
- **#1305** `fix(mailbox): refuse to open the live session DBs from a test process`
- **#1306** `Sync nv-main with upstream/main (28 commits, through f7376aa9)`
- **#1307** `fix(compose): converge standing instructions on instructions.prepend.md`
- **#1308** `test(mailbox): enumerate host outbound.db writers instead of naming five files`
- **#1309** `fix(channels): make the dashboard barrel import optional, not branch-broken`
- _+2 more: #1295, #1291_

### nv-dashboard (2 PRs)
- **#1293** `dashboard: live per-session cost-ceiling control (set-ceiling-v2)`
- **#1294** `fix(dashboard): port the dashboard's DB migrations to the async central-DB API`

### nv-slang (1 PRs)
- **#1298** `ci(nv-slang): adopt nv-main's ci.yml — a stale workflow cannot compose its replacement`

### nv-slangpy (1 PRs)
- **#1299** `ci(nv-slangpy): adopt nv-main's ci.yml — a stale workflow cannot compose its replacement`

### nv-nanoclaw (1 PRs)
- **#1300** `ci(nv-nanoclaw): adopt nv-main's ci.yml — a stale workflow cannot compose its replacement`

## 📅 2026-08-25

### nv-main (4 PRs)
- **#1279** `feat(supervise-issues): recognize cost-stopped sessions, skip the nudge`
- **#1281** `fix(agent-route): attachment presence overrides echo-drop classification`
- **#1284** `docs(claude-trace): document reverse-proxy.js's untraced patch gap`
- **#1285** `Add pi (pi.dev) as a fourth agent provider`

### nv-dashboard (4 PRs)
- **#1278** `feat(dashboard): split pending approvals into their own tab`
- **#1280** `dashboard: PR/issue badge + filer on the Sessions table`
- **#1283** `dashboard: coworker filter dropdown on the Sessions tab`
- **#1286** `fix(dashboard): Sessions coworker-filter dropdown unreadable in light mode`

## 📅 2026-08-24

### nv-main (3 PRs)
- **#1268** `cost-approval: card the ceiling only, fix missing approve handler`
- **#1271** `fix(claude-trace): stop dropping bytes when a UTF-8 char spans TCP chunks`
- **#1273** `gh-thread-origin: capture who filed a GitHub issue/PR behind a session`

### nv-dashboard (1 PRs)
- **#1269** `dashboard: Sessions pill — p99 color, stopped is the only actionable state`

### nv-slang (1 PRs)
- **#1270** `fix(slang-workflows): repoint stale Reports heading reference`

## 📅 2026-08-21

### nv-dashboard (1 PRs)
- **#1261** `dashboard: cost-decision card shows spend/cap + session (not a bare title)`

## 📅 2026-08-20

### nv-main (2 PRs)
- **#1258** `cost-approval escalation card (Option 2) — money-safe, behind COST_APPROVAL_CARD flag`
- **#1259** `cost-approval: official approval card (dashboard-native), -377 lines`

### nv-dashboard (1 PRs)
- **#1260** `dashboard: cost-status filter (Needs decision / Escalated / Stopped) on Sessions tab`

## 📅 2026-08-19

### nv-main (8 PRs)
- **#1239** `funnel: emit approverWeekly trend for the Verity panel (producer)`
- **#1238** `` feat(cost-cap): runtime-configurable Tier-2 cost cap via `ncl cost-cap` ``
- **#1242** `feat(funnel): collect human-review rounds per PR, bot vs human, over time`
- **#1245** `feat(runaway): enrich runaway approval card with cost + session id`
- **#1247** `fix(funnel): stop regression-quality losing the shared REST rate-limit race`
- **#1249** `feat(review-rounds): headline the review-CYCLE metric, align producer with the slide`
- **#1251** `funnel: extend Verity WoW trend across legacy (pre-ledger) history`
- **#1254** `docs: refresh slang-coworkers-prod scheduled-task snapshot (26→51)`

### nv-dashboard (9 PRs)
- **#1241** `dashboard: weekly agreement trend chart for the Verity panel (renderer)`
- **#1243** `feat(nv-dashboard): review-rounds panel — human review rounds per PR, bot vs human`
- **#1240** `perf(nv-dashboard): serve scheduled-task counts from a memoized snapshot (kill the per-request session-DB scan)`
- **#1246** `dashboard: show cost + session link on the runaway approval card`
- **#1248** `fix(dashboard): render regression-quality errors as text, not [object Object]`
- **#1250** `feat(nv-dashboard): plot review CYCLES, align the panel to the slide`
- **#1252** `dashboard: extend Verity WoW approver panel with legacy (unverified) history`
- **#1253** `perf(nv-dashboard): dash-perf round 2 — scan worker, delta broadcast, trace index`
- **#1255** `fix(nv-dashboard): dash-perf r2 follow-ups — overflow-epoch recovery, reconnect floor, SSE listener cleanup`

## 📅 2026-08-18

### nv-main (5 PRs)
- **#1225** `fix(container): add apt.llvm.org for per-group clang-format-17`
- **#1227** `test(guard): make conformance empty-allowlist test hermetic vs on-disk .env`
- **#1231** `harden(merge-train): opt-in --reconcile-stale for deeply-stale prod deploys`
- **#1230** `feat(cost-cap): two-tier per-group p90 + hard $150 ceiling`
- **#1233** `fix(funnel): count merged PRs by App bot across all repos since Apr 10`

### nv-dashboard (3 PRs)
- **#1226** `feat(dashboard): per-group p90 map for cost-thresholds.json`
- **#1232** `perf(nv-dashboard): persist per-file cost cache for warm restarts (+robustness)`
- **#1234** `feat(nv-dashboard): bot-contributions panel shows merged/total PRs`

## 📅 2026-08-17

### nv-main (10 PRs)
- **#1208** `fix(spine): point coworker memory at the OKF memory/ tree (not CLAUDE.local.md)`
- **#1209** `ops(claude-trace): upstream refresh-claude-trace-www.sh + symlink fix`
- **#1210** `fix(group-init): lean harness default — disableWorkflows (mirror merged upstream #3031)`
- **#1211** `fix(#14): retire ABSTAIN_INFRA — fold into ABSTAIN_POLICY + reason_code (enum)`
- **#1216** `feat(nv-main): per-session cost cap + escalation (LEAN v1) — runner + host`
- **#1218** `feat(nv-main): per-group OKF memory synthesis skill + no-backlog cron pattern (#15, code only)`
- **#1219** `feat(nv-main): per-coworker wire-mix Grafana panel (#4)`
- **#1220** `feat(nv-main): daily costliest-session digest skill (Tier 5, code only)`
- **#1221** `feat(nv-main): preamble trim — Tier 0 mislabels + Tier 1 native-tool strip + Tier 2 per-type skills scoping + Tier 3 chain-reporting (4 invariants)`
- **#1222** `fix(nv-main): force codex critique sandbox=danger-full-access (rewrite, not deny)`

### nv-dashboard (6 PRs)
- **#1203** `revert(dashboard): remove Overview cost-at-a-glance cards (#1200)`
- **#1204** `feat(dashboard): cost-per-session percentiles (p50/p75/p90/p99/max) on Sessions tab`
- **#1205** `fix(dashboard): accurate 30d session cost (uncap scan + drop false unpriced flag)`
- **#1206** `feat(dashboard): transcript link per Sessions row (env-gated)`
- **#1214** `fix(#14): retire ABSTAIN_INFRA from dashboard display (tolerant fallback)`
- **#1217** `feat(nv-dashboard): Sessions cost-cap column + continue/stop override`

### nv-slang (1 PRs)
- **#1212** `fix(#14): retire ABSTAIN_INFRA in slang approver prose/scripts`

### nv-slangpy (1 PRs)
- **#1213** `fix(#14): retire ABSTAIN_INFRA in slangpy approver prose/scripts`

## 📅 2026-08-14

### nv-main (2 PRs)
- **#1198** `feat(nv-main): agent_groups.paused operator kill switch`
- **#1199** `docs(supervise-issues): R10 — never schedule a per-issue cron`

### nv-dashboard (2 PRs)
- **#1200** `feat(dashboard): cost at a glance on the Admin Overview`
- **#1201** `feat(dashboard): per-session cost column + sort on the Sessions tab`

## 📅 2026-08-11

### nv-main (2 PRs)
- **#1187** `ops: put the Grafana stack in git; stop it reporting stale numbers as current`
- **#1188** `nv-path-guard: nv-main owns ops/`

### nv-dashboard (1 PRs)
- **#1189** `dashboard: price opus-5 — cost was understated 52x`

## 📅 2026-08-10

### nv-main (21 PRs)
- **#1179** `ci: pin every third-party action to a SHA (15 refs across 6 workflows)`
- **#1178** `fix(ci-gate): drop --jq, which gh refuses alongside --slurp (4,964 silent probe failures)`
- **#1176** `chore: finish F15 follow-ups — slang-mcp's python job on nv-main, plus a lint gate for nv-main's own python`
- **#1175** `chore: typecheck tranche 4 — clear remaining src errors`
- **#1174** `docs: refresh the slang-coworkers-prod scheduled-task snapshot (13 -> 27 series)`
- **#1173** `ci: run dump-scheduled-tasks --check on committed snapshots`
- **#1171** `pr-mapping: first-claim-wins, so a PR's webhooks cannot be captured`
- **#1170** ``staleness: accept pnpm's `--`, and stop reporting a crash as a finding``
- **#1168** ``mcp allow-list: only an explicit `ncl` list may change a group's scope``
- _+12 more: #1167, #1166, #1165, #1164, #1162, #1161, #1160, #1159, #1158, #1157, #1154, #1151_

### nv-dashboard (5 PRs)
- **#1169** `dashboard: a drift report we cannot fully understand is unavailable, never zero (F05)`
- **#1172** `dashboard: render the KB doctor report, which nothing has ever displayed`
- **#1180** `dashboard: unit cost — triager+fixer+reviewer spend per PR opened, by week`
- **#1181** `dashboard: open the DB lazily in /api/unit-cost`
- **#1182** `dashboard: match unit-cost groups by folder + stop duplicating funnel panels`

### nv-slang (3 PRs)
- **#1163** `discord: settle reply capacity by reservation id, and stop refunding on age (F15)`
- **#1177** `fix(slang-mcp): clear the 15 pre-existing ruff errors and wire the gate (F15 follow-up)`
- **#1183** `test(slang-mcp): cover the blob-sha lookup that create_or_update_file silently lost`

### nv-nanoclaw (1 PRs)
- **#1145** `fix(nanoclaw-pr-review-runner): don't accept a partial CI rail as a Devin verdict`

## 📅 2026-08-09

### nv-main (3 PRs)
- **#1150** `deps: own ccusage on nv-main, and assert runtime specifiers actually resolve`
- **#1152** `critique-gate: close the consume/stamp interleaving that manufactured a bogus escalation`
- **#1153** `fix(setup): prove the overlay actually landed before calling a merge composed`

## 📅 2026-08-06

### nv-main (32 PRs)
- **#1134** `path-guard: provision pathspec itself, so a nv-main test cannot break sibling CI`
- **#1133** `typecheck: widen the gate past src/, ratcheted against a shrink-only baseline`
- **#1132** `supply-chain: enforce the release-age quarantine on in-image installs, pin codex 0.146.0`
- **#1131** `cron: make a nonzero exit from a scheduled job impossible to miss`
- **#1130** `funnel: report what the legacy quarantine set aside`
- **#1129** `ci: stop generating trailing blank lines, and make a skipped CI run visible (W1 + W2)`
- **#1128** `migrate-v1-to-v2: a path glob in the JSDoc closed the comment, breaking the file`
- **#1127** `agent-runner: lock the clone refresh and stop letting git's stamp hide a partial one`
- **#1126** `setup: failed steps rendered the green success glyph`
- _+23 more: #1125, #1124, #1120, #1119, #1118, #1116, #1115, #1114, #1113, #1111, #1110, #1109, #1108, #1107, #1106, #1105, #1103, #1102, #1101, #1097, #1096, #1085, #1084_

### nv-dashboard (7 PRs)
- **#1095** `dashboard: render critique-gate cards with the PR, session and provenance`
- **#1098** `dashboard: fix three defects in the critique-gate card (review of #1095)`
- **#1100** `dashboard: clamp every approval reason, add a critique-gate strip`
- **#1104** `dashboard: surface review cost and regression quality — with their denominators`
- **#1117** `dashboard: say whether the approver ledger is provenance-filtered`
- **#1121** `dashboard: read the structured kb-doctor artifact, and stop reporting 0 drift`
- **#1122** `dashboard: pin ccusage instead of executing whatever npm serves today`

### nv-slang (1 PRs)
- **#1123** `fix(discord): a failed forward must not consume reply capacity (F15, #920 follow-up)`

## 📅 2026-08-05

### nv-main (13 PRs)
- **#1092** `critique-gate: self-heal stale/missing escalations, close the fail-open`
- **#1086** `Sync nv-main with upstream/main`
- **#1083** `feat(scripts): verify-only drift check for nv-main-owned files`
- **#1082** `feat(ncl): mcp-tools get/set — read and change a group's MCP tool allow-list`
- **#1081** `fix(codex): silent turns — deliver-nothing detection + stale-thread rotation`
- **#1079** `fix(approval-ledger): stamp the human verdict host-side, not via an agent turn`
- **#1078** `feat(scripts): regression-quality — quality axis for coworker autonomy`
- **#1077** `fix(webhook): GC the CI-gate park slot when a PR reaches a terminal state`
- **#1076** `feat(scripts): kb-doctor — report drift between git and what production runs`
- _+4 more: #1075, #1074, #1071, #1052_

### nv-dashboard (4 PRs)
- **#1048** `Sync nv-dashboard with upstream/main`
- **#1046** `fix(dashboard): supply instance on dashboard messaging_group insert`
- **#1080** `feat(dashboard): GET /api/kb-health — surface KB cost, shape and drift`
- **#1088** `Sync nv-dashboard with upstream/main`

### nv-slang (2 PRs)
- **#1049** `Sync nv-slang with upstream/main`
- **#1089** `Sync nv-slang with upstream/main`

### nv-slangpy (2 PRs)
- **#1050** `Sync nv-slangpy with upstream/main`
- **#1090** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (2 PRs)
- **#1051** `Sync nv-nanoclaw with upstream/main`
- **#1091** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-08-04

### nv-main (6 PRs)
- **#1064** `fix(cli): group-scoped tasks lookup misses tasks in ordinary sessions`
- **#1065** `fix(sweep): reclaim bounced claims before the wake, not after`
- **#1066** `fix(learnings-wiki): bound the fold — supersede-aware coverage, page cap, catalog-only index`
- **#1067** `fix(learnings-wiki): land the prod-only footer normalizer into the embedded builder`
- **#1068** `feat(scripts): kb-health — standing offline telemetry for the learnings KB`
- **#1069** `fix(approval-ledger): join the human verdict when the PR head advanced`

## 📅 2026-07-27

### nv-main (8 PRs)
- **#1031** `Sync nv-main with upstream/main`
- **#1033** `fix(merge-train): roll back the merge if the composed tree doesn't build`
- **#1036** `fix(ci): composed-merge takes HEAD for nv-main PRs (stop reverting their changes)`
- **#1035** `feat(create-agent): thread sidebar_group through content (complete nv-main absorption)`
- **#1034** `feat(setup): LLM-assisted keep-both merge fallback (opt-in NANOCLAW_LLM_MERGE)`
- **#1037** `fix(compose): canonicalize the whole owned set to nv-main (deterministic dashboard, no resync)`
- **#1038** `ci(compose-check): validate the real deploy compose onto nv-coworkers`
- **#1039** `fix(compose): derive is_owned from nv-main.txt (single source of truth)`

### nv-dashboard (1 PRs)
- **#1032** `Sync nv-dashboard with upstream/main`

### nv-slang (1 PRs)
- **#1026** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#1027** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#1028** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-25

### nv-main (1 PRs)
- **#1019** `fix(rebuild-claude): create groups/main/ before writing CLAUDE.md`

### nv-dashboard (3 PRs)
- **#1018** `fix(dashboard): stream compact live-state deltas`
- **#1021** `fix(nv-dashboard): restore Shared Artifacts shell`
- **#1020** `feat(nv-dashboard): add shared-state read-only dashboard port`

## 📅 2026-07-24

### nv-main (1 PRs)
- **#1013** `fix(setup): pin package.json + pnpm-lock.yaml to nv-main after compose merge`

## 📅 2026-07-23

### nv-main (1 PRs)
- **#1006** `test(setup): CI-protect merge-train.sh + compose_fork shell logic`

## 📅 2026-07-22

### nv-main (2 PRs)
- **#996** `Sync nv-main with upstream/main`
- **#1004** `feat(setup): project-integrations wizard multiselect + fork bootstrap in bash setup.sh`

### nv-dashboard (1 PRs)
- **#998** `Sync nv-dashboard with upstream/main`

### nv-slang (1 PRs)
- **#999** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#1000** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#1001** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-21

### nv-main (2 PRs)
- **#988** `Sync nv-main with upstream/main`
- **#994** `fix(supervise-issues): nudge dispatches that bounce with zero activity (slang#12165)`

### nv-dashboard (2 PRs)
- **#986** `feat(dashboard): PR-approver panel as default-closed dropdown, always 4 categories`
- **#990** `Sync nv-dashboard with upstream/main`

### nv-slang (1 PRs)
- **#991** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#992** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#993** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-19

### nv-main (4 PRs)
- **#975** `Sync nv-main with upstream/main`
- **#981** `feat(approver): host CI-gate + debounce for reviewable PRs`
- **#984** `feat(approver): precise CI gate via gh check-run probe`
- **#985** `fix(approver): per-repo CI_GATE_REQUIRED_CHECK_RUN map`

### nv-dashboard (1 PRs)
- **#977** `Sync nv-dashboard with upstream/main`

### nv-slang (2 PRs)
- **#978** `Sync nv-slang with upstream/main`
- **#982** `feat(slang-pr-approver): collect-once + Devin subagent + abstain early-return`

### nv-slangpy (2 PRs)
- **#979** `Sync nv-slangpy with upstream/main`
- **#983** `feat(slangpy-pr-approver): collect-once + Devin subagent + abstain early-return`

### nv-nanoclaw (1 PRs)
- **#980** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-17

### nv-main (1 PRs)
- **#966** `Sync nv-main with upstream/main`

### nv-dashboard (1 PRs)
- **#968** `Sync nv-dashboard with upstream/main`

### nv-slang (1 PRs)
- **#969** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#970** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#971** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-16

### nv-main (3 PRs)
- **#961** `fix(agent-runner): stop test poll-loops leaking across files (fixes the /clear-abort CI flake)`
- **#960** `fix(agent-runner): bounce a2a handoffs that fail via the THROWN-error path (#12108)`
- **#962** `feat(codex-critique): flag comment-noise as must-fix during code review`

### nv-slang (1 PRs)
- **#963** `feat(slang): comment invariant — design rationale belongs in the PR body, not source`

### nv-slangpy (1 PRs)
- **#964** `feat(slangpy): comment invariant — design rationale belongs in the PR body, not source`

## 📅 2026-07-15

### nv-main (7 PRs)
- **#943** `fix(a2a): redrive bounced handoffs + mechanical supervisor enforcement`
- **#942** `Sync nv-main with upstream/main da9a74fc (2026-07-14) — guard-seam + a2a lineage port`
- **#948** `feat(welcome): combined interactive + coworker/lego onboarding`
- **#949** `fix(agent-runner): align poll-loop test processQuery calls to nv-main signature`
- **#950** `test(validate-templates): guard the critique-gate stage contract at author time`
- **#952** `refactor(memory): adopt upstream memory-session-hook shape on nv-main`
- **#955** `Sync nv-main with upstream/main a11ad11 (2026-07-15)`

### nv-dashboard (4 PRs)
- **#937** `fix(dashboard): spawn ccusage directly (node cli.js), not via npx — kill the fan-out pileup`
- **#930** `Sync nv-dashboard with upstream/main da9a74fc (2026-07-14)`
- **#951** `fix(dashboard): render ask_question cards + wire option buttons in thread view`
- **#945** `Sync nv-dashboard with upstream/main`

### nv-slang (2 PRs)
- **#928** `Sync nv-slang with upstream/main da9a74fc (2026-07-14)`
- **#946** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#927** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (2 PRs)
- **#929** `Sync nv-nanoclaw with upstream/main da9a74fc (2026-07-14)`
- **#947** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-14

### nv-main (2 PRs)
- **#921** `fix(funnel): emit standalone approverDecisions[] for all Verity decisions`
- **#919** `fix(channels): restore dropped dashboard barrel self-registration import`

### nv-dashboard (2 PRs)
- **#922** `feat(dashboard): dedicated PR-approver (Verity) shadow-decision panel`
- **#936** `fix(dashboard): make Context histogram respect the 1d/7d/30d/all period selector`

### nv-slang (2 PRs)
- **#934** `feat(slang): add code-comment discipline as a spine invariant`
- **#920** `fix(slang-mcp): forward Discord follow-ups from the always-on daemon`

### nv-slangpy (1 PRs)
- **#935** `feat(slangpy): add code-comment discipline as a spine invariant`

## 📅 2026-07-13

### nv-main (7 PRs)
- **#911** `feat(supervise-issues): STALE-OPEN worktree tier — reclaim dead-open build trees under disk pressure`
- **#912** `feat(base): universal TodoWrite step-tracking + compaction survival`
- **#915** `feat(supervise-issues): critical-pressure tier — reclaim idle KEEP builds at ENOSPC risk`
- **#916** `fix(agent-runner): skip git worktrees in additionalDirectories (autocompact thrash)`
- **#917** `refactor(agent-runner): precise linked-worktree predicate + side-effect-free helper`
- **#918** `feat(agent-runner): refresh primary clones at boot (ff-only + submodules)`
- **#924** `docs(codex-critique): add DECISION_REVIEW to the stage menu + table`

### nv-slang (1 PRs)
- **#913** `feat(slang-fixer): peer-review-before-report as a spine invariant`

### nv-slangpy (1 PRs)
- **#914** `feat(slangpy-fixer): peer-review-before-report as a spine invariant`

## 📅 2026-07-12

### nv-main (2 PRs)
- **#903** `fix(supervise-issues): escalate operator-only docker reclaim under disk pressure`
- **#904** `fix(supervise-issues): name-agnostic all-tier worktree GC discovery`

### nv-slang (1 PRs)
- **#905** `fix(slang-reviewer): uniform wt- worktree naming + trap on stop`

## 📅 2026-07-11

### nv-main (3 PRs)
- **#893** `Sync nv-main with upstream/main (a30547fb)`
- **#898** `docs(approval-ledger): drop stale offline-scoring references after approver went live-only`
- **#901** `fix(supervise-issues): archive closed chains + never suppress a needs_nudge row`

### nv-dashboard (1 PRs)
- **#892** `Sync nv-dashboard with upstream/main`

### nv-slang (3 PRs)
- **#889** `Sync nv-slang with upstream/main`
- **#896** `feat(slang-pr-approver): self-harvest posted bot reviews + run Devin, drop reviewer delegation`
- **#900** `fix(slang-pr-approver): wait for a pending review bot instead of racing to Devin-only`

### nv-slangpy (3 PRs)
- **#890** `Sync nv-slangpy with upstream/main`
- **#897** `feat(slangpy-pr-approver): self-harvest posted bot reviews + run Devin, drop reviewer delegation`
- **#899** `fix(slangpy-pr-approver): wait for a pending review bot instead of racing to Devin-only`

### nv-nanoclaw (1 PRs)
- **#891** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-10

### nv-main (8 PRs)
- **#868** `Sync nv-main with upstream/main 0c0f4c25`
- **#870** `fix(sweep): guard per-session spine compose in detectStaleContainers`
- **#871** `fix(funnel): regenerate bot-contributions snapshot in funnel-cron`
- **#873** `Sync nv-main with upstream/main (0c0f4c25)`
- **#874** `fix(webhook): route reviewable PRs to *-pr-approver not reviewer`
- **#877** `feat(webhook): route terminal PR events to approver for its learning loop`
- **#885** `fix(supervise-issues): nudge fixer-owned chains that go dark (bot-last ≠ handoff)`
- **#886** `fix(supervise-issues): partial-tolerant PR enrichment (batched issueOrPullRequest + salvage)`

### nv-dashboard (1 PRs)
- **#864** `Sync nv-dashboard with upstream/main`

### nv-slang (6 PRs)
- **#865** `Sync nv-slang with upstream/main`
- **#875** `feat(slang-pr-approver): mounted-policy fallback for shadow relaxation`
- **#878** `feat(slang-pr-approver): gap-severity judgment + TodoWrite anchor + dispatch clarity`
- **#880** `docs(slang-pr-approve): offline batch launches each PR as its own self-thread session`
- **#884** `docs(slang-pr-review): wire Devin exit-4 (transient launch failure) + refresh semantics`
- **#882** `fix(slang-pr-review): treat Devin Chrome-launch failure (exit 4) as transient, self-heal + retry`

### nv-slangpy (4 PRs)
- **#866** `Sync nv-slangpy with upstream/main`
- **#876** `feat(slangpy-pr-approver): mounted-policy fallback for shadow relaxation`
- **#879** `feat(slangpy-pr-approver): gap-severity judgment + TodoWrite anchor + dispatch clarity`
- **#881** `docs(slangpy-pr-approve): offline batch launches each PR as its own self-thread session`

### nv-nanoclaw (2 PRs)
- **#867** `Sync nv-nanoclaw with upstream/main`
- **#883** `fix(nanoclaw-pr-review-runner): transient Chrome-launch retry + stable-done for Devin scraper`

## 📅 2026-07-09

### nv-main (6 PRs)
- **#836** `Sync nv-main with upstream/main`
- **#846** `feat(webhook): route PR ready_for_review to slang-pr-approver via ROUTE_READY_PRS_TO`
- **#851** `feat(webhook): route all reviewable PR events to the orchestrator`
- **#854** `Add approval-decision ledger (record_decision host infra)`
- **#857** `feat(funnel): join Verity approver decision onto PR rows`
- **#860** `fix(agent-runner): stop sidecar rows starving the scheduled-task poll`

### nv-dashboard (9 PRs)
- **#843** `feat(dashboard): weekly Funnel-trend graph (merged÷filed + PRs-created)`
- **#844** `feat(dashboard): Context column in By-Coworker table (compactions + peak histogram)`
- **#845** `fix(dashboard): scale context histogram to widest window used (1M for Opus)`
- **#838** `Sync nv-dashboard with upstream/main`
- **#847** `feat(dashboard): friendly a2a group names + live Groups tab`
- **#848** `feat(dashboard): a2a channel names + real/a2a session split + stale flag in Groups`
- **#849** `feat(dashboard): nv-slang-bot contributions table in Funnel view`
- **#850** `feat(dashboard): clean @mention handle per coworker (strip \b)`
- **#858** `feat(dashboard): add Approver column to funnel issue table`

### nv-slang (4 PRs)
- **#839** `Sync nv-slang with upstream/main`
- **#852** `feat(slang-github-webhook): route github.pr_ready_for_review to the reviewer`
- **#834** `Add slang-pr-approver coworker: standalone offline approval-decision agent (shadow mode)`
- **#855** `Skill wording: record-decision → the record_decision MCP tool`

### nv-slangpy (3 PRs)
- **#840** `Sync nv-slangpy with upstream/main`
- **#853** `Add slangpy-pr-approver: full approver clone for the slangpy project`
- **#856** `Skill wording: record-decision → the record_decision MCP tool`

### nv-nanoclaw (1 PRs)
- **#841** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-07-08

### nv-main (12 PRs)
- **#833** `fix(host): wakeContainer returns Promise<boolean> (match its documented contract)`
- **#832** `Sync nv-main with upstream/main (559bb5ca)`
- **#830** `fix(delivery): consume github outbound as a no-op instead of retry→failed`
- **#829** `fix(a2a): re-arm the chain-routing gate soft-cap on a linked handoff`
- **#828** `fix(a2a): guard + clean up self-referential lineage rows`
- **#827** `fix(a2a): reject cross-thread in_reply_to hijacks in Layer-1 routing`
- **#826** `fix(a2a): resolve in_reply_to override seq→id in the message fan-out path`
- **#823** `docs: reconcile marker-model sections to the landed state`
- **#821** `Sync nv-main with upstream/main (2.1.39)`
- _+3 more: #814, #810, #809_

### nv-dashboard (2 PRs)
- **#817** `Sync nv-dashboard with upstream/main`
- **#824** `dashboard: exempt review-group telemetry from the 7-day hook_events prune`

### nv-slang (2 PRs)
- **#818** `Sync nv-slang with upstream/main`
- **#825** `slang-clarity-review-runner: worktree isolation, output floor, run keying`

### nv-slangpy (1 PRs)
- **#819** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (2 PRs)
- **#820** `Sync nv-nanoclaw with upstream/main`
- **#831** `nanoclaw-pr-review-runner: don't treat a still-generating Devin response as done`

## 📅 2026-07-07

### nv-main (1 PRs)
- **#808** `fix(hooks): record reviewer attestations under container mawk (awk interval bug)`

## 📅 2026-07-06

### nv-main (6 PRs)
- **#799** `Sync nv-main with upstream/main (b6cb53e2)`
- **#800** `fix(supervise-issues): make pull-universe.sh robust to bash quoting + large chain universes`
- **#802** `fix(container-runner): add --init so container PID 1 reaps zombies`
- **#803** `fix(critique-gate): Close verdict-enforcement gaps + tamper-resistance`
- **#804** `docs+test: critique-gate boundaries doc + delivery-vocabulary coverage (follow-up to #803)`
- **#805** `docs: critique-gate extension recipes (R1–R7)`

### nv-dashboard (1 PRs)
- **#793** `Sync nv-dashboard with upstream/main`

### nv-slang (1 PRs)
- **#797** `Sync nv-slang with upstream/main (b6cb53e2)`

### nv-slangpy (1 PRs)
- **#794** `Sync nv-slangpy with upstream/main`

## 📅 2026-07-03

### nv-main (5 PRs)
- **#777** `feat(composer): compose-time {{vars.KEY}} value substitution`
- **#778** `feat(workflows): base triage-issue workflow (shared skeleton for project triagers)`
- **#781** `style(composer): prettier-format the value-substitution tests`
- **#782** `fix(onboard-project): generate {project}-plan/{project}-implement, not retired workflows`
- **#789** `Sync nv-main with upstream/main (aecad864)`

### nv-dashboard (1 PRs)
- **#786** `Sync nv-dashboard with upstream/main (aecad864)`

### nv-slang (2 PRs)
- **#779** `refactor(slang): slang-triage-issue extends base triage-issue (dedup)`
- **#787** `Sync nv-slang with upstream/main (aecad864)`

### nv-slangpy (2 PRs)
- **#780** `refactor(slangpy): slangpy-triage-issue extends base triage-issue (dedup)`
- **#784** `Sync nv-slangpy with upstream/main (aecad864)`

### nv-nanoclaw (1 PRs)
- **#788** `Sync nv-nanoclaw with upstream/main (aecad864)`

## 📅 2026-07-02

### nv-main (17 PRs)
- **#766** `fix: route codex creds via OneCLI + harden MCP proxy ACL/body cap (HIGH)`
- **#767** `fix(data-safety): register.ts → DB helpers; back up before global→shared DELETE (HIGH)`
- **#768** `chore(hygiene): gitignore slang_kb/archives/pidfiles + drop orphan package-lock.json`
- **#769** `test(providers): barrel-driven registration guards for both provider trees (HIGH)`
- **#770** `fix(types,restart): re-export widened engage/sender aliases; restart via on_wake`
- **#771** `feat(setup): move the nv merge into setup/merge-train.sh; /setup invokes it`
- **#772** `fix(composer): throw on an unresolvable workflow extends target`
- **#773** `fix(run-test): route sqlite3 CLI reads through scripts/q.ts`
- **#774** `fix(add-slang): drop personal-fork remote + route merge through merge-train.sh`
- _+8 more: #765, #764, #763, #760, #759, #758, #757, #756_

### nv-dashboard (3 PRs)
- **#755** `fix(dashboard): populate active/paused task counts in admin overview`
- **#762** `fix(dashboard): add sonnet-5 cost reporting and skill transcript scanning`
- **#775** `perf(dashboard): mtime-gate message-ts poll + 3s→1s (snappier chat/badge)`

## 📅 2026-07-01

### nv-main (1 PRs)
- **#752** `fix(supervise): worktree GC checks issue state, not just PR state`

### nv-nanoclaw (1 PRs)
- **#747** `fix(agent-runner): prefer session routing over webhook routing in extractRouting`

## 📅 2026-06-30

### nv-main (8 PRs)
- **#714** `chore(nv-main): allowlist upstream-synced files in path-guard`
- **#721** `fix(ci): stop composed-tree vitest OOM (exit 137)`
- **#725** `fix(supervise): move PR #711 edits to nv-main (path-guard owner)`
- **#730** `feat(recall): wiki-first recall for plan/implement + workspace spine`
- **#728** `feat(skills): learnings-wiki — synthesize shared learnings into a Karpathy wiki`
- **#734** `fix(approvals): case-insensitive approve — canonicalized Approve was rejected`
- **#735** `fix(learnings-wiki): standard markdown links instead of Obsidian syntax`
- **#742** `fix(recall): limit=100 for wiki/index.md read (plan/implement + workspace spine)`

### nv-dashboard (9 PRs)
- **#722** `fix(dashboard): lighten test-server boot (gate MCP/ccusage/timers under VITEST)`
- **#723** `fix(nv-dashboard): restore orphaned decision.ts + destinations refresh (standalone runtime fix)`
- **#724** `fix(nv-dashboard): full standalone parity — restore squash-dropped deps + run dashboard tests in CI`
- **#727** `feat(dashboard): add deep-link URLs for tabs and admin pills`
- **#736** `fix(dashboard): populate LAST RUN for recurring scheduled tasks`
- **#737** `feat(dashboard): add descriptions to funnel status legend`
- **#738** `fix(dashboard): align totalCost with model breakdown sum`
- **#739** `feat(dashboard): unified issue table + win-rate as merged/PRs-authored`
- **#741** `fix(dashboard): funnel table polish — dropdown, inst fallback, trend label`

### nv-slang (2 PRs)
- **#731** `feat(recall): wiki-first recall for slang workflows`
- **#743** `fix(recall): limit=100 for wiki/index.md read (slang workflows)`

### nv-slangpy (2 PRs)
- **#732** `feat(recall): wiki-first recall for slangpy workflows`
- **#744** `fix(recall): limit=100 for wiki/index.md read (slangpy workflows)`

### nv-nanoclaw (2 PRs)
- **#733** `feat(recall): wiki-first recall for nanoclaw-pr-review`
- **#745** `fix(recall): limit=100 for wiki/index.md read (nanoclaw-pr-review)`

## 📅 2026-06-29

### nv-main (3 PRs)
- **#710** `feat(webhook): handle pull_request closed/merged for worktree GC`
- **#712** `fix(hooks): wire force-codex-sandbox.sh into container settings.json`
- **#670** `Sync nv-main with upstream/main (8be5be93)`

### nv-dashboard (1 PRs)
- **#645** `Sync nv-dashboard with upstream/main (8be5be93)`

### nv-slang (1 PRs)
- **#634** `Sync nv-slang with upstream/main (8be5be93)`

### nv-slangpy (1 PRs)
- **#642** `Sync nv-slangpy with upstream/main (8be5be93)`

### nv-nanoclaw (1 PRs)
- **#643** `Sync nv-nanoclaw with upstream/main (8be5be93)`

## 📅 2026-06-26

### nv-main (4 PRs)
- **#699** `refactor(supervise): split skill + add CI column & rebase-master nudge`
- **#700** ``fix(composer): gate workflow step parsing to the `## Steps` region``
- **#703** `fix(webhook): recognize both bot identities in the own-bot guard (stop self-👀)`
- **#704** `fix(supervise): deterministic scan.py + fix broken wake-gate & --thread-prefix`

### nv-slang (1 PRs)
- **#701** `fix(slang-workflows): correct step formatting for clean composer rendering`

### nv-slangpy (1 PRs)
- **#702** `fix(slangpy-workflows): restore inherited steps in slangpy-implement`

## 📅 2026-06-25

### nv-main (4 PRs)
- **#690** `docs(supervise): self-healing reaping guide + transcript-rotation note`
- **#691** `fix(a2a): collapse split gh-issue/pr coworker sessions into one canonical`
- **#693** `fix(startup): clear stale container_status before the gh-session reconcile`
- **#695** `feat(funnel): add --since flag to override the window start`

### nv-dashboard (4 PRs)
- **#688** `feat(dashboard): add host disk usage to Admin Infrastructure panel`
- **#692** `feat(dashboard): swim-lane shared-thread view + honor clicked session`
- **#694** `feat(dashboard): hide scheduled-task/system rows by default + slim lane toggle`
- **#696** `feat(dashboard): offer swim-lane on any multi-coworker thread, not just gh-*`

## 📅 2026-06-24

### nv-main (4 PRs)
- **#682** `feat(agent-runner): block coworkers from closing GitHub issues`
- **#683** `fix(supervise): proactive worktree-volume disk check via RO /ephemeral mount`
- **#673** `fix(nv-main): honor ENABLE_GPU=1 from .env on setup/update rebuilds`
- **#686** `fix(supervise): §8 worktree GC reaps dead-session orphans (wake + save-then-remove)`

### nv-slang (1 PRs)
- **#684** `fix(slang-fixer): report real worktree volume on disk-full (df /workspace/agent)`

## 📅 2026-06-23

### nv-slang (1 PRs)
- **#671** `Add no-push invariant to slang-maintainer`

## 📅 2026-06-17

### nv-main (2 PRs)
- **#662** `fix(supervise-issues): key-based dedup + awareness re-promotion + 10-col board`
- **#664** `fix(supervise-issues): awaiting_us trigger + by-us activity clock (#11594 autonomy gap)`

### nv-dashboard (1 PRs)
- **#663** `feat(dashboard): make funnel Refresh button recompute the snapshot`

### nv-slang (4 PRs)
- **#659** `fix(slang-fix-issue): use REST gh api for cross-fork PR create`
- **#665** `fix(slang-fix-issue): never gate an authorized human-facing reply on a build`
- **#668** `fix(slang-implement): check for a GPU before declaring a defect hardware-gated`
- **#669** `Add slang-pr-report skill to slang-maintainer coworker type`

### nv-slangpy (2 PRs)
- **#660** `fix(slangpy-implement): use REST gh api for cross-fork PR create`
- **#666** `fix(slangpy-implement): never gate an authorized human-facing reply on a build`

### nv-nanoclaw (1 PRs)
- **#661** `docs(nanoclaw-github): clarify REST-not-gh-pr-create for this fork repo`

## 📅 2026-06-16

### nv-main (1 PRs)
- **#654** `feat(cost): echo-drop coworker no-ops + non-blocking runaway card`

### nv-slang (2 PRs)
- **#653** `docs(slang-fixer): classify priority-yield CI failures as non-failures`
- **#655** `fix(slang-triage): make posting the issue comment the default`

### nv-slangpy (1 PRs)
- **#656** `fix(slangpy-triage): make posting the issue comment the default`

## 📅 2026-06-15

### nv-main (1 PRs)
- **#649** `fix(container): content-aware hook-event dedup so settings.json self-heals`

### nv-dashboard (1 PRs)
- **#650** `fix(dashboard): timeline attribution prefers live sessions over stale-stopped`

### nv-slang (1 PRs)
- **#647** `feat(slang-fix-issue): dispatch CI on draft PRs + apply pr: label`

## 📅 2026-06-12

### nv-main (2 PRs)
- **#637** `fix(build): skip local skills + fix dir tree-sha check in fetch-skills.sh`
- **#639** `chore(container): bump codex 0.124.0 → 0.139.0 + drop dead CODEX_PROFILE passthrough`

### nv-dashboard (2 PRs)
- **#638** `fix(dashboard): deep-link to a message outside the loaded window`
- **#641** `feat(dashboard): Copy + Link buttons in the thread/a2a side panel`

## 📅 2026-06-11

### nv-main (4 PRs)
- **#620** `docs: update USAGE.md to reflect current coworker state`
- **#627** `fix: add fallback model support and reduce MCP timeout noise`
- **#628** `feat(critique): verdict gate for OUTPUT_REVIEW + sandbox enforcement`
- **#629** `fix(webhook): fall back to orchestrator for CI/review events on PRs the bot was pulled into`

### nv-dashboard (2 PRs)
- **#633** `feat(dashboard): copy-message-to-clipboard button (#632)`
- **#635** `feat(dashboard): shareable permalink to a specific message`

### nv-slang (1 PRs)
- **#630** `feat(slang-github-webhook): repo-keyed generic routing + tighten fix-issue workflow`

### nv-slangpy (1 PRs)
- **#631** `feat(slangpy): webhook handling + PR-review-fix + peer-review parity with slang`

## 📅 2026-06-10

### nv-main (1 PRs)
- **#621** `fix(spine): require reading current source before drafting code claims`

### nv-dashboard (2 PRs)
- **#617** `fix(dashboard): guard ccusage refresh re-entrancy + cap concurrency to CPU threads`
- **#608** `fix(dashboard): prevent XSS via md() link-href attribute injection`

### nv-slang (1 PRs)
- **#622** `fix(slang): work from current checkout + read source before review replies`

### nv-slangpy (1 PRs)
- **#623** `fix(slangpy): work from current checkout before editing code`

### nv-nanoclaw (1 PRs)
- **#618** `fix(agent-runner): reclaim disk on transcript rotation (re-land on nv-nanoclaw)`

## 📅 2026-06-09

### nv-main (1 PRs)
- **#613** `fix(github-webhook): mint a per-PR thread for unmapped PR mentions`

### nv-slang (4 PRs)
- **#611** `fix(slang-github-webhook): route PRs by live fix/issue-<n> branch, not stale dev/<folder>/`
- **#612** `feat(slang-github-webhook): route human/fork PR review-fix requests to the fixer`
- **#614** `feat(slang-triage): allow triage to label issues`
- **#615** `feat(slang-fix-issue): encode what-to-fix (CI + review sweep) in PR-review-fix mode`

## 📅 2026-06-08

### nv-main (3 PRs)
- **#601** `feat(funnel): per-issue partition + win-rate + weekly trend`
- **#604** `fix(spine): draft-held PR still requires an issue comment`
- **#607** `fix(github-webhook): forward issue follow-ups on chains we drive (isParticipantIssue)`

### nv-dashboard (2 PRs)
- **#602** `feat(dashboard): visual issue funnel + fix collapsed board columns`
- **#603** `fix(dashboard): report 1M context window for opus-4-8`

### nv-slang (1 PRs)
- **#605** `fix(slang-triage): draft-held PR still needs the issue comment`

### nv-slangpy (1 PRs)
- **#606** `fix(slangpy-triage): draft-held PR still needs the issue comment`

## 📅 2026-06-06

### nv-slang (3 PRs)
- **#597** `fix(slang): generic push-remote in fix-issue + correct bot identity name`
- **#598** `fix(slang): drop redundant [draft] title prefix from fix-issue PR template`
- **#599** `fix(slang): target master, not main, in fix-issue workflow`

### nv-slangpy (1 PRs)
- **#589** `feat(slangpy-spine): bot-disclaimer in slangpy-common context`

## 📅 2026-06-05

### nv-main (5 PRs)
- **#580** `fix(gates): route chain-routing/critique refusals to the sender, not the peer`
- **#581** `fix(supervise-issues): rediscover chain universe live every tick`
- **#585** `refactor(implement): add {#ship} anchor to the Ship step`
- **#593** `fix(ci): canonical-resolution merge step (composed-state schema + lockfile)`
- **#595** `fix(container): don't bypass proxy for discord.com so OneCLI injects the Bot token`

### nv-dashboard (1 PRs)
- **#594** `fix(ci): canonical-resolution merge step (composed-state schema + lockfile)`

### nv-slang (4 PRs)
- **#582** `fix(slang-triage): codify issue-comment posting; drop contradictory "never post"`
- **#584** `fix(slang-github-webhook): replace deprecated PR_CREATED/pr-mappings.json with report_pr_created`
- **#588** `feat(slang-spine): bot-disclaimer in slang-common context`
- **#591** `fix(ci): canonical-resolution merge step (composed-state schema + lockfile)`

### nv-slangpy (4 PRs)
- **#583** `fix(slangpy-triage): codify issue-comment posting; drop contradictory "never post"`
- **#586** `fix(slangpy-implement): ship override — report_pr_created + Fixes #N in PR body`
- **#587** `feat(slangpy-reviewer): add /slangpy-pr-review workflow + review-output invariant`
- **#590** `fix(ci): canonical-resolution merge step (fixes sidebar_group schema failure)`

### nv-nanoclaw (1 PRs)
- **#592** `fix(ci): canonical-resolution merge step (composed-state schema + lockfile)`

## 📅 2026-06-04

### nv-main (6 PRs)
- **#570** `fix(nv-main): own base-nanoclaw skill where base-common references it`
- **#573** `feat(supervise-issues): track no-PR chains — triage comment as artifact + disposition`
- **#574** `feat(supervise-issues): remove weekend draft→ready CI flip (§7)`
- **#575** `fix(supervise-issues): board delivery MUST specify to= (multi-destination supervisor)`
- **#577** `fix(github-webhook): only 👀 comments addressed to the bot; never self-react`
- **#578** `fix(supervise-issues): board destination = literal to="orchestrator", verbatim, one session`

### nv-dashboard (1 PRs)
- **#576** `fix(dashboard): hide all machine action-envelopes from chat (not just cli_request)`

### nv-nanoclaw (1 PRs)
- **#572** `fix(nv-nanoclaw): drop base-nanoclaw (moved to nv-main #570) + harden ci.yml`

## 📅 2026-06-03

### nv-main (9 PRs)
- **#546** `fix(db): land sidebar_group union on nv-main + renumber migration 028 (fixes composed-tree CI)`
- **#542** `feat(supervise-issues): resumable-artifact directive, weekend CI window, superseded-PR postmortem + worktree GC`
- **#547** `docs(supervise-issues): cost-aware cadence + delta reporting + generic examples`
- **#548** `fix(webhook): process PR comments on mapped PRs + re-read GH_TOKEN at call time`
- **#554** `fix(routing-gate): require in_reply_to only, add soft-cap, backfill critique-gate`
- **#558** `refactor(routing): chain-routing check always-on, not an overlay`
- **#562** `feat(funnel): host-side issue funnel report (script + design doc)`
- **#565** `feat(funnel): scope to shader-slang org by default`
- **#566** `feat(webhook): route PR review verdicts, review threads, and CI failures to the owning fixer`

### nv-dashboard (8 PRs)
- **#522** `feat(dashboard): group coworkers in the sidebar by prod / specific user`
- **#549** `fix(dashboard): show all active sessions in coworker list (untruncate low-volume coworkers)`
- **#540** `fix(dashboard): show command + target detail on cli_command approval cards`
- **#550** `fix(dashboard): filter ncl chatter server-side so large replies are not pushed off the message window`
- **#552** `fix(db): remove orphaned 023-sidebar-group migration (collided at v23, crashed prod)`
- **#553** `fix(dashboard): hoist hideChatterSql scope — restores outbound messages dropped by #550`
- **#563** `feat(dashboard): Funnel tab + /api/funnel (serves cached snapshot)`
- **#564** `refactor(dashboard): move Funnel into Admin > Funnel`

### nv-slang (6 PRs)
- **#543** `refactor(slang-workflows): replace PR-watcher/build-watchdog polling with webhook + subagent`
- **#551** `chore(slang): remove orphaned slang-templates/ dir`
- **#555** `feat(slang): opt chain coworkers into chain-routing-gate`
- **#559** `fix(slang): remove type-declared overlays (dashboard-selected instead)`
- **#568** `ci(slang): propagate nv-main hardened ci.yml (is_owned auto-resolve)`
- **#567** `feat(slang): handle review verdicts, review threads, and CI failures in slang-github-webhook`

### nv-slangpy (3 PRs)
- **#545** `refactor(slangpy-implement): blocking Agent subagent for long builds, drop schedule_task watchdog`
- **#556** `feat(slangpy): opt chain coworkers into chain-routing-gate`
- **#560** `fix(slangpy): remove type-declared overlays (dashboard-selected instead)`

### nv-nanoclaw (3 PRs)
- **#544** `refactor(nanoclaw-implement): blocking Agent subagent for long builds, drop schedule_task watchdog`
- **#557** `feat(nanoclaw): opt chain coworkers into chain-routing-gate`
- **#561** `fix(nanoclaw): remove type-declared overlays (dashboard-selected instead)`

## 📅 2026-06-02

### nv-main (4 PRs)
- **#532** `revert(skills): restore upstream-tracking skills tightened in #526`
- **#534** `ci: harden nv-* fan-merge (owned-conflict auto-resolve) + fix webhook-github test mocks`
- **#536** `fix(webhook): issue_comment fall-through rejoins issue chain (not orphan session)`
- **#539** `fix(spine): substantive human comment re-opens a closed/holding chain`

### nv-dashboard (1 PRs)
- **#538** `feat(dashboard): hide ncl polling chatter + fix Load-older pagination`

### nv-slang (1 PRs)
- **#537** `feat(slang-reviewer): add Reviewer C (clarity) — wraps shader-slang/slang#11340 skills`

## 📅 2026-06-01

### nv-main (8 PRs)
- **#519** `fix(spine): per-edge a2a model + GitHub as primary human-observability surface`
- **#520** `feat(skill/supervise-issues): verify the GitHub-comment loop is closed`
- **#521** `feat(webhook): also dev-route issue comments via ROUTE_ISSUES_TO`
- **#523** `fix(container): rename placeholder auth stub + guard against URL-baked stubs`
- **#530** `style(container-runner): prettier-format OneCLI-stub guard line (unblocks CI)`
- **#524** `fix(spine): tighten chain-reporting + github-comment-not-closure + per-issue routing + tabular status`
- **#525** `fix(webhook): forward issue comments past the mention gate when ROUTE_ISSUES_TO is set`
- **#526** `docs(spine): tighten base spine/skills/workflows/overlays (instruction-context diet)`

### nv-slang (1 PRs)
- **#527** `docs(slang): tighten slang spine/skills/workflows (instruction-context diet)`

### nv-slangpy (1 PRs)
- **#528** `docs(slangpy): tighten slangpy spine + workflows (instruction-context diet)`

### nv-nanoclaw (1 PRs)
- **#529** `docs(nanoclaw): tighten nanoclaw spine + skill + workflows (instruction-context diet)`

## 📅 2026-05-31

### nv-main (1 PRs)
- **#517** `fix(spine): forbid all direct dispatches past a child to its descendants`

## 📅 2026-05-29

### nv-main (3 PRs)
- **#510** `feat(webhook): mint per-issue orchestrator session for issues opened`
- **#513** `fix(routing): canonical thread + parent-concept spine + idempotency`
- **#514** `feat(skill): supervise-issues — periodic supervisor for in-flight issue chains`

### nv-dashboard (3 PRs)
- **#509** `fix(dashboard): timeline depth + InstructionsLoaded detail rendering`
- **#512** `fix(dashboard): webhook envelope renderer + responsiveness + clickable session`
- **#515** `feat(dashboard): clickable dispatch links — open recipient session from outbound message`

## 📅 2026-05-28

### nv-main (13 PRs)
- **#507** `feat(transcripts): add --since-hours filter to build-transcripts-archive`
- **#506** `fix(spine): require explicit thread_id on fresh peer dispatch`
- **#504** `docs: add cross-instance webhook routing doc`
- **#503** `docs(spine): add fan-out rule to agents.md`
- **#501** `feat(webhook): ROUTE_ISSUES_TO — dev-route GitHub issues to a peer instance`
- **#500** `fix(webhook): bring back deterministic host-side 👀 reaction`
- **#497** `chore(docs): scrub developer-specific paths/usernames from on-call runbook`
- **#496** `chore(webhook): drop legacy fanout/require-mapping/host-eyes paths`
- **#495** `feat(webhook): orchestrator routing for unmapped events + issues support`
_+4 more: #493, #492, #491, #459_

### nv-dashboard (3 PRs)
- **#498** `chore(dashboard): scrub developer-specific path from V1 import prompt`
- **#435** `Sync nv-dashboard with upstream/main`
- **#505** `fix(dashboard): SSE state dedup + per-client backpressure`

### nv-slang (3 PRs)
- **#494** `feat(slang-github-webhook): add Step 0 — coworker posts 👀 reaction`
- **#502** `feat(slang-reviewer): post merged review back to GitHub when authorized`
- **#436** `Sync nv-slang with upstream/main`

### nv-slangpy (1 PRs)
- **#437** `Sync nv-slangpy with upstream/main`

### nv-nanoclaw (1 PRs)
- **#438** `Sync nv-nanoclaw with upstream/main`

## 📅 2026-05-27

### nv-main (6 PRs)
- **#475** `fix(webhook): authenticate the 👀 reaction with GH_TOKEN`
- **#477** `show-transcript: sort by last activity + search + activity-window filter + split claude/codex`
- **#478** `fetch-skills: retry transient gh skill install failures + surface real stderr`
- **#481** `codex hooks → dashboard parity (5 lifecycle events) + ncl introspection`
- **#482** `codex hooks: also wire pr-auto-map.sh on PostToolUse(Bash)`
- **#486** `fix(mcp-auth-proxy): make tokenPath overridable so tests do not clobber prod`

### nv-dashboard (5 PRs)
- **#476** `fix(dashboard): surface marker-only overlays in coworker editor`
- **#483** `fix(dashboard): show hidden sessions in the Hidden Sessions expander`
- **#484** `fix(dashboard): on-demand ccusage refresh + subprocess cleanup`
- **#488** `fix(dashboard): bound ccusage fan-out — fix Overview $0 + memory bloat`
- **#489** `fix(dashboard): wire cost refresh to Overview tab, not Infra`

### nv-slang (2 PRs)
- **#479** `slang spine: pin skill-source to @main (slang-skills coworkers branch merged upstream)`
- **#485** `feat(slang-fix-issue): add simplify step before commit`

### nv-slangpy (1 PRs)
- **#480** `slangpy spine: pin skill-source to @main (slang-skills coworkers branch merged upstream)`

## 📅 2026-05-26

### nv-main (5 PRs)
- **#460** `feat(skill): /show-transcript renders Claude+Codex sessions to HTML on :8080`
- **#464** `feat(a2a): pin recipient session via target_session_id`
- **#465** `fix(container-runner,hooks,composer): heal hook bloat + per-stage critique enforcement`
- **#467** `fix(hooks,overlays,spine): plan-gate becomes per-overlay opt-in (mirrors critique-gate)`
- **#473** `feat(webhook): post 👀 reaction on receipt to acknowledge @mentions`

### nv-dashboard (4 PRs)
- **#461** `feat(dashboard): render timestamps in operator-configured TZ`
- **#462** `feat(dashboard): include a2a/self-loop sibling threads in summaries`
- **#463** `fix(dashboard): truthful thread view + accurate badge counts`
- **#472** `fix(dashboard): show cross-session a2a within same agent group`

### nv-slang (2 PRs)
- **#466** `fix(slang): plan-first slang-fix-issue + per-type critique stages`
- **#468** `fix(slang): markdown bullets + heredoc PR body + plan-gate / critique-gate opt-in`

### nv-slangpy (1 PRs)
- **#469** `fix(slangpy): markdown bullets + overlay opt-ins (mirror of #468)`

### nv-nanoclaw (1 PRs)
- **#470** `fix(nanoclaw): markdown bullets + overlay opt-ins (mirror of #468/#469)`

## 📅 2026-05-23

### nv-main (14 PRs)
- **#456** `feat(overlay): emit buddy + critique-gate events to dashboard hook stream`
- **#455** `fix(buddy): wait for SDK to flush JSONL before distilling (#68)`
- **#454** `fix(buddy): repair codex --json thread-id extraction (codex 0.124+ shape)`
- **#453** `fix(critique-gate): close text-output bypass — gate enforces on <message to=> blocks too`
- **#452** `fix(agent-runner): chain regex accepts thread_id; buddy-call.sh jq compiles`
- **#451** `fix(overlay): MARKER materialization is operator-driven, not anchor-driven`
- **#447** `feat(container): per-session ~/.codex mount for ALL coworkers, not just codex-provider`
- **#446** `fix(buddy,critique): missing OVERLAY.md + container-restart resilience`
- **#444** `feat(buddy): hook-driven companion via codex exec; replace Agent-fork pattern`
_+5 more: #443, #442, #441, #440, #439_

### nv-dashboard (3 PRs)
- **#448** `fix(dashboard): preserve underscores in folder→container name match`
- **#450** `fix(dashboard): repair matchContainerName rival logic + matching test (PR #448 follow-up)`
- **#457** `feat(dashboard): render critique-gate REFUSED as collapsed yellow card`

### nv-slang (2 PRs)
- **#445** `feat(slang-pilot): activate critique-gate + buddy-monitor on slang-fixer / -triage / -reviewer`
- **#449** `revert(slang-pilot): drop static overlay assignments — use runtime per-group config`

## 📅 2026-05-22

### nv-main (6 PRs)
- **#424** `ci(format): apply prettier to src/github-webhook-server.ts`
- **#422** `fix(a2a): in_reply_to auto-resolve + soft gate audit`
- **#423** `fix(host): scaffold groups/<gid>/memory/ + --pull=never on per-group rebuilds`
- **#425** `prose(nv-main): buddy rewrite + base spine path-tokens + implement worktree isolation`
- **#430** `fix(audit): meta-ack audit — soft enforcement of [MUST] no-meta-ack rule`
- **#432** `fix(host): --pull=never → --pull=false on per-group docker build`

### nv-slang (2 PRs)
- **#426** `prose(nv-slang): workflow hardening across slang-{plan,triage-issue,fix-issue}`
- **#429** `revert(slang-fix-issue): drop gh auth preflight from Step 1`

### nv-slangpy (1 PRs)
- **#427** `prose(nv-slangpy): workflow hardening across slangpy-{plan,triage-issue}`

### nv-nanoclaw (1 PRs)
- **#428** `prose(nv-nanoclaw): nanoclaw-plan path tokens`

## 📅 2026-05-21

### nv-main (7 PRs)
- **#413** `fix(composer): overlays follow workflow extends: chain`
- **#414** `feat(composer): canonical base workflow + implicit extends`
- **#415** `feat(composer): trait-based overlay matching + start: true mode`
- **#416** `refactor(overlays): buddy + critique adopt new auto-attach shape`
- **#417** `feat(composer): anchor aliases for canonical-stage matching`
- **#418** `fix(overlays): buddy must not double-spawn`
- **#421** `feat(webhook): WEBHOOK_REQUIRE_MAPPING + WEBHOOK_FANOUT_URLS for cross-instance delivery`

### nv-dashboard (1 PRs)
- **#419** `fix(dashboard): fold cli_response payloads in main feed`

### nv-slang (1 PRs)
- **#410** `fix(slang): bindings — slang-build provides code.build`

## 📅 2026-05-20

### nv-main (9 PRs)
- **#389** `feat(channels): add Telegram channel adapter`
- **#391** `feat(nv-main): lego spine refactor — composer features, base spine split, workflow tightening`
- **#398** `feat(ncl): expose agent_provider field on groups resource`
- **#401** `fix(nv-main): a2a multi-hop ancestor routing + thread-aware reply primitives`
- **#402** `fix(nv-main): tighten a2a reply precedence and ancestor guards`
- **#403** `fix(nv-main): orchestrator must not cross-post status across chains`
- **#404** `fix(spine): no meta-acknowledgements + close chains explicitly`
- **#405** `fix(a2a): peer-affinity respects thread_id when sender supplied one`
- **#406** `fix(spine): consolidate chain-reporting to 5 rules with [MUST] markers`

### nv-dashboard (6 PRs)
- **#390** `feat(dashboard): recognize the telegram channel adapter`
- **#395** `fix(dashboard): channels list — drop wrong prefix map, exclude helper modules`
- **#396** `fix(dashboard): drop "Global Memory" CLAUDE.md scope retired in v2`
- **#397** `feat(dashboard): clickable session IDs in Admin → Sessions`
- **#399** `fix(dashboard): codex cost — switch to unified ccusage CLI`
- **#400** `fix(dashboard): fold cli_response payloads in thread view`

### nv-slang (3 PRs)
- **#386** `feat(slang-mcp): mandate DeepWiki + GitHub research in summon and continuation prompts`
- **#393** `feat(nv-slang): code-changes invariant + workflow tightening + identity restoration`
- **#407** `feat(slang-triage): principal-engineer rewrite — research, solution space, always forward`

### nv-slangpy (3 PRs)
- **#394** `feat(nv-slangpy): code-changes invariant split + slangpy-implement signal restoration`
- **#408** `feat(slangpy-triage): specialist workflow — DeepWiki + local + gh, always forward`
- **#409** `feat(slangpy): register slangpy-triage / fixer / reviewer types`

### nv-nanoclaw (1 PRs)
- **#392** `feat(nv-nanoclaw): code-changes invariant split + writer rules + workflow tightening`

## 📅 2026-05-19

### nv-main (6 PRs)
- **#369** `Rebase nv-main on upstream/main v2.0.64 — cli_scope, ncl, A2A in_reply_to + L2 guard, drop onecli-gateway/add-deltachat`
- **#377** `Sync nv-main with upstream/main (2026-05-19)`
- **#382** `feat(nv-main): tee container stdio to per-session log files`
- **#383** `fix(nv-main): enable contrib/non-free apt components in base image`
- **#385** `fix(nv-main): self-heal container_configs row on first spawn`
- **#384** `feat(nv-main): ncl sessions messages — read-only transcript verb`

### nv-dashboard (2 PRs)
- **#371** `Rebase nv-dashboard on upstream/main v2.0.64 — pixel-office + a2a inspector + ccusage 19+ + paginate`
- **#379** `Sync nv-dashboard with upstream/main (2026-05-19)`

### nv-slang (1 PRs)
- **#372** `Rebase nv-slang stacked on wip/nv-main — slang skills, slang-mcp, slang-github-webhook (moved from nv-main #357), slang-reviewer`

### nv-slangpy (2 PRs)
- **#373** `Rebase nv-slangpy on upstream/main v2.0.64 — skill-discovery context for SlangPy agents (#297)`
- **#380** `Sync nv-slangpy with upstream/main (2026-05-19)`

### nv-nanoclaw (2 PRs)
- **#374** `Rebase nv-nanoclaw on upstream/main v2.0.64 — base-nanoclaw + nanoclaw-reviewer coworker (Devin PR review #350)`
- **#381** `Sync nv-nanoclaw with upstream/main (2026-05-19)`

## 📅 2026-05-18

### nv-main (7 PRs)
- **#357** `chore(nv-main): remove container/skills/github-webhook/ — moves to nv-slang`
- **#355** `fix: break engine self-loop chain — routing guards + envelope + skill rewrite`
- **#362** `feat(host): recompose every group CLAUDE.md at NanoClaw startup`
- **#364** `fix(host): downgrade MCP auth proxy 5m-timeout from ERROR to INFO`
- **#366** `fix(agent-runner): restore a2a reply auto-route on agent channel`
- **#367** `fix(agent-route): explicit same-session guard on a2a reply branch`
- **#368** `chore(a2a): trim L1 comment rot, drop dead test, add host L2 auto-route coverage`

### nv-dashboard (3 PRs)
- **#349** `fix(dashboard): paginate older messages in coworker chat + thread views`
- **#363** `fix(dashboard): adapt cost panel to ccusage 19+ schema (period field, no modelBreakdowns)`
- **#365** `fix(dashboard): filter ccusage output to Claude-only (fix codex global mis-attribution)`

### nv-slang (5 PRs)
- **#356** `feat(slang-mcp): forum-thread continuation with cap, Resolved stop, OP-only`
- **#358** `feat(nv-slang): add slang-github-webhook skill — moved from nv-main, rewritten for one-comment-per-task`
- **#359** `feat(slang-mcp): eager Discord init + restore DISCORD_POST_SUMMON / DISCORD_READ_ONLY gates`
- **#360** `fix(slang-mcp): gate eager Discord init behind DISCORD_EAGER_INIT (prod-safe default off)`
- **#361** `docs(slang-discord): modernize WORKFLOW + spine + critique for post-#356 push/continuation architecture`

### nv-nanoclaw (1 PRs)
- **#350** `feat(nv-nanoclaw): add nanoclaw-reviewer coworker (Devin-only PR review)`

## 📅 2026-05-15

### nv-main (1 PRs)
- **#352** `fix(mcp-registry): reap supergateway descendants on stop + log /servers/restart callers`

### nv-slang (1 PRs)
- **#351** `feat(slang-mcp): gate on_thread_create SummonView post behind DISCORD_POST_SUMMON`

## 📅 2026-05-14

### nv-main (4 PRs)
- **#336** `ci(nv-main): catch silent-empty-workflow-body failure mode`
- **#338** `fix(host-sweep): stale CLAUDE.md detect survives host restarts`
- **#341** `feat(nv-main): add chain-reporting protocol to base spine`
- **#345** `fix(nv-main): fetch-skills compares tree-sha, not just branch name`

### nv-dashboard (3 PRs)
- **#337** `fix(dashboard): always bind new coworkers to admin's messaging group`
- **#343** `fix(dashboard): unread badges propagate correctly + don't auto-mark on view`
- **#344** `fix(dashboard): hidden-session count + Create Modal type-cache regression`

### nv-slang (6 PRs)
- **#334** `feat(nv-slang): add slang-reviewer coworker + slang-pr-review workflow`
- **#333** `feat(nv-slang): add optional peer-review step to slang-fix-issue`
- **#335** `fix(nv-slang): reformat workflow steps to numbered-list (composer compat)`
- **#339** `fix(nv-slang): peer-review quietness rule + active-work sentinel`
- **#342** `feat(nv-slang): draft-PR mode + 5-bullet chain reporting`
- **#347** `feat(slang-mcp): DISCORD_READ_ONLY env gate for Discord-write paths`

## 📅 2026-05-13

### nv-main (12 PRs)
- **#331** `feat(nv-main): add session-direct ingress for dashboard a2a admin replies`
- **#326** `fix(nv-main): drop slang-only workflow refs from buddy applies-to`
- **#324** `chore(nv-main): remove project-specific workflows (slang owns triage-issue/fix-issue/discord-answer)`
- **#320** `docs(spines/base): strengthen append_learning trigger conditions`
- **#318** `docs(spines/base): clarify send_card scope vs send_message routing`
- **#314** `fix: SQL injection, timestamp residual, and uncaught readdirSync crash`
- **#313** `style: format mcp-registry.ts`
- **#310** `fix(approvals): create pending_approvals row before DM delivery check`
- **#309** `fix: prevent MCP subprocess leak via stateful mode + process group kill`
- _+3 more: #308, #304, #301_

### nv-dashboard (13 PRs)
- **#332** `feat(dashboard): /api/chat/send-to-session for a2a admin replies`
- **#330** `fix(dashboard): allow admin to reply in own coworker a2a sessions`
- **#329** `fix(dashboard): drop bad parentId fallback in a2a inspector button`
- **#328** `fix(dashboard): a2a inspector lookup uses a2a_session_sources table`
- **#327** `feat(nv-dashboard): filter overlay editor by coworker workflows (extends-aware)`
- **#321** `fix(dashboard): make a2a session chat icon clickable`
- **#319** `fix(dashboard): restore a2a_peer resolution for session purple badge`
- **#317** `fix(dashboard): card-render ReferenceError + asset cache-busting`
- **#316** `fix(dashboard): remove undefined slug ref breaking session list`
- _+4 more: #315, #312, #311, #300_

### nv-slang (2 PRs)
- **#323** `feat(nv-slang): add slang-triage-issue workflow + retarget slang triager binding`
- **#325** `feat(nv-slang): add slang-fix-issue + slang-discord-answer workflows + critique overlay`

## 📅 2026-05-12

### nv-main (6 PRs)
- **#265** `feat(nv-main): add optional overlays param to create_agent MCP tool`
- **#274** `feat(nv-main): port overlay-config DB column from nv-nanoclaw #267`
- **#275** `refactor(nv-main): simplify critique overlay — drop file-writing ceremony`
- **#276** `ci(nv-main): add path-guard for nv-* overlay branches`
- **#277** `feat(nv-main): external skill registry — skill-source in coworker-types.yaml`
- **#294** `ci(nv-main): add fetch-skills + build step to CI pipeline`

### nv-dashboard (5 PRs)
- **#266** `feat(nv-dashboard): overlay selection UI + MCP token race fix`
- **#280** `chore(nv-dashboard): drop legacy groups/global + claude-md-compose`
- **#281** `test(nv-dashboard): add overlays column to createDashboardTestDb`
- **#298** `chore(nv-dashboard): re-land #280 (drop legacy groups/global + claude-md-compose)`
- **#299** `fix(dashboard): persist overlay selection in getCwCoworkers merge`

### nv-slang (5 PRs)
- **#268** `feat(nv-slang): remove overlays from slang coworker-types.yaml`
- **#272** `chore(nv-slang): strip leaked nv-main files + clean rebuild`
- **#278** `feat(nv-slang): add skill-source for shader-slang/slang-skills registry`
- **#292** `chore(nv-slang): remove bundled skills — fetched from shader-slang/slang-skills`
- **#296** `feat(nv-slang): add skill-discovery context for agents`

### nv-slangpy (5 PRs)
- **#269** `feat(nv-slangpy): remove overlays from slangpy coworker-types.yaml`
- **#273** `chore(nv-slangpy): strip leaked nv-main files + clean rebuild`
- **#279** `feat(nv-slangpy): add skill-source for shader-slang/slang-skills registry`
- **#293** `chore(nv-slangpy): remove bundled skills — fetched from shader-slang/slang-skills`
- **#297** `feat(nv-slangpy): add skill-discovery context for agents`

### nv-nanoclaw (2 PRs)
- **#267** `feat(nv-nanoclaw): per-agent overlay composition pipeline + migration`
- **#271** `chore(nv-nanoclaw): simplify overlay migration — drop backfill`

## 📅 2026-05-11

### nv-main (10 PRs)
- **#241** `fix(host-sweep): break spawn-kill loop after container crash`
- **#243** `fix(nv-main): close refreshDestinations closure leak + pass MCP tool inventory`
- **#244** `fix(nv-main): close composer-drift — slim base-common + backtick extends + restore base-nanoclaw skill`
- **#245** `feat(nv-main): daily log rotation with copytruncate (systemd-fd-safe)`
- **#247** `fix(nv-main): extends-note em-dash — no phantom Unknown-slash-ref warnings (regression from #244)`
- **#254** `feat(nv-main): cross-coworker dashboard file+message forwarding`
- **#256** `fix(nv-main): cross-coworker delivery — owner-only + a2a thread lookup`
- **#259** `fix(nv-main): disable bwrap sandbox in Codex config.toml + Claude settings.json`
- **#261** `feat(nv-main): enable codex_hooks experimental feature`
- **#262** `fix(nv-main): pr_session_mappings NULL thread_id insert failure`

### nv-dashboard (6 PRs)
- **#242** `feat(dashboard): remove chat tab, unify admin messages view`
- **#246** `feat(nv-dashboard): add GET /api/coworkers — list endpoint to round out POST`
- **#248** `chore(nv-dashboard): drop leaked agent-runner/agents.instructions.md — nv-main owns`
- **#252** `feat(nv-dashboard): a2a session visibility + approval feedback + fullscreen fix`
- **#253** `fix(nv-dashboard): collapsible relay messages + self-echo filter + unread polish`
- **#255** `fix(nv-dashboard): inbox attachment rendering + thread file links`

### nv-slang (2 PRs)
- **#249** `chore(nv-slang): drop leaked agent-runner/agents.instructions.md — nv-main owns`
- **#258** `fix(slang-mcp): remove GITHUB_API_BASE from OneCLI env vars`

### nv-slangpy (1 PR)
- **#250** `chore(nv-slangpy): drop leaked agent-runner/agents.instructions.md — nv-main owns`

### nv-nanoclaw (1 PR)
- **#251** `chore(nv-nanoclaw): drop leaked agent-runner/agents.instructions.md — nv-main owns`

## 📅 2026-05-10

### nv-main (3 PRs)
- **#237** `feat(nv-main): A/B/C/D test infra + buddy overlay + proxy/codex fixes`
- **#239** `feat(nv-main): PR→session mapping for webhook routing`
- **#240** `feat(nv-main): auto-detect PR creation and prompt report_pr_created`

### nv-slang (1 PR)
- **#238** `feat(nv-slang): discord support types + REST API fallback + A/B test coworker types`

## 📅 2026-05-08

### nv-main (18 PRs)
- **#235** `feat(nv-main): webhook PR→session round-trip routing`
- **#234** `feat(nv-main): add coworker bootstrap skill + expanded setup`
- **#231** `feat(nv-main): GitHub webhook receiver + mcp tool instruction files`
- **#230** `style(nv-main): reformat ternary in renderCoworkerSpine for readability`
- **#226** `chore(nv-main): split working-session delta (replaces #224)`
- **#221** `fix(nv-main): move dashboard-ingress into nv-main so core builds standalone`
- **#215** `fix(nv-main): skip self-referential a2a routing; raise idle-end default to 20 min; revert scheduling.md from base-common`
- **#214** `feat(nv-main): mandatory watchdog pattern for long-running tasks`
- **#211** `fix(nv-main): pass-through subagents in plan-gate and state-reset hooks`
- _+9 more: #210, #209, #207, #204, #199, #198, #193, #192, #188_

### nv-dashboard (27 PRs)
- **#232** `fix(nv-dashboard): channel-registry test + chat-sdk-bridge + index updates`
- **#223** `fix(nv-dashboard): sync dashboard-ingress from nv-main (restore for clean merges)`
- **#222** `fix(nv-dashboard): drop dashboard-ingress ownership (now lives in nv-main)`
- **#220** `fix(nv-dashboard): replace ghost shape filter with activity_count field for session visibility`
- **#219** `fix(nv-dashboard): remove InstructionsLoaded from session-flow (pure noise)`
- **#218** `fix(nv-dashboard): fix fetchCwThread guard and fetch-error handling`
- **#217** `feat(nv-dashboard): make session name in active block clickable to open thread`
- **#216** `fix(nv-dashboard): null-guard nanoclaw_session_id before rendering thread action buttons`
- **#213** `feat(nv-dashboard): add pin/rename/timeline action buttons to thread header`
- _+18 more: #208, #206, #205, #203, #202, #201, #200, #197, #196, #195, #194, #191, #190, #189, #187, #184, #183, #182_

### nv-slang (3 PRs)
- **#186** `fix(nv-slang): MCP server hygiene — env-vars, SQL injection, debug gate, stale requirements`
- **#212** `fix(nv-slang): add build watchdog and parent notification to slang-implement verify step`
- **#228** `chore(nv-slang): split working-session delta (replaces #224)`

### nv-slangpy (1 PR)
- **#229** `chore(nv-slangpy): split working-session delta (replaces #224)`

### nv-nanoclaw (1 PR)
- **#227** `chore(nv-nanoclaw): split working-session delta (replaces #224)`

## 📅 2026-05-07

### nv-main (9 PRs)
- **#148** `fix(agent-runner): handle HTTP MCP servers + route codex MCP through NVIDIA_API_KEY`
- **#149** `fix(agent-runner): use env_vars allowlist to keep OneCLI secrets out of codex TOML`
- **#153** `fix(agent-to-agent): add refreshDestinationsForAgentGroup helper`
- **#162** `chore(nv-main): move 4 token-named files to their owning buckets`
- **#168** `chore(nv-main): remove /setup and /add-coworkers — owned by nv-coworkers`
- **#169** `fix(nv-main): restore setup/SKILL.md to origin/main version (partial revert of #168)`
- **#175** `feat(nv-main): per-thread plumbing + sdk_session_routes + thread-aware a2a + backfill`
- **#178** `fix(nv-main): A2A round-trip envelope — reply routes to originating source session`
- **#180** `feat(nv-main): session display titles — schema + helper`

### nv-dashboard (6 PRs)
- **#154** `fix(dashboard): refresh destinations projection after mutating agent_destinations`
- **#163** `chore(nv-dashboard): restore 9 phantom deletes + adopt dashboard-ingress.*`
- **#176** `feat(nv-dashboard): Slack-threads UI + Timeline route-joins + session slugs + a2a inspector`
- **#177** `fix(nv-dashboard): drop duplicated session block from Recent Events + restore author-colour palette`
- **#179** `fix(nv-dashboard): strict container matching + 404 on explicit-thread misses`
- **#181** `feat(nv-dashboard): session display titles + pixel-office hit-test + artifact shell + honest pagination`

### nv-slang (1 PR)
- **#164** `chore(nv-slang): restore 9 phantom deletes + adopt architecture-alignment-slang.test.ts`

### nv-slangpy (1 PR)
- **#165** `chore(nv-slangpy): restore 9 phantom-deleted base files`

### nv-nanoclaw (1 PR)
- **#166** `chore(nv-nanoclaw): restore 9 phantom-deleted base files`

## 📅 2026-05-06

### nv-main (6 PRs)
- **#118** `fix(nv-main): require >=1 codex-critique per task before any external post`
- **#122** `feat(nv-main): license: MIT + rename base-plan→plan + critique→critique-overlay`
- **#138** `chore(nv-main): route session-local changes to nv-main`
- **#143** `skill(split-commit): add name-based ownership + path-prefix anti-pattern`
- **#145** `fix(nv-main): mtime-refresh skill mirrors so upstream changes propagate`
- **#147** `fix(nv-main): prune orphaned agent.md mirrors on wake`

### nv-dashboard (4 PRs)
- **#119** `fix(nv-dashboard): newest-first ordering, ghost-filtered sub-sessions, split Timeline picker, merge Metrics into Overview`
- **#120** `fix(nv-dashboard): attribute Codex cost to coworker; guard MCP /tools 401 parse`
- **#121** `fix(nv-dashboard): per-server tool counts in Admin → Infra MCP list`
- **#139** `chore(nv-dashboard): route session-local changes to nv-dashboard`

### nv-slang (4 PRs)
- **#117** `feat(nv-slang): annotate externally-posting slang-mcp tools with openWorldHint`
- **#124** `feat(nv-slang): license: MIT + flatten slang-maintain-release-report allowed-tools`
- **#140** `chore(nv-slang): route session-local changes to nv-slang`
- **#144** `test(nv-slang): update slang-reader scenario tests for 6→2 workflow model`

### nv-slangpy (2 PRs)
- **#125** `feat(nv-slangpy): add license: MIT to 9 project assets`
- **#141** `chore(nv-slangpy): route session-local changes to nv-slangpy`

### nv-nanoclaw (2 PRs)
- **#123** `feat(nv-nanoclaw): add license: MIT to 9 project assets`
- **#142** `chore(nv-nanoclaw): route session-local changes to nv-nanoclaw`

## 📅 2026-05-05

### nv-main (30 PRs)
- **#115** `fix(nv-main): generalize critique gate to openWorld-annotated MCP tools`
- **#114** `fix(nv-main): honor disable_overlays at runtime hook injection + R20 test`
- **#111** `fix(nv-main): per-instance CA bundle path for host-side MCP servers`
- **#109** `fix(nv-main): promote <message to="..."> to base-common invariant + plumb routing through follow-up pushes`
- **#108** `feat(nv-main): invert new_session default — fresh session per fire, opt out via new_session:false`
- **#106** `fix(agent-runner): honor new_session in the follow-up push path too (fixes PR #58 bypass)`
- **#105** `feat(nv-main): log per-turn usage in agent-runner (enables cost A/B testing)`
- **#104** `feat(nv-main): forward ENABLE_PROMPT_CACHING_1H_BEDROCK + FORCE_PROMPT_CACHING_5M into containers`
- **#103** `feat(nv-main): wire new_session end-to-end for scheduled tasks (fixes dead feature from #58)`
- _+21 more: #102, #100, #97, #96, #95, #93, #92, #90, #84, #83, #82, #80, #77, #75, #73, #72, #70, #69, #67, #63, #62_

### nv-dashboard (9 PRs)
- **#74** `fix(dashboard): Create modal lists spine types + delete cleans OneCLI + reverse dests`
- **#76** `fix(dashboard): Create modal enforces single-type selection`
- **#89** `feat(dashboard): add /api/health liveness/readiness endpoint`
- **#101** `fix(nv-dashboard): stop one bad row from bisecting the channel view`
- **#107** `fix(nv-dashboard): drop strict-auth gate on /exec endpoint`
- **#110** `fix(nv-dashboard): style agent-to-agent messages distinctly in coworker view`
- **#112** `fix(nv-dashboard): promote nanoclaw v2 session to primary identity; nest SDK UUIDs as sub-sessions`
- **#113** `fix(dashboard): subtract cached tokens from codex INPUT column`
- **#116** `fix(nv-dashboard): thread disable_overlays through on-demand spine preview`

### nv-slang (7 PRs)
- **#65** `refactor(nv-slang): move spine + workflows to new layout`
- **#71** `test(nv-slang): update spine-size ceiling post-refactor`
- **#85** `refactor(nv-slang): sweep stale /workspace/group → /workspace/agent`
- **#87** `fix(nv-slang): drop stale codex-critique from spine skills array`
- **#94** `fix(nv-slang): drop backticked /regenerate-toc from slang-document WORKFLOW.md`
- **#98** `feat(nv-slang): declare slang-maintain-release-report in slang-common skills`
- **#99** `chore(nv-slang): sync slang-fixer and slang-triage coworker bundles with cleaned prod instructions`

### nv-slangpy (2 PRs)
- **#66** `refactor(nv-slangpy): move spine + workflows to new layout`
- **#88** `fix(nv-slangpy): drop stale codex-critique from spine skills array`

### nv-nanoclaw (3 PRs)
- **#64** `refactor(nv-nanoclaw): move spine + workflows to new layout`
- **#86** `fix(nv-nanoclaw): drop stale codex-critique from spine skills array`
- **#91** `fix(nv-nanoclaw): drop dup base workflows from nanoclaw-common + -writer`

## 📅 2026-05-04

### nv-main (1 PR)
- **#58** `feat(agent-runner): new_session flag for scheduled tasks`

### nv-dashboard (1 PR)
- **#59** `feat(dashboard): include @ccusage/codex metrics in cost panel`

## 📅 2026-05-02

### nv-main (3 PRs)
- **#51** `fix(onboard-coworker): auto-wire destinations from YAML bundle after create_agent`
- **#54** `fix(container): git push via OneCLI proxy Basic auth injection`
- **#57** `fix(container): set git insteadOf rewrite at container startup for HTTPS push via OneCLI proxy`

### nv-slang (2 PRs)
- **#50** `fix(slang-mcp): merge system CA bundle with OneCLI CA for SSL verification`
- **#56** `fix(slang-mcp): OneCLI proxy auth + SSL CA bundle merge`

## 📅 2026-05-01

### nv-slang (1 PR)
- **#49** `fix(slang-mcp): replace static PAT with OneCLI proxy auth`

## 📅 2026-04-30

### nv-main (11 PRs)
- **#48** `fix(container): disable bwrap in Codex config.toml for Docker compatibility`
- **#47** `fix(container): set GIT_SSL_CAINFO so git works through OneCLI proxy`
- **#46** `fix(sweep): kill+respawn stale containers instead of /clear`
- **#45** `feat(nv-main): Codex provider parity — skill body loading, hook enforcement, additional dir discovery`
- **#44** `fix(onecli): namespace CA cert files to avoid multi-instance collision`
- **#43** `fix(mcp): restore OneCLI proxy for host-side MCP servers`
- **#42** `fix(gpu): detect NVIDIA runtime via docker info, prefer --runtime=nvidia`
- **#41** `fix(critique-overlay): resist scope-shrinkage and circular tests in PLAN_REVIEW`
- **#40** `feat: codex-critique direct + critique enforcement + intent-router + GPU + workflow-state`
- _+2 more: #38, #36_

### nv-dashboard (1 PR)
- **#39** `feat(nv-dashboard): add Metrics panel with cost tracking, activity, users, channels`

### nv-slang (1 PR)
- **#37** `fix(slang-mcp): honor SSL_CERT_FILE for OneCLI proxy trust`

## 📅 2026-04-29

### nv-main (3 PRs)
- **#24** `docs: rewrite split-commit skill from battle-tested nv-* branch split`
- **#26** `fix: name-based migration detection, prettier, debug checklist`
- **#25** `fix(overlays): enforce plan + critique gates via runtime hooks`

### nv-slang (4 PRs)
- **#27** `fix: ensure pr-knowledge DB schema exists before querying`
- **#28** `fix: drop leaked session-manager.ts that regresses path-traversal guard`
- **#29** `fix(slang): remove plan-overlay (merged into critique-overlay)`
- **#32** `fix(nv-slang): strip 5 non-slang files leaked from prod install`

### nv-slangpy (1 PR)
- **#30** `fix(slangpy): remove plan-overlay (merged into critique-overlay)`

### nv-nanoclaw (1 PR)
- **#31** `fix(nanoclaw): remove plan-overlay (merged into critique-overlay)`

## 📅 2026-04-28

### nv-main (5 PRs)
- **#8** `docs: add onboard-project section to USAGE.md`
- **#9** `fix: pidfile singleton guard`
- **#18** `Fix container timeout ceiling + add GPU passthrough`
- **#19** `fix: parse JSON array for allowed_mcp_tools`
- **#12** `fix: add discord.com to NO_PROXY (keep api.github.com routed through proxy)`

### nv-dashboard (1 PR)
- **#10** `fix: dashboard responsive layout + rem font units`

### nv-slang (2 PRs)
- **#11** `feat: Discord support bot with feedback collector`
- **#13** `feat(nv-slang): Discord support bot with feedback collector`

<!-- END AUTO -->
