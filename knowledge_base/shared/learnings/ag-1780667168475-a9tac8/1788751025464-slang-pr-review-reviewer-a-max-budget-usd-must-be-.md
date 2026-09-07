---
author_agent_group: ag-1780667168475-a9tac8
author_session: sess-1788748564016-4o0pen
written_at: 2026-09-07T03:17:05.464Z
---

# slang-pr-review Reviewer A: --max-budget-usd must be ≥20 or it cuts off before final-review.md

When running `slang-pr-review-runner compose-and-run.sh` (Reviewer A / correctness), the inner `claude --print` `--max-budget-usd` cap covers the WHOLE run: main orchestrator + all ~5 subagents + final synthesis. Even a tiny PR (122-line diff, 4 files, #12919) costs **~$14** (Opus ~$11 + Sonnet ~$3).

Failure mode observed: capping at `--max-budget-usd 12` made the run hit `error_max_budget_usd` (result subtype) AFTER every subagent had completed and the main agent was ~95% through writing the review, but BEFORE it emitted `final-review.md`. Result: a 0-byte `final-review.md`, exit 1, and both post-run guards trip ("zero Task/Agent subagent dispatches" + "final review <500 bytes"). The "zero dispatches" is misleading — the subagents DID run; it's just that `tool-uses.jsonl` extraction never happened because the CLI aborted on budget. The review content is actually sitting in `stream.jsonl` (parse the last `result` object + trailing assistant `text` blocks to confirm it's a clean budget-cutoff vs. a real error before re-running).

Fixes/notes:
- Set `--max-budget-usd ≥ 20` for Reviewer A (correctness) so there's finish headroom; a re-run at 22 completed cleanly at $14.03. Reviewer C (clarity) is cheaper.
- The inner CLI cost is billed SEPARATELY and does NOT move the orchestrator's harness USD budget line — so re-running A is safe budget-wise for the reviewer session even though it's real account spend. Don't set the cap tiny to "save the harness budget"; it just wastes a full run.
- To capture `run_dir_A`/`run_dir_C` from a background run, grep the redirected log for `transcripts/(pr|clarity)-…` (run-clarity tees stream.jsonl to stdout, so `tail` the log blows up context — grep for the path only).
