# SPIRV Submodule Update

Update spirv-tools and spirv-headers submodules and regenerate derived files.

## Workflow

1. Check current submodule versions:
   ```bash
   git submodule status external/spirv-tools external/spirv-headers
   ```

2. Update to latest:
   ```bash
   cd external/spirv-tools && git fetch origin && git checkout origin/main && cd ../..
   cd external/spirv-headers && git fetch origin && git checkout origin/main && cd ../..
   ```

3. Regenerate SPIRV headers (if build scripts exist):
   ```bash
   python3 external/spirv-headers/tools/buildHeaders/bin/makeHeaders.py
   ```

4. Build and test:
   ```bash
   cmake --build --preset debug --parallel $(nproc)
   cd build && ctest --output-on-failure -R spirv
   ```

5. If tests pass, commit:
   ```bash
   git add external/spirv-tools external/spirv-headers
   git commit -m "Update SPIRV submodules to latest"
   ```

## Gotchas

- **Breaking API changes** — New SPIRV versions occasionally change instruction formats. Check SPIRV changelog before updating.
- **Generated files** — Some SPIRV-related files are auto-generated. If the generation script fails, check `external/spirv-headers/tools/` for updated paths.
- **Test coverage** — Run SPIRV-specific tests, not just full suite: `ctest -R spirv`
