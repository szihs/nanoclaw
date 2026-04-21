---
name: base-test-gen
type: workflow
description: Generate tests for an under-tested function, module, or bug class. Use when coverage is missing, a regression needs a pinning test, or a refactor needs safety nets before it lands. Not for fixing bugs — tests only.
requires: [code-read, test-run, test-gen, vcs-pr]
uses:
  skills: []
  workflows: []
params:
  target: { type: string, required: true, description: "Module / function / file to cover." }
  repo:   { type: string, required: true }
  style:  { type: enum, default: "table", enum: ["table", "property", "example"], description: "Preferred test shape." }
produces:
  - test_log: { path: "/workspace/group/tests/{{target_slug}}.md" }
  - patch:    { path: "git commit on {{branch}}" }
---

# Base Test Gen

Project-agnostic test-generation workflow. Writes **tests only** — never modifies production code.

## Invariants

- Tests must fail against the current code only when the behavior they assert is actually wrong. No tautological tests.
- Prefer the project's existing test harness, fixtures, and conventions. Do not introduce a new framework.
- Every generated test has a docstring or comment stating the intent in one line — "what does this protect?".
- Do not skip or xfail a test you wrote in the same commit.

## Steps

1. **Read the target** {#read} — understand the signature, inputs, outputs, and edge cases. Note invariants the target is supposed to maintain.

2. **Enumerate cases** {#enumerate} — happy path, boundary, error, and interaction with neighboring modules. Prioritize cases that would catch the classes of bug you've seen before in this subsystem.

3. **Generate** {#generate} — write tests in the project's style (`{{style}}`). Keep each test focused; avoid fixture sprawl.

4. **Run + verify** {#verify} — run the new tests. They must pass. Flip one target invariant locally to confirm at least one test actually fails when behavior breaks.

5. **Commit + PR** {#commit} — tests-only commit. Log what's covered, what's explicitly not, and why, to `{{test_log.path}}`.

## Handoff

- If generating the test reveals a bug, stop, log it, and route to a fix workflow — do not silently fix it here.
- If coverage cannot be written without restructuring production code, note the blocker and propose a test-support patch in a separate follow-up.
