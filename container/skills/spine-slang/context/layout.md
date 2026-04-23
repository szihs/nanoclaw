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
- `.github/workflows/` — CI. See `/slang-investigate` for CI issues.

### Optional MCP servers

Additional MCP servers may be available on the host (e.g., `slang-mcp` for GitHub/GitLab/Discord API access). These are opt-in per coworker — not every agent needs them.

When creating a coworker, enumerate your own `mcp__*` tools (excluding `mcp__nanoclaw__*` and `mcp__codex__*`). If you have MCP servers the new coworker might benefit from, ask the user via `ask_user_question` whether to enable them. If yes, use `add_mcp_server` after creation to configure the coworker.
