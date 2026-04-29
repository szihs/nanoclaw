---
name: slangpy-docs
description: "Read and write SlangPy documentation."
provides: [doc.read, doc.write]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git add:*), Bash(git commit:*), Bash(python:*), Bash(sphinx:*), Bash(pre-commit:*)
---

## Documentation locations

- `docs/` -- Sphinx documentation (published at slangpy.shader-slang.org)
- `docs/src/` -- Source pages for the developer guide and user documentation
- `docs/generated/` -- Auto-generated API reference
- `docs/generate_api.py` -- Script to regenerate API docs
- `docs/conf.py` -- Sphinx configuration
- `README.md` -- Project overview and quick start
- `CONTRIBUTING.md` -- Contribution guide
- `DEVELOP.md` -- Developer setup (links to online docs)

## Doc style

### Python API docs (Sphinx)

```python
def myfunc(x: int, y: int) -> int:
    """
    Description.

    :param x: Some parameter.
    :param y: Some parameter.
    :return: Some return value.
    """
```

### C++ API docs (Doxygen)

```cpp
/// Pack two float values to 8-bit snorm.
/// @param v Float values in [-1,1].
/// @param options Packing options.
/// @return 8-bit snorm values in low bits, high bits all zero.
uint32_t pack_snorm2x8(float2 v, const PackOptions options = PackOptions::safe);
```

### Slang language docs

`.slang` files in tests and examples serve as living documentation. Key patterns:
- `[shader("compute")]` entry points
- `StructuredBuffer<T>` / `RWStructuredBuffer<T>` typed GPU arrays
- `[Differentiable]` functions with `bwd_diff()` for automatic differentiation
- Generic types, interfaces, conformance

## Building documentation

```bash
cd docs
pip install -r requirements.txt
python generate_api.py                # Regenerate API reference
sphinx-build -b html . _build/html    # Build HTML docs
```

Online docs: https://slangpy.shader-slang.org/en/latest/

## Documenting the functional API

The functional API is the primary user-facing feature. Key concepts to document:

1. **Module loading** -- `spy.Module.load_from_file(device, "shader.slang")`
2. **Function calling** -- `module.func(arg1, arg2)` with automatic type marshalling
3. **Tensor operations** -- `spy.Tensor.from_numpy(device, array)`
4. **Vectorization** -- `.map()` for explicit dimension/type mappings
5. **Differentiability** -- `[Differentiable]` Slang functions with PyTorch integration

## Documenting new types

When a new type is added to the functional API:
1. Update API reference in `docs/`
2. Add usage example showing the type in a function call
3. Document the type resolution behavior (what Slang parameters it resolves to)
4. Document vectorization dimensionality behavior

## From project

- `AGENTS.md` -- functional API overview, type resolution reference, vectorization reference, doc style conventions
- `CLAUDE.md` -- doc style (Doxygen for C++, Sphinx for Python)
- `docs/` -- existing Sphinx documentation structure
- `README.md` -- project overview and quick start examples
