---
name: slang-review
type: workflow
description: "Review a Slang compiler change against project conventions and compiler-specific concerns."
extends: review
requires: [repo.read, code.read, doc.read]
uses:
  skills: [slang-code-reader, slang-github]
  workflows: []
overrides:
  assess: "Apply the six Slang review domains (from project agents): (1) Code quality -- verify consistency across similar locations (new IROp in some switch statements but not others, null checks on as<T>() casts, new backend in dispatch tables). (2) Cross-backend -- when emit code changes, grep all sibling slang-emit-*.cpp for the same pattern; flag complex transforms in emit that belong in IR passes. (3) IR correctness -- verify SSA form maintained, pass ordering correct, type legalization intact, slang-ir-insts.lua properly updated. (4) Security/UB -- null dereferences, out-of-bounds, use-after-free, signed overflow, uninitialized variables. (5) Test coverage -- bug fixes must have regression tests as .slang files, new features need coverage, use CPU/INTERPRET for no-GPU. (6) Documentation -- stale comments near changed code, include/slang.h doc drift, user-guide updates for new features. Check ABI: no mid-enum insertions, no vtable reordering, experimental interfaces marked, pr: breaking label if needed."
---
