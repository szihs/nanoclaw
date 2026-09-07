---
author_agent_group: ag-1780667166418-apezq5
author_session: sess-1788743693450-w5fcjq
written_at: 2026-09-07T01:26:54.687Z
---

# Slang SPIR-V: opaque resource/sampler function-locals get no debug info — root cause is two upstream type-gates, not the emitter

**Symptom (issue #12918):** with `slangc -target spirv-asm -O0 -g2`, function-local aliases of opaque resource types (`Texture2D t = g;`, `SamplerState s = g;`) get NO `OpString`/`DebugLocalVariable`/`DebugValue`, while scalar/vector locals and the global resources do. Valid SPIR-V still emits.

**Root cause is a chain of TYPE gates, all in IR — NOT the emitter:**
1. (ROOT) `DebugValueStoreContext::isDebuggableType` — `slang-ir-insert-debug-value-store.cpp` (~L22-104) is a `switch(type->getOp())` with no case for resource/sampler ops; its `default` returns `true` only for `IRBasicType`. So `kIROp_TextureType`/`kIROp_SamplerStateType` → `false`, and both the param loop (~L137) and local-var loop (~L192) `continue` **before** `emitDebugVar` (~L194). No DebugVar is ever created. (This pass runs in lowering BEFORE `constructSSA`, so the opaque local is still an `IRVar` here — it's filtered by type, not absent.)
2. `slang-ir-spirv-legalize.cpp`: `processDebugValue` (~L2348) and `processDebugVar` (~L2490) delete any Debug record whose type fails `isSimpleDataType` (`slang-ir-util.cpp:356`, no resource case) — a second strip even if gate 1 is relaxed.

**Key non-obvious insight — the emit path ALREADY handles opaque handles correctly:** `emitDebugVarDeclaration` (`slang-emit-spirv.cpp:4676`) checks `hasBackingVar`; when false it emits `OpDebugLocalVariable` and **omits** `OpDebugDeclare` (L4700/L4714), binding the value via `OpDebugValue`. `emitDebugVarBackingLocalVarDeclaration` (L4755) already returns `nullptr` for opaque handles because `isAllowedDebugVarType` (L4733) rejects them (a Function-storage `OpVariable` for an opaque handle would be illegal SPIR-V). And `emitDebugType` already produces debug types for Texture/Sampler (globals emit `DebugGlobalVariable` — see `tests/spirv/debug-variable-scope.slang:30-31`). So the reporter's "no backing OpVariable/DebugDeclare needed, just DebugLocalVariable + DebugValue on the loaded SSA handle" form is already what emit produces — the fix is purely upstream.

**Fix shape:** relax gates 1+2 to admit opaque LEAF handle types, reusing the canonical `isOpaqueType(IRType*, IRType** outLeaf)` / `isResourceType` (`slang-legalize-types.cpp:257`/`:164`, decl `slang-legalize-types.h:693`) rather than a hand-rolled `getOp()` switch. Prefer narrowing at the two spirv-legalize call sites over widening the SHARED `isSimpleDataType` (many other consumers). Verify the DebugValue (emitted after the initializing store) survives SSA promotion still pointing at the loaded handle SSA (it persists — used by OpSampledImage). GPU-free to test (`//TEST:SIMPLE(filecheck=CHECK):-target spirv-asm … -g2 -O0 -emit-spirv-directly`); anchor CHECKs on real `DebugLocalVariable`/`OpName` lines because `-g2` embeds the full source as `OpString` and naive FileCheck self-matches.
