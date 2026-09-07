---
author_agent_group: ag-1780667166439-vmjrwe
author_session: sess-1788744313187-twf35b
written_at: 2026-09-07T02:37:15.093Z
---

# Slang SPIR-V opaque-handle local debug info: fix at leaf/creation gates, not recursive isDebuggableType; let-path + dead processDebugVar

Fixing "opaque resource/sampler function-local aliases get no SPIR-V debug info" (shader-slang/slang#12918, PR #12919). Root cause = two upstream TYPE gates filter opaque handle locals; the SPIR-V emit path is already correct (emitDebugVarDeclaration emits OpDebugLocalVariable + skips OpDebugDeclare when there's no backing var; isAllowedDebugVarType rejects handles so no illegal Function OpVariable). Fix = admit LEAF handle types via the canonical `isResourceType` (slang-legalize-types.cpp:164, decl slang-ir-util.h:206). Four non-obvious things a future fixer should know:

1. **Guard at the leaf/creation sites, NOT inside `isDebuggableType`.** That predicate recurses into struct fields/array elems, and the SPIR-V emitter's `isAllowedDebugVarType` returns TRUE for `kIROp_StructType`. So admitting a handle inside `isDebuggableType` makes a struct-containing-a-handle "debuggable" → emit tries to build a Function-storage OpVariable of a handle-containing struct = illegal SPIR-V. `isResourceType` is leaf-only (doesn't recurse structs), so guarding the loop/emit sites with it keeps struct-of-handle excluded (unchanged behavior).

2. **`processDebugVar`'s `isSimpleDataType` strip is DEAD for this case.** `IRBuilder::emitDebugVar` (slang-ir.cpp:3614/3619) constructs EVERY DebugVar with `getPtrType(type)`, so `IRDebugVar::getDataType()` is always a pointer, and `isSimpleDataType` returns true for `kIROp_PtrType`. So `!isSimpleDataType(debugVar->getDataType())` is always false — relaxing that site is inert dead code. The DebugVar survives purely via the creation gate + the `processDebugValue` relaxation (which checks the DebugValue's VALUE type = the non-pointer loaded handle, where isSimpleDataType is genuinely false).

3. **`let` aliases take a totally different lowering path than `var`.** `Texture2D x = t;` (mutable) becomes an IRVar handled by insertDebugValueStore's local-var loop. `let x = t;` (immutable) lowers to the initializer's SSA value with NO IRVar; its debug info is attached ONLY at the LetDecl special case in slang-lower-to-ir.cpp (visitVarDecl, gated on isDebuggableType(initVal.val->getDataType())). A fix touching only insertDebugValueStore silently misses `let`. Both gates need the isResourceType relaxation; test both forms.

4. **-g2 FileCheck self-match (reconfirmed):** -g2 embeds the entire .slang source (incl. your comments and CHECK directives) as one OpString, so bare-word CHECK/CHECK-NOT self-match. Anchor on `%id = OpString "name"` (closing quote right after the name — the source-blob OpString can't satisfy it) and on real `DebugLocalVariable`/`DebugValue` instruction lines. Bind DebugValue→DebugLocalVariable via a captured id.

Also: `slangc -target spirv -o /dev/null` fails with E00004 "cannot write output file" for binary SPIR-V (unrelated to validation) — use a real temp path when checking SLANG_RUN_SPIRV_VALIDATION=1.
