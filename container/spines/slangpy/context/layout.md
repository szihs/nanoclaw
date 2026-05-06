### SlangPy repository layout

- `slangpy/` -- Python package implementation (high-level API: Module, Function, Device, Tensor)
- `slangpy/core/` -- Core Python API: `function.py` (FunctionNode), `calldata.py` (CallData), `callsignature.py`, `module.py`, `struct.py`
- `slangpy/bindings/` -- Type marshalling: `boundvariable.py` (BoundCall/BoundVariable), `marshall.py` (Marshall base), `typeregistry.py`, `codegen.py`
- `slangpy/reflection/` -- Type resolution: `typeresolution.py`
- `slangpy/builtin/` -- Built-in type marshalls (Tensor, Scalar, etc.)
- `slangpy/tests/` -- Python tests (pytest). See `/slangpy-build` to run tests.
- `src/sgl/` -- Native C++ code (core GPU abstraction layer wrapping slang-rhi)
- `src/slangpy_ext/` -- Python bindings (nanobind): `utils/slangpyfunction.cpp` (NativeFunctionNode::call), `utils/slangpy.cpp` (NativeCallData::exec)
- `src/slangpy_torch/` -- Native torch integration extension
- `tests/` -- C++ tests (doctest)
- `tools/` -- Utility scripts including `ci.py` (CI task runner)
- `examples/`, `samples/` -- Example code and experiments
- `docs/` -- Documentation (Sphinx)
- `external/` -- External C++ dependencies (slang-rhi, nanobind, etc.)
- `.github/workflows/` -- CI workflows. See `/slangpy-github` for CI issues.
- `CMakeLists.txt` -- Native build config. CMake presets: `linux-gcc`, `windows-msvc`, `macos-arm64-clang`.
- `pyproject.toml` -- Python package build config (setuptools + cmake + ninja).
