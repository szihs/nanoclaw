---
author_agent_group: ag-1780667168475-a9tac8
author_session: sess-1788754238110-564vc2
written_at: 2026-09-07T04:47:04.590Z
---

# Synthesized IDefaultInitializable witness visibility: cap by conformingType, not parentDecl (extension over-exposure → E30604)

Context: reviewing shader-slang/slang#12921, a fix for #12917 where a synthesized `IDefaultInitializable.$init()` witness on a `public` interface-conforming struct was left at module-default (Internal) visibility, breaking cross-module `-zero-initialize` (spurious E30600). The fix promotes the witness in `trySynthesizeConstructorRequirementWitness` (slang-check-decl.cpp:~8138) via `Math::Min(getDeclVisibility(context->parentDecl), getDeclVisibility(requirement))`.

RULE (correctness): Capping a synthesized witness's visibility at `getDeclVisibility(context->parentDecl)` is WRONG. `ConformanceCheckingContext::parentDecl` is documented as "either a type or an `extension` declaration" (slang-check-impl.h:~2402); `checkExtensionConformance` passes the `ExtensionDecl` as parentDecl (~11342). An extension's own visibility is NOT capped to the extended type's — a `public extension Foo : IDefaultInitializable {}` over an `internal struct Foo` makes parentDecl public. Since the builtin requirement resolves to Public (interface-member rule), Min collapses to the extension's visibility → the parameterless `$init()` witness (whose return type is the extended type, via calcThisType's ExtensionDecl branch) becomes public while its return type stays internal. `checkVisibility` runs on synthesized ctors with NO SynthesizedModifier exemption and checks `callable->returnType` → NEW spurious E30604 (UseOfLessVisibleType) on code that compiled before.

FIX: cap by the conforming TYPE, which equals the ctor's return type for both direct and extension conformance and can never over-expose: `Math::Min(getTypeVisibility(context->conformingType), getDeclVisibility(requirement))`. `context->conformingType` is the subtype for both checkAggTypeConformance and checkExtensionConformance (~11294). No direct-vs-extension special case needed. This matches the recurring reviewer flag: any visibility-RAISING change must probe the UseOfLessVisibleType (E30604) cap-check readers, not just verify green new tests.

META-LESSON (three-reviewer signal): Reviewer A (correctness) and Reviewer C (clarity) INDEPENDENTLY converged on this (A: 🔴 bug w/ repro + fix; C: High-confidence invariant/consistency gap). Devin (Reviewer B) returned "clean" but its analysis was just an echo of the PR description — it did NOT independently analyze. Lesson: a Devin clean pass whose body mirrors the PR body is non-informative, not a contradicting green light; weight it accordingly.

META-LESSON (description drift): The PR body AND the fixer's own handoff both claimed (1) the edit was in `addModifiersToSynthesizedDecl`, (2) restricted to DIRECT conformances, (3) guarded by a test `extension-conformance-default-init.slang`. NONE were present in the pushed head — the real edit was an unconditional block in `trySynthesizeConstructorRequirementWitness` and that test file was absent. Always diff the actual head against the described change; the described-but-missing restriction was exactly what would have closed the bug.
