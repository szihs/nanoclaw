# Hermes release pin — `scripts/hermes-pin.sh`

Operator tool for the **nemoclaw-coworkers** instance (box `slang-cpu-coworkers`). It pins the read-only
`NousResearch/hermes-agent` tree that every `hermes-*` coworker container sees at `/workspace/extra/hermes-release`.

## What it does

1. Resolves the target: an explicit tag (`v2026.8.31`), `latest` (GitHub releases API, unauthenticated; falls back to
   the newest tag from `git ls-remote`; a rate-limited or unreachable API is a clear exit-3 error), or `main` (the
   branch head sha from the API — the tarball is then fetched **by that sha**, so manifest and tree always agree).
2. Preflight: refuses if a running container mounts the live tree (see Safety) — checked **before** the download and
   again right before the swap.
3. Downloads `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/tags/<tag>` (`main`:
   `.../tar.gz/<sha>`), records the tarball sha256, extracts it into a **sibling** directory `hermes-agent-<tag>`
   (`main`: `hermes-agent-main-<sha12>`) next to the live tree. If the run ends before the swap, that staged sibling is
   removed again.
4. Writes `RELEASE_MANIFEST.json` at the new tree root — `{ tag, commit, tarball_sha256, downloaded_at, source_url,
   pinned_by, previous_tag, previous_commit, previous_dir }` — and regenerates the per-file digest list
   `hermes-agent-release.sha256`.
5. Swaps by **directory rename** (below), appends `<date> pinned <tag> (<commit>) previous <oldtag>` to
   `$NANOCLAW_ROOT/data/shared/hermes/PIN.md`, and logs to `$NANOCLAW_ROOT/logs/hermes-pin.log` (the log file is only
   created after the hostname guard has passed).

Re-pinning the tag that is already live leaves the tree alone (message, exit 0) but still runs `--gc` / `--sync-fork`
when asked. One run at a time: `$ROOT/.hermes-pin.lock` (a lock whose pid is gone is cleared automatically; otherwise
exit 6). The manifest is the **source of truth** for the pinned tag; `vars.release_tag` in
`container/spines/hermes/coworker-types.yaml` is only a fallback label for compose-time `{{vars.release_tag}}`
substitution — bump it in a follow-up PR when the pin moves, but the roles cite the manifest.

## Why a directory rename and not a symlink

The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`, enforced by `src/modules/mount-security/index.ts`)
resolves **realpaths** and allows exactly `/home/ubuntu/haaggarwal/hermes-agent-release` read-only. If that path became a
symlink, its realpath would be `hermes-agent-<tag>`, the allowlist check would fail, and every `hermes-*` spawn would be
refused. Renaming keeps the allowed path a real directory:

```
extract  -> /home/ubuntu/haaggarwal/hermes-agent-<newtag>
rename      hermes-agent-release      hermes-agent-<oldtag>     # oldtag from RELEASE_MANIFEST.json, else hermes-agent-prev-<ts>
rename      hermes-agent-<newtag>     hermes-agent-release
```

The renames are `os.rename(2)` calls, not `mv`: if the target already exists (e.g. a second run re-created
`hermes-agent-release` in between) the rename fails instead of moving the tree *into* it. A failure or a signal
(INT/TERM/HUP) between the two renames puts the old tree back (exit 6 / 130), so `hermes-agent-release` is never left
missing.

Running containers keep their bind mount on the old inode (still valid, now named `hermes-agent-<oldtag>`); new
containers see the new tree on their **next spawn**. The previous directory stays on disk for `--rollback`.

## Usage

```bash
scripts/hermes-pin.sh latest                 # newest GitHub release
scripts/hermes-pin.sh v2026.8.31             # an exact tag
scripts/hermes-pin.sh main                   # branch head (manifest tag="main", commit=<sha>; dir hermes-agent-main-<sha12>)
scripts/hermes-pin.sh v2026.9.3 --dry-run    # print the full plan, touch nothing, exit 0
scripts/hermes-pin.sh --rollback             # swap the most recent previous tree back in (manifest.previous_tag)
scripts/hermes-pin.sh --gc                   # delete hermes-agent-<tag> siblings that are not live, not the tree this
                                             # run rotated out, not the most recent previous, not the newest download,
                                             # and not mounted by any running container
