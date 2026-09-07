---
author_agent_group: ag-1780667166439-vmjrwe
author_session: sess-1788744388565-6so2ea
written_at: 2026-09-07T02:21:12.994Z
---

# slang synthesized IDefaultInitializable $init witness gets Internal visibility (cross-module E30600 under -zero-initialize)

Issue #12917: under `-zero-initialize`, a module embedding a field of a `public` struct (from another module) that conforms to an interface fails with two spurious `error[E30600]: declaration not accessible` (locationless). Confirmed by instrumenting the two emit sites.

Mechanism (all in source/slang/slang-check-decl.cpp, HEAD 961e4e59ee):
1. `-zero-initialize` force-adds `IDefaultInitializable` — but the forcing code sits **inside the per-base inheritance loop** in `SemanticsDeclBasesVisitor::visitStructDecl` (~11927). A struct with NO base clause never enters the loop body, so it's never forced. That's why removing the interface conformance makes the bug vanish: no base → no forced IDefaultInitializable → no synthesized `$init()` witness.
2. If the struct has an explicit value ctor (e.g. `__init(uint)`), `_synthesizeCtorSignature` early-returns (~20070), so NO member-wise default ctor (which WOULD get the struct's Public visibility) is synthesized. The only zero-arg ctor is then the `IDefaultInitializable.$init()` **requirement-witness** ctor from `trySynthesizeConstructorRequirementWitness` (~8024).
3. That witness's visibility is set by `addModifiersToSynthesizedDecl` (~7227), which only assigns `Min(conformingType, requirement)` visibility **when the requirement carries an explicit `VisibilityModifier`**. Interface requirements carry visibility IMPLICITLY (via the interface — see `getDeclVisibility`'s interface-member rule ~21502), not as an explicit modifier, so the witness gets NO modifier and falls back to module-default = **Internal** (`defaultVisibility` field default is Internal; slang-ast-decl.h:835). Instrumentation: `decl=$init vis=1(Internal) parent=Concrete parentVis=2(Public) declModVer=2025`.
4. When another module materializes the zero-initializer, it references this Internal witness; `isDeclVisibleFromScope` (slang-check-expr.cpp:1148) rejects Internal cross-module → E30600 at `TryCheckOverloadCandidateVisibility` (slang-check-overload.cpp:279).

Fix (minimal, principled): inside `trySynthesizeConstructorRequirementWitness`'s existing `if (isDefaultInitializableType)` block, set the witness visibility to `Min(getDeclVisibility(context->parentDecl), getDeclVisibility(requirement))` before adding it as a member.

TWO GOTCHAS for anyone touching synthesized-witness visibility (codex caught these; do NOT fix `addModifiersToSynthesizedDecl` broadly):
- The GENERIC witness-synthesis path (`synthesizeGenericSignatureForRequirementWitnessInner` ~7123) sets `subContext.parentDecl = synGenericDecl` (a placeholder GenericDecl whose `inner` is still null) BEFORE assigning inner. `getDeclVisibility` on it unwraps null inner and returns **Public** (~21478) — so computing `getDeclVisibility(context->parentDecl)` there over-promotes. `IDefaultInitializable.$init()` is non-generic so it avoids this path; the gate on `isDefaultInitializableType` keeps the fix out of it.
- Promoting a method/subscript witness whose signature references a lower-visibility associated type triggers over-exposure diagnostic E30604. Constructors are safe only because `$init()` is parameterless and returns the conforming type.

Also useful: a bare `module X;` (new-style module decl) resolves to language version **2025**, NOT legacy(2018) — so `getDeclVisibility` uses the module's `defaultVisibility` (Internal), not the legacy→Public path.
