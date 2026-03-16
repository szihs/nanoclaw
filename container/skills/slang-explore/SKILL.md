---
name: slang-explore
description: Explore the Slang compiler architecture, trace features through the codebase, and understand design patterns. Use when investigating how a feature works or planning changes.
allowed-tools: Bash(find:*), Bash(grep:*), Bash(wc:*)
---

# Slang Codebase Exploration

## Repository Structure

```
slang/
├── source/slang/          # Core compiler source
│   ├── slang-ast-*.h/cpp  # AST node definitions
│   ├── slang-check-*.cpp  # Semantic checking / type checking
│   ├── slang-emit-*.cpp   # Backend code emission (HLSL, GLSL, CUDA, SPIRV, etc.)
│   ├── slang-ir*.h/cpp    # Intermediate representation
│   ├── slang-parser*.cpp  # Parser
│   ├── slang-lexer*.cpp   # Lexer/tokenizer
│   ├── slang-lower*.cpp   # Lowering passes
│   └── slang-compiler*.cpp # Compiler driver
├── source/core/           # Core utilities (strings, containers, etc.)
├── source/compiler-core/  # Shared compiler infrastructure
├── tools/                 # Command-line tools (slangc, etc.)
├── tests/                 # Test suite
│   ├── tests/compute/     # Compute shader tests
│   ├── tests/hlsl/        # HLSL compatibility tests
│   ├── tests/bugs/        # Bug regression tests
│   └── tests/diagnostics/ # Error message tests
├── docs/                  # Documentation
├── slang-llvm/            # LLVM integration
├── prelude/               # Stdlib prelude files
└── CMakeLists.txt         # Build system
```

## Key Architectural Components

### Frontend Pipeline
1. **Lexer** (`slang-lexer.cpp`) → tokens
2. **Parser** (`slang-parser.cpp`) → AST
3. **Semantic Check** (`slang-check*.cpp`) → typed AST
4. **Lower to IR** (`slang-lower-to-ir.cpp`) → IR

### IR System
- Node definitions: `slang-ir.h`, `slang-ir-insts.h`
- Passes: `slang-ir-*.cpp` (optimization, specialization, legalization)
- SSA-based intermediate representation

### Backend Pipeline
- **HLSL**: `slang-emit-hlsl.cpp`
- **GLSL**: `slang-emit-glsl.cpp`
- **CUDA**: `slang-emit-cuda.cpp`
- **SPIRV**: `slang-emit-spirv*.cpp`
- **C/C++**: `slang-emit-c-like.cpp` (base class)
- **Metal**: `slang-emit-metal.cpp`
- **WGSL**: `slang-emit-wgsl.cpp`

## Tracing a Feature

To understand how a feature works end-to-end:

1. **Find the syntax**: Search parser for the keyword
   ```bash
   grep -rn "keyword_name" source/slang/slang-parser*.cpp
   ```

2. **Find the AST node**: Search AST definitions
   ```bash
   grep -rn "class.*Decl\|class.*Expr\|class.*Stmt" source/slang/slang-ast-*.h | grep -i "feature"
   ```

3. **Find semantic checking**: Search check files
   ```bash
   grep -rn "visit.*FeatureName\|check.*FeatureName" source/slang/slang-check*.cpp
   ```

4. **Find IR lowering**: Search lower files
   ```bash
   grep -rn "emit.*FeatureName\|lower.*FeatureName" source/slang/slang-lower*.cpp
   ```

5. **Find backend emission**: Search emit files
   ```bash
   grep -rn "FeatureName" source/slang/slang-emit-*.cpp
   ```

6. **Find tests**: Search test suite
   ```bash
   find tests/ -name "*.slang" | xargs grep -l "feature_keyword"
   ```

## Useful Exploration Commands

Count lines per component:
```bash
wc -l source/slang/slang-ir*.cpp source/slang/slang-ir*.h | sort -n
```

Find all IR instruction types:
```bash
grep -h "INST(" source/slang/slang-ir-insts.h | head -50
```

Find all AST node types:
```bash
grep "class.*Decl\b" source/slang/slang-ast-decl.h
grep "class.*Expr\b" source/slang/slang-ast-expr.h
grep "class.*Stmt\b" source/slang/slang-ast-stmt.h
```

Find all backend targets:
```bash
ls source/slang/slang-emit-*.cpp
```

## Writing Exploration Reports

When exploring a feature, create a structured report in `/workspace/group/investigations/`:

```markdown
# Investigation: <Feature Name>

## Summary
One-paragraph overview of how the feature works.

## Pipeline Trace
1. **Syntax**: How it's parsed (file:line)
2. **AST**: Node type and structure
3. **Checking**: Semantic validation
4. **IR**: How it's represented
5. **Backend**: How each target emits it

## Key Files
- file1.cpp:123 — description
- file2.h:45 — description

## Open Questions
- Things that need further investigation
```
