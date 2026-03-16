---
name: slang-repo
description: Clone, build, and test the Slang compiler repo. Use when you need to set up the Slang source, create git worktrees for isolated work, build with CMake, or run tests.
allowed-tools: Bash(git:*), Bash(cmake:*), Bash(ninja:*), Bash(ctest:*), Bash(make:*)
---

# Slang Repo Management

## Repository Location

The Slang repo is mounted at `/workspace/extra/slang` (git worktree, writable).
If not available, clone it:

```bash
git clone https://github.com/shader-slang/slang.git /workspace/group/slang
```

## Git Worktrees

Each coworker gets its own worktree. To create additional worktrees for sub-tasks:

```bash
cd /workspace/extra/slang
git worktree add /workspace/group/worktrees/my-branch -b my-branch
```

List worktrees: `git worktree list`
Remove when done: `git worktree remove /workspace/group/worktrees/my-branch`

## Building Slang

Slang uses CMake with presets:

```bash
cd /workspace/extra/slang

# Configure (Release build)
cmake --preset default -DSLANG_ENABLE_TESTS=ON

# Build
cmake --build --preset default --parallel $(nproc)
```

Common CMake options:
- `-DSLANG_ENABLE_TESTS=ON` — enable test targets
- `-DSLANG_ENABLE_CUDA=ON` — enable CUDA backend
- `-DSLANG_ENABLE_OPTIX=ON` — enable OptiX support
- `-DCMAKE_BUILD_TYPE=Debug` — debug build with symbols

If presets aren't available, use manual configuration:

```bash
mkdir -p build && cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DSLANG_ENABLE_TESTS=ON
ninja -j$(nproc)
```

## Running Tests

```bash
cd /workspace/extra/slang/build
ctest --output-on-failure --parallel $(nproc)
```

Run specific test:
```bash
ctest -R "test-name-pattern" --output-on-failure
```

Run with verbose output:
```bash
ctest -V -R "test-name-pattern"
```

## Common Build Issues

- **Missing dependencies**: `apt-get install -y libx11-dev libxrandr-dev libgl1-mesa-dev`
- **Out of memory during build**: Reduce parallelism: `ninja -j2`
- **Stale CMake cache**: `rm -rf build/CMakeCache.txt` and re-configure

## Updating the Repo

```bash
cd /workspace/extra/slang
git fetch origin
git rebase origin/master
```

## Build Artifacts

After building, key binaries are in `build/`:
- `build/slangc` — the Slang compiler
- `build/slang-test` — test runner
- Test outputs in `build/tests/`
