#!/usr/bin/env bash
# hermes-pin.sh — pin the Hermes release tree the hermes-* coworkers read.
#
# USAGE
#   scripts/hermes-pin.sh <tag|latest|main> [--dry-run] [--force] [--sync-fork] [--gc]
#                         [--root DIR] [--allow-any-host]
#   scripts/hermes-pin.sh --rollback [--gc] [--dry-run] [--force] [--root DIR] [--allow-any-host]
#   scripts/hermes-pin.sh --gc       [--dry-run] [--force] [--root DIR] [--allow-any-host]
#
# WHAT IT DOES
#   The coworkers cite NousResearch/hermes-agent from a READ-ONLY bind mount of
#   $ROOT/hermes-agent-release (container path /workspace/extra/hermes-release).
#   NanoClaw's mount allowlist pins that exact realpath, so the live tree is a
#   real directory and is swapped by RENAME, never by symlink:
#
#     1. resolve   <tag> | latest (GitHub releases/latest; git ls-remote fallback) |
#                  main (head sha from the API; the tarball is then fetched BY THAT SHA so the
#                  manifest and the tree always agree — manifest tag="main", commit=<sha>,
#                  sibling dir hermes-agent-main-<sha12>)
#     2. preflight refuse if any RUNNING container bind-mounts the live tree (--force overrides).
#                  Runs BEFORE the download (fail fast) and again right before the swap.
#     3. download  https://codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/tags/<tag>
#                  (main: .../tar.gz/<sha>)
#     4. verify    sha256 the tarball, extract into $ROOT/.hermes-pin-tmp.<pid>/, require exactly
#                  one top-level dir containing pyproject.toml, stage it as $ROOT/hermes-agent-<tag>
#                  (the staged dir is removed again if the run ends before the swap)
#     5. manifest  write RELEASE_MANIFEST.json INTO the new tree (before the swap)
#     6. swap      rename hermes-agent-release -> hermes-agent-<oldtag> (old tag from its manifest,
#                  else hermes-agent-prev-<UTC stamp>); rename hermes-agent-<tag> -> hermes-agent-release.
#                  Renames use os.rename(2): an existing non-empty target is an ERROR, never a
#                  move-into. INT/TERM/HUP or a failure between the two renames puts the old
#                  tree back (exit 130 / 6).
#     7. sha256    regenerate $ROOT/hermes-agent-release.sha256 (one "<sha256>  <relpath>" per file)
#     8. docs      append "<date> pinned <tag> (<commit>) previous <oldtag>" to
#                  $NANOCLAW_ROOT/data/shared/hermes/PIN.md
#     9. --sync-fork  push the upstream tag to slang-coworkers/hermes-agent main + tag when `gh`
#                  is authenticated; otherwise print the exact commands (never fails the pin)
#    10. --gc      delete hermes-agent-<x> siblings that are not: live, the tree rotated out by
#                  this run, the most recent previous (live manifest previous_dir), the newest
#                  download (manifest downloaded_at), or mounted by a running container
#
#   Re-pinning the tag that is already live is a no-op for the tree (exit 0) but --gc and
#   --sync-fork still run. --rollback swaps the previous tree (live manifest previous_dir) back in.
#
#   One run at a time: $ROOT/.hermes-pin.lock (mkdir lock holding the pid; a lock whose pid is
#   gone is removed automatically, exit 6 otherwise).
#
#   Running-container check: docker records Mounts[].Source as the CREATE-TIME string, which goes
#   stale after a rename. The script therefore resolves what each container really mounts through
#   /proc/<pid>/mountinfo (current path) and /proc/<pid>/root/<dest> (dev:inode). Where that is
#   unavailable (macOS, or not root) it is conservative: any running container whose create-time
#   source is under $ROOT/hermes-agent-* blocks the swap, and gc keeps every sibling, unless --force.
#
#   Running containers keep their bind mount on the OLD inode (the rename is safe for them);
#   new containers see the new tree on their next spawn:
#     ncl groups restart --id <hermes-group-id>
#
# RELEASE_MANIFEST.json (source of truth for the spine; replaces the hardcoded tag)
#   { "tag", "commit", "tarball_sha256", "downloaded_at", "source_url", "pinned_by",
#     "previous_tag", "previous_commit", "previous_dir" }
#
# ENVIRONMENT
#   NANOCLAW_ROOT          instance checkout; PIN.md + logs live under it
#                          (default /home/ubuntu/haaggarwal/nemoclaw-coworkers)
#   HERMES_PIN_HOSTS       hostname regex the script may run on (default ^slang-cpu-coworkers)
#   HERMES_PIN_DOCKER      container CLI for the mount check (default docker)
#   GH_TOKEN|GITHUB_TOKEN  optional; only used to raise the GitHub API rate limit
#   Offline / test hooks:
#   HERMES_PIN_TARBALL     local .tar.gz to use instead of downloading
#   HERMES_PIN_COMMIT      commit sha to record instead of asking the API
#   HERMES_PIN_TAG         tag to use for `latest` instead of asking the API
#   HERMES_PIN_SKIP_DOCKER=1  skip the running-container mount check
#   HERMES_PIN_PROC        procfs root used to resolve container mounts (default /proc)
#   HERMES_PIN_TEST_SLEEP_MID_SWAP  seconds to sleep between the two renames (signal-trap test)
#
# EXIT CODES
#   0    pinned / no-op / dry-run / rolled back / gc done
#   1    usage error
#   2    hostname guard refused (use --allow-any-host)
#   3    could not resolve the ref (API unreachable / rate-limited) or download the tarball
#   4    tarball failed verification (bad archive, no single top-level dir, no pyproject.toml)
#   5    refused: a running container mounts the live tree, or that cannot be verified (use --force)
#   6    filesystem error during the swap, or another run holds the lock
#   7    rollback impossible (no previous tree recorded / present)
#   130  interrupted (INT/TERM/HUP); the live tree is restored and the staged tree removed
#
# LOG: $NANOCLAW_ROOT/logs/hermes-pin.log (created only after the hostname guard passes)
#
# Portability: bash 3.2+, GNU/BSD coreutils; sha256 via shasum/sha256sum/python3; JSON + rename via python3.