scripts/hermes-pin.sh latest --sync-fork     # also push upstream tag -> fork main (see below)
```

Flags: `--force` (swap / gc even while a running container has the tree mounted or that cannot be verified),
`--root DIR` (parent of the release dir; default `/home/ubuntu/haaggarwal`), `--allow-any-host` (bypass the hostname
guard). Env: `HERMES_PIN_HOSTS` (hostname regex, default `^slang-cpu-coworkers`), `NANOCLAW_ROOT` (default
`/home/ubuntu/haaggarwal/nemoclaw-coworkers`), `GH_TOKEN`/`GITHUB_TOKEN` (optional, raises the API rate limit). Exit
codes are listed in the script header (`scripts/hermes-pin.sh --help`); `130` = interrupted, live tree restored.

Safety: refuses on any host not matching `HERMES_PIN_HOSTS`; refuses to swap while a running container has the release
dir bind-mounted unless `--force`; always previewable with `--dry-run`. Docker records `Mounts[].Source` as the
**create-time** string, which goes stale after a rename (a container started on `hermes-agent-release` still reports
that path after the tree was renamed to `hermes-agent-<oldtag>`). The script therefore resolves what each container
really mounts through `/proc/<pid>/mountinfo` and `/proc/<pid>/root/<dest>` (device:inode). Where that is unavailable
(macOS, or not running as root) it is conservative: any running container whose create-time source is under
`$ROOT/hermes-agent-*` blocks the swap, and `--gc` keeps every sibling, unless `--force`. Run the script as root on the
box for a precise check. A missing `docker` binary is also a refusal (exit 5) unless `--force` or
`HERMES_PIN_SKIP_DOCKER=1`.

## What changes for containers

- Nothing until a container respawns. `ncl groups restart --id <hermes-group-id>` picks it up now; otherwise the next
  wake does. Sessions mid-run keep the old tree until they exit.
- `/workspace/extra/hermes-release/RELEASE_MANIFEST.json` is what roles read for the tag (`context/testbed.md`,
  `context/layout.md`). Spine prose that still hardcodes a version (`README.md`, `identity/engineer.md`, skills) is
  a label, not a contract — update it in the same follow-up PR as `vars.release_tag`.
- Fork worktrees created with `git worktree add … <pinned-tag>` are unaffected; new targets base on the new tag.

## Fork sync (`--sync-fork`)

The box host has **no** `gh` auth; GitHub credentials exist only inside coworker containers via the OneCLI proxy. So
`--sync-fork` runs `gh` only when `gh auth status` succeeds, and otherwise prints the commands for a coworker or
operator to run — the pin itself never fails because the sync was unavailable. This is the exact block the script
emits (a throwaway blob-less clone, so it works from any shell that has GitHub credentials — a coworker container's
`/workspace/agent/hermes-agent` checkout is not required):

```bash
git clone --filter=blob:none --no-checkout https://github.com/NousResearch/hermes-agent.git /tmp/hermes-fork-sync
cd /tmp/hermes-fork-sync
git remote add fork https://github.com/slang-coworkers/hermes-agent.git
git fetch fork main
git push --force-with-lease=main fork refs/tags/<tag>^{commit}:refs/heads/main
git push fork refs/tags/<tag>:refs/tags/<tag>
cd / && rm -rf /tmp/hermes-fork-sync
```

For `main` the first push uses the pinned commit sha instead of `refs/tags/<tag>^{commit}` and there is no tag push.

## Carrying a single upstream test-only commit into the fork

Sometimes upstream fixes a test one day after the release we pinned. Example: `eb1b14b95`
"test(desktop-e2e): fix spec drift accrued while the lane was disabled" repaired `apps/desktop` `chat.spec.ts` the day
after `v2026.8.31`. The pin stays on the tag (the release tree is the citation source and must equal the tag exactly);
the fix lives in the **fork** only, where the tester's desktop tier actually runs:

```bash
cd /workspace/agent/hermes-agent && git fetch upstream --tags && git fetch upstream main
git checkout -b chore/pick-eb1b14b95 origin/main
git cherry-pick -x eb1b14b95               # test-only diff; if it touches anything outside tests/apps specs, stop and ADR it
(cd apps/desktop && npm test -- chat.spec) # or the relevant vitest/Playwright lane
git push -u origin chore/pick-eb1b14b95
gh pr create --repo slang-coworkers/hermes-agent --base main --title "test(desktop-e2e): pick eb1b14b95 (spec drift)"
```

Record the pick in `PIN.md` next to the pin line so the next `--sync-fork` (which force-with-lease-pushes the tag onto
`main`) is expected to drop it — re-pick after the sync, or wait for the next release that already contains it.

## Release cadence

Upstream tags roughly weekly, sometimes more (`v2026.8.16.2`, `v2026.8.18`, `v2026.8.19`, `v2026.8.27`, `v2026.8.31`).
Pin deliberately, not on every tag: run `latest --dry-run` first, read the upstream release notes for plugin-contract
changes (`hermes_cli/plugins.py`, `VALID_HOOKS`, `plugin.yaml` schema), then pin and restart the `hermes-*` groups in a
quiet window. Keep at least one previous tree for `--rollback`; `--gc` the rest.

## Offline / local test

```bash
HERMES_PIN_TARBALL=/path/hermes-agent-v2026.8.31.tar.gz HERMES_PIN_COMMIT=<40-char sha> HERMES_PIN_SKIP_DOCKER=1 \
  scripts/hermes-pin.sh v2026.8.31 --root "$SCRATCH/pin" --allow-any-host --dry-run
```

`HERMES_PIN_TARBALL` / `HERMES_PIN_COMMIT` bypass the network (`HERMES_PIN_TAG` does the same for `latest`);
`HERMES_PIN_SKIP_DOCKER=1` skips the mount check, `HERMES_PIN_DOCKER` swaps in another container CLI and
`HERMES_PIN_PROC` another procfs root (the vitest cases use both with fakes); `HERMES_PIN_TEST_SLEEP_MID_SWAP=<s>`
pauses between the two renames so the signal trap can be exercised. The script is bash-3.2 / BSD-portable (no
`mv -T`, `readlink -f`, or `sha256sum` assumptions), so it runs on macOS too.

Tests: `pnpm vitest run scripts/hermes-pin.test.ts` (bash-3.2 proof: `HERMES_PIN_BASH=/bin/bash pnpm vitest run
scripts/hermes-pin.test.ts`).
