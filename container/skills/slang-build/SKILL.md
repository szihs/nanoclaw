---
name: slang-build
description: "Clone, configure, build, and test the Slang compiler. Trigger when the repo needs initial setup, a rebuild, or when build/test commands fail. Not for code changes (use /slang-fix). Keywords: clone, build, cmake, ninja, test, setup, configure, compile."
provides: [code-build, test-run, ci-inspect]
allowed-tools: Bash(git:*), Bash(cmake:*), Bash(ninja:*), Bash(ctest:*), Bash(make:*)
---

# Slang Setup & Build

Set up the [Slang](https://github.com/shader-slang/slang) shading language compiler (~1.2M lines C++).

## Quick Start

```bash
# Clone (if not already at /workspace/group/slang)
git clone https://github.com/shader-slang/slang.git /workspace/group/slang
cd /workspace/group/slang

# Configure and build
cmake --preset default -DSLANG_ENABLE_TESTS=ON
cmake --build --preset debug --parallel 2

# Run tests
cd build/Debug && ctest --output-on-failure --parallel 2
```

Install missing packages: `sudo apt-get install -y <package>`

## Detailed Guides

| Need | Read |
|------|------|
| First-time clone and full build | build.md |
| Codebase structure and pipeline | structure.md |
| Build failing or unexpected errors | gotchas.md |

## Key Build Details

- Default branch is `master`, not `main`
- Presets in `CMakePresets.json` — if missing, use manual cmake invocation
- Always pass `-DSLANG_ENABLE_TESTS=ON` or test targets won't exist
- Use `-j2` if `$(nproc)` causes OOM in containers
- `slang-test` binary (not `ctest`) is the primary test runner for Slang-specific tests
- Formatting: run `./extras/formatting.sh` before committing

## Testing

```bash
# Run all tests via slang-test
./build/Debug/bin/slang-test

# Run specific test category
./build/Debug/bin/slang-test tests/compute/

# CPU-only compute tests (no GPU needed)
./build/Debug/bin/slang-test -use-test-server tests/compute/
```

## Related Skills

- `/slang-explore` — investigate features and trace code paths
- `/slang-fix` — implement changes after building
- `/slang-github` — fetch issues/PRs, create PRs
- `/slang-maintain-release-report` — release management workflows
