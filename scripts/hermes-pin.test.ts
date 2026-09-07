/**
 * Behavioral tests for scripts/hermes-pin.sh, run under the host vitest suite so the
 * shell logic is CI-protected (same rationale as check-task-snapshots.test.ts).
 *
 * The script swaps the READ-ONLY Hermes release tree the hermes-* coworkers cite from,
 * by directory rename (the mount allowlist pins the realpath, so no symlinks). Every
 * case here runs fully offline: HERMES_PIN_TARBALL points at a fake GitHub-style
 * tarball, HERMES_PIN_COMMIT stands in for the API sha, HERMES_PIN_SKIP_DOCKER skips
 * the running-container mount check (the docker cases swap in a fake `docker` via HERMES_PIN_DOCKER
 * and a fake procfs via HERMES_PIN_PROC), and --allow-any-host bypasses the hostname guard.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'hermes-pin.sh');
// Allow proving bash-3.2 compatibility locally: HERMES_PIN_BASH=/bin/bash pnpm vitest run scripts/hermes-pin.test.ts
const BASH = process.env.HERMES_PIN_BASH || 'bash';

interface Fixture {
  root: string;
  nanoclawRoot: string;
  live: string;
  shaFile: string;
  pinMd: string;
  logFile: string;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pin-'));
  const root = path.join(base, 'haaggarwal');
  const nanoclawRoot = path.join(base, 'nanoclaw');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(nanoclawRoot, { recursive: true });
  return {
    root,
    nanoclawRoot,
    live: path.join(root, 'hermes-agent-release'),
    shaFile: path.join(root, 'hermes-agent-release.sha256'),
    pinMd: path.join(nanoclawRoot, 'data', 'shared', 'hermes', 'PIN.md'),
    logFile: path.join(nanoclawRoot, 'logs', 'hermes-pin.log'),
  };
}

/**
 * A GitHub-shaped tarball: one top-level folder hermes-agent-<tag>/ with the files the
 * verifier looks at (pyproject.toml is required) plus a nested path so the sha256 list
 * has to walk subdirectories.
 */
function makeTarball(fx: Fixture, tag: string, opts: { withPyproject?: boolean } = {}): string {
  const src = fs.mkdtempSync(path.join(fx.root, '..', `src-${tag}-`));
  const top = path.join(src, `hermes-agent-${tag}`);
  fs.mkdirSync(path.join(top, 'apps', 'desktop'), { recursive: true });
  if (opts.withPyproject !== false) {
    fs.writeFileSync(path.join(top, 'pyproject.toml'), `[project]\nname = "hermes-agent"\nversion = "${tag}"\n`);
  }
  fs.writeFileSync(path.join(top, 'README.md'), `# hermes-agent ${tag}\n`);
  fs.writeFileSync(path.join(top, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: 'desktop', version: tag }));
  const out = path.join(src, `hermes-agent-${tag}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', src, `hermes-agent-${tag}`], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`fixture tar failed: ${r.stderr}`);
  return out;
}

interface RunOpts {
  tarball?: string;
  commit?: string;
  allowAnyHost?: boolean;
  env?: Record<string, string>;
}

function run(fx: Fixture, args: string[], opts: RunOpts = {}) {
  const argv = [SCRIPT, ...args, '--root', fx.root];
  if (opts.allowAnyHost !== false) argv.push('--allow-any-host');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HERMES_PIN_SKIP_DOCKER: '1',
    NANOCLAW_ROOT: fx.nanoclawRoot,
    ...(opts.env ?? {}),
  };
  if (opts.tarball) env.HERMES_PIN_TARBALL = opts.tarball;
  if (opts.commit) env.HERMES_PIN_COMMIT = opts.commit;
  const r = spawnSync(BASH, argv, { encoding: 'utf-8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

function pin(fx: Fixture, tag: string, commit: string, extra: string[] = []) {
  const tarball = makeTarball(fx, tag);
  return run(fx, [tag, ...extra], { tarball, commit });
}

/**
 * A fake `docker` CLI. FAKE_DOCKER_SOURCE is the CREATE-TIME bind source docker would report for the one
 * running container (empty = no containers); FAKE_DOCKER_PID is the pid the script resolves through
 * $HERMES_PIN_PROC/<pid>/root/<dest>. No /proc on macOS, so identity resolution is degraded unless the
 * test builds that fake procfs.
 */
function makeFakeDocker(fx: Fixture): string {
  const p = path.join(fx.root, '..', 'fake-docker.sh');
  fs.writeFileSync(
    p,
    `#!/bin/sh
case "$1" in
  ps) [ -z "\${FAKE_DOCKER_SOURCE:-}" ] || echo abc123def456 ;;
  inspect)
    if [ -z "\${FAKE_DOCKER_SOURCE:-}" ]; then echo '[]'; exit 0; fi
    printf '[{"Name":"/nanoclaw-hermes-builder","State":{"Pid":%s},"Mounts":[{"Type":"bind","Source":"%s","Destination":"/workspace/extra/hermes-release","RW":false}]}]\\n' "\${FAKE_DOCKER_PID:-12345}" "$FAKE_DOCKER_SOURCE" ;;
  *) echo "fake docker: unsupported: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return p;
}

