---
author_agent_group: ag-1780667166439-vmjrwe
author_session: sess-1786762423483-d1mkxe
written_at: 2026-09-06T06:54:25.628Z
---

# Slang serialized-module version bump: AST tags are positional and decode BEFORE IR

When a change inserts a new **AST node type** mid-hierarchy (e.g. a new `Type`/`Val` subclass), it is a **backward-incompatible serialization change** and needs a serialized-module format version bump. Why: AST nodes are serialized by their **positional `ASTNodeType` tag** (FIDDLE-generated, NO stable-name indirection), so inserting a node shifts every later tag — a module written by an older compiler mis-decodes/crashes when read by a newer one. (IR opcodes are SAFE: they serialize via stable-name indirection, `getOpcodeStableName`.)

**The version constant + existing gate:** `IRModuleInfo::kSupportedSerializationVersion` in `source/slang/slang-serialize-ir.cpp` stamps the whole container; `readSerializedModuleIR_` checks it with `!=` (rejects both older AND newer). There's a SECOND, unrelated version — `IRModule::k_min/maxSupportedModuleVersion` (slang-ir.h) — that is the IR *instruction-set* version and is NOT enforced on load. Bump `kSupportedSerializationVersion`, not the IR-inst version.

**CRITICAL placement:** both module-load paths — `Linkage::loadSerializedModuleContents` (user precompiled `.slang-module`) and `Session::_readBuiltinModule` (core/builtin, reachable via `loadCoreModule`/`-load-core-module` with a USER-supplied blob) — call `readSerializedModuleAST` BEFORE `readSerializedModuleIR`, and `readSerializedModuleAST` eagerly decodes the ModuleDecl + declsToRegister. So the pre-existing IR-side `!=` gate fires TOO LATE (AST already mis-decoded/crashed). Add an EARLY gate that reads only the version field from the IR chunk (`cast<Fossilized<IRModuleInfo>>(getRootValue(...))->serializationVersion`) BEFORE `readSerializedModuleAST`. Gate BOTH paths.

**.lua diagnostics gotcha:** the generated `Diagnostics::Foo` struct gets a `.location` (SourceLoc) field ONLY when the `err()` declares a `span({loc="location",...})`. Plain `~placeholder` message args become **String** fields named after the placeholder; call via struct designated-init `sink->diagnose(Diagnostics::Foo{.path=..., .foundVersion=...})` with NO `.location`. Diagnostic error codes live in `source/slang/slang-diagnostics.lua` as `err(name, code, msg)`.

**Testing:** you can't cleanly check in a stale-binary fixture (self-invalidating on each bump; binary blobs aren't used in tests/). Prove rejection with a cross-version manual test: an OLDER-commit slangc writes a module (`slangc m.slang -o m.slang-module`), the NEW slangc loads it (`slangc use.slang -r m.slang-module -target spirv`) and must reject with a clean diagnostic + exit 1 (NOT SIGSEGV/139). Round-trip regression is covered by `tests/serialization/`.

Context: shader-slang/slang PR #12555 (dyn IFoo / ExistentialType), maintainer-approved version bump, commit 0d73132ff8.
