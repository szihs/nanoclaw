---
name: slangpy-build
description: "Clone, build, and test SlangPy. Use when the repo needs setup, a rebuild, or when tests fail."
provides: [code.build, test.run, test.gen, ci.inspect]
allowed-tools: Bash(git:*), Bash(cmake:*), Bash(python:*), Bash(pytest:*), Bash(pip:*), Bash(pre-commit:*), Read, Grep, Glob
---

## Clone

```bash
git clone --recursive --tags https://github.com/shader-slang/slangpy.git /workspace/agent/slangpy
cd /workspace/agent/slangpy
git remote add upstream https://github.com/shader-slang/slangpy.git
git fetch --tags upstream
```

## Build

SlangPy uses CMake presets for the native C++/nanobind layer. On Linux:

```bash
cmake --preset linux-gcc                    # Configure
cmake --build --preset linux-gcc-debug      # Build (debug)
cmake --build --preset linux-gcc-release    # Build (release)
cmake --preset linux-gcc --fresh            # Reconfigure from scratch
```

Available presets: `windows-msvc`, `windows-arm64-msvc`, `linux-gcc`, `macos-arm64-clang`.

For Python editable install (preferred for development):

```bash
pip install -e .
```

Use `python tools/ci.py configure` and `python tools/ci.py build` for CI-style builds that handle platform detection automatically.

## Test

Always build before running tests.

```bash
# All Python tests
pytest slangpy/tests -v

# Example tests
pytest samples/tests -vra

# C++ unit tests
python tools/ci.py unit-test-cpp

# Specific test file
pytest slangpy/tests/slangpy_tests/test_X.py -v

# Specific test function
pytest slangpy/tests/slangpy_tests/test_X.py::test_fn -v
```

Debug generated shaders:

```bash
SLANGPY_PRINT_GENERATED_SHADERS=1 pytest slangpy/tests/slangpy_tests/test_X.py -v
```

## CI

CI runs via `.github/workflows/ci.yml` and calls `tools/ci.py`:

```bash
python tools/ci.py --help                    # All available commands
python tools/ci.py configure                 # CMake configure
python tools/ci.py build                     # Build
python tools/ci.py unit-test-python          # Python tests
python tools/ci.py unit-test-cpp             # C++ tests
python tools/ci.py test-examples             # Example tests
```

To inspect CI failures:

```bash
gh run list --repo shader-slang/slangpy --workflow=ci.yml --limit 5
gh run view <run-id> --log-failed
```

## Formatting

Run `pre-commit run --all-files` before committing. Re-run if it modifies files. Uses Black for Python and clang-format for C++.

## Debugging the functional API

The functional API has a 3-phase call path. When debugging:

1. **Phase 1 (Signature Lookup)** -- runs every call in C++ (`src/slangpy_ext/utils/slangpyfunction.cpp`). Check `NativeCallDataCache` for signature string construction.
2. **Phase 2 (Kernel Generation)** -- runs once per unique signature in Python (`slangpy/core/calldata.py`). Check type resolution, vectorization dimensionality, generated kernel code.
3. **Phase 3 (Dispatch)** -- runs every call in C++ (`src/slangpy_ext/utils/slangpy.cpp`). Check shape calculation, uniform binding, dispatch thread count.

Set `SLANGPY_PRINT_GENERATED_SHADERS=1` to see the Slang compute kernel source generated in Phase 2.

## Local Slang build

To test with a local Slang compiler build:

```bash
cmake --preset linux-gcc --fresh -DSGL_LOCAL_SLANG=ON -DSGL_LOCAL_SLANG_DIR=<slang-dir> -DSGL_LOCAL_SLANG_BUILD_DIR=build/Debug
cmake --build --preset linux-gcc-debug
```

## Gotchas

- Always build before running tests -- tests import the native extension.
- PyTorch integration is automatic when PyTorch is installed.
- Hot-reload is supported for shader (.slang) development.
- Slang uses **single dashes** for multi-character options: `-help`, `-target spirv`.

## From project

- `AGENTS.md` -- 3-phase functional API architecture, build commands, test commands, debugging workflow
- `CLAUDE.md` -- references AGENTS.md
- `CONTRIBUTING.md` -- build from source instructions, test workflow
- `CMakeLists.txt` -- CMake build system, presets, platform detection
- `pyproject.toml` -- Python build config (setuptools + cmake + ninja)
- `tools/ci.py` -- CI task runner with configure, build, test, coverage commands
