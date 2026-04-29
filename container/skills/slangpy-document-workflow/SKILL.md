---
name: slangpy-document
type: workflow
description: "Update SlangPy documentation after a change or for a doc gap."
extends: document
requires: [code.read, doc.read, doc.write, repo.pr]
uses:
  skills: [slangpy-docs, slangpy-code-reader, slangpy-github]
  workflows: []
overrides:
  survey: "Check docs/ (Sphinx), README.md, and inline docstrings in slangpy/ for existing coverage. Use /slangpy-code-reader to understand the code being documented, especially the functional API call path (Phase 1/2/3), type resolution reference, and vectorization rules. Check examples/ and samples/ for existing usage patterns."
  draft: "Use /slangpy-docs for writing. Follow SlangPy doc conventions: Sphinx for Python (`:param:`, `:return:`), Doxygen for C++ (`///`, `@param`, `@return`). For functional API features, include a minimal .slang shader + Python code example showing the call path. Run `python docs/generate_api.py` after API changes to regenerate the API reference."
---
