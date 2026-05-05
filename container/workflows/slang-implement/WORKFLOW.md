---
name: slang-implement
type: workflow
description: "Implement a fix or feature in the Slang compiler. Specialized build/test/format steps."
extends: implement
requires: [code.read, code.edit, test.run, test.gen, repo.pr]
uses:
  skills: [slang-build, slang-code-reader, slang-github, slang-code-writer]
  workflows: []
overrides:
  reproduce: "Write a failing test as a `.slang` file under `tests/`. Use CPU (`//TEST:COMPARE_COMPUTE(filecheck-buffer=CHECK):-cpu -output-using-type`) or interpreter (`//TEST:INTERPRET(filecheck=CHECK):`) directives since no GPU is available. For diagnostic tests use `//DIAGNOSTIC_TEST:SIMPLE(diag=CHECK):`. Commit the failing test first."
  patch: "Use /slang-code-writer. Keep changes minimal and within one subsystem (parser, semantic checker, IR pass, or emitter). When fixing emitters, check all sibling slang-emit-*.cpp files for consistency. Prefer IR pass fixes over emit-level workarounds. When adding new IR instructions, update slang-ir-insts.lua."
  validate: "Build: `cmake --build --preset debug >/dev/null 2>&1 || cmake --build --preset debug`. Test: `./build/Debug/bin/slang-test tests/path/to/new-test.slang`. Format: `./extras/formatting.sh`. For cross-backend changes, test with SPIRV validation: `SLANG_RUN_SPIRV_VALIDATION=1 ./build/Debug/bin/slangc -target spirv -o /dev/null test.slang`."
---
