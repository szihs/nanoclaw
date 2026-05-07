# spine-base

Universal coworker spine. Provides:

- **Invariants** (`invariants/`) — safety, truthfulness, scope rules every coworker obeys.
- **Context** (`context/`) — workspace layout + invocation protocol every coworker needs in every turn.
- **Base type** (`coworker-types.yaml`) — `base-common`, the root every project type extends.

Procedural content lives in sibling workflow skills (`/investigate`, `/implement`, `/review`, `/document` — in `base-*-workflow/` directories) and loads on demand via Claude Code's native SKILL.md progressive disclosure.

See `docs/lego-coworker-workflows.md` for the full design.

## Status

Prototype alongside the existing 6-section composer. Activated when `src/claude-composer.ts` is rewritten around the spine + manifest model. Until then, these files are staged but not yet consumed.
