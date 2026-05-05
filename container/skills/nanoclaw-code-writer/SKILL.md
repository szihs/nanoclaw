---
name: nanoclaw-code-writer
description: "Implement changes in NanoClaw. Edit code, write tests, format, commit."
provides: [code.read, code.edit, test.gen]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Code Writer

## Style

- TypeScript strict mode, ES2022 target, NodeNext modules
- Prettier for formatting (`pnpm run format:fix`)
- No comments unless the WHY is non-obvious
- Prefer editing existing files over creating new ones
- Migrations are additive only — never drop tables or columns

## Test patterns

- Host tests: vitest in `src/**/*.test.ts`, `setup/**/*.test.ts`, `dashboard/**/*.test.ts`
- Agent-runner tests: `bun:test` in `container/agent-runner/src/**/*.test.ts`
- Architecture alignment tests verify spine composition doesn't drift

## Workflow

1. Create a branch: `git checkout -b fix/description`
2. Make changes — minimal, one concern per PR
3. Run format: `pnpm run format:fix`
4. Run tests: `pnpm exec vitest run && npm run validate:templates`
5. Commit with clear message
