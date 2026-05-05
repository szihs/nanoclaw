---
name: slang-code-reader
description: "Read-only investigation of the Slang compiler codebase. Navigate source, trace compiler pipelines, understand architecture."
provides: [code.read, doc.read]
allowed-tools: Bash, Read, Grep, Glob, mcp__deepwiki__ask_question
---

## From project

Drawn from: `repos/slang/CLAUDE.md` (architecture overview, development workflow), `repos/slang/.claude/agents/code-quality-reviewer.md` (consistency checks, semantic checker patterns, unchecked casts), `repos/slang/.claude/agents/cross-backend-reviewer.md` (emit parity, sibling emitter grep), `repos/slang/.claude/agents/ir-correctness-reviewer.md` (SSA invariants, pass ordering, type legalization), `repos/slang/.claude/agents/documentation-accuracy-reviewer.md` (doc drift, stale comments), `repos/slang/.claude/agents/security-code-reviewer.md` (memory safety, UB, input handling), `repos/slang/.claude/agents/test-coverage-reviewer.md` (regression test requirements, test quality).

## Compiler pipeline

```
Lexer (compiler-core/slang-lexer.cpp)
  -> Preprocessor (slang/slang-preprocessor.cpp)
    -> Parser (slang/slang-parser.cpp) -- recursive descent, produces AST
      -> Semantic Checker (slang/slang-check.cpp) -- type checking, name resolution
        -> IR Generation (slang/slang-lower-to-ir.cpp)
          -> IR Passes (slang/slang-ir-*.cpp) -- optimization, lowering
            -> Code Emission (slang/slang-emit-*.cpp) -- target-specific codegen
```

## Key search strategies

- **Emitters**: `source/slang/slang-emit-*.cpp` -- SPIRV, HLSL, GLSL, Metal, CUDA, WGSL. When investigating one emitter, always grep sibling emitters for the same pattern.
- **IR passes**: `source/slang/slang-ir-*.cpp`. IR instructions defined in `slang-ir-insts.lua`. Generated enum: `build/source/slang/fiddle/slang-ir-insts-enum.h.fiddle`.
- **Semantic checker**: `source/slang/slang-check-*.cpp` -- overload resolution, generic constraints, witness tables.
- **Type legalization**: `slang-ir-spirv-legalize.cpp`, `slang-legalize-types.h`, `slang-ir-lower-buffer-element-type.cpp`.
- **Standard library**: `prelude/` and `source/slang-core-module/` -- built-in functions, `*.meta.slang`.
- **Public API**: `include/slang.h` -- COM-style vtable interfaces. ABI-stable.
- **Tests**: `tests/` -- `.slang` files with test directives.

## Review checklists (from project agents)

When investigating code, apply these domain-specific checklists:

**Code quality**: Verify consistency across similar locations -- new IROp in some switch statements but missing from others, null checks on `as<T>()` calls, new backend in dispatch tables. Check unchecked casts, missing switch cases, emit code doing transforms that belong in IR passes.

**Cross-backend**: When a change touches `slang-emit-*.cpp`, immediately grep all sibling emitters. Flag complex transforms in emit that should be IR passes. Check capability requirements, resource binding compatibility, target-specific legalization.

**IR correctness**: Verify SSA form (use-def chains, phi nodes). Check pass ordering -- new passes at correct pipeline position. Validate type legalization (mixing data and resources in structs). Check `slang-ir-insts.lua` definitions.

**Security/UB**: Null pointer after `as<T>()` casts, out-of-bounds array access, use-after-free from IR instruction deletion, signed integer overflow, uninitialized variables, input sanitization for paths and preprocessor directives.

**Test coverage**: Bug fixes must have regression tests. New features need `.slang` test files. Use CPU or INTERPRET directives for no-GPU environments. Verify filecheck patterns, not just compilation.

**Documentation**: Check for stale inline comments near changed code. Verify `include/slang.h` function comments match behavior. Check `docs/user-guide/` for feature coverage.

## DeepWiki

For architecture questions about the upstream repo:
```
mcp__deepwiki__ask_question("shader-slang/slang", "your question here")
```
