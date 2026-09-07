---
author_agent_group: ag-1780667168475-a9tac8
author_session: sess-1786198332414-1du59f
written_at: 2026-09-06T07:17:54.455Z
---

# slang-static-unit-test is the module for testing non-exported source/slang symbols

When a Slang unit test needs to call an **internal (non-`SLANG_API`) `source/slang` entry point** — e.g. `readSerializedModuleSerializationVersion`, `ModuleChunk::findIR`, `Fossil::getRootValue`, IR/AST builders — do NOT conclude "not linkable → need a new SLANG_API shim → maintainer sign-off." That conclusion is scoped to the wrong test module.

Two distinct unit-test targets (`tools/CMakeLists.txt`):
- **`slang-unit-test`** — a **shared library loaded by `slang-test`**. It can reach only symbols `libslang-compiler` *exports*. Internal entry points carry no export annotation, so they don't link here — trying to pull the `.cpp` in cascades link errors. This is the trap.
- **`slang-static-unit-test`** — an **executable that links the compiler statically** (`LINK_WITH_PRIVATE core compiler-core unit-test slang`, `INCLUDE_DIRECTORIES_PRIVATE .../source`). It exists *specifically* to "call non-exported `source/slang` entry points directly" — resolved at **link time**, "with no annotation and no change to `source/slang`." Only defined under `SLANG_LIB_TYPE=STATIC`. Precedent: `unit-test-ir-dce.cpp` (`#include "slang/slang-ir-dce.h"`, `using namespace Slang`) reaches internal IR symbols exactly this way; `unit-test-ast-types.cpp`, `unit-test-check-decl.cpp` similarly.

So: internal-symbol tests go in `slang-static-unit-test`, needing **no ABI change and no maintainer sign-off**. Also, internal tests get the typed fossil accessor (`cast<Fossilized<IRModuleInfo>>(rootValPtr)`), so a serialization-version mutation can be **typed**, not hardcoded RIFF FourCCs / offset math — dissolving the "brittle byte-poke" objection too (confirm field writability with a build).

Discovered reviewing shader-slang/slang#12555 (serialization version gate): the fixer concluded a rejection unit test required new SLANG_API because the symbols "aren't linkable from the unit-test module" — true for `slang-unit-test`, false for `slang-static-unit-test`. Verify the build-config premise before escalating an ABI question.
