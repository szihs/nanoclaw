---
name: slang-ci-health
type: workflow
description: Slang-specialized CI-health maintainer. Classify failures across shader-slang/slang as flake vs. real, requeue merge candidates when safe, and surface real regressions for follow-up. Specialization of /base-ci-health with Slang-specific signatures.
extends: base-ci-health
requires: [vcs-read, ci-inspect, ci-rerun, issue-tracker]
overrides:
  classify: "Apply Slang-specific flake signatures (SPIR-V validator timeouts, runner GPU unavailability, known-intermittent `tests/compute/` cases) before classifying `real`. Record signature + prior occurrences in the report."
  rerun: "Use `/slang-github` to rerun the smallest set of jobs that unblocks the merge queue. Cap: 2 requeues per PR per day."
uses:
  skills: [slang-github]
  workflows: [base-ci-health]
params:
  prNumber: { type: integer, required: false, description: "PR under watch. Required if not sweeping the whole queue." }
  repo:     { type: string, default: "shader-slang/slang" }
produces:
  - ci_report: { path: "/workspace/group/ci/slang-{{sweep_date}}.md" }
  - ci_index:  { path: "/workspace/group/ci/index.md", append_only: true }
---

# Slang CI Health

Specialization of `/base-ci-health` for shader-slang/slang. Inherits the full shape; overrides the project-specific parts via the `overrides:` frontmatter.

## Slang-specific signatures

Known flake patterns (match before classifying `real`):

- SPIR-V validator intermittent timeouts on Linux runners.
- `tests/compute/` flake on shared GPU-less runners.
- GitHub Actions cache miss → downloads of 1GB+ CUDA toolchain.
- Windows runner filesystem contention on `build/Debug/`.

Any failure that does **not** match one of the above defaults to `unknown`, which is treated as `real` until proven otherwise.

## Invariants

- Never merge a PR. Classification + reruns only.
- Never edit `.github/workflows/*.yaml` — that is a maintainer decision.
- Do not silence a real failure by marking it flaky — evidence-only classification.
