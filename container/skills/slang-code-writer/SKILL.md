---
name: slang-code-writer
description: "Implement changes in the Slang compiler. Edit code, write tests, format, commit."
provides: [code.read, code.edit, test.gen]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

## From project

Drawn from: `repos/slang/CLAUDE.md` (development workflow, code style), `repos/slang/CONTRIBUTING.md` (contribution process, formatting, testing), `repos/slang/.github/copilot-instructions.md` (formatting, testing directives).

## Code style

Follow Slang coding conventions (`docs/design/coding-conventions.md`):

- Indent by four spaces. No tabs except in Makefiles.
- No STL containers, iostreams, or built-in C++ RTTI.
- Use `<stdio.h>` not `<cstdio>`.
- Types: UpperCamelCase. Values: lowerCamelCase. Macros: `SLANG_SCREAMING_SNAKE`.
- Globals: `g` prefix. Static class members: `s` prefix. Constants: `k` prefix. Members: `m_` prefix. Private member functions: `_` prefix.
- No type-based prefixes (no `p` for pointers).
- Function params: `in`, `out`, `io` prefix for pointer/reference direction.
- Trailing commas in array initializer lists.
- Comments explain "why" not "what."

## Formatting

**Run `./extras/formatting.sh` before every commit.** Use `--check-only` to verify without modifying.

Required tools: clang-format 17-18, gersemi 0.21-0.22, prettier 3+, shfmt 3+.

## Test patterns

Every fix or feature must have a regression test as `.slang` file under `tests/`.

**CPU test** (no GPU):
```slang
//TEST:COMPARE_COMPUTE(filecheck-buffer=CHECK):-cpu -output-using-type
// ... shader code ...
//CHECK: expected_output
```

**Interpreter test** (no GPU):
```slang
//TEST:INTERPRET(filecheck=CHECK):
void main()
{
    //CHECK: hello!
    printf("hello!");
}
```

**Diagnostic test** (verify compiler errors):
```slang
//DIAGNOSTIC_TEST:SIMPLE(diag=CHECK):-target spirv
int foo = undefined;
//CHECK: E01234
//CHECK:  ^^^^^^^^^ error
```

See `tests/language-feature/lambda/lambda-0.slang` for a full example.

## Development workflow

### Adding new language features

1. Update lexer for new tokens (`source/compiler-core/slang-lexer.cpp`)
2. Extend parser for new syntax (`source/slang/slang-parser.cpp`)
3. Add semantic analysis (`source/slang/slang-check-*.cpp`)
4. Implement IR generation (`source/slang/slang-ir-*.cpp`)
5. Add code generation for each target backend (`source/slang/slang-emit-*.cpp`)
6. Write comprehensive tests under `tests/`

### Adding an IR instruction

Update `source/slang/slang-ir-insts.lua`, then regenerate.

### Adding a built-in function

Add to appropriate module in `prelude/`.

### Modifying public headers

All files under `include/` are public API. See `/slang-code-reader` for ABI rules. Never insert enum values mid-enum. Never reorder virtual methods.

## Commit workflow

1. Create branch: `git checkout -b feature/description`
2. Make minimal changes within one subsystem
3. Write/update tests
4. Build: `cmake --build --preset debug`
5. Test: `./build/Debug/bin/slang-test tests/path/to/new-test.slang`
6. Format: `./extras/formatting.sh`
7. Commit -- do not mention Claude in commit messages
8. Push and create PR with `pr: non-breaking` or `pr: breaking` label
