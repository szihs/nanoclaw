---
name: nanoclaw-implement
type: workflow
description: "Implement a fix or feature in NanoClaw. Specialized build/test/format steps."
extends: implement
requires: [code.read, code.edit, test.run, test.gen, repo.pr]
uses:
  skills: [nanoclaw-build, nanoclaw-code-reader, nanoclaw-github, nanoclaw-code-writer]
  workflows: []
overrides:
  reproduce: "Write a failing test in src/**/*.test.ts that demonstrates the issue."
  patch: "Use /nanoclaw-code-writer. Source changes only for bug fixes — new capabilities go in skills."
  validate: "Build: pnpm run build. Test: pnpm exec vitest run. Templates: npm run validate:templates. Format: pnpm run format:fix."
---
