---
name: nanoclaw-review
type: workflow
description: "Review a NanoClaw change against project conventions."
extends: review
requires: [repo.read, code.read, doc.read]
uses:
  skills: [nanoclaw-code-reader, nanoclaw-github]
  workflows: []
overrides:
  assess: "Check: one thing per PR, no new features in core (should be skills), migrations additive only, tests pass, validate:templates pass, no secrets in code."
---
