### Slang ABI and API invariants

- `include/` is public API. Preserve binary (ABI) and source compatibility.
- Enums: never insert mid-enum. Append before the sentinel with explicit integer values.
- Removed enumerators: rename to `REMOVED_<Name>`, keep original integer.
- COM vtables: never reorder/remove/change virtual methods. Append only.
- Run `./extras/formatting.sh` before every commit.
- Label PRs `pr: non-breaking` or `pr: breaking`.
- Include regression tests as `.slang` files under `tests/`.
- No STL containers, iostreams, or built-in C++ RTTI.
