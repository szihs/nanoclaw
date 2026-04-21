# nanoclaw-base

Upstream-parity default bodies for the `main` and `global` assistants.

## What it provides

- `main` coworker type — verbatim upstream/v2 `groups/main/CLAUDE.md`
- `global` coworker type — verbatim upstream/v2 `groups/global/CLAUDE.md`

Both are declared `flat: true`, which tells `composeCoworkerSpine` to emit the prompt body verbatim with no section scaffolding. Additive skills (ones that re-declare `main`/`global` with `context:` fragments only) are merged into these same type names; the composer joins each block with `---`.

## Why it exists

The project-wide invariant: with *only* `nanoclaw-base` installed, `groups/{main,global}/CLAUDE.md` equals the upstream file byte-for-byte. The fixture-parity test in `src/claude-composer.test.ts` pins this — it pairs with `test-fixtures/upstream-v2/*.md`.

## Updating to a new upstream

```bash
# fetch latest upstream prompts
git fetch upstream
git show upstream/v2:groups/main/CLAUDE.md   > test-fixtures/upstream-v2/main.md
git show upstream/v2:groups/global/CLAUDE.md > test-fixtures/upstream-v2/global.md

# re-sync the skill bodies and regenerate
cp test-fixtures/upstream-v2/main.md   container/skills/nanoclaw-base/prompts/main-body.md
cp test-fixtures/upstream-v2/global.md container/skills/nanoclaw-base/prompts/global-body.md
npm run rebuild:claude
```