set -euo pipefail

UPSTREAM_REPO="NousResearch/hermes-agent"
FORK_REPO="slang-coworkers/hermes-agent"
API_BASE="https://api.github.com/repos/${UPSTREAM_REPO}"
CODELOAD_BASE="https://codeload.github.com/${UPSTREAM_REPO}/tar.gz"

# ----------------------------------------------------------------------------- args
REF=""
ROOT="/home/ubuntu/haaggarwal"
DRY_RUN=0
FORCE=0
SYNC_FORK=0
DO_ROLLBACK=0
DO_GC=0
ALLOW_ANY_HOST=0

usage() {
  sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY_RUN=1 ;;
    --force)          FORCE=1 ;;
    --sync-fork)      SYNC_FORK=1 ;;
    --rollback)       DO_ROLLBACK=1 ;;
    --gc)             DO_GC=1 ;;
    --allow-any-host) ALLOW_ANY_HOST=1 ;;
    --root)           [ $# -ge 2 ] || { echo "--root needs a directory" >&2; exit 1; }
                      ROOT="$2"; shift ;;
    --root=*)         ROOT="${1#--root=}" ;;
    -h|--help)        usage; exit 0 ;;
    --*)              echo "unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)                if [ -n "$REF" ]; then echo "only one ref allowed (got '$REF' and '$1')" >&2; exit 1; fi
                      REF="$1" ;;
  esac
  shift
done

if [ -z "$REF" ] && [ "$DO_ROLLBACK" -eq 0 ] && [ "$DO_GC" -eq 0 ]; then
  usage >&2
  exit 1
fi
if [ -n "$REF" ] && [ "$DO_ROLLBACK" -eq 1 ]; then
  echo "--rollback takes no ref" >&2
  exit 1
fi

