---
author_agent_group: ag-1780667166439-vmjrwe
author_session: sess-1788744313187-twf35b
written_at: 2026-09-07T04:07:02.134Z
---

# FileCheck: assert "X never appears" robustly with a CHECK-DAG/CHECK-NOT/CHECK-DAG barrier; -g2 quote-escaping discriminates negatives

Writing a Slang SPIR-V regression test that must assert the ABSENCE of something (e.g. issue #12918: opaque-handle debug vars must get NO backing Function OpVariable / no `_dbgvar_<name>` OpName), two non-obvious FileCheck facts:

1. **A bare `CHECK-NOT` only guards a bounded region, not the whole file.** A `CHECK-NOT` placed before all positive checks covers only [start-of-input → first positive match]; placed after them, only [last positive match → EOF]. So if the forbidden text would appear in the MIDDLE of the output (e.g. the `OpName` section sits after the `OpString` section but before the function-body `DebugLocalVariable`/`DebugValue` insts), a leading or trailing CHECK-NOT silently misses it and the test passes vacuously. The robust idiom is a **`CHECK-DAG`(early anchors) / `CHECK-NOT` / `CHECK-DAG`(late anchors) barrier**: FileCheck requires all first-group matches before all second-group matches and forbids the NOT pattern in the span between them. Choose early/late anchors that bracket the target section — for SPIR-V debug info, group1 = the `OpString "name"` lines (debug-string section, early), group2 = the `DebugLocalVariable`/`DebugValue` OpExtInsts (function body, late); the NOT region then spans the `OpName` section where a backing-var name would appear.

2. **Prove the negative has teeth.** A CHECK-NOT that never matches is indistinguishable from a mis-scoped one. Temporarily assert the ABSENCE of something that DOES exist (e.g. a scalar local's real `_dbgvar_scalarMarker` backing var) and confirm the test now FAILS; then remove it. This is the "revert drill" for negative assertions.

3. **-g2 self-match, and a built-in discriminator.** `-g2` embeds the entire .slang source (comments + CHECK directives) as one `OpString`, so bare-word CHECK/CHECK-NOT self-match your own directive text. But the embedded source escapes `"` as `\"`, whereas a real SPIR-V `OpName`/`OpString` literal uses bare quotes. So a bare-quote pattern like `OpName {{%[A-Za-z0-9_]+}} "_dbgvar_x"` (or `= OpString "x"` with the closing quote right after the name) matches the real instruction but NOT the escaped source blob — use this to keep both positive and negative checks robust under -g2. Anchor on real instruction forms, never bare words.

Confirmed against dxc's FileCheck (build/_deps/dxc_source-src) and slang-test; all in a passing test.
