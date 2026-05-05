### Slang repository layout

- `source/slang/` -- Compiler: parser, checker, IR, passes, emitters
- `source/core/` -- Core utilities (strings, containers, platform)
- `source/compiler-core/` -- Lexer, diagnostics, downstream compilers
- `source/slangc/` -- CLI compiler (`slangc`)
- `include/` -- Public API (`slang.h`). ABI-stable.
- `prelude/` -- Built-in definitions and standard library
- `tests/` -- Test suite (`.slang` files with test directives)
- `docs/` -- Documentation (`user-guide/`, `design/`, `building.md`)
- `extras/` -- Dev tools: formatting.sh, insttrace.py, repro-remix.sh
- `tools/` -- slang-test, slang-unit-test
- `external/` -- Third-party dependencies
- `.github/workflows/` -- CI. See `/slang-github`.
