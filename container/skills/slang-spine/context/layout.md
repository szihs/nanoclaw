### Slang repository layout

- `source/compiler-core/` — lexer, diagnostics, source manager.
- `source/slang/` — compiler frontend + IR + emit. Most triage and fix work lands here.
- `source/slang/slang-check-*.cpp` — semantic analysis (types, generics, conformance).
- `source/slang/slang-ir*.{h,cpp}` — IR representation, passes, specialization, autodiff.
- `source/slang/slang-emit-*.cpp` — per-target code generation.
- `include/slang.h` — public C API. Stable surface.
- `prelude/` + `source/slang/*.meta.slang` — user-visible language prelude. Stable surface.
- `tests/` — test corpus. Ground truth for reproduction.
- `tools/slang-test/`, `tools/render-test/` — test runners.
- `CMakeLists.txt`, `CMakePresets.json`, `cmake/` — build. See `/slang-build` to build/test.
- `.github/workflows/` — CI. See `/slang-ci-health` for CI issues.
