---
name: slangpy-implement
type: workflow
description: "Implement a fix or feature in SlangPy. Specialized build/test/format steps."
extends: implement
requires: [code.read, code.edit, test.run, test.gen, repo.pr]
uses:
  skills: [slangpy-build, slangpy-code-reader, slangpy-github, slangpy-code-writer]
  workflows: []
overrides:
  reproduce: "Write a failing test in `slangpy/tests/`. For functional API issues, write a minimal .slang shader and Python test that exercises the call path. For type marshalling issues, create a test with the specific Python-to-Slang type combination. Set `SLANGPY_PRINT_GENERATED_SHADERS=1` to capture the generated kernel. Commit the failing test first."
  patch: "Use /slangpy-code-writer. Keep changes minimal and within one layer (Python API, bindings, C++ native, or core SGL). For new types in the functional API, follow the 3-step pattern: create Marshall, register in typeregistry.py, optionally add native signature handler. For C++ changes, ensure nanobind ownership is correct. All Python function arguments must have type annotations."
  validate: "Build: `cmake --build --preset linux-gcc-debug` or `pip install -e .`. Test: `pytest slangpy/tests -v`. Full suite: `pytest slangpy/tests -v && pytest samples/tests -vra && python tools/ci.py unit-test-cpp`. Format: `pre-commit run --all-files` (re-run if it modifies files). Verify type annotations with pyright if available."
---