function dockerEnv(fx: Fixture, docker: string, source: string): Record<string, string> {
  return {
    HERMES_PIN_SKIP_DOCKER: '0',
    HERMES_PIN_DOCKER: docker,
    FAKE_DOCKER_SOURCE: source,
    FAKE_DOCKER_PID: '12345',
    HERMES_PIN_PROC: path.join(fx.root, '..', 'proc'),
  };
}

/** Point the fake procfs at what the container REALLY holds (a bind mount tracks the inode, not the name). */
function fakeProcMount(fx: Fixture, realDir: string) {
  const dest = path.join(fx.root, '..', 'proc', '12345', 'root', 'workspace', 'extra');
  fs.mkdirSync(dest, { recursive: true });
  const link = path.join(dest, 'hermes-release');
  if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.symlinkSync(realDir, link);
}

function spawnPin(fx: Fixture, args: string[], env: Record<string, string>) {
  const child = spawn(BASH, [SCRIPT, ...args, '--root', fx.root, '--allow-any-host'], {
    env: { ...(process.env as Record<string, string>), HERMES_PIN_SKIP_DOCKER: '1', NANOCLAW_ROOT: fx.nanoclawRoot, ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<{ status: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) => {
    child.on('close', (status, signal) => resolve({ status, signal, out }));
  });
  return { child, done };
}

function hiddenEntries(fx: Fixture): string[] {
  return fs.readdirSync(fx.root).filter((e) => e.startsWith('.hermes-pin'));
}

function manifest(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'RELEASE_MANIFEST.json'), 'utf-8'));
}

function snapshot(fx: Fixture): string {
  const entries = fs.readdirSync(fx.root).sort();
  const parts: string[] = [];
  for (const e of entries) {
    const p = path.join(fx.root, e);
    const st = fs.lstatSync(p);
    parts.push(`${e}:${st.isDirectory() ? 'd' : 'f'}:${st.ino}`);
  }
  const pinMd = fs.existsSync(fx.pinMd) ? fs.readFileSync(fx.pinMd, 'utf-8') : '<none>';
  const m = fs.existsSync(path.join(fx.live, 'RELEASE_MANIFEST.json'))
    ? fs.readFileSync(path.join(fx.live, 'RELEASE_MANIFEST.json'), 'utf-8')
    : '<none>';
  return [parts.join('\n'), pinMd, m].join('\n---\n');
}

