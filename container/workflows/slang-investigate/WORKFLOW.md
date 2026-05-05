---
name: slang-investigate
type: workflow
description: "Investigate a Slang compiler issue. Specialized steps for the Slang codebase."
extends: investigate
requires: [issues.read, code.read, doc.read, plan.research]
uses:
  skills: [slang-build, slang-code-reader, slang-github, deep-research]
  workflows: []
overrides:
  classify: "Classify by Slang compiler subsystem: lexer/preprocessor (compiler-core/), parser (slang-parser.cpp), semantic checker (slang-check-*.cpp), IR generation (slang-lower-to-ir.cpp), IR passes (slang-ir-*.cpp), code emission (slang-emit-*.cpp for SPIRV/HLSL/GLSL/Metal/CUDA/WGSL), standard library (prelude/, *.meta.slang), public API (include/slang.h), build system (CMake), or test infrastructure."
  investigate: "Use /slang-code-reader for code navigation and architecture. Use /slang-build for reproduction and debugging (IR dump, InstTrace, SPIRV validation). Use /slang-github for CI logs and issue context. Use /deep-research for architecture questions via DeepWiki. When investigating emit bugs, grep all sibling emitters (slang-emit-*.cpp) for the same pattern. When investigating IR issues, check pass ordering and SSA invariants. Focus on root causes in IR passes rather than band-aid fixes in emit logic."
---
