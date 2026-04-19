---
name: slang-triage
type: workflow
description: Triage an incoming Slang compiler issue into a subsystem + severity + next-step report. Use when a new GitHub issue is filed on shader-slang/slang or a user asks to triage a Slang bug. Specialization of /base-triage with Slang subsystem mapping.
extends: base-triage
requires: [issue-tracker, code-read]
overrides:
  investigate: "Use `/slang-explore` to map symptoms onto Slang subsystems (lexer, parser, semantic-check, IR, emit, reflection). Record one primary subsystem + up to two secondaries."
uses:
  skills: [slang-github, slang-explore]
  workflows: [base-triage]
params:
  issueNumber: { type: integer, required: true }
  repo: { type: string, default: "shader-slang/slang" }
produces:
  - triage_report: { path: "/workspace/group/reports/issue-{{issueNumber}}.md" }
---

# Slang Triage

Project-specific specialization of `/base-triage` for Slang compiler issues.

## Steps

1. **Run base triage** — invoke `/base-triage target={{repo}}#{{issueNumber}}`. Use its structured output as the scaffold.

2. **Read the issue** with `/slang-github read issue {{issueNumber}}`. Include all comments, labels, and linked PRs in the ingestion summary.

3. **Map subsystem** with `/slang-explore`. Slang subsystems and their characteristic files:

   | Subsystem | Characteristic files |
   |-----------|----------------------|
   | Lexer / preprocessor | `source/compiler-core/slang-lexer.cpp`, `source/slang/slang-preprocessor.cpp` |
   | Parser | `source/slang/slang-parser*.cpp` |
   | Semantic check | `source/slang/slang-check-*.cpp` |
   | Type system | `source/slang/slang-type-layout.cpp`, `slang-check-generics.cpp`, `slang-check-conformance.cpp` |
   | AST | `source/slang/slang-ast-*.h` |
   | IR | `source/slang/slang-ir*.{h,cpp}`, `slang-lower-to-ir.cpp` |
   | IR specialization / autodiff | `source/slang/slang-ir-specialize.cpp`, `slang-ir-autodiff*.cpp` |
   | Emit / codegen | `source/slang/slang-emit-*.cpp` |
   | Reflection / public API | `include/slang.h`, `source/slang/slang.cpp`, `slang-reflection.cpp` |
   | Capabilities | `source/slang/slang-capability.*` |

   Record the subsystem candidates in the triage report. Prefer naming one primary + up to two secondaries; do not list every subsystem.

4. **Search for duplicates and related work** with `/slang-github search`. Check closed and open issues/PRs in `{{repo}}`. Label-match on subsystem tags where available.

5. **Finalize the report** at `{{triage_report.path}}` following the `/base-triage` template, with Slang-specific additions:
   - `subsystem`: primary + secondaries from step 3.
   - `reproduction`: Slang source + compile command if the reporter provided one, else `none`.
   - `codegen target`: if the issue is target-specific (HLSL, GLSL, SPIR-V, Metal, WGSL, CPU, CUDA), name it.

6. **Post upstream** — comment on the issue with the triage summary. Do not self-assign; do not close as duplicate without maintainer sign-off.

## Slang-specific invariants

- The compiler test suite is the ground truth for reproduction. If the issue cannot be reduced to a `tests/` file, say so explicitly.
- Do not speculate on fix complexity — that is the fix workflow's job.
- `include/slang.h` and public reflection APIs are stable surface. Flag any triage that implies changing them.
