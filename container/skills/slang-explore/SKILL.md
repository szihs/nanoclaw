---
name: slang-explore
description: "Investigate the Slang compiler codebase before making changes. Trigger when you need to trace a feature through the pipeline, understand how code works, or plan an implementation. Read-only — no edits. Keywords: investigate, trace, explore, analyze, git log -S, pipeline."
provides: [code-read, doc-read]
allowed-tools: Bash, Read, Grep, Glob, mcp__deepwiki__ask_question
---

# Slang Explore

Read-only investigation of the Slang compiler codebase. Use `/slang-build` first to ensure the repo is cloned.

## Useful Commands

```bash
cd /workspace/group/slang

# Search git history for when a feature was introduced
git log -S "keyword" --oneline -- source/slang/

# Search for function/type definitions
grep -rn "functionName" source/slang/ --include="*.cpp" --include="*.h"

# Find all files touching a feature
git log --all --oneline --name-only -- "*keyword*"

# Dump IR at every pass
./build/Debug/bin/slangc -dump-ir -target spirv-asm -o /dev/null test.slang

# Trace a specific IR instruction
SLANG_INST_TRACE=0x1234 ./build/Debug/bin/slangc ...

# SPIRV validation
SLANG_RUN_SPIRV_VALIDATION=1 ./build/Debug/bin/slangc -target spirv ...
```

Use `mcp__deepwiki__ask_question` with `repoName: "shader-slang/slang"` for high-level documentation lookups.

## Compiler Pipeline

Trace your feature through the 7 stages:

| Stage | Key Files | What to Look For |
|-------|----------|-----------------|
| Lexer | `source/compiler-core/slang-lexer.cpp` | New tokens |
| Preprocessor | `source/slang/slang-preprocessor.cpp` | Macro handling |
| Parser | `source/slang/slang-parser.cpp` | AST node creation |
| Semantic Check | `source/slang/slang-check-*.cpp` | Type checking, validation |
| IR Generation | `source/slang/slang-lower-to-ir.cpp` | AST → IR lowering |
| IR Passes | `source/slang/slang-ir-*.cpp` | Optimization, specialization |
| Code Emission | `source/slang/slang-emit-*.cpp` | Target-specific output |

See pipeline.md for detailed per-stage descriptions and backends.md for emitter architecture.

## Gotchas

- **Single-dash options**: Slang uses `-help`, `-target`, `-dump-ir` — NOT double-dash `--help`
- **X-macro IR instructions**: `slang-ir-insts.h` uses Lua-generated macros. Searching for an instruction by name requires understanding the `INST()` macro pattern — grep for `kIROp_YourInst` or check `slang-ir-insts.lua`
- **Large source tree**: `grep -rn` on 800+ files in `source/slang/` is slow. Narrow with `--include="*.cpp"` or use `git log -S` for historical search
- **IR dump is verbose**: `-dump-ir` outputs every pass. Pipe through `grep` or redirect to a file

## Related Skills

- `/slang-build` — clone, build, run tests
- `/slang-fix` — implement changes after investigation
- `/slang-github` — fetch issue/PR context before investigating
- `/slang` — role reference for understanding team domain boundaries
