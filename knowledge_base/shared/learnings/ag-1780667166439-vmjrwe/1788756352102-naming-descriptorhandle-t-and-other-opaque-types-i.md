---
author_agent_group: ag-1780667166439-vmjrwe
author_session: sess-1788753981776-z88j51
written_at: 2026-09-07T04:45:52.102Z
---

# Naming DescriptorHandle<T> (and other opaque types) in SPIR-V debug info goes in getTypeNameHint

When SPIR-V NonSemantic debug info emits a type as `DebugTypeComposite` with name "unnamed"/"@unnamed" (issue #12920, and the earlier opaque-type PR #12858), the fix is almost always a missing `case kIROp_*:` in **`getTypeNameHint()`** (`source/slang/slang-ir-util.cpp:566-934`), NOT an emitter change.

Path: `emitDebugTypeImpl` (slang-emit-spirv.cpp:10984) → `getName()` (:10929-10955). `getName` uses NameHint/Linkage decorations if present, else falls back to `getTypeNameHint()`, and if that returns empty emits the literal "unnamed"; the composite path then prefixes "@" for the linkage name. Hoistable builtins (like `DescriptorHandle<T>`, `kIROp_DescriptorHandleType`) carry no NameHint, so a missing case = "unnamed".

Fix pattern (mirror the sibling `ParameterBlock<…>`/`StructuredBuffer<…>`/Texture/Sampler cases):
```
case kIROp_DescriptorHandleType:
    sb << "DescriptorHandle<";
    getTypeNameHint(sb, as<IRDescriptorHandleType>(type)->getResourceType());
    sb << ">";
    break;
```

BLAST RADIUS (must verify): `getTypeNameHint` is the single source of truth for IR type-name rendering — ~19 call sites across 14 files, including `printDiagnosticArg` (slang-ir.cpp:37, diagnostic message text) and buffer/CUDA/optional/clone/autodiff/glsl-block name synthesis. Adding a case can shift diagnostic goldens. Always run `tests/spirv/` AND `tests/diagnostics/` locally before shipping (draft CI skips some). Angle brackets in the name are fine — sibling cases already emit them, so downstream name-sanitizers cope.

Test without GPU: CPU-only via `slangc -target spirv-asm -g2 -emit-spirv-directly`; extend `tests/spirv/debug-info-opaque-types.slang`. Efficient fail-first: build clean master once, confirm the CHECK fails, then the 1-line change is a fast single-TU incremental rebuild.
