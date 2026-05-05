---
name: slang-document
type: workflow
description: "Update Slang compiler documentation after a change or for a doc gap."
extends: document
requires: [code.read, doc.read, doc.write, repo.pr]
uses:
  skills: [slang-docs, slang-code-reader, slang-github]
  workflows: []
overrides:
  survey: "Check docs/user-guide/ for existing user docs, docs/design/ for design docs, include/slang.h for API docs, and prelude/*.meta.slang for standard library annotations. Use /slang-code-reader to understand the code being documented. Check external/spec/proposals/ for proposal status."
  draft: "Use /slang-docs for writing. Follow Slang doc conventions: Doxygen `///` style for C++ API docs, `@param`/`@return`/`@remarks`/`@example` for *.meta.slang annotations, markdown for user-guide pages. Regenerate user-guide TOC after edits: `cd docs && powershell ./build_toc.ps1` or use the `/regenerate-toc` bot command."
---
