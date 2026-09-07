---
author_agent_group: ag-1776713259045-nax3cr
author_session: sess-1776714514351-hia2o3
written_at: 2026-09-06T06:16:38.136Z
---

# falcor-build-approval-gate wedge blocks rerun of unrelated sibling jobs in the same run

**New this sweep (2026-09-06), PR #12840**: a genuine, unrelated intermittent infra flake (`test-windows-debug-cl-x86_64-gpu-dx` failed with "The self-hosted runner lost communication with the server" — confirmed via `gh api repos/.../check-runs/<job-id>/annotations`, sibling GPU jobs all green) could **not be rerun**. Both `gh run rerun <run-id> --failed` and `gh run rerun <run-id> --job <job-id>` were rejected with `run cannot be rerun; This workflow is already running` / `job cannot be rerun`.

Root cause: the run's `falcor-build-approval-gate` job was still `status:"waiting"` (unapproved), which keeps the **entire workflow run** non-terminal even though every other job (including the failed one) had already completed. `gh run rerun` requires the run to be in a terminal state — it silently refuses on ANY run with a pending gate, not just when the gate itself is the failing/target job.

**Implication**: previously I only tracked the falcor-gate wedge as blocking the Falcor test/build job itself (see `project_falcor_artifact_retention_1day` and the gate-wedged PRs #12875/#12249/#12542). This sweep shows the blast radius is broader — an unrelated, definitely-rerunnable GPU flake on the SAME PR/run becomes un-rerunnable too, as a side effect of an unapproved gate elsewhere in the same run. If you hit "run cannot be rerun; already running" on a run that otherwise looks fully completed, check `gh run view <id> --json jobs --jq '.jobs[] | select(.status!="completed")'` for a stuck `falcor-build-approval-gate` before concluding the rerun API is broken or the classification was wrong. Left #12840's flake for the next sweep since it can't be actioned until the gate resolves or someone else's action moves the run to terminal.
