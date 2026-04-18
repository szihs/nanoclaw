# Building Slang

## Clone

```bash
git clone https://github.com/shader-slang/slang.git /workspace/group/slang
cd /workspace/group/slang
git submodule update --init --recursive
```

## Configure

Slang uses CMake presets defined in `CMakePresets.json`:

```bash
cmake --preset default -DSLANG_ENABLE_TESTS=ON
```

Common options:

| Option | Purpose |
|--------|---------|
| `-DSLANG_ENABLE_TESTS=ON` | Enable test targets (always include) |
| `-DSLANG_ENABLE_CUDA=ON` | CUDA backend support |
| `-DSLANG_ENABLE_OPTIX=ON` | OptiX ray tracing support |
| `-DCMAKE_BUILD_TYPE=Debug` | Debug symbols (overrides preset default) |

If presets are unavailable (older checkout or stripped `CMakePresets.json`):

```bash
mkdir -p build && cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DSLANG_ENABLE_TESTS=ON
```

## Build

```bash
cmake --build --preset debug --parallel $(nproc)
```

Or from the build directory directly:

```bash
cd build
ninja -j$(nproc)
```

### Key Build Artifacts

| Path | What |
|------|------|
| `build/Debug/bin/slangc` | Slang compiler CLI |
| `build/Debug/bin/slang-test` | Slang test runner |
| `build/Debug/lib/libslang.so` | Shared library |
| `build/Debug/bin/slang-rhi-tests` | RHI test runner |
| `build/Debug/bin/render-test` | Render test runner |

## GPU Environment

CUDA and Vulkan are pre-installed in the container. Set these before running GPU tests:

```bash
# Vulkan ICD (NVIDIA driver from host)
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json

# Slang build libraries (needed for render-test and slang-rhi-tests)
export LD_LIBRARY_PATH="/workspace/group/slang/build/Debug/lib:${LD_LIBRARY_PATH}"
```

Verify GPU detection:

```bash
cd /workspace/group/slang/build/Debug/bin
./slang-test -only-api-detection
```

Expected output (on NVIDIA GPU container):
```
Supported backends: glslang spirv-dis clang gcc genericcpp nvrtc llvm spirv-opt
Check vk,vulkan:  Supported
Check cpu:        Supported
Check cuda:       Supported
Check llvm:       Supported
```

Note: `slang-test` may segfault on exit after detection — this is a known harmless issue.

## Test

### slang-test (compiler tests)

Use parallel test servers for speed:

```bash
cd /workspace/group/slang/build/Debug/bin
./slang-test -server-count 16
```

Filter by backend:

```bash
./slang-test -api cuda -server-count 8
./slang-test -api vulkan -server-count 8
```

### slang-rhi-tests (GPU/RHI tests)

```bash
cd /workspace/group/slang/build/Debug/bin
LD_LIBRARY_PATH=/workspace/group/slang/build/Debug/lib:$LD_LIBRARY_PATH \
  ./slang-rhi-tests
```

Ray tracing tests only:

```bash
./slang-rhi-tests --gtest_filter="*ray*tracing*"
```

### Coverage

Slang has built-in coverage support:

```bash
cmake --preset coverage
cmake --build --preset coverage
# Or use the all-in-one script:
bash tools/coverage/run-coverage-local.sh
```

## Building slangpy

slangpy lives at `/workspace/group/slangpy`:

```bash
git clone https://github.com/shader-slang/slangpy.git /workspace/group/slangpy
cd /workspace/group/slangpy
git submodule update --init --recursive
```

Configure and build:

```bash
cmake --preset linux-gcc
pip install --break-system-packages numpy libcst
cmake --build --preset linux-gcc-debug --parallel $(nproc)
```

Run C++ tests:

```bash
cd /workspace/group/slangpy/build/linux-gcc/Debug
./sgl_tests
```

## DirectX Shader Compiler (DXC) — Optional

DXC (`libdxcompiler.so`) is available for Linux but has caveats:

- **Do NOT place DXC libs in slang's bin directory** — the bundled LLVM conflicts with slang's own LLVM and breaks CUDA/Vulkan detection
- dx12/dx11 API tests require a full D3D runtime (Windows-only), not just the DXC compiler
- DXC is only useful for HLSL-to-SPIRV/DXIL compilation testing on Linux

If needed, download from [DXC releases](https://github.com/microsoft/DirectXShaderCompiler/releases) and keep the `.so` files in a separate directory (e.g., `/workspace/group/dxc/lib/`).

## Git Worktrees

Create isolated worktrees for parallel work:

```bash
cd /workspace/group/slang

# With issue number
git worktree add /workspace/group/worktrees/issue-1234_fix-thing -b issue-1234_fix-thing

# List active worktrees
git worktree list

# Clean up when done
git worktree remove /workspace/group/worktrees/issue-1234_fix-thing
```
