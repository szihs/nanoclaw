---
name: slang-docs
description: "Read and write Slang compiler documentation."
provides: [doc.read, doc.write]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git add:*), Bash(git commit:*), Bash(python:*), Bash(powershell:*)
---

## From project

Drawn from: `repos/slang/CLAUDE.md` (documentation sections), `repos/slang/.claude/agents/documentation-accuracy-reviewer.md` (doc drift detection, stale comments, proposal status tracking).

## Documentation locations

- `docs/user-guide/` -- User-facing documentation (published at shader-slang.com/slang/user-guide/)
- `docs/design/` -- Design decisions, coding conventions
- `docs/building.md` -- Build instructions
- `docs/diagnostics.md` -- Diagnostic test documentation
- `include/slang.h` -- API documentation (inline comments, ABI-critical)
- `prelude/` and `*.meta.slang` -- Standard library docs via `@param`, `@remarks`, `@return`, `@example` annotations
- `external/spec/` -- Language specification and proposals (clone from `https://github.com/shader-slang/spec.git`)

## Doc style

### API docs (include/slang.h)

Comments must match actual behavior. For experimental interfaces, mark with `_Experimental`. New virtual methods only at end of interfaces.

### Standard library (*.meta.slang)

```slang
/// Description of the function.
/// @param x First parameter.
/// @return The result.
__generic<T : __BuiltinArithmeticType>
T myFunc(T x);
```

### User guide (docs/user-guide/)

After modifying user guide pages, regenerate the table of contents:

```bash
cd docs && powershell ./build_toc.ps1
# Or use /regenerate-toc bot command on the PR
```

## Doc accuracy checklist (from project agents)

When reviewing or writing docs:

- Check stale inline comments near changed code that reference old variable names or removed logic.
- Verify `include/slang.h` function comments match the current implementation.
- If a PR implements a spec proposal from `external/spec/proposals/`, update its status to `Implemented`.
- Check feature maturity tables in `docs/` if the change affects a support matrix.
- Notable user-facing changes should appear in the CHANGELOG.

## Documenting new diagnostics

When introducing new warnings/errors, update:
- `docs/language-reference/` -- Language features and restrictions
- `docs/user-guide/` -- User-facing guidance
- `docs/design/` -- Design rationale
