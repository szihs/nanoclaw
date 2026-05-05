---
name: slangpy-review
type: workflow
description: "Review a SlangPy change against project conventions and codebase-specific invariants."
extends: review
requires: [repo.read, code.read, doc.read]
uses:
  skills: [slangpy-code-reader, slangpy-github]
  workflows: []
overrides:
  assess: "Apply these review lenses from /slangpy-code-reader: (1) Type marshalling correctness -- Marshall implementations must correctly implement resolve_types(), resolve_dimensionality(), gen_calldata(); type registry entries must match; vectorization dimensionality must be consistent between Python and C++ layers. (2) C++/Python boundary -- nanobind ownership, NativeCallDataCache signature construction, GIL management. (3) GPU resource management -- Buffer/Texture lifecycle, device memory allocation, OOM handling. (4) Shader code generation -- generated kernels match bound parameter types, differentiability propagation, correct entry point generation. (5) Error handling -- Python exceptions (ValueError, TypeError, SlangPyError), C++ translation via nanobind, shader compile errors with diagnostics, GPU errors from RHI. (6) Test coverage -- new APIs must have tests in slangpy/tests/, type annotations on all Python arguments. Check formatting with `pre-commit run --all-files`. Verify squash merge message is descriptive."
---
