---
name: slangpy-code-reader
description: "Read-only investigation of the SlangPy codebase. Navigate source, trace the functional API call path, understand architecture, apply review lenses."
provides: [code.read, doc.read]
allowed-tools: Bash, Read, Grep, Glob, mcp__deepwiki__ask_question
---

## Architecture

### Three-layer model

1. **Python Layer** (`slangpy/`) -- High-level API with Module, Function, Device, Tensor classes
2. **C++ Binding Layer** (`src/slangpy_ext/`) -- Nanobind-based Python-C++ interface
3. **Core SGL Layer** (`src/sgl/`) -- Low-level GPU device management, shader compilation, wrapping slang-rhi

C++ types typically map to slang-rhi counterparts (e.g., `Device` wraps `rhi::IDevice`).

### Functional API call path

```
Python call -> Phase 1: Signature Lookup (C++) -> Cache hit? -> Phase 3: Dispatch (C++)
                                                | Cache miss
                                         Phase 2: Kernel Generation (Python)
```

### Key classes

| Class | Layer | File | Purpose |
|-------|-------|------|---------|
| `FunctionNode` | Python | `slangpy/core/function.py` | Callable Slang function with modifiers |
| `CallData` | Python | `slangpy/core/calldata.py` | Generated kernel data (bindings, compiled shader) |
| `BoundCall` | Python | `slangpy/bindings/boundvariable.py` | Collection of BoundVariable for a single call |
| `BoundVariable` | Python | `slangpy/bindings/boundvariable.py` | Pairs Python value with Slang parameter |
| `Marshall` | Python | `slangpy/bindings/marshall.py` | Base class for type-specific marshalling |
| `NativeCallData` | C++ | `src/slangpy_ext/utils/slangpy.cpp` | Native call data with cached dispatch info |
| `NativeCallDataCache` | C++ | `src/slangpy_ext/utils/slangpyfunction.cpp` | Signature -> CallData cache |

### Phase 1: Signature Lookup (every call, C++)

**File:** `src/slangpy_ext/utils/slangpyfunction.cpp`

Builds a unique signature string from the function node chain and argument types/properties. Looks up in `NativeCallDataCache`. Cache hit skips to Phase 3; cache miss triggers Phase 2.

### Phase 2: Kernel Generation (once per signature, Python)

**File:** `slangpy/core/calldata.py` -> `CallData.__init__()`

Pipeline: unpack arguments -> build BoundCall -> apply explicit vectorization -> type resolution (`slangpy/reflection/typeresolution.py`) -> bind parameters -> apply implicit vectorization -> calculate call dimensionality -> create return value binding -> finalize mappings -> calculate differentiability -> generate code -> compile shader.

### Phase 3: Dispatch (every call, C++)

**File:** `src/slangpy_ext/utils/slangpy.cpp`

Unpack arguments -> calculate call shape -> allocate return value -> bind uniforms + dispatch -> read results.

### Type resolution reference

| Python Value | Slang Parameter | Resolved Binding |
|--------------|-----------------|------------------|
| `Tensor[float, 2D]` | `float` | `float` (elementwise) |
| `Tensor[float, 2D]` | `Tensor<float,2>` | `Tensor<float,2>` (whole) |
| `Tensor[float, 2D]` | `float2` | `float2` (row as vector) |
| `Tensor[float, 2D]` | `vector<T,2>` | `vector<float,2>` (generic) |

### Vectorization dimensionality reference

| Python Value | Slang Parameter | Dimensionality |
|--------------|-----------------|----------------|
| `Tensor[float, 2D shape=(H,W)]` | `float` | 2 (one thread per element) |
| `float` | `float` | 0 (single thread) |
| `Tensor[float, 2D]` | `Tensor<float,2>` | 0 (whole tensor per thread) |
| `Tensor[float, 2D shape=(H,W)]` | `float2` | 1 (one thread per row) |

## Search strategies

- Python high-level API: `slangpy/core/` -- Module, Function, Device, Tensor
- Type marshalling: `slangpy/bindings/` -- BoundVariable, Marshall, TypeRegistry, CodeGen
- Type resolution: `slangpy/reflection/typeresolution.py`
- Built-in marshalls: `slangpy/builtin/` -- Tensor, Scalar, etc.
- C++ bindings: `src/slangpy_ext/` -- nanobind wrappers
- Core SGL: `src/sgl/` -- device, shader, buffer, texture
- Tests: `slangpy/tests/` -- Python tests organized by feature
- C++ tests: `tests/` -- doctest-based native tests
- Examples: `examples/`, `samples/` -- usage patterns and experiments

## Review lenses

When reviewing code, apply these specialized lenses:

### Type marshalling correctness

- Marshall implementations must correctly implement `resolve_types()`, `resolve_dimensionality()`, `gen_calldata()`
- Type registry entries must match Python types to their Marshall implementations
- Vectorization dimensionality must be consistent between Python and C++ layers

### C++/Python boundary

- Nanobind type conversions must handle ownership correctly
- `NativeCallDataCache` signature construction must capture all call-relevant state
- GIL management around long-running GPU operations

### GPU resource management

- Buffer and Texture lifecycle -- creation, binding, readback
- Device memory allocation patterns, out-of-memory handling
- Compute dispatch thread count derivation from call shape

### Shader code generation

- Generated Slang compute kernels must match the bound parameter types
- Differentiability annotations (`[Differentiable]`, `bwd_diff`) propagation
- Correct `[shader("compute")]` entry point generation

### Error handling

- Python exceptions: `ValueError`, `TypeError`, `SlangPyError`
- C++ errors translated to Python via nanobind
- Shader compile errors surface as exceptions with Slang diagnostic text
- GPU errors (device lost, OOM) propagate from RHI layer

## DeepWiki

For architecture questions about the upstream repo:
```
mcp__deepwiki__ask_question("shader-slang/slangpy", "your question here")
```

## From project

- `AGENTS.md` -- full functional API architecture (Phase 1/2/3), key files, key classes, type resolution reference, vectorization reference, adding new types
- `CLAUDE.md` -- references AGENTS.md
- `CONTRIBUTING.md` -- code review process, PR workflow