# ----------------------------------------------------------------------------- paths
py() { python3 "$@"; }
realpath_py() { py -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

case "$ROOT" in /*) ;; *) ROOT="$(pwd)/$ROOT" ;; esac
ROOT="${ROOT%/}"
LIVE="$ROOT/hermes-agent-release"
SHA_FILE="$ROOT/hermes-agent-release.sha256"
MANIFEST_NAME="RELEASE_MANIFEST.json"
NANOCLAW_ROOT="${NANOCLAW_ROOT:-/home/ubuntu/haaggarwal/nemoclaw-coworkers}"
PIN_MD="$NANOCLAW_ROOT/data/shared/hermes/PIN.md"
LOG_PATH="$NANOCLAW_ROOT/logs/hermes-pin.log"
LOG_FILE=""   # set by init_log — only after the hostname guard passed (no side effects before it)
DOCKER_BIN="${HERMES_PIN_DOCKER:-docker}"
HOST_RE="${HERMES_PIN_HOSTS:-^slang-cpu-coworkers}"
HOSTNAME_NOW="$(hostname 2>/dev/null || echo unknown-host)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TODAY="${NOW_ISO%%T*}"
PINNED_BY="${SUDO_USER:-${USER:-$(id -un)}}@${HOSTNAME_NOW}"

# ----------------------------------------------------------------------------- logging
_log_file() {
  if [ -n "$LOG_FILE" ]; then
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true
  fi
}
log()  { printf '%s\n' "$*"; _log_file "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; _log_file "warn: $*"; }
die()  { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; _log_file "error(exit $code): $*"; exit "$code"; }
plan() { if [ "$DRY_RUN" -eq 1 ]; then printf '[dry-run] %s\n' "$*"; else log "$*"; fi; }

init_log() {
  if mkdir -p "$(dirname "$LOG_PATH")" 2>/dev/null && touch "$LOG_PATH" 2>/dev/null; then
    LOG_FILE="$LOG_PATH"
  else
    echo "warn: cannot write $LOG_PATH; logging to stdout only" >&2
    LOG_FILE=""
  fi
}

# ----------------------------------------------------------------------------- state + cleanup
TMP=""
LOCK=""
LOCK_HELD=0
STAGING=""
STAGED_BY_US=0     # 1 while $STAGING exists but the swap has not completed (removed on exit)
SWAP_FROM=""       # where the live tree was renamed to, non-empty ONLY between the two renames
PROTECT_DIR=""     # the tree this run rotated out of $LIVE — gc never deletes it

restore_live() { # restore_live WHY — put the old tree back if a swap was interrupted midway
  if [ -n "$SWAP_FROM" ] && [ ! -e "$LIVE" ] && [ -d "$SWAP_FROM" ]; then
    if rename_dir "$SWAP_FROM" "$LIVE" 2>/dev/null; then
      warn "restored $LIVE from $SWAP_FROM after $1"
    else
      warn "could not restore $LIVE from $SWAP_FROM after $1 — rename it back by hand"
    fi
  fi
  SWAP_FROM=""
}

cleanup() { # cleanup WHY
  restore_live "$1"
  if [ "$STAGED_BY_US" -eq 1 ] && [ -n "$STAGING" ] && [ "$STAGING" != "$LIVE" ] && [ -d "$STAGING" ]; then
    rm -rf "$STAGING"
    warn "removed staged $STAGING (the run ended before the swap)"
  fi
  STAGED_BY_US=0
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  if [ "$LOCK_HELD" -eq 1 ] && [ -n "$LOCK" ]; then rm -rf "$LOCK"; LOCK_HELD=0; fi
}
on_exit()   { cleanup "exit"; }
on_signal() { # on_signal NAME
  trap - INT TERM HUP EXIT
  cleanup "interrupt (SIG$1)"
  _log_file "interrupted by SIG$1 (exit 130)"
  exit 130
}
trap on_exit EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

# ----------------------------------------------------------------------------- helpers
json_get() { # json_get FILE KEY  -> value or "" (null/missing/unreadable)
  py -c 'import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
v=d.get(sys.argv[2]) if isinstance(d, dict) else None
print("" if v is None else v)' "$1" "$2"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else py -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
  fi
}

rename_dir() { # rename_dir SRC DST — rename(2): never moves SRC *into* an existing DST (the `mv` hazard)
  py -c 'import os,sys
try:
    os.rename(sys.argv[1], sys.argv[2])
except OSError as e:
    sys.stderr.write("rename %s -> %s: %s\n" % (sys.argv[1], sys.argv[2], e.strerror))
    sys.exit(1)' "$1" "$2"
}

dev_ino() { # dev_ino PATH -> "st_dev:st_ino" or "" when PATH cannot be stat'ed
  py -c 'import os,sys
try:
    s=os.stat(sys.argv[1]); print("%d:%d" % (s.st_dev, s.st_ino))
except OSError:
    pass' "$1" 2>/dev/null || true
}

epoch_utc() { # epoch_utc SECONDS -> ISO UTC or ""
  py -c 'import datetime,sys
try:
    print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
except Exception:
    print("")' "$1" 2>/dev/null || true
}

# --- GitHub API -------------------------------------------------------------
API_CODE=""
API_ERR=""
hdr() { # hdr NAME -> value of the last response header NAME (case-insensitive) in $TMP/api.hdr
  awk -F': ' -v k="$1" '{ if (tolower($1) == k) v = $2 } END { if (v != "") print v }' "$TMP/api.hdr" 2>/dev/null | tr -d '\r'
}
api_get() { # api_get URL OUTFILE -> 0 on HTTP 2xx (body in OUTFILE); otherwise 1 with API_ERR set
  local url="$1" out="$2" code tok auth=()
  API_CODE=""; API_ERR=""
  tok="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$tok" ]; then auth=(-H "Authorization: Bearer $tok"); fi
  : > "$TMP/api.hdr"; : > "$TMP/api.err"
  if code="$(curl -sSL --retry 2 --retry-max-time 40 --connect-timeout 15 \
        -H 'Accept: application/vnd.github+json' -H 'User-Agent: hermes-pin.sh' "${auth[@]+"${auth[@]}"}" \
        -D "$TMP/api.hdr" -o "$out" -w '%{http_code}' "$url" 2>"$TMP/api.err")"; then :; else
    API_ERR="could not reach api.github.com ($(tail -n1 "$TMP/api.err" 2>/dev/null | sed 's/^curl: //'))"
    return 1
  fi
  API_CODE="$code"
  case "$code" in
    2??) return 0 ;;
    403|429)
      local remaining reset when
      remaining="$(hdr x-ratelimit-remaining)"; reset="$(hdr x-ratelimit-reset)"
      if [ "$remaining" = "0" ] || [ "$code" = "429" ]; then
        when="$(epoch_utc "$reset")"
        API_ERR="GitHub API rate limit exhausted (HTTP $code, x-ratelimit-remaining: ${remaining:-?}, resets ${when:-unknown}); set GH_TOKEN or pass an explicit tag"
      else
        API_ERR="GitHub API refused the request (HTTP $code) for $url"
      fi
      return 1 ;;
    404) API_ERR="GitHub API: not found (HTTP 404) for $url"; return 1 ;;
    *)   API_ERR="GitHub API returned HTTP $code for $url"; return 1 ;;
  esac
}

newest_tag_via_git() { # newest v-prefixed tag by numeric components, or "" — never fails the caller
  { GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "https://github.com/${UPSTREAM_REPO}.git" 2>/dev/null || true; } \
    | awk '{print $2}' | sed 's#^refs/tags/##' \
    | py -c 'import re,sys
def key(t):
    return [int(x) if x.isdigit() else -1 for x in re.split(r"[^0-9]+", t.lstrip("v")) if x != ""]
tags=[l.strip() for l in sys.stdin if l.strip()]
tags=[t for t in tags if re.match(r"^v?\d", t)]
print(max(tags, key=key) if tags else "")'
}

# dir suffix used for sibling names: hermes-agent-<suffix>
suffix_for() { # suffix_for TAG COMMIT
  if [ "$1" = "main" ]; then
    if [ -n "$2" ] && [ "$2" != "unknown" ]; then printf 'main-%s' "$(printf '%s' "$2" | cut -c1-12)"
    else printf 'main-%s' "$NOW_STAMP"; fi
  else
    printf '%s' "$1"
  fi
}

live_tag()    { [ -f "$LIVE/$MANIFEST_NAME" ] && json_get "$LIVE/$MANIFEST_NAME" tag || true; }
live_commit() { [ -f "$LIVE/$MANIFEST_NAME" ] && json_get "$LIVE/$MANIFEST_NAME" commit || true; }
live_prev_dir() { # the sibling dir the live manifest says was live before it (basename)
  local m="$LIVE/$MANIFEST_NAME" d t c
  [ -f "$m" ] || return 0
  d="$(json_get "$m" previous_dir)"
  if [ -n "$d" ]; then printf '%s\n' "$d"; return 0; fi
  t="$(json_get "$m" previous_tag)"
  [ -n "$t" ] && [ "$t" != "unknown" ] || return 0
  c="$(json_get "$m" previous_commit)"
  # a `main` previous without its sha cannot be named (hermes-agent-main-<sha12>)
  if [ "$t" = "main" ] && { [ -z "$c" ] || [ "$c" = "unknown" ]; }; then return 0; fi
  printf 'hermes-agent-%s\n' "$(suffix_for "$t" "$c")"
}

newest_script_dir() { # basename of the newest sibling this script created (manifest downloaded_at, then mtime), excluding live
  py - "$ROOT" "$LIVE" "$MANIFEST_NAME" <<'PY'
import glob, json, os, sys
root, live, mname = sys.argv[1:4]
best = None
for d in sorted(glob.glob(os.path.join(root, "hermes-agent-*"))):
    if os.path.islink(d) or not os.path.isdir(d) or os.path.abspath(d) == os.path.abspath(live):
        continue
    m = os.path.join(d, mname)
    if os.path.isfile(m):
        try:
            at = json.load(open(m)).get("downloaded_at") or ""
        except Exception:
            at = ""
        st = os.stat(m)
        key = (1, str(at), getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
    elif os.path.basename(d).startswith("hermes-agent-prev-"):
        key = (0, os.path.basename(d), 0)
    else:
        continue  # not ours
    if best is None or key > best[0]:
        best = (key, d)
print(os.path.basename(best[1]) if best else "")
PY
}

# ----------------------------------------------------------------------------- guard + lock
hostname_guard() {
  if [ "$ALLOW_ANY_HOST" -eq 1 ]; then return 0; fi
  if [[ "$HOSTNAME_NOW" =~ $HOST_RE ]]; then return 0; fi
  die 2 "hostname '$HOSTNAME_NOW' does not match HERMES_PIN_HOSTS='$HOST_RE' (pass --allow-any-host to override)"
}

acquire_lock() {
  LOCK="$ROOT/.hermes-pin.lock"
  local other
  if ! mkdir "$LOCK" 2>/dev/null; then
    other="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$other" ] && [ "$other" != "$$" ] && ! kill -0 "$other" 2>/dev/null; then
      warn "removing stale lock $LOCK (pid $other is gone)"
      rm -rf "$LOCK"
      mkdir "$LOCK" 2>/dev/null || die 6 "another hermes-pin run holds $LOCK (pid $(cat "$LOCK/pid" 2>/dev/null || echo '?'))"
    else
      die 6 "another hermes-pin run holds $LOCK (pid ${other:-?}); wait for it, or remove the lock if that pid is gone"
    fi
  fi
  LOCK_HELD=1
  echo "$$" > "$LOCK/pid"
}

# ----------------------------------------------------------------------------- mounts
# MOUNT_TABLE lines: "<container>\t<create-time source>\t<dest>\t<current root path|->\t<dev:ino|->"
MOUNT_TABLE=""
MOUNT_DEGRADED=0   # 1 when a running container has a hermes-agent-* mount whose identity could not be resolved

build_mount_table() { # lazily; call it OUTSIDE $(...) so the table (and a die) reach the parent shell
  [ -z "$MOUNT_TABLE" ] || return 0
  MOUNT_TABLE="$TMP/mounts.tsv"
  : > "$MOUNT_TABLE"
  MOUNT_DEGRADED=0
  if [ "${HERMES_PIN_SKIP_DOCKER:-0}" = "1" ]; then return 0; fi
  if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
    [ "$FORCE" -eq 1 ] || die 5 "$DOCKER_BIN not found; cannot verify running-container mounts (use --force or HERMES_PIN_SKIP_DOCKER=1)"
    warn "$DOCKER_BIN not found; --force given, continuing without mount check"
    return 0
  fi
  local ids
  if ! ids="$("$DOCKER_BIN" ps -q 2>/dev/null)"; then
    [ "$FORCE" -eq 1 ] || die 5 "$DOCKER_BIN ps failed; cannot verify that no running container mounts the live tree (use --force)"
    warn "$DOCKER_BIN ps failed; --force given, continuing without mount check"
    return 0
  fi
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  if ! "$DOCKER_BIN" inspect $ids > "$TMP/inspect.json" 2>/dev/null; then
    [ "$FORCE" -eq 1 ] || die 5 "$DOCKER_BIN inspect failed; cannot verify running-container mounts (use --force)"
    warn "$DOCKER_BIN inspect failed; --force given, continuing without mount check"
    return 0
  fi
  py - "$TMP/inspect.json" > "$MOUNT_TABLE" <<'PY'
import codecs, json, os, sys
proc = os.environ.get("HERMES_PIN_PROC", "/proc")
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = []
def unesc(s):
    try:
        return codecs.decode(s, "unicode_escape")
    except Exception:
        return s
for c in data if isinstance(data, list) else []:
    name = (c.get("Name") or "").lstrip("/")
    pid = (c.get("State") or {}).get("Pid") or 0
    roots = {}
    if pid:
        try:
            with open("%s/%s/mountinfo" % (proc, pid)) as f:
                for line in f:
                    p = line.split()
                    if len(p) >= 5:
                        roots[unesc(p[4])] = unesc(p[3])   # mountpoint -> root (CURRENT host path within its fs)
        except Exception:
            pass
    for m in c.get("Mounts") or []:
        src = m.get("Source") or ""
        dst = m.get("Destination") or ""
        if not src:
            continue
        rp = roots.get(dst) or "-"
        ident = "-"
        if pid:
            try:
                st = os.stat("%s/%s/root%s" % (proc, pid, dst))
                ident = "%d:%d" % (st.st_dev, st.st_ino)
            except Exception:
                pass
        print("%s\t%s\t%s\t%s\t%s" % (name, src, dst, rp, ident))
PY
  if [ -n "$(unverified_hermes_mounts)" ]; then MOUNT_DEGRADED=1; fi
}

mounted_by() { # mounted_by DIR -> containers VERIFIED (via /proc) to mount DIR right now
  build_mount_table
  [ -s "$MOUNT_TABLE" ] || return 0
  local target real ident
  target="$1"
  real="$(realpath_py "$target" 2>/dev/null || printf '%s' "$target")"
  ident="$(dev_ino "$target")"
  awk -F '\t' -v a="$target" -v b="$real" -v id="$ident" '
    ($4 != "-" && ($4 == a || $4 == b)) || (id != "" && $5 != "-" && $5 == id) { print $1 }' "$MOUNT_TABLE" | sort -u
}

stale_mounted_by() { # stale_mounted_by DIR -> containers whose CREATE-TIME source is DIR or under it (stale after a rename)
  build_mount_table
  [ -s "$MOUNT_TABLE" ] || return 0
  local target real
  target="$1"
  real="$(realpath_py "$target" 2>/dev/null || printf '%s' "$target")"
  awk -F '\t' -v a="$target" -v b="$real" '
    { src=$2; if (src==a || src==b || index(src, a "/")==1 || index(src, b "/")==1) print $1 }' "$MOUNT_TABLE" | sort -u
}

unverified_hermes_mounts() { # containers with a hermes-agent-* mount whose real identity could not be resolved
  [ -s "$MOUNT_TABLE" ] || return 0
  local rr
  rr="$(realpath_py "$ROOT" 2>/dev/null || printf '%s' "$ROOT")"
  awk -F '\t' -v a="$ROOT/hermes-agent-" -v b="$rr/hermes-agent-" '
    $4 == "-" && $5 == "-" && (index($2, a) == 1 || index($2, b) == 1) { print $1 }' "$MOUNT_TABLE" | sort -u
}

preflight_mounts() { # preflight_mounts DIR  -> exits 5 unless --force
  local dir="$1" who note=""
  build_mount_table
  who="$(mounted_by "$dir")"
  if [ -z "$who" ] && [ "$MOUNT_DEGRADED" -eq 1 ]; then
    who="$(unverified_hermes_mounts)"
    note=" [create-time mount sources; the real identity cannot be verified without /proc access — run as root for a precise check]"
  fi
  if [ -z "$who" ]; then
    plan "preflight: no running container mounts $dir"
    return 0
  fi
  local list
  list="$(printf '%s' "$who" | tr '\n' ' ')"
  if [ "$FORCE" -eq 1 ]; then
    warn "running container(s) mount $dir: $list$note — proceeding under --force (they keep the old inode; new spawns see the new tree)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "preflight: WOULD REFUSE — running container(s) mount $dir: $list$note (stop them or pass --force)"
    return 0
  fi
  die 5 "running container(s) mount $dir: $list$note — stop them (ncl groups restart) or pass --force"
}

# ----------------------------------------------------------------------------- resolve
TAG=""
COMMIT=""
TARBALL_URL=""
SOURCE_URL=""

resolve_ref() {
  local api_reason=""
  case "$REF" in
    latest)
      if [ -n "${HERMES_PIN_TAG:-}" ]; then
        TAG="$HERMES_PIN_TAG"
      else
        if api_get "$API_BASE/releases/latest" "$TMP/latest.json"; then
          TAG="$(json_get "$TMP/latest.json" tag_name)"
          [ -n "$TAG" ] || api_reason="releases/latest returned no tag_name"
        else
          api_reason="$API_ERR"
        fi
        if [ -z "$TAG" ] && command -v git >/dev/null 2>&1; then
          warn "releases/latest unavailable ($api_reason); falling back to newest tag from git ls-remote"
          TAG="$(newest_tag_via_git 2>/dev/null || true)"
        fi
        [ -n "$TAG" ] || die 3 "could not resolve 'latest': ${api_reason:-no tags found} (git ls-remote fallback found nothing either)"
      fi
      ;;
    main) TAG="main" ;;
    *)    TAG="$REF" ;;
  esac

  if [ -n "${HERMES_PIN_COMMIT:-}" ]; then
    COMMIT="$HERMES_PIN_COMMIT"
  else
    COMMIT=""
    if api_get "$API_BASE/commits/$TAG" "$TMP/commit.json"; then
      COMMIT="$(json_get "$TMP/commit.json" sha)"
    fi
    if [ -z "$COMMIT" ]; then
      [ "$TAG" != "main" ] || die 3 "could not resolve the commit sha of main via $API_BASE/commits/main: ${API_ERR:-no sha in the response}"
      warn "could not resolve commit sha for $TAG via the GitHub API (${API_ERR:-no sha in the response}); recording 'unknown'"
      COMMIT="unknown"
    fi
  fi

  if [ "$TAG" = "main" ]; then
    # fetch BY SHA so the tarball and the manifest describe the same tree even if main moves meanwhile
    TARBALL_URL="$CODELOAD_BASE/$COMMIT"
    SOURCE_URL="https://github.com/${UPSTREAM_REPO}/tree/$COMMIT"
  else
    TARBALL_URL="$CODELOAD_BASE/refs/tags/$TAG"
    SOURCE_URL="https://github.com/${UPSTREAM_REPO}/releases/tag/$TAG"
  fi
  if [ -n "${HERMES_PIN_TARBALL:-}" ]; then
    SOURCE_URL="file://$(realpath_py "$HERMES_PIN_TARBALL")"
  fi
  log "resolve: ref=$REF -> tag=$TAG commit=$COMMIT"
}

# ----------------------------------------------------------------------------- download / verify
TARBALL=""
TARBALL_SHA=""

download() {
  TARBALL="$TMP/hermes-agent.tar.gz"
  if [ -n "${HERMES_PIN_TARBALL:-}" ]; then
    [ -f "$HERMES_PIN_TARBALL" ] || die 3 "HERMES_PIN_TARBALL=$HERMES_PIN_TARBALL is not a file"
    cp "$HERMES_PIN_TARBALL" "$TARBALL"
    log "download: using local tarball $HERMES_PIN_TARBALL"
  else
    log "download: $TARBALL_URL"
    curl -fSL --retry 3 --connect-timeout 20 -o "$TARBALL" "$TARBALL_URL" 2>"$TMP/curl.err" \
      || die 3 "download failed: $TARBALL_URL ($(tail -n1 "$TMP/curl.err" 2>/dev/null))"
  fi
  TARBALL_SHA="$(sha256_file "$TARBALL")"
  log "download: tarball sha256=$TARBALL_SHA size=$(wc -c < "$TARBALL" | tr -d ' ') bytes"
}

verify() {
  local extract="$TMP/extract" top count
  mkdir -p "$extract"
  tar -xzf "$TARBALL" -C "$extract" 2>"$TMP/tar.err" || die 4 "tarball does not extract: $(tail -n1 "$TMP/tar.err")"
  count="$(find "$extract" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  [ "$count" = "1" ] || die 4 "expected exactly one top-level entry in the tarball, found $count"
  top="$(find "$extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$top" ] || die 4 "top-level entry is not a directory"
  [ -f "$top/pyproject.toml" ] || die 4 "no pyproject.toml in $(basename "$top") — not a hermes-agent tree"
  [ -f "$top/README.md" ] || warn "no README.md in $(basename "$top") (continuing)"
  if [ "$TAG" != "main" ]; then
    case "$(basename "$top")" in
      *"${TAG#v}") ;;
      *) warn "top-level dir '$(basename "$top")' does not end with '${TAG#v}'" ;;
    esac
  fi
  STAGING="$ROOT/hermes-agent-$(suffix_for "$TAG" "$COMMIT")"
  if [ -e "$STAGING" ]; then
    build_mount_table
    if [ "$FORCE" -eq 0 ] && { [ -n "$(mounted_by "$STAGING")" ] || [ "$MOUNT_DEGRADED" -eq 1 ]; }; then
      die 5 "$STAGING already exists and is (or may be) mounted by a running container; refusing to replace it (use --force)"
    fi
    warn "replacing existing sibling $STAGING"
    rm -rf "$STAGING"
  fi
  rename_dir "$top" "$STAGING" || die 6 "could not stage $STAGING"
  STAGED_BY_US=1
  log "verify: extracted $(basename "$top") -> $STAGING ($(find "$STAGING" -type f | wc -l | tr -d ' ') files)"
}

# ----------------------------------------------------------------------------- manifest
OLD_TAG=""
OLD_COMMIT=""
OLD_DIR=""

compute_old_dir() { # what the current live tree will be renamed to
  OLD_TAG=""
  OLD_COMMIT=""
  OLD_DIR=""
  [ -d "$LIVE" ] || return 0
  OLD_TAG="$(live_tag)"
  OLD_COMMIT="$(live_commit)"
  local suffix
  if [ -n "$OLD_TAG" ]; then
    suffix="$(suffix_for "$OLD_TAG" "$OLD_COMMIT")"
  else
    OLD_TAG="unknown"
    suffix="prev-$NOW_STAMP"
  fi
  OLD_DIR="$ROOT/hermes-agent-$suffix"
  if [ -e "$OLD_DIR" ] || [ "$OLD_DIR" = "$STAGING" ]; then
    OLD_DIR="$ROOT/hermes-agent-$suffix-$NOW_STAMP"
  fi
}

write_manifest() { # write_manifest DEST_DIR
  local dest="$1/$MANIFEST_NAME"
  py - "$dest" "$TAG" "$COMMIT" "$TARBALL_SHA" "$NOW_ISO" "$SOURCE_URL" "$PINNED_BY" "$OLD_TAG" "$OLD_COMMIT" "$OLD_DIR" <<'PY'
import json, os, sys
dest, tag, commit, sha, at, src, by, prev_tag, prev_commit, prev_dir = sys.argv[1:11]
m = {
    "tag": tag,
    "commit": commit,
    "tarball_sha256": sha,
    "downloaded_at": at,
    "source_url": src,
    "pinned_by": by,
    "previous_tag": prev_tag or None,
    "previous_commit": (prev_commit or None) if prev_tag else None,
    "previous_dir": os.path.basename(prev_dir) if prev_dir else None,
}
with open(dest, "w") as f:
    json.dump(m, f, indent=2, sort_keys=False)
    f.write("\n")
PY
  log "manifest: wrote $dest"
}

# ----------------------------------------------------------------------------- swap
swap() { # swap NEW_DIR  (uses OLD_DIR computed beforehand)
  local new="$1"
  if [ -d "$LIVE" ]; then
    SWAP_FROM="$OLD_DIR"
    rename_dir "$LIVE" "$OLD_DIR" || { SWAP_FROM=""; die 6 "could not rename $LIVE -> $OLD_DIR"; }
    log "swap: $LIVE -> $OLD_DIR"
    PROTECT_DIR="$OLD_DIR"
  fi
  [ -z "${HERMES_PIN_TEST_SLEEP_MID_SWAP:-}" ] || sleep "$HERMES_PIN_TEST_SLEEP_MID_SWAP"
  # a failure here leaves $LIVE missing; cleanup() renames $SWAP_FROM back (die 6 or a signal alike)
  rename_dir "$new" "$LIVE" || die 6 "could not rename $new -> $LIVE${OLD_DIR:+ (previous tree at $OLD_DIR)}"
  SWAP_FROM=""
  STAGED_BY_US=0
  log "swap: $new -> $LIVE"
}

regen_sha_file() {
  py - "$LIVE" "$SHA_FILE" <<'PY'
import hashlib, os, sys
root, out = sys.argv[1], sys.argv[2]
lines = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for fn in sorted(filenames):
        p = os.path.join(dirpath, fn)
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        lines.append("%s  %s" % (h.hexdigest(), os.path.relpath(p, root)))
tmp = out + ".tmp"
with open(tmp, "w") as f:
    f.write("\n".join(lines) + ("\n" if lines else ""))
os.replace(tmp, out)
print(len(lines))
PY
}

# ----------------------------------------------------------------------------- docs
update_shared_docs() { # update_shared_docs LINE
  if ! mkdir -p "$(dirname "$PIN_MD")" 2>/dev/null; then
    warn "cannot create $(dirname "$PIN_MD"); skipping PIN.md update"
    return 0
  fi
  if [ ! -f "$PIN_MD" ]; then
    {
      echo "# Hermes release pin log"
      echo
      echo "Written by scripts/hermes-pin.sh. Source of truth: /workspace/extra/hermes-release/$MANIFEST_NAME."
      echo
    } > "$PIN_MD" 2>/dev/null || { warn "cannot write $PIN_MD"; return 0; }
  fi
  printf -- '- %s\n' "$1" >> "$PIN_MD" 2>/dev/null || { warn "cannot append to $PIN_MD"; return 0; }
  log "docs: appended to $PIN_MD"
}

# ----------------------------------------------------------------------------- fork sync
sync_fork() {
  local push_ref tag_push
  if [ "$TAG" = "main" ]; then push_ref="$COMMIT"; tag_push=""; else push_ref="refs/tags/$TAG"; tag_push="refs/tags/$TAG:refs/tags/$TAG"; fi
  local cmds
  cmds="$(cat <<EOF
git clone --filter=blob:none --no-checkout https://github.com/${UPSTREAM_REPO}.git /tmp/hermes-fork-sync
cd /tmp/hermes-fork-sync
git remote add fork https://github.com/${FORK_REPO}.git
git fetch fork main
git push --force-with-lease=main fork ${push_ref}^{commit}:refs/heads/main${tag_push:+
git push fork $tag_push}
cd / && rm -rf /tmp/hermes-fork-sync
EOF
)"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "sync-fork: would run (or print) the following:"
    printf '%s\n' "$cmds" | sed 's/^/    /'
    return 0
  fi
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    log "sync-fork: gh is authenticated; pushing $TAG to $FORK_REPO"
    local work="$TMP/fork-sync"
    if gh auth setup-git >/dev/null 2>&1 \
      && git clone -q --filter=blob:none --no-checkout "https://github.com/${UPSTREAM_REPO}.git" "$work" \
      && git -C "$work" remote add fork "https://github.com/${FORK_REPO}.git" \
      && git -C "$work" fetch -q fork main \
      && git -C "$work" push --force-with-lease=main fork "${push_ref}^{commit}:refs/heads/main" \
      && { [ -z "$tag_push" ] || git -C "$work" push fork "$tag_push"; }; then
      log "sync-fork: $FORK_REPO main + tag now at $TAG ($COMMIT)"
      return 0
    fi
    warn "sync-fork: push failed; run the commands below from an authenticated coworker/operator shell"
  else
    warn "sync-fork: no gh auth on this host (GitHub credentials live in coworker containers via OneCLI) — run from a coworker:"
  fi
  printf '%s\n' "$cmds" | sed 's/^/    /'
  _log_file "sync-fork: commands printed for manual execution ($TAG)"
}

# ----------------------------------------------------------------------------- gc
gc() {
  build_mount_table
  local keep_prev newest d name victims=""
  keep_prev="$(live_prev_dir)"
  newest="$(newest_script_dir)"
  if [ "$MOUNT_DEGRADED" -eq 1 ]; then
    if [ "$FORCE" -eq 0 ]; then
      warn "gc: a running container mounts a hermes-agent tree and its identity cannot be verified (no /proc access) — keeping every sibling (run as root, or pass --force to fall back to create-time mount sources)"
    else
      warn "gc: --force given; judging mounts by their create-time sources (a tree renamed since a container started may be misjudged)"
    fi
  fi
  for d in "$ROOT"/hermes-agent-*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ "$d" != "$LIVE" ] || continue
    [ -z "$PROTECT_DIR" ] || [ "$d" != "$PROTECT_DIR" ] || { plan "gc: keep $name (rotated out by this run)"; continue; }
    [ "$name" != "$keep_prev" ] || { plan "gc: keep $name (most recent previous)"; continue; }
    [ "$name" != "$newest" ] || { plan "gc: keep $name (newest download)"; continue; }
    case "$name" in
      hermes-agent-prev-*) ;;
      *) [ -f "$d/$MANIFEST_NAME" ] || { plan "gc: skip $name (no $MANIFEST_NAME — not created by this script)"; continue; } ;;
    esac
    if [ -n "$(mounted_by "$d")" ]; then plan "gc: keep $name (mounted by a running container)"; continue; fi
    if [ "$MOUNT_DEGRADED" -eq 1 ]; then
      if [ "$FORCE" -eq 0 ]; then plan "gc: keep $name (a running container's hermes-agent mount cannot be verified; use --force)"; continue; fi
      if [ -n "$(stale_mounted_by "$d")" ]; then plan "gc: keep $name (create-time mount source of a running container)"; continue; fi
    fi
    victims="$victims$d
"
  done
  if [ -z "$victims" ]; then plan "gc: nothing to remove"; return 0; fi
  printf '%s' "$victims" | while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then plan "gc: would remove $d"; else rm -rf "$d"; log "gc: removed $d"; fi
  done
}

# ----------------------------------------------------------------------------- rollback
rollback() {
  [ -d "$LIVE" ] || die 7 "no live tree at $LIVE"
  local cur_tag prev_name prev_dir prev_tag prev_commit cur_dest cur_suffix
  cur_tag="$(live_tag)"; [ -n "$cur_tag" ] || cur_tag="unknown"
  prev_name="$(live_prev_dir)"
  [ -n "$prev_name" ] || die 7 "live $MANIFEST_NAME records no previous tree — nothing to roll back to"
  prev_dir="$ROOT/$prev_name"
  [ -d "$prev_dir" ] || die 7 "previous tree $prev_dir is gone (pin the old tag explicitly instead)"
  prev_tag="$(json_get "$prev_dir/$MANIFEST_NAME" tag 2>/dev/null || true)"; [ -n "$prev_tag" ] || prev_tag="unknown"
  prev_commit="$(json_get "$prev_dir/$MANIFEST_NAME" commit 2>/dev/null || true)"; [ -n "$prev_commit" ] || prev_commit="unknown"
  if [ "$cur_tag" != "unknown" ]; then cur_suffix="$(suffix_for "$cur_tag" "$(live_commit)")"; else cur_suffix="prev-$NOW_STAMP"; fi
  cur_dest="$ROOT/hermes-agent-$cur_suffix"
  [ ! -e "$cur_dest" ] || cur_dest="$cur_dest-$NOW_STAMP"

  plan "rollback: live $cur_tag -> $prev_tag ($prev_commit)"
  plan "rollback: rename $LIVE -> $cur_dest"
  plan "rollback: rename $prev_dir -> $LIVE"
  preflight_mounts "$LIVE"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "rollback: would regenerate $SHA_FILE and append to $PIN_MD"
    log "DRY RUN — nothing changed"
    return 0
  fi
  SWAP_FROM="$cur_dest"
  rename_dir "$LIVE" "$cur_dest" || { SWAP_FROM=""; die 6 "could not rename $LIVE -> $cur_dest"; }
  PROTECT_DIR="$cur_dest"
  [ -z "${HERMES_PIN_TEST_SLEEP_MID_SWAP:-}" ] || sleep "$HERMES_PIN_TEST_SLEEP_MID_SWAP"
  rename_dir "$prev_dir" "$LIVE" || die 6 "could not rename $prev_dir -> $LIVE (current tree at $cur_dest)"
  SWAP_FROM=""
  local n; n="$(regen_sha_file)"
  update_shared_docs "$TODAY rolled back to $prev_tag ($prev_commit) from $cur_tag — $cur_tag kept at $(basename "$cur_dest")"
  log "rollback: live is now $prev_tag ($prev_commit); $cur_tag kept at $cur_dest; sha256 list: $n files"
  log "next: ncl groups restart --id <hermes-group-id>   # new containers pick up the tree on spawn"
}

# ----------------------------------------------------------------------------- pin
pin() {
  resolve_ref
  local cur_tag cur_commit
  cur_tag="$(live_tag)"; cur_commit="$(live_commit)"
  if [ "$FORCE" -eq 0 ] && [ -n "$cur_tag" ] && [ "$cur_tag" = "$TAG" ] \
     && { [ "$COMMIT" = "unknown" ] || [ -z "$cur_commit" ] || [ "$cur_commit" = "$COMMIT" ]; }; then
    log "already pinned: $LIVE is $TAG ($cur_commit) — tree unchanged (use --force to re-download)"
    [ "$SYNC_FORK" -eq 0 ] || sync_fork
    [ "$DO_GC" -eq 0 ] || gc
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    STAGING="$ROOT/hermes-agent-$(suffix_for "$TAG" "$COMMIT")"
    compute_old_dir
    preflight_mounts "$LIVE"
    plan "download: ${HERMES_PIN_TARBALL:-$TARBALL_URL}"
    plan "verify:   extract into $ROOT/.hermes-pin-tmp.<pid>/ ; require pyproject.toml ; stage as $STAGING"
    plan "manifest: $STAGING/$MANIFEST_NAME {tag=$TAG commit=$COMMIT previous_tag=${OLD_TAG:-null} previous_dir=${OLD_DIR:+$(basename "$OLD_DIR")}}"
    if [ -d "$LIVE" ]; then plan "swap:     rename $LIVE -> $OLD_DIR"; else plan "swap:     (no live tree yet)"; fi
    plan "swap:     rename $STAGING -> $LIVE"
    plan "sha256:   regenerate $SHA_FILE"
    plan "docs:     append '$TODAY pinned $TAG ($COMMIT) previous ${OLD_TAG:-none}' to $PIN_MD"
    [ "$SYNC_FORK" -eq 0 ] || sync_fork
    [ "$DO_GC" -eq 0 ] || gc
    log "DRY RUN — nothing changed"
    return 0
  fi

  preflight_mounts "$LIVE"      # fail fast, before the download
  download
  verify
  compute_old_dir
  write_manifest "$STAGING"
  MOUNT_TABLE=""                # re-read: the download may have taken a while
  preflight_mounts "$LIVE"      # authoritative, right before the swap
  swap "$STAGING"
  local n; n="$(regen_sha_file)"
  update_shared_docs "$TODAY pinned $TAG ($COMMIT) previous ${OLD_TAG:-none}"
  [ "$SYNC_FORK" -eq 0 ] || sync_fork
  [ "$DO_GC" -eq 0 ] || gc

  log ""
  log "hermes-pin: pinned $TAG ($COMMIT) -> $LIVE"
  if [ -n "$OLD_DIR" ]; then log "  previous : ${OLD_TAG} kept at $OLD_DIR (use --rollback)"; else log "  previous : none (first pin)"; fi
  log "  manifest : $LIVE/$MANIFEST_NAME"
  log "  tarball  : sha256 $TARBALL_SHA"
  log "  sha256   : $SHA_FILE ($n files)"
  log "  docs     : $PIN_MD"
  log "  next     : ncl groups restart --id <hermes-group-id>   # new containers pick up the tree on spawn"
}

# ----------------------------------------------------------------------------- main
main() {
  hostname_guard
  init_log
  [ -d "$ROOT" ] || die 6 "root $ROOT does not exist"
  acquire_lock
  TMP="$(mktemp -d "$ROOT/.hermes-pin-tmp.$$.XXXXXX")" || die 6 "cannot create temp dir under $ROOT"
  _log_file "start: argv=[$REF] dry_run=$DRY_RUN force=$FORCE sync_fork=$SYNC_FORK rollback=$DO_ROLLBACK gc=$DO_GC root=$ROOT host=$HOSTNAME_NOW"
  if [ "$DO_ROLLBACK" -eq 1 ]; then
    rollback
    [ "$DO_GC" -eq 0 ] || gc
    return 0
  fi
  if [ -z "$REF" ]; then
    # --gc alone
    gc
    return 0
  fi
  pin
}

main
