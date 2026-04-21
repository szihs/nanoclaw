---
name: slang-patch
description: "Implement a code change, bug fix, or new test in the Slang compiler. Trigger after investigation is complete and you know what to change. Requires /slang-build (repo built) and /slang-explore (code understood). Keywords: patch, implement, edit, branch, commit, test, write code."
provides: [code-edit, test-gen]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
argument-hint: "[brief description of what to change]"
---

# Slang Patch

Implement code changes in the Slang compiler. Use `/slang-explore` first to understand the code.

## Prerequisites

- `/slang-build` — repo must be cloned and built
- `/slang-explore` — investigate the relevant code paths first

## Branch Naming

```
slang/fix-<short-desc>-issue<NUMBER>
slang/feat-<short-desc>
```

## Build & Test

```bash
cd /workspace/group/slang
cmake --build --preset debug --parallel 2

# Run specific test
./build/Debug/bin/slang-test tests/your-test.slang

# Run full suite
./build/Debug/bin/slang-test
```

## Before Committing

```bash
./extras/formatting.sh    # required — PR CI will reject unformatted code
git add <specific files>  # don't use -A — avoid staging unintended files
git commit -m "Fix #<NUMBER>: <concise description>"
```

## Test Patterns

See test-patterns.md for `//TEST` directive formats, test file placement, and examples.

## Gotchas

- **Build path**: Use `build/Debug/bin/` (from cmake preset). `build/Release/bin/` only exists with a Release preset
- **`formatting.sh` requires clang-format**: Install with `sudo apt-get install -y clang-format` if missing. Version mismatch can cause spurious diffs
- **`slang-test` exit code 0 on skip**: Tests skipped due to missing GPU return 0, not failure. Check output for "SKIPPED" to confirm tests actually ran
- **Test placement**: `tests/bugs/` for bug regressions, `tests/compute/` for compute shaders, `tests/hlsl/` for HLSL compat, `tests/diagnostics/` for error message validation
- **Large files**: `source/slang/slang-parser.cpp` is 15k+ lines. Use Grep to find the relevant section before editing

## Related Skills

- `/slang-build` — if build fails or repo needs rebuilding
- `/slang-explore` — investigate code paths before or during implementation
- `/slang-github` — create a PR after the fix is ready
