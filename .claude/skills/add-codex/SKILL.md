---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription or OpenAI API key, vault-only via OneCLI. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
metadata:
  nanoclaw-provider: codex
  nanoclaw-provider-label: Codex
  nanoclaw-provider-hint: OpenAI — ChatGPT subscription or API key
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# Codex agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth codex` performs this whole install (barrels, CLI manifest entry, image rebuild) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw resolves each group's agent backend through three tiers — `sessions.agent_provider` → `agent_groups.agent_provider` → `container_configs.provider` → `claude` (see **Use it** below). This fork carries the Codex payload in trunk, so this skill wires and authenticates rather than fetching: confirm the payload, append one import to each of the three provider barrels, add the pinned Codex CLI to the container manifest (`container/cli-tools.json`), rebuild, then run the vault auth walk-through.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id, no on-disk transcript). This replaced the earlier `@openai/codex-sdk` library integration, which is gone — no dependency on it remains in `container/agent-runner/package.json`, and any lockfile still naming `@openai/codex-sdk` is stale and should be deleted, not reinstalled from. Credentials are **vault-only**: OneCLI serves a sentinel `auth.json` stub into the container and swaps the real ChatGPT token or API key on the wire — no key in `.env`, nothing readable in the container.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Check whether the payload is already wired (on trunk it is — see step 1). These are the markers that mean installed — skip to **Authenticate**:

- `src/providers/codex.ts`
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/providers/codex.ts` — the picker entry + vault auth walk-through
- `import './codex.js';` in all three barrels: `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, `setup/providers/index.ts`
- an `@openai/codex` entry in `container/cli-tools.json`

`verifyCodexInstall` in `setup/providers/codex.ts` checks exactly this list; `--step provider-auth codex` runs it as the install check.

### 1. The payload ships in trunk — there is nothing to fetch

**This skill carries no `nc:copy from-branch:providers` step, and must not gain one.** This fork's codex files are forks of the `providers` branch payload, not copies: `codex-app-server.ts`, `container/…/codex.ts` and `src/providers/codex.ts` all diverge by hundreds of lines. A `copy` directive overwrites its destination unconditionally in **refresh** mode (`scripts/skill-apply.ts` `selfStatus`), and `/update-skills` refreshes every provider it finds in `src/providers/index.ts` — so a fence here would silently revert that divergence, and tsc would stay green because upstream's versions compile. Pruning a fence to "only the files we carry" does not help: those are the diverged ones. `setup/providers/codex.test.ts` fails if a fence reappears.

The payload this fork does not carry, and does not want:

| Not carried | Why |
|---|---|
| `src/providers/codex-agents-md.ts` (+ test) | CLAUDE.md is composed by the lego spine; codex gets native discovery from the `AGENTS.md → CLAUDE.md` symlink in `src/group-init.ts`. Upstream's AGENTS.md composer has no reader here. |
| `container/AGENTS.md` | The base that composer embeds. No composer, no reader. |
| `container/agent-runner/src/providers/exchange-archive.ts` (+ test) | Its `onExchangeComplete` hook is implemented by no provider in this fork. |
| upstream's `codex-registration` / `codex-host-contribution` / `codex.turns` / `codex-cli-tools` tests | Covered here by `src/providers/barrel-registration.test.ts`, `codex.factory.test.ts`, `codex-app-server.test.ts`. |

`setup/providers/codex.ts` is fork-local too: upstream's `verifyCodexInstall` requires `codex-agents-md.ts`, so upstream's copy reports this working install as broken.

### 2. Wire the barrels

This fork carries no `src/provider-contracts/codex.ts` nor its container twin, so the two
provider-CONTRACT barrels are deliberately not wired: appending `import './codex.js';` there
would import a module that does not exist here and break the build. Upstream's copy of this
skill has those two fences because upstream installs the `providers`-branch payload, which
does carry them. Do not re-add them without also carrying the declarations.

Append the self-registration import to each of the three provider barrels (skipped if the line is already present — which is the normal state on trunk; these stay so a deleted line self-heals). Each barrel-registration test imports its real barrel and asserts `codex` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './codex.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './codex.js';
```

```nc:append to:setup/providers/index.ts
import './codex.js';
```

### 3. CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. Add Codex by appending one entry — idempotent on `name`, so a re-run is a no-op. `@openai/codex` has no native postinstall (its published `scripts` are empty), so no `onlyBuilt`. Both `container/Dockerfile` and `container/Dockerfile.derived` install every manifest entry via pinned `pnpm install -g`; no Dockerfile edit is needed.

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "@openai/codex", "version": "0.146.0" }
```

The version (`0.146.0`, published 2026-07-29) is the canonical pin — this SKILL.md is the source of truth, and `container/cli-tools.json` must agree with it.

Two things to know before bumping it:

- **The pin is the whole supply-chain control.** Codex briefly escaped the manifest into a hand-written `pnpm install -g` layer duplicated across both Dockerfiles, and `0.146.1` reached the image roughly 14.6 hours after it was published. Keep it here.
- **The release-age quarantine is now ENFORCED on this install path**, not merely documented. `container/install-cli-tools.sh` writes `minimum-release-age=4320` into `/root/.npmrc` — the config a global install actually reads — and proves at build time that pnpm is honouring it. A pin younger than three days fails the image build with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. That is why the pin is `0.146.0` and not `0.146.1`: check the publish time first (`pnpm view @openai/codex@<version> time`) and choose a version that has already matured rather than the newest tag. Do **not** reach for `minimumReleaseAgeExclude` — it needs explicit human sign-off, and every entry is a permanent hole unless someone prunes it.

### 4. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 5. Validate

```nc:run effect:test
pnpm vitest run src/providers/barrel-registration.test.ts setup/providers/
```
```nc:run effect:test
cd container/agent-runner && bun test src/providers/
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth codex
```

The same walk-through fresh installs get from the setup picker: ChatGPT subscription (browser login or device pairing) or an OpenAI API key, landed in the OneCLI vault. Idempotent — it short-circuits when a matching secret already exists. It finishes with the install check.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host.

**The provider resolves through three tiers, highest first** (`resolveProviderName` in `src/container-runner.ts`): `sessions.agent_provider` → `agent_groups.agent_provider` → `container_configs.provider` → `"claude"`. The command above writes the lowest tier, so a group carrying `agent_groups.agent_provider` (what `ncl groups get` shows as `agent_provider`, and what the dashboard's picker sets) keeps that value regardless. Check with `ncl groups get --id <group-id>`; clear a stale override with `ncl groups update --id <group-id> --agent-provider ''` (empty resolves as unset). Switching *away* from codex has the same trap — see [REMOVE.md](REMOVE.md).

Every provider uses the same `memory/` tree, so memory carries across
automatically. Run `/migrate-memory` only when upgrading a group that still has
legacy `.seed.md`, `CLAUDE.local.md`, or unindexed imported memory. See
[docs/provider-migration.md](../../docs/provider-migration.md).

### Default new groups to codex (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires codex in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Codex is installed. Default new agent groups to codex? Existing groups keep their current provider."

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value codex
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction. Creation itself stays provider-agnostic (no `--provider` flag — provider is a DB property stamped from the instance default at creation).

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`.
- **Auth errors mid-conversation:** the vault secret is missing or stale — re-run `pnpm exec tsx setup/index.ts --step provider-auth codex` (subscription re-login updates the vault copy).
