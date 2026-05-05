---
name: nanoclaw-docs
description: "Read and write NanoClaw documentation."
provides: [doc.read, doc.write]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git add:*), Bash(git commit:*)
---

# Documentation

## Locations

- `docs/` — Architecture docs, runbooks, coworker workflow spec
- `CLAUDE.md` — Root project instructions (operator-facing)
- `CONTRIBUTING.md` — Contribution guidelines
- `container/skills/*/SKILL.md` — Per-skill documentation
- `docs/lego-coworker-workflows.md` — Full lego model specification
- `docs/DEBUG_CHECKLIST.md` — Troubleshooting guide
- `docs/ON-CALL-RUNBOOK.md` — Operational runbook
