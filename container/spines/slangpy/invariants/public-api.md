### SlangPy project invariants

- New Python APIs must have tests in `slangpy/tests/`.
- Always build before running tests.
- Run `pre-commit run --all-files` after completing tasks; re-run if it modifies files.
- Use type annotations for all Python function arguments.
- Minimize new dependencies -- the project has minimal external deps.
- C++ code style: PascalCase classes, snake_case functions/variables, `m_` prefix for members.
- Python code style: PascalCase classes, snake_case functions/variables, `_` prefix for private members. Black formatter (line-length 100).
- Slang tests use `.slang` files with `[shader("compute")]` entry points, `StructuredBuffer<T>` / `RWStructuredBuffer<T>` for typed GPU arrays.
- Don't mention Claude in commit messages.
- PRs require review approval + CI pass. Squash merge with descriptive final commit message.
- When debugging, set `SLANGPY_PRINT_GENERATED_SHADERS=1` to see generated kernel code.
