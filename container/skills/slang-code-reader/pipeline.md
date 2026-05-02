# Compiler Pipeline

```
Source → Lexer → Preprocessor → Parser → AST → Semantic Check → Lower to IR → IR Passes → Backend Emit
```

## Stage Details

### 1. Lexer (`slang-lexer.cpp`)
Produces `Token`s from source text. Stores `TokenCode`, raw text, and source location. Handles C-isms (backslash continuation, `#include` angle brackets). Does NOT extract literal values or distinguish keywords from identifiers.

### 2. Preprocessor (`slang-preprocessor.cpp`)
Runs over full source file at once, producing flat token array. Handles `#include`, macros, conditionals. No interaction with parser — all preprocessing completes before parsing begins.

### 3. Parser (`slang-parser.cpp`)
Recursive-descent, arbitrary lookahead (input is pre-tokenized). Uses heuristic approach for `<` ambiguity (generic vs comparison). Produces AST where types and expressions share representation (resolved later). Syntax keywords are looked up in environment, not hardcoded.

### 4. Semantic Check (`slang-check-*.cpp`)
The largest and most complex phase. Handles:
- Name resolution and overload resolution
- Type checking and inference
- Generic instantiation and interface conformance
- Witness table generation

Key files:
| File | Phase |
|------|-------|
| `slang-check-decl.cpp` | Declaration checking |
| `slang-check-expr.cpp` | Expression type checking |
| `slang-check-stmt.cpp` | Statement validation |
| `slang-check-impl.cpp` | Interface/generic implementation (10k+ lines) |
| `slang-check-overload.cpp` | Overload resolution |

### 5. Lower to IR (`slang-lower-to-ir.cpp`)
Converts typed AST to SSA-based IR. Key transformations:
- Member functions → free functions with `this` parameter
- Nested structs → top-level structs
- Compound expressions → instruction sequences
- Control flow → CFG of basic blocks
- Attaches mangled names to symbols

Done once per translation unit, target-independent.

### 6. IR Passes (`slang-ir-*.cpp`)
158+ instruction types (defined via macros in `slang-ir-insts.h`). Passes include:
- SSA promotion and copy propagation (mandatory)
- Dead code elimination
- Specialization (generics, interfaces)
- Legalization (target-specific transforms)

### 7. Backend Emit (`slang-emit-*.cpp`)
Target-specific code generation. See `backends.md`.

## Tracing a Feature

To understand how a feature flows end-to-end:

```bash
# 1. Find the syntax keyword
grep -rn "keyword" source/slang/slang-parser*.cpp

# 2. Find the AST node
grep -rn "class.*Decl\|class.*Expr\|class.*Stmt" source/slang/slang-ast-*.h | grep -i "feature"

# 3. Find semantic checking
grep -rn "visit.*Feature\|check.*Feature" source/slang/slang-check*.cpp

# 4. Find IR lowering
grep -rn "emit.*Feature\|lower.*Feature" source/slang/slang-lower*.cpp

# 5. Find IR representation
grep -rn "Feature" source/slang/slang-ir-insts.h

# 6. Find backend emission
grep -rn "Feature" source/slang/slang-emit-*.cpp

# 7. Find test coverage
find tests/ -name "*.slang" | xargs grep -l "feature_keyword"
```

## Useful Commands

```bash
# Count lines per component
wc -l source/slang/slang-ir*.cpp source/slang/slang-ir*.h | sort -n

# All IR instruction types
grep -h "INST(" source/slang/slang-ir-insts.h | head -50

# All AST node types by category
grep "class.*Decl\b" source/slang/slang-ast-decl.h
grep "class.*Expr\b" source/slang/slang-ast-expr.h
grep "class.*Stmt\b" source/slang/slang-ast-stmt.h

# All backend emitters
ls source/slang/slang-emit-*.cpp
```
