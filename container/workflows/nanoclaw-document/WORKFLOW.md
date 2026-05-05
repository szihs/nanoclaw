---
name: nanoclaw-document
type: workflow
description: "Update NanoClaw documentation after a change or for a doc gap."
extends: document
requires: [code.read, doc.read, doc.write, repo.pr]
uses:
  skills: [nanoclaw-docs, nanoclaw-code-reader, nanoclaw-github]
  workflows: []
overrides:
  survey: "Check docs/ for existing docs. Use /nanoclaw-code-reader to understand the code being documented."
  draft: "Use /nanoclaw-docs for writing. Keep docs minimal — architecture decisions in docs/, operational guides in SKILL.md files."
---
