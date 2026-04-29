---
name: slang-build
description: "Build and test the Slang compiler. Configure CMake, compile, run slang-test, inspect CI."
provides: [code.build, test.run, test.gen, ci.inspect]
allowed-tools: Bash(git:*), Bash(cmake:*), Bash(python:*), Bash(ninja:*), Read, Grep, Glob
---

## From project

Drawn from: `repos/slang/CLAUDE.md` (build system, testing, debugging sections), `repos/slang/.claude/skills/repro-remix/SKILL.md` (RTX Remix shader repro), `repos/slang/.claude/skills/slangpy-debug/SKILL.md` (SlangPy compatibility testing).

## Build

Slang uses CMake presets. Redirect build output to null on first attempt to save tokens.

```bash
# Configure (Ninja Multi-Config)
cmake --preset default

# Build debug (redirect, re-run on failure for logs)
cmake --build --preset debug >/dev/null 2>&1 || cmake --build --preset debug

# Build release
cmake --build --preset release >/dev/null 2>&1 || cmake --build --preset release

# Specific targets only
cmake --build --preset debug --target slangc
cmake --build --preset debug --target slang-test
```

**sccache**: Pass `-DSLANG_USE_SCCACHE=ON` at configure time for faster rebuilds. Requires `sccache` in PATH.

## Test

slang-test must run from the repository root.

```bash
# All tests (multi-server, 10-30 min)
./build/Release/bin/slang-test -use-test-server -server-count 8

# Specific test file
./build/Release/bin/slang-test tests/path/to/test.slang

# Unit tests
./build/Release/bin/slang-test slang-unit-test-tool/
```

**Writing tests without GPU** (no GPU available in containers):

- CPU compute: `//TEST:COMPARE_COMPUTE(filecheck-buffer=CHECK):-cpu -output-using-type`
- Interpreter: `//TEST:INTERPRET(filecheck=CHECK):`
- Diagnostic tests: `//DIAGNOSTIC_TEST:SIMPLE(diag=CHECK):-target spirv`

See `tests/language-feature/lambda/lambda-0.slang` for a full CPU test example.

**SPIRV validation**: Set `SLANG_RUN_SPIRV_VALIDATION=1` when using `slangc -target spirv`. Do not use the system's `spirv-val`.

## Debugging tools

**IR Dump**: Always combine `-dump-ir` with `-target` and `-o`.

```bash
slangc -dump-ir -target spirv-asm -o tmp.spv test.slang | python extras/split-ir-dump.py
slangc -dump-ir-before lowerGenerics -dump-ir-after lowerGenerics -target spirv-asm -o tmp.spv test.slang > pass.dump
```

**InstTrace** (trace where a problematic IR instruction was created):

```bash
python3 ./extras/insttrace.py <debugUID> ./build/Debug/bin/slangc tests/my-test.slang -target spirv
```

**RTX Remix shader repro**: `./extras/repro-remix.sh` clones dxvk-remix, replaces Slang with local build, compiles all shaders with SPIRV validation. Use `--clean` for fresh clone.

**SlangPy compat testing**: Clone `external/slangpy`, build with local Slang via `CMAKE_ARGS="-DSGL_LOCAL_SLANG=ON -DSGL_LOCAL_SLANG_DIR=../.. -DSGL_LOCAL_SLANG_BUILD_DIR=build/Debug" python -m pip install -e .`

## CI

CI runs via `.github/workflows/ci.yml`. To inspect failures:

```bash
gh run list --repo shader-slang/slang --workflow=ci.yml --limit 5
gh run view <run-id> --log-failed
```

## Command line

Slang uses single dashes for multi-character options: `-help`, `-target spirv`, `-dump-ir`, `-stage compute`. Not double dashes.

## AVOID

Do NOT use: `-dump-ast`, `-dump-intermediate-prefix`, `-dump-intermediates`, `-dump-ir-ids`, `-serial-ir`, `-dump-repro`, `-load-repro`, `-extract-repro`, `-category`, `-api`.
