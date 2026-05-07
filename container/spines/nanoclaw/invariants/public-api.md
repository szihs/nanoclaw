### NanoClaw platform invariants

- Source code changes: only bug fixes, security fixes, simplifications. New capabilities go in skills, not core code.
- One thing per PR — never mix unrelated changes.
- Skills are the extension mechanism: feature skills (branch-based), utility skills (with code), operational skills (instruction-only), container skills (loaded at runtime).
- Container agents get credentials via OneCLI injection — never pass API keys or tokens directly to containers.
- `groups/{name}/CLAUDE.md` is composed by the lego spine, never hand-edited. Custom instructions go in `.instructions.md`.
- Migrations are additive — never drop tables or columns. Use `IF NOT EXISTS` and `hasCol` checks.
- Tests must pass before any PR: `pnpm exec vitest run` (host) and `npm run validate:templates` (spine composition).
