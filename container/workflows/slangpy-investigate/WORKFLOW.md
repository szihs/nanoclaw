---
name: slangpy-investigate
type: workflow
description: "Investigate a SlangPy issue. Specialized steps for the SlangPy codebase."
extends: investigate
requires: [issues.read, code.read, doc.read, plan.research]
uses:
  skills: [slangpy-build, slangpy-code-reader, slangpy-github, deep-research]
  workflows: []
overrides:
  classify: "Classify by SlangPy subsystem and layer: Python API (slangpy/core/ -- Module, Function, Device, Tensor), type marshalling (slangpy/bindings/ -- Marshall, BoundVariable, TypeRegistry), type resolution (slangpy/reflection/), kernel generation (slangpy/core/calldata.py -- Phase 2), C++ bindings (src/slangpy_ext/ -- nanobind layer, NativeCallData), core SGL (src/sgl/ -- GPU device, shader compilation), functional API dispatch (Phase 1/3 in C++), or test/CI infrastructure. Determine which phase of the functional API call path is involved."
  investigate: "Use /slangpy-code-reader for code navigation, the 3-phase call path trace, type resolution reference, and review lenses. Use /slangpy-build for repro and debugging (SLANGPY_PRINT_GENERATED_SHADERS=1 for kernel inspection, local Slang build for compiler issues). Use /slangpy-github for CI logs and issue history. Use /deep-research for architecture questions via DeepWiki. Check if the issue is in Python marshalling vs C++ dispatch vs generated shader code. For compiler-related issues, determine if root cause is in Slang itself vs the SlangPy binding layer."
---
