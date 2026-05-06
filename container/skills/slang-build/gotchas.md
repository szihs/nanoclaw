# Gotchas

Known failure points when working with the Slang repo. Add to this as new issues are discovered.

## Build

- **OOM during parallel build**: Container memory limits can cause `ninja -j$(nproc)` to be killed. Use `-j2` in containers.
- **Missing CMake presets**: Some older commits or shallow clones lack `CMakePresets.json`. Fall back to manual cmake: `cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release`.
- **Stale CMake cache**: After switching branches with different CMake options, `rm -rf build/CMakeCache.txt` and reconfigure. Symptoms: missing targets, wrong flags.
- **Missing X11/GL deps**: On fresh containers, install: `apt-get install -y libx11-dev libxrandr-dev libgl1-mesa-dev`.

## Git

- **Default branch is `master`**, not `main`. `git fetch origin && git rebase origin/master`.
- **Submodules**: Slang has submodules. After clone: `git submodule update --init --recursive`. Missing this causes cryptic build failures.
- **Large repo**: Full clone is ~2GB. Use `--depth 1` for exploration-only tasks where history doesn't matter.

## Tests

- **`slang-test` vs `ctest`**: Slang has its own test runner (`slang-test`) that handles `.slang` test files. `ctest` wraps this but some test patterns only work with `slang-test` directly.
- **Test file format**: `.slang` test files contain expected output in comments. Look for `//TEST:` directives at the top of test files to understand what they verify.
- **GPU tests skip on CPU-only**: Tests requiring CUDA/Vulkan/D3D will skip (not fail) when hardware isn't available. This is expected in containers.
