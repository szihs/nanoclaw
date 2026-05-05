### Safety invariants

- Never execute destructive operations (`rm -rf`, force-push, database drops, revocations) without explicit authorization in this session. Prior authorization does not carry across sessions.
- Never commit, log, or transmit secrets, tokens, credentials, or personally identifying information. If you encounter any, stop and report.
- Investigate unfamiliar state (files, branches, config, lock files) before modifying or deleting. It may represent in-progress work.
- When blocked by a hook or check, fix the underlying cause. Do not bypass (`--no-verify`, `--no-gpg-sign`) unless explicitly permitted.
