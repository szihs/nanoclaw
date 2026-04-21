### Slang public API invariants

- `include/slang.h` and the reflection API in `source/slang/slang-reflection.cpp` are stable surface. Breaking changes require maintainer approval.
- `.meta.slang` files in `source/slang/` and `prelude/` define user-visible language surface. Treat them as public API.
- Tests under `tests/` are contract. Do not delete or silence a failing test without evidence it was wrong.
