---
name: slangpy-code-writer
description: "Implement changes in SlangPy. Edit code, write tests, format, commit."
provides: [code.read, code.edit, test.gen]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

## Code style

### C++

- **Classes**: PascalCase | **Functions/variables**: snake_case | **Members**: `m_` prefix
- Use nanobind patterns for Python bindings
- C++ tests use doctest framework

### Python

- **Classes**: PascalCase | **Functions/variables**: snake_case | **Public Members**: no prefix | **Private Members**: `_` prefix
- **All arguments must have type annotations**
- Black formatter, line-length 100
- Use `typing_extensions` for backward-compatible type hints (Python >= 3.9)

### Slang (.slang files)

- `[shader("compute")]` attribute marks GPU entry points
- `StructuredBuffer<T>` / `RWStructuredBuffer<T>` for typed GPU arrays
- `uint3 tid : SV_DispatchThreadID` for thread indexing
- Generics via `<T>`, interfaces via `interface IFoo`, conformance via `struct Foo : IFoo`
- Differentiable functions: `[Differentiable] float foo(float x)` with `bwd_diff(foo)` for backprop

## Development workflow

### Adding new Python APIs

1. Implement in `slangpy/` (core/, bindings/, builtin/, or appropriate subpackage)
2. Add type annotations to all function arguments
3. Write tests in `slangpy/tests/`
4. Build and run tests
5. Run `pre-commit run --all-files`

### Adding a new type to the functional API

1. **Create a Marshall** in `slangpy/bindings/` or `slangpy/builtin/` -- subclass `Marshall` and implement `resolve_types()`, `resolve_dimensionality()`, `gen_calldata()`. See existing marshalls (e.g., `TensorMarshall`) for the pattern.
2. **Register** in `slangpy/bindings/typeregistry.py` -- add entry to `PYTHON_TYPES` dict.
3. **(Optional) Native signature** -- for performance, add a type signature handler in `NativeCallDataCache` constructor (`src/slangpy_ext/utils/slangpyfunction.cpp`).

### Modifying the C++ binding layer

- Edits in `src/slangpy_ext/` affect the nanobind interface
- Changes in `src/sgl/` affect the core GPU abstraction
- Always rebuild after C++ changes: `cmake --build --preset linux-gcc-debug`

### Modifying kernel generation

- `slangpy/core/calldata.py` -- the Phase 2 pipeline (type resolution, vectorization, code generation, compilation)
- `slangpy/bindings/codegen.py` -- Slang compute kernel source generation
- Set `SLANGPY_PRINT_GENERATED_SHADERS=1` to inspect generated kernels

## Workflow

1. Create a branch: `git checkout -b feature/description`
2. Make changes, keeping them minimal and focused
3. Write/update tests -- new APIs require tests in `slangpy/tests/`
4. Build: `cmake --build --preset linux-gcc-debug` or `pip install -e .`
5. Test: `pytest slangpy/tests -v`
6. Format: `pre-commit run --all-files` (re-run if it modifies files)
7. Commit with descriptive message (do not mention Claude)
8. Push and create PR against `shader-slang/slangpy:main`

## Documentation style

### C++ (Doxygen)

```cpp
/// Description.
void do_something();

/// @param v Float values.
/// @return Result.
uint32_t my_func(float2 v);
```

### Python (Sphinx)

```python
def myfunc(x: int, y: int) -> int:
    """
    Description.

    :param x: Some parameter.
    :param y: Some parameter.
    :return: Some return value.
    """
```

## Error handling patterns

- Python-layer errors: standard exceptions (`ValueError`, `TypeError`, `SlangPyError`)
- C++ errors: translated to Python via nanobind
- Shader compile errors: exceptions with Slang diagnostic text
- GPU errors (device lost, OOM): propagate from RHI layer

## From project

- `AGENTS.md` -- architecture (3 layers, 3 phases), key files, key classes, adding new types, type resolution, code style
- `CLAUDE.md` -- references AGENTS.md, key rules (type annotations, tests, pre-commit)
- `CONTRIBUTING.md` -- PR process, branch workflow, testing requirements