describe('hermes-pin.sh', () => {
  beforeAll(() => {
    const r = spawnSync(BASH, ['-n', SCRIPT], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`bash -n failed: ${r.stderr}`);
  });

  it('first pin: installs the tree, writes the manifest, sha256 list, PIN.md and log', () => {
    const fx = makeFixture();
    const r = pin(fx, 'v1.0.0', 'deadbeef');
    expect(r.status, r.out).toBe(0);

    expect(fs.existsSync(path.join(fx.live, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(fx.live, 'pyproject.toml'))).toBe(true);
    expect(fs.existsSync(path.join(fx.live, 'apps', 'desktop', 'package.json'))).toBe(true);
    // The staging sibling was renamed into place, not copied.
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(false);
    // No temp dir left behind.
    expect(fs.readdirSync(fx.root).filter((e) => e.startsWith('.hermes-pin-tmp'))).toEqual([]);

    const m = manifest(fx.live);
    expect(m.tag).toBe('v1.0.0');
    // mirrored copy next to PIN.md so groups without the release-tree mount can read the pin
    const shared = JSON.parse(fs.readFileSync(path.join(path.dirname(fx.pinMd), 'RELEASE_MANIFEST.json'), 'utf8'));
    expect(shared.tag).toBe('v1.0.0');
    expect(m.commit).toBe('deadbeef');
    expect(m.previous_tag).toBeNull();
    expect(m.previous_dir).toBeNull();
    expect(typeof m.tarball_sha256).toBe('string');
    expect((m.tarball_sha256 as string).length).toBe(64);
    expect(m.downloaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(m.source_url).toMatch(/^file:\/\//);
    expect(typeof m.pinned_by).toBe('string');

    expect(fs.existsSync(fx.shaFile)).toBe(true);
    const shaLines = fs.readFileSync(fx.shaFile, 'utf-8').trim().split('\n');
    // 3 fixture files + the manifest itself
    expect(shaLines.length).toBe(4);
    for (const line of shaLines) expect(line).toMatch(/^[0-9a-f]{64}  \S/);
    expect(shaLines.some((l) => l.endsWith('  apps/desktop/package.json'))).toBe(true);
    expect(shaLines.some((l) => l.endsWith('  RELEASE_MANIFEST.json'))).toBe(true);

    const pinMd = fs.readFileSync(fx.pinMd, 'utf-8');
    expect(pinMd).toMatch(/^- \d{4}-\d{2}-\d{2} pinned v1\.0\.0 \(deadbeef\) previous none$/m);

    expect(fs.existsSync(fx.logFile)).toBe(true);
    expect(fs.readFileSync(fx.logFile, 'utf-8')).toMatch(/pinned v1\.0\.0/);
    expect(r.stdout).toMatch(/hermes-pin: pinned v1\.0\.0 \(deadbeef\)/);
  });

  it('re-pinning the live tag is a no-op', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const before = snapshot(fx);
    const liveIno = fs.statSync(fx.live).ino;

    const r = pin(fx, 'v1.0.0', 'deadbeef');
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/already pinned/);
    expect(snapshot(fx)).toBe(before);
    expect(fs.statSync(fx.live).ino).toBe(liveIno);
    expect(fs.readdirSync(fx.root).filter((e) => e.startsWith('hermes-agent-') && e !== 'hermes-agent-release')).toEqual([
      'hermes-agent-release.sha256',
    ]);
  });

  it('same tag with a different commit is NOT a no-op (main-style re-pin)', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const r = pin(fx, 'v1.0.0', 'cafef00d');
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).not.toMatch(/already pinned/);
    expect(manifest(fx.live).commit).toBe('cafef00d');
  });

  it('second tag renames the old live to hermes-agent-<oldtag>; --rollback restores it', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const v1Ino = fs.statSync(fx.live).ino;

    const r2 = pin(fx, 'v2.0.0', 'feedface');
    expect(r2.status, r2.out).toBe(0);
    const oldDir = path.join(fx.root, 'hermes-agent-v1.0.0');
    expect(fs.existsSync(oldDir)).toBe(true);
    // rename, not copy: the old tree keeps its inode
    expect(fs.statSync(oldDir).ino).toBe(v1Ino);
    expect(manifest(oldDir).tag).toBe('v1.0.0');
    const m2 = manifest(fx.live);
    expect(m2.tag).toBe('v2.0.0');
    expect(m2.commit).toBe('feedface');
    expect(m2.previous_tag).toBe('v1.0.0');
    expect(m2.previous_dir).toBe('hermes-agent-v1.0.0');
    expect(fs.readFileSync(path.join(fx.live, 'README.md'), 'utf-8')).toContain('v2.0.0');
    expect(fs.readFileSync(fx.pinMd, 'utf-8')).toMatch(/pinned v2\.0\.0 \(feedface\) previous v1\.0\.0$/m);
    // sha256 list follows the live tree
    expect(fs.readFileSync(fx.shaFile, 'utf-8')).toContain('  README.md');
    const shaBefore = fs.readFileSync(fx.shaFile, 'utf-8');

    const rb = run(fx, ['--rollback']);
    expect(rb.status, rb.out).toBe(0);
    expect(manifest(fx.live).tag).toBe('v1.0.0');
    expect(fs.statSync(fx.live).ino).toBe(v1Ino);
    expect(fs.readFileSync(path.join(fx.live, 'README.md'), 'utf-8')).toContain('v1.0.0');
    const v2Dir = path.join(fx.root, 'hermes-agent-v2.0.0');
    expect(fs.existsSync(v2Dir)).toBe(true);
    expect(manifest(v2Dir).tag).toBe('v2.0.0');
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.readFileSync(fx.shaFile, 'utf-8')).not.toBe(shaBefore);
    expect(fs.readFileSync(fx.pinMd, 'utf-8')).toMatch(/rolled back to v1\.0\.0 \(deadbeef\) from v2\.0\.0/);

    // v1's manifest records no previous, so a second rollback has nowhere to go.
    const rb2 = run(fx, ['--rollback']);
    expect(rb2.status).toBe(7);
  });

  it('--rollback with no live tree exits 7', () => {
    const fx = makeFixture();
    expect(run(fx, ['--rollback']).status).toBe(7);
  });

  it('--dry-run prints the plan and changes nothing', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const before = snapshot(fx);
    const logBefore = fs.readFileSync(fx.logFile, 'utf-8');

    const tarball = makeTarball(fx, 'v2.0.0');
    const r = run(fx, ['v2.0.0', '--dry-run', '--gc', '--sync-fork'], { tarball, commit: 'feedface' });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);
    expect(r.stdout).toMatch(/\[dry-run\] swap: .*hermes-agent-release -> .*hermes-agent-v1\.0\.0/);
    expect(r.stdout).toMatch(/\[dry-run\] swap: .*hermes-agent-v2\.0\.0 -> .*hermes-agent-release/);
    expect(r.stdout).toMatch(/git push --force-with-lease=main fork refs\/tags\/v2\.0\.0\^\{commit\}:refs\/heads\/main/);
    expect(r.stdout).toMatch(/git push fork refs\/tags\/v2\.0\.0:refs\/tags\/v2\.0\.0/);
    expect(snapshot(fx)).toBe(before);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(false);
    // dry-run still logs (audit trail) but never writes PIN.md
    expect(fs.readFileSync(fx.logFile, 'utf-8').length).toBeGreaterThan(logBefore.length);

    const rb = run(fx, ['--rollback', '--dry-run']);
    // v1 has no previous -> exit 7 even in dry-run; first do a real second pin then dry-run rollback
    expect(rb.status).toBe(7);
    expect(pin(fx, 'v2.0.0', 'feedface').status).toBe(0);
    const before2 = snapshot(fx);
    const rb2 = run(fx, ['--rollback', '--dry-run']);
    expect(rb2.status, rb2.out).toBe(0);
    expect(rb2.stdout).toMatch(/\[dry-run\] rollback: live v2\.0\.0 -> v1\.0\.0 \(deadbeef\)/);
    expect(snapshot(fx)).toBe(before2);
  });

  it('hostname guard refuses unless the hostname matches or --allow-any-host is given', () => {
    const fx = makeFixture();
    const tarball = makeTarball(fx, 'v1.0.0');
    const r = run(fx, ['v1.0.0'], {
      tarball,
      commit: 'deadbeef',
      allowAnyHost: false,
      env: { HERMES_PIN_HOSTS: '^this-host-does-not-exist-' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hostname .* does not match/);
    expect(fs.existsSync(fx.live)).toBe(false);
    // the guard runs before ANY filesystem side effect: no logs dir, no lock, no temp dir
    expect(fs.existsSync(path.join(fx.nanoclawRoot, 'logs'))).toBe(false);
    expect(hiddenEntries(fx)).toEqual([]);

    // A matching regex lets it through without --allow-any-host.
    const ok = run(fx, ['v1.0.0'], { tarball, commit: 'deadbeef', allowAnyHost: false, env: { HERMES_PIN_HOSTS: '.' } });
    expect(ok.status, ok.out).toBe(0);
    expect(manifest(fx.live).tag).toBe('v1.0.0');
  });

  it('a tarball without pyproject.toml fails verification (exit 4) and leaves the live tree untouched', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const before = snapshot(fx);
    const bad = makeTarball(fx, 'v9.9.9', { withPyproject: false });
    const r = run(fx, ['v9.9.9'], { tarball: bad, commit: 'badbad00' });
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/pyproject\.toml/);
    expect(snapshot(fx)).toBe(before);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v9.9.9'))).toBe(false);
    expect(fs.readdirSync(fx.root).filter((e) => e.startsWith('.hermes-pin-tmp'))).toEqual([]);
  });

  it('a missing tarball path exits 3', () => {
    const fx = makeFixture();
    const r = run(fx, ['v1.0.0'], { tarball: path.join(fx.root, 'nope.tar.gz'), commit: 'deadbeef' });
    expect(r.status).toBe(3);
  });

  it('usage errors exit 1', () => {
    const fx = makeFixture();
    expect(run(fx, []).status).toBe(1);
    expect(run(fx, ['v1.0.0', '--bogus']).status).toBe(1);
    expect(run(fx, ['v1.0.0', '--rollback']).status).toBe(1);
    expect(run(fx, ['--help']).status).toBe(0);
  });

  it('--gc removes stale siblings but keeps live, the most recent previous, and foreign dirs', () => {
    const fx = makeFixture();
    // A pre-existing tree with no manifest (the box today) becomes hermes-agent-prev-<stamp> on first pin.
    fs.mkdirSync(fx.live);
    fs.writeFileSync(path.join(fx.live, 'pyproject.toml'), '[project]\n');
    // A neighbour that merely shares the prefix must never be touched.
    const foreign = path.join(fx.root, 'hermes-agent-fork-checkout');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'x');

    const r1 = pin(fx, 'v1.0.0', 'deadbeef');
    expect(r1.status, r1.out).toBe(0);
    const prevDirs = fs.readdirSync(fx.root).filter((e) => e.startsWith('hermes-agent-prev-'));
    expect(prevDirs.length).toBe(1);
    const m1 = manifest(fx.live);
    expect(m1.previous_tag).toBe('unknown');
    expect(m1.previous_dir).toBe(prevDirs[0]);
    expect(fs.readFileSync(fx.pinMd, 'utf-8')).toMatch(/pinned v1\.0\.0 \(deadbeef\) previous unknown$/m);

    expect(pin(fx, 'v2.0.0', 'feedface').status).toBe(0);
    expect(pin(fx, 'v3.0.0', 'c0ffee00').status).toBe(0);

    const dry = run(fx, ['--gc', '--dry-run']);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.stdout).toMatch(/would remove .*hermes-agent-v1\.0\.0/);
    expect(dry.stdout).toMatch(/would remove .*hermes-agent-prev-/);
    expect(dry.stdout).toMatch(/keep hermes-agent-v2\.0\.0 \(most recent previous\)/);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(true);

    const gc = run(fx, ['--gc']);
    expect(gc.status, gc.out).toBe(0);
    const left = fs.readdirSync(fx.root).sort();
    expect(left).toEqual(['hermes-agent-fork-checkout', 'hermes-agent-release', 'hermes-agent-release.sha256', 'hermes-agent-v2.0.0']);
    expect(manifest(fx.live).tag).toBe('v3.0.0');

    // rollback still works after gc because the most recent previous survived
    expect(run(fx, ['--rollback']).status).toBe(0);
    expect(manifest(fx.live).tag).toBe('v2.0.0');
  });

  it('pin combined with --gc cleans up in the same run', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    expect(pin(fx, 'v2.0.0', 'feedface').status).toBe(0);
    const r = pin(fx, 'v3.0.0', 'c0ffee00', ['--gc']);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/gc: removed .*hermes-agent-v1\.0\.0/);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(true);
  });

  it('--sync-fork without gh auth prints the manual commands and still exits 0', () => {
    const fx = makeFixture();
    const tarball = makeTarball(fx, 'v1.0.0');
    // Point gh at nothing so `gh auth status` cannot succeed even on a dev laptop.
    const r = run(fx, ['v1.0.0', '--sync-fork'], {
      tarball,
      commit: 'deadbeef',
      env: { GH_CONFIG_DIR: path.join(fx.root, 'no-gh-config'), GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/git push --force-with-lease=main fork refs\/tags\/v1\.0\.0\^\{commit\}:refs\/heads\/main/);
    expect(r.out).toMatch(/slang-coworkers\/hermes-agent/);
    expect(manifest(fx.live).tag).toBe('v1.0.0');
  });
  it('--rollback --gc keeps the tree it just rolled back from; a later --gc keeps it as the newest download', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    expect(pin(fx, 'v2.0.0', 'feedface').status).toBe(0);
    expect(pin(fx, 'v3.0.0', 'c0ffee00').status).toBe(0);

    const r = run(fx, ['--rollback', '--gc']);
    expect(r.status, r.out).toBe(0);
    expect(manifest(fx.live).tag).toBe('v2.0.0');
    expect(r.stdout).toMatch(/gc: keep hermes-agent-v3\.0\.0 \(rotated out by this run\)/);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v3.0.0'))).toBe(true);
    // v1 is v2's recorded previous -> also kept
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(true);
    expect(r.stdout).toMatch(/gc: nothing to remove/);

    // a fresh run has no "rotated out" memory, but v3 is still the newest download
    const gc = run(fx, ['--gc']);
    expect(gc.status, gc.out).toBe(0);
    expect(gc.stdout).toMatch(/gc: keep hermes-agent-v3\.0\.0 \(newest download\)/);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v3.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(true);
  });

  it('running-container preflight: exit 5 before the download and without staged litter; --force swaps; gc never trusts stale mount strings', () => {
    const fx = makeFixture();
    const docker = makeFakeDocker(fx);
    // no containers running: pin proceeds through the real docker code path
    let r = run(fx, ['v1.0.0'], { tarball: makeTarball(fx, 'v1.0.0'), commit: 'deadbeef', env: dockerEnv(fx, docker, '') });
    expect(r.status, r.out).toBe(0);
    const v1Ino = fs.statSync(fx.live).ino;

    // a container was started on the live tree; docker reports the create-time source string
    const before = snapshot(fx);
    r = run(fx, ['v2.0.0'], { tarball: makeTarball(fx, 'v2.0.0'), commit: 'feedface', env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(5);
    expect(r.stderr).toMatch(/nanoclaw-hermes-builder/);
    expect(r.out).not.toMatch(/download:/); // fail-fast: refused BEFORE fetching anything
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(false); // no staged sibling left behind
    expect(hiddenEntries(fx)).toEqual([]); // no temp dir, no lock
    expect(snapshot(fx)).toBe(before);

    // --dry-run reports the refusal but exits 0
    r = run(fx, ['v2.0.0', '--dry-run'], { tarball: makeTarball(fx, 'v2.0.0'), commit: 'feedface', env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/WOULD REFUSE/);

    // --force swaps; the container keeps v1's inode, now named hermes-agent-v1.0.0
    r = run(fx, ['v2.0.0', '--force'], { tarball: makeTarball(fx, 'v2.0.0'), commit: 'feedface', env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(0);
    expect(manifest(fx.live).tag).toBe('v2.0.0');
    expect(fs.statSync(path.join(fx.root, 'hermes-agent-v1.0.0')).ino).toBe(v1Ino);
    r = run(fx, ['v3.0.0', '--force'], { tarball: makeTarball(fx, 'v3.0.0'), commit: 'c0ffee00', env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(0);

    // Without /proc the script cannot tell WHICH tree the container holds (its Source string still says
    // hermes-agent-release, which is now v3) -> gc refuses to delete any sibling.
    r = run(fx, ['--gc'], { env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/gc: keep hermes-agent-v1\.0\.0 \(a running container's hermes-agent mount cannot be verified/);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(true);

    // With /proc (faked): the container really holds v1's inode -> v1 is kept as MOUNTED, and since the live
    // tree itself is not mounted the next pin needs no --force.
    fakeProcMount(fx, path.join(fx.root, 'hermes-agent-v1.0.0'));
    r = run(fx, ['--gc', '--dry-run'], { env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/gc: keep hermes-agent-v1\.0\.0 \(mounted by a running container\)/);
    r = run(fx, ['v4.0.0', '--gc'], { tarball: makeTarball(fx, 'v4.0.0'), commit: 'beefcafe', env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/preflight: no running container mounts/);
    expect(manifest(fx.live).tag).toBe('v4.0.0');
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(true); // mounted
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v3.0.0'))).toBe(true); // rotated out / previous
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(false); // the only true victim
    expect(r.stdout).toMatch(/gc: removed .*hermes-agent-v2\.0\.0/);

    // and when the container really holds the LIVE tree, preflight refuses precisely
    fakeProcMount(fx, fx.live);
    r = run(fx, ['v5.0.0'], { tarball: makeTarball(fx, 'v5.0.0'), commit: 'f005ba11', env: dockerEnv(fx, docker, fx.live) });
    expect(r.status, r.out).toBe(5);
    expect(r.stderr).not.toMatch(/cannot be verified/);
  });

  it('a missing docker binary is a refusal (exit 5) unless --force or HERMES_PIN_SKIP_DOCKER', () => {
    const fx = makeFixture();
    const env = { HERMES_PIN_SKIP_DOCKER: '0', HERMES_PIN_DOCKER: path.join(fx.root, 'no-such-docker') };
    let r = run(fx, ['v1.0.0'], { tarball: makeTarball(fx, 'v1.0.0'), commit: 'deadbeef', env });
    expect(r.status, r.out).toBe(5);
    expect(r.stderr).toMatch(/not found/);
    expect(fs.existsSync(fx.live)).toBe(false);
    r = run(fx, ['v1.0.0', '--force'], { tarball: makeTarball(fx, 'v1.0.0'), commit: 'deadbeef', env });
    expect(r.status, r.out).toBe(0);
  });

  it('`latest` with the GitHub API unreachable exits 3 with a clear reason (not a bare 128)', () => {
    const fx = makeFixture();
    const r = run(fx, ['latest', '--dry-run'], {
      env: {
        https_proxy: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        http_proxy: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        no_proxy: '',
        NO_PROXY: '',
        HOME: '/nonexistent',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        HERMES_PIN_TAG: '',
      },
    });
    expect(r.status, r.out).toBe(3);
    expect(r.stderr).toMatch(/rate limit|could not reach/);
    expect(r.stderr).toMatch(/could not resolve 'latest'/);
    expect(hiddenEntries(fx)).toEqual([]);
  });

  it('re-pinning the live tag still honours --gc and --sync-fork', () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    expect(pin(fx, 'v2.0.0', 'feedface').status).toBe(0);
    expect(pin(fx, 'v3.0.0', 'c0ffee00').status).toBe(0);
    const liveIno = fs.statSync(fx.live).ino;

    const r = run(fx, ['v3.0.0', '--gc', '--sync-fork'], {
      tarball: makeTarball(fx, 'v3.0.0'),
      commit: 'c0ffee00',
      env: { GH_CONFIG_DIR: path.join(fx.root, 'no-gh-config'), GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/already pinned/);
    expect(fs.statSync(fx.live).ino).toBe(liveIno);
    expect(r.stdout).toMatch(/gc: removed .*hermes-agent-v1\.0\.0/);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(true);
    expect(r.out).toMatch(/git push --force-with-lease=main fork refs\/tags\/v3\.0\.0\^\{commit\}:refs\/heads\/main/);
  });

  it('`main` fetches the tarball by the resolved sha and names the sibling hermes-agent-main-<sha12>', () => {
    const fx = makeFixture();
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const dry = run(fx, ['main', '--dry-run'], { commit: sha });
    expect(dry.status, dry.out).toBe(0);
    expect(dry.stdout).toMatch(new RegExp(`download: https://codeload\\.github\\.com/NousResearch/hermes-agent/tar\\.gz/${sha}$`, 'm'));

    const r = run(fx, ['main'], { tarball: makeTarball(fx, 'main'), commit: sha });
    expect(r.status, r.out).toBe(0);
    const m = manifest(fx.live);
    expect(m.tag).toBe('main');
    expect(m.commit).toBe(sha);

    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-main-0123456789ab'))).toBe(true);
    const m1 = manifest(fx.live);
    expect(m1.previous_tag).toBe('main');
    expect(m1.previous_commit).toBe(sha);
    expect(m1.previous_dir).toBe('hermes-agent-main-0123456789ab');
    expect(run(fx, ['--rollback']).status).toBe(0);
    expect(manifest(fx.live).commit).toBe(sha);
  });

  it('refuses to run while another hermes-pin holds the lock; a lock whose pid is gone is cleared', () => {
    const fx = makeFixture();
    const lock = path.join(fx.root, '.hermes-pin.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); // alive: this test runner

    let r = pin(fx, 'v1.0.0', 'deadbeef');
    expect(r.status, r.out).toBe(6);
    expect(r.stderr).toMatch(/another hermes-pin run holds/);
    expect(fs.existsSync(lock)).toBe(true); // not ours -> left alone
    expect(fs.existsSync(fx.live)).toBe(false);

    fs.writeFileSync(path.join(lock, 'pid'), '2147483646'); // no such process
    r = pin(fx, 'v1.0.0', 'deadbeef');
    expect(r.status, r.out).toBe(0);
    expect(r.stderr).toMatch(/stale lock/);
    expect(fs.existsSync(lock)).toBe(false);
    expect(manifest(fx.live).tag).toBe('v1.0.0');
  });

  it('two concurrent pins never nest a tree inside the live dir', async () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const pairs: Array<[string, string, string, string]> = [
      ['v2.0.0', 'feedface', 'v3.0.0', 'c0ffee00'],
      ['v4.0.0', 'beefcafe', 'v5.0.0', 'f005ba11'],
    ];
    for (const [ta, ca, tb, cb] of pairs) {
      const a = spawnPin(fx, [ta], { HERMES_PIN_TARBALL: makeTarball(fx, ta), HERMES_PIN_COMMIT: ca });
      const b = spawnPin(fx, [tb], { HERMES_PIN_TARBALL: makeTarball(fx, tb), HERMES_PIN_COMMIT: cb });
      const [ra, rb] = await Promise.all([a.done, b.done]);
      for (const res of [ra, rb]) expect([0, 6], res.out).toContain(res.status);
      expect([ra.status, rb.status].filter((s) => s === 0).length, ra.out + rb.out).toBeGreaterThanOrEqual(1);
      // the invariant: nothing ever got moved INTO the live tree
      expect(fs.readdirSync(fx.live).filter((e) => e.startsWith('hermes-agent-'))).toEqual([]);
      expect(fs.existsSync(path.join(fx.live, 'pyproject.toml'))).toBe(true);
      expect([ta, tb]).toContain(manifest(fx.live).tag);
      for (const d of fs.readdirSync(fx.root).filter((e) => e.startsWith('hermes-agent-') && !e.endsWith('.sha256'))) {
        expect(fs.readdirSync(path.join(fx.root, d)).filter((e) => e.startsWith('hermes-agent-'))).toEqual([]);
      }
      expect(hiddenEntries(fx)).toEqual([]);
    }
  });

  it('a signal between the two renames restores the live tree (exit 130) and removes the staged tree', async () => {
    const fx = makeFixture();
    expect(pin(fx, 'v1.0.0', 'deadbeef').status).toBe(0);
    const v1Ino = fs.statSync(fx.live).ino;

    const { child, done } = spawnPin(fx, ['v2.0.0'], {
      HERMES_PIN_TARBALL: makeTarball(fx, 'v2.0.0'),
      HERMES_PIN_COMMIT: 'feedface',
      HERMES_PIN_TEST_SLEEP_MID_SWAP: '3',
    });
    // wait for the first rename (live dir gone) — that is the window the trap must cover
    const deadline = Date.now() + 15000;
    while (fs.existsSync(fx.live) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(fx.live)).toBe(false);
    child.kill('SIGTERM');
    const r = await done;
    expect(r.status, r.out).toBe(130);

    expect(fs.existsSync(fx.live)).toBe(true);
    expect(fs.statSync(fx.live).ino).toBe(v1Ino);
    expect(manifest(fx.live).tag).toBe('v1.0.0');
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v1.0.0'))).toBe(false); // renamed back
    expect(fs.existsSync(path.join(fx.root, 'hermes-agent-v2.0.0'))).toBe(false); // staged tree removed
    expect(hiddenEntries(fx)).toEqual([]); // temp dir + lock released
    expect(r.out).toMatch(/restored .*hermes-agent-release .* after interrupt \(SIGTERM\)/);
    // and the tree is healthy: a normal pin works afterwards
    expect(pin(fx, 'v2.0.0', 'feedface').status).toBe(0);
    expect(manifest(fx.live).tag).toBe('v2.0.0');
  }, 30000);
});
