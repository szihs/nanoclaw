/**
 * container-runner — composition and lifecycle policy.
 *
 * What used to be here were source-text assertions: `readFileSync` on this
 * module plus a regex. They broke on a byte-identical move and stayed green
 * through a behavior change, so each one is now a behavioral case against the
 * thing it was really guarding. Argv assertions moved to
 * `src/drivers/docker-driver.test.ts`, which is where argv now lives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CONTAINER_CPU_LIMIT, CONTAINER_MEMORY_LIMIT } from './config.js';
import type { CapDiagnostics } from './claude-composer/project-doc.js';
import type { ContainerConfig } from './container-config.js';
import {
  armSessionLifecycle,
  assertComposedDocUsable,
  composeSessionSpec,
  migrateStandingInstructions,
  normalizeRotateAgeDays,
  parseMemoryMb,
  parsePidsLimit,
  readStandingInstructions,
  reportProjectDocPressure,
  resolveProviderName,
  syncSkillSymlinks,
  toMountSpecs,
} from './container-runner.js';
import type { SupervisedHandle } from './drivers/session-events.js';
import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import type { AgentGroup, Session } from './types.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// composeSessionSpec resolves the group's timezone override through the central
// DB (resolveGroupTimezone → getContainerConfig), so a live driver is required.
// No rows are seeded: a group with no container_configs row resolves to the
// install-global timezone, which is what every case here expects.
beforeAll(async () => {
  await runMigrations(await initTestDb());
});

afterAll(async () => {
  await closeDb();
});

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('normalizeRotateAgeDays', () => {
  it('defaults to "0" (age rotation disabled) when unset', () => {
    expect(normalizeRotateAgeDays(undefined)).toBe('0');
  });

  it('maps a blank/whitespace value to "0" — NOT the container-side 14-day default', () => {
    // The blocker: the container reader treats '' / '   ' as the 14-day
    // default, so forwarding one silently re-enables the loss (#1327).
    expect(normalizeRotateAgeDays('')).toBe('0');
    expect(normalizeRotateAgeDays('   ')).toBe('0');
  });

  it('maps a non-numeric value to "0" rather than forwarding garbage', () => {
    expect(normalizeRotateAgeDays('soon')).toBe('0');
    expect(normalizeRotateAgeDays('14d')).toBe('0');
  });

  it('forwards a finite numeric override verbatim (trimmed)', () => {
    expect(normalizeRotateAgeDays('60')).toBe('60');
    expect(normalizeRotateAgeDays('  60  ')).toBe('60');
    expect(normalizeRotateAgeDays('0')).toBe('0');
  });
});

const agentGroup: AgentGroup = {
  id: 'agent-1',
  name: 'Agent One',
  folder: 'agent-one',
  agent_provider: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as AgentGroup;

describe('paused agent-group kill switch (structural)', () => {
  // wakeContainer is THE choke point every wake path funnels through (router
  // fanout via delivery, agent-to-agent / host-direct delivery, the host-sweep
  // due-message wake, scheduled-task fires, container-restart), and
  // spawnContainer has no other caller. A per-wiring pause was proven
  // insufficient on prod — the a2a and sweep paths never consult wirings — so
  // the pause MUST gate the spawn itself. Driving wakeContainer needs a live DB
  // + runtime, so this guards the invariant structurally: the paused check must
  // read the group and short-circuit BEFORE spawnContainer is reached.
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');

  it('wakeContainer checks group.paused', () => {
    const wake = src.indexOf('export function wakeContainer');
    const spawnCall = src.indexOf('spawnContainer(session)', wake);
    const pausedCheck = src.indexOf('group?.paused', wake);
    expect(wake).toBeGreaterThan(-1);
    expect(pausedCheck).toBeGreaterThan(-1);
    // The guard returns before the spawn.
    expect(pausedCheck).toBeLessThan(spawnCall);
  });

  it('the paused guard resolves false (does not spawn) rather than throwing', () => {
    // The gates moved out of `wakeContainer` into the async `wakeGuarded` body
    // during the async central-DB port, so the wake's in-flight promise is
    // still registered synchronously while both gates read the DB. The guarded
    // outcome is unchanged — a paused group resolves false — but inside an async
    // function that is spelled `return false`, not `return Promise.resolve(false)`,
    // and the block now ends at the spawn `try` rather than `const existing`.
    const guarded = src.indexOf('async function wakeGuarded');
    expect(guarded).toBeGreaterThan(-1);
    const guardBlock = src.slice(src.indexOf('group?.paused', guarded), src.indexOf('try {', guarded));
    expect(guardBlock).toContain('return false;');
    expect(guardBlock).not.toContain('throw');
  });
});

describe('detectStaleContainers per-session compose guard (structural)', () => {
  // composeCoworkerSpine THROWS when a coworker type references a skill/workflow/
  // overlay that isn't resolvable on disk (e.g. an external `skill-source` skill
  // not yet fetched into container/skills/). detectStaleContainers loops over
  // ALL active containers and composes each; before the guard, one unresolvable
  // type propagated its throw to the sweep's outer try/catch and skipped the
  // entire CLAUDE.md-stale respawn loop — disabling instruction hot-reload
  // fleet-wide for every healthy coworker. The compose must be wrapped
  // per-session so a broken type is skipped (continue), not fatal to the scan.
  // Driving the real loop needs a live activeContainers map, so guard the wiring
  // structurally, matching the invariant test above.
  it('wraps the per-session spine compose in try/catch and continues on failure', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const fnStart = src.indexOf('export async function detectStaleContainers');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
    // The render must sit inside a try whose catch skips just this session. The
    // compose call now lives behind `renderComposedDocument` (one seam shared with
    // spawn), so the guard is asserted on the call that can throw.
    expect(fnBody).toMatch(/try\s*{[\s\S]*renderComposedDocument\(/);
    expect(fnBody).toMatch(/catch \(err\) {[\s\S]*Skipping stale-check[\s\S]*continue;/);
  });

  // Both hash sites must resolve the persona the SAME way spawn does. They used
  // to read `.instructions.md` directly while spawn went through
  // readStandingInstructions, which migrates that file to
  // `instructions.prepend.md` and reads the canonical name. After the first
  // spawn migrated it, the legacy path no longer existed: spawn composed WITH
  // the persona, both hash sites composed WITHOUT it, and the digests could
  // never agree — so every group with a persona looked permanently stale and
  // got restarted on every 60s sweep.
  //
  // Structural, like the guard above: the divergence is in which reader is
  // called, and driving the real functions needs a live activeContainers map.
  //
  // Both paths now reach the persona through `renderComposedDocument`, so they
  // cannot diverge from spawn by construction rather than by two call sites
  // happening to agree. Assert that neither reconstructs the inputs locally —
  // which is how the original bug was written.
  it('records and compares the spawn hash through the same persona reader as spawn', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    for (const fn of ['export async function recomposeAndUpdateHash', 'export async function detectStaleContainers']) {
      const start = src.indexOf(fn);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}', start));
      // Naming the legacy path is fine — it is the migration SOURCE argument.
      // Reading it straight off disk is the bug.
      expect(body, `${fn} must not read the legacy persona path directly`).not.toMatch(
        /readFileSync\([^)]*\.instructions\.md/,
      );
      expect(body, `${fn} must render through the shared seam`).toMatch(/renderComposedDocument\(/);
      // ...and must not rebuild compose options of its own: that is precisely the
      // duplication that let the digests drift apart.
      expect(body, `${fn} must not build its own compose options`).not.toMatch(/composeCoworkerSpine\(/);
    }

    // The seam is where the shared persona reader must actually be called.
    const seam = src.slice(src.indexOf('async function composeOptionsFor'));
    expect(seam.slice(0, seam.indexOf('\n}\n'))).toMatch(/readStandingInstructions\(/);
  });
});

// Dropped with this merge, genuinely superseded rather than lost:
//  - 'per-container resource limits': the knobs are now SessionSpec.resources,
//    covered behaviorally by parseMemoryMb/parsePidsLimit + the driver's
//    resourceArgs tests.
//  - 'container boot-failure tripwire': the stderr tail moved into
//    DockerHandle.start(); docker-driver.test.ts asserts it.
//  - 'hardeningArgs': moved to docker-driver.ts, and its three unconditional
//    flags are asserted in docker-driver.test.ts.

const session: Session = {
  id: 'session-1',
  agent_group_id: 'agent-1',
  messaging_group_id: 'messaging-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as Session;

const containerConfig: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;

const mounts: VolumeMount[] = [
  {
    hostPath: '/install/data/v2-sessions/agent-1/session-1',
    containerPath: '/workspace',
    readonly: false,
    mountClass: 'group-state',
    scope: 'agent-1',
  },
  {
    hostPath: '/install/container/agent-runner/src',
    containerPath: '/app/src',
    readonly: true,
    mountClass: 'install-surface',
    scope: 'agent-1',
  },
];

function compose(
  overrides: {
    gateway?: Record<string, unknown>;
    contribution?: Record<string, unknown>;
    containerConfig?: ContainerConfig;
  } = {},
) {
  return composeSessionSpec({
    agentGroup,
    session,
    containerName: 'nanoclaw-v2-agent-one-1700000000000',
    mounts,
    containerConfig: overrides.containerConfig ?? containerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: (overrides.contribution ?? {}) as never,
    gateway: (overrides.gateway ?? {}) as never,
    instanceId: 'test-instance-id',
  });
}

function composeWithFolder(folder: string) {
  return composeSessionSpec({
    agentGroup: { ...agentGroup, folder },
    session,
    containerName: 'nanoclaw-v2-agent-one-1700000000000',
    mounts,
    containerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: {} as never,
    gateway: {} as never,
    instanceId: 'test-instance-id',
  });
}

describe('composeSessionSpec', () => {
  it('keys the session by install, group and session id', async () => {
    expect((await compose()).key).toMatchObject({ agentGroupId: 'agent-1', sessionId: 'session-1' });
  });

  it('routes the model provider contribution onto the contributed lane', async () => {
    // Registry-sourced env is provenance-exempt from the credential-NAME check
    // — the custom-endpoint provider registers ANTHROPIC_AUTH_TOKEN=placeholder
    // for the gateway to overwrite on the wire, and composed-lane rules would
    // deny that install's every spawn.
    const spec = await compose({
      contribution: { env: { XDG_DATA_HOME: '/workspace/xdg', ANTHROPIC_AUTH_TOKEN: 'placeholder' } },
    });
    expect(spec.containers[0].contributedEnv).toMatchObject({
      XDG_DATA_HOME: '/workspace/xdg',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
    expect(spec.containers[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('passes non-secret mailbox environment on the composed lane', async () => {
    expect((await compose()).containers[0].env.NANOCLAW_MAILBOX_BACKEND).toBe('sqlite');
  });

  it('the gateway contribution fills the contributed lane last and wins a collision', async () => {
    const spec = await compose({
      contribution: { env: { HTTPS_PROXY: 'http://provider:1' } },
      gateway: { env: { HTTPS_PROXY: 'http://gateway-must-win:15001' } },
    });
    expect(spec.containers[0].contributedEnv?.HTTPS_PROXY).toBe('http://gateway-must-win:15001');
  });

  it('gateway mounts merge collision-free, shadowing a composed mount on the same target', async () => {
    const spec = await compose({
      gateway: {
        mounts: [
          {
            class: 'allowlisted-extra',
            hostPath: '/tmp/stub',
            containerPath: '/workspace',
            mode: 'ro',
            groupScope: 'agent-1',
          },
          {
            class: 'allowlisted-extra',
            hostPath: '/tmp/ca.pem',
            containerPath: '/tmp/onecli-ca.pem',
            mode: 'ro',
            groupScope: 'agent-1',
          },
        ],
      },
    });
    const targets = spec.containers[0].mounts.map((m) => m.containerPath);
    expect(targets.filter((t) => t === '/workspace')).toHaveLength(1);
    expect(spec.containers[0].mounts.find((m) => m.containerPath === '/workspace')?.hostPath).toBe('/tmp/stub');
    expect(targets).toContain('/tmp/onecli-ca.pem');
  });

  it('gateway containers ride beside the agent', async () => {
    const spec = await compose({
      gateway: {
        containers: [{ role: 'egress-proxy', image: 'proxy:1', env: {}, mounts: [] }],
      },
    });
    expect(spec.containers.map((c) => c.role)).toEqual(['agent', 'egress-proxy']);
  });

  it('carries the lineage label and stamps the group folder VERBATIM (D9)', async () => {
    // The id→folder mapping lives only in the central DB; carrying the folder
    // on the session is what lets an admission-side check pin `groups/<folder>`
    // mounts to the session. Byte-identical to `agentGroup.folder` — drivers
    // refuse rather than project it, so composition must never pre-mangle it.
    expect((await compose()).labels['nanoclaw-container-name']).toBe('nanoclaw-v2-agent-one-1700000000000');
    expect((await compose()).labels['nanoclaw-group-folder']).toBe(agentGroup.folder);
  });

  it('REFUSES a folder that exceeds the 63-byte label cap instead of letting a driver project it', async () => {
    // Admission joins `groups/<folder>` hostPaths to this label by string
    // concatenation; no admission-side check can invert a hash-suffix
    // projection, so an unlabelable folder must refuse at composition —
    // before any driver, where the error can name the real problem instead
    // of surfacing later as a policy denial blaming the wrong culprit.
    let thrown: unknown;
    try {
      await composeWithFolder(`agent-${'x'.repeat(70)}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect(String((thrown as Error).message)).toContain('nanoclaw-group-folder');
    expect(String((thrown as Error).message)).toContain('rename the group folder');
  });

  it('REFUSES a folder outside the label-value charset, even a short one', async () => {
    for (const folder of ['spike agent', 'café', 'agent-']) {
      let thrown: unknown;
      try {
        await composeWithFolder(folder);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `folder '${folder}' must refuse`).toMatchObject({ kind: 'spec-invalid', retryable: false });
    }
  });

  it('accepts a folder at exactly 63 bytes, and the uuid-minted shape a governance flow creates', async () => {
    // The bound is the cap itself, not a timid margin below it — and the
    // ~42-byte `agent-<uuid>` shape minted group folders get must stay legal,
    // so refusals are rare and loud rather than routine.
    const sixtyThree = `a${'b'.repeat(61)}c`;
    expect(sixtyThree.length).toBe(63);
    expect((await composeWithFolder(sixtyThree)).labels['nanoclaw-group-folder']).toBe(sixtyThree);
    const minted = 'agent-ef251cff-7911-42a6-b835-942fa947ab74';
    expect((await composeWithFolder(minted)).labels['nanoclaw-group-folder']).toBe(minted);
  });

  it('splits PID 1 so a driver can preserve the image init', async () => {
    const agent = (await compose()).containers[0];
    expect(agent.command).toEqual(['bash', '-c']);
    // The invariant is the PID-1 SPLIT: a `bash -c` wrapper whose script ends by
    // `exec`ing the runner, so bun replaces the shell and signals reach it
    // directly. Not exact equality — this fork's agentEntrypointScript() emits a
    // preamble first (a `git config url.insteadOf` and a ~/.codex/config.toml
    // heredoc), which exact-matching upstream's single-line form would forbid.
    expect(agent.args).toHaveLength(1);
    const script = agent.args![0];
    expect(script).toContain('exec bun run /app/src/index.ts');
    expect(script.trimEnd().endsWith('exec bun run /app/src/index.ts')).toBe(true);
  });

  it('asks for a shared-private network and the standard posture', async () => {
    const spec = await compose();
    expect(spec.network).toBe('shared-private');
    expect(spec.hardening).toBe('standard');
    expect(spec.runtimeTier).toBe('container');
    expect(spec.stopGraceSeconds).toBe(1);
  });

  it('reads the isolation tier from the group container config, defaulting to container', async () => {
    expect((await compose()).runtimeTier).toBe('container');
    expect((await compose({ containerConfig: { ...containerConfig, runtimeTier: 'vm' } })).runtimeTier).toBe('vm');
    expect((await compose({ containerConfig: { ...containerConfig, runtimeTier: 'container' } })).runtimeTier).toBe(
      'container',
    );
  });

  it('composes an explicit runAs posture on a uid-1000 host', async () => {
    // uid 1000 matches the agent image's node user, so Docker's realization of
    // this posture is a no-op — but the spec contract (drivers/types.ts) says
    // the identity that must read 0600 host-owned material is explicit for
    // every non-root host, never inherited from an image USER. A driver whose
    // auxiliary image runs as 65532 cannot open the session's 0600 material
    // without it. Reverting to the old host-uid heuristic fails exactly this case.
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const getgid = vi.spyOn(process, 'getgid').mockReturnValue(1000);
    try {
      const spec = await compose();
      expect(spec.runAs).toEqual({ uid: 1000, gid: 1000 });
      expect(spec.containers[0].env.HOME).toBe('/home/node');
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
    }
  });

  it('maps identity and HOME together for any non-root uid', async () => {
    // Under a uid the image has no passwd entry for, HOME resolves to '/' and
    // the provider SDK's `mkdir ~/.claude` dies EACCES — so the mapping and
    // the explicit HOME travel together, exactly as they did in the old argv.
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(501);
    const getgid = vi.spyOn(process, 'getgid').mockReturnValue(20);
    try {
      const spec = await compose();
      expect(spec.runAs).toEqual({ uid: 501, gid: 20 });
      expect(spec.containers[0].env.HOME).toBe('/home/node');
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
    }
  });

  it('never asks a runtime to run the session as root', async () => {
    // The hardened posture pins non-root, so a composed uid-0 runAs could never
    // be realized; Docker's root behavior (image USER wins) stays unchanged.
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      const spec = await compose();
      expect(spec.runAs).toBeUndefined();
      expect(spec.containers[0].env.HOME).toBeUndefined();
    } finally {
      getuid.mockRestore();
    }
  });

  it('leaves cpu and memory unset by default (unbounded, as today)', async () => {
    // Guards the knobs' own defaults: an accidental default cap would OOM-kill
    // workloads that run fine now.
    expect(CONTAINER_CPU_LIMIT).toBe('');
    expect(CONTAINER_MEMORY_LIMIT).toBe('');
    const spec = await compose();
    expect(spec.resources.cpus).toBeUndefined();
    expect(spec.resources.memoryMb).toBeUndefined();
    expect(spec.resources.shmSizeMb).toBe(1024);
  });
});

describe('parseMemoryMb', () => {
  it('reads the operator-facing docker size strings', () => {
    expect(parseMemoryMb('8g')).toBe(8192);
    expect(parseMemoryMb('512m')).toBe(512);
    expect(parseMemoryMb('2G')).toBe(2048);
  });

  it('treats a bare number as bytes, the way Docker does', () => {
    // Reinterpreting it as megabytes would multiply an existing operator value
    // by a million.
    expect(parseMemoryMb('536870912')).toBe(512);
  });

  it('treats blank and zero as unbounded — the meanings Docker itself assigns', () => {
    for (const value of ['', '   ', '0']) {
      expect(parseMemoryMb(value)).toBeUndefined();
    }
  });

  it('REFUSES garbage instead of silently removing the cap', () => {
    // Fail-closed like the raw pass-through this replaced: Docker used to
    // reject an invalid value at spawn. Returning undefined would fail in the
    // one wrong direction a resource limit has — quietly uncapped.
    for (const value of ['lots', '-4', '8gb extra', '8 gigs']) {
      expect(() => parseMemoryMb(value), `'${value}' must refuse`).toThrow(/CONTAINER_MEMORY_LIMIT/);
    }
  });
});

describe('parsePidsLimit', () => {
  it('accepts a positive integer and floors fractions', () => {
    expect(parsePidsLimit('2048')).toBe(2048);
    expect(parsePidsLimit('2048.7')).toBe(2048);
  });

  it('rejects 0, negatives, blank and garbage', () => {
    // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
    for (const value of ['0', '-1', '', '   ', 'lots']) {
      expect(parsePidsLimit(value)).toBeUndefined();
    }
  });
});

describe('toMountSpecs', () => {
  it('carries the class and scope through, and maps readonly to a mode', () => {
    expect(toMountSpecs(mounts, 'agent-1')).toEqual([
      {
        class: 'group-state',
        hostPath: '/install/data/v2-sessions/agent-1/session-1',
        containerPath: '/workspace',
        mode: 'rw',
        groupScope: 'agent-1',
      },
      {
        class: 'install-surface',
        hostPath: '/install/container/agent-runner/src',
        containerPath: '/app/src',
        mode: 'ro',
        groupScope: 'agent-1',
      },
    ]);
  });

  it('defaults an unclassed mount to the vetted-upstream class', () => {
    const [spec] = toMountSpecs([{ hostPath: '/x', containerPath: '/y', readonly: false }], 'agent-1');
    expect(spec.class).toBe('allowlisted-extra');
    expect(spec.groupScope).toBe('agent-1');
  });
});

describe('armSessionLifecycle', () => {
  function fakeHandle(startBehavior: () => Promise<void> = async () => {}): {
    handle: Pick<SupervisedHandle, 'onTerminal' | 'start'>;
    order: string[];
  } {
    const order: string[] = [];
    return {
      order,
      handle: {
        onTerminal: () => order.push('onTerminal'),
        start: async () => {
          order.push('start');
          await startBehavior();
        },
      },
    };
  }

  it('arms terminal handling before starting, and bookkeeping after', async () => {
    const { handle, order } = fakeHandle();
    await armSessionLifecycle({
      handle,
      onTerminal: () => {},
      afterStart: () => {
        order.push('afterStart');
      },
    });

    // A failure landing during startup must find a runtime that already knows
    // how to finalize; recording "running" before the session exists would
    // mark a session running that never started.
    expect(order).toEqual(['onTerminal', 'start', 'afterStart']);
  });

  it('never runs the post-start bookkeeping when the start fails', async () => {
    const { handle, order } = fakeHandle(async () => {
      throw new Error('image-unavailable');
    });

    await expect(
      armSessionLifecycle({
        handle,
        onTerminal: () => {},
        afterStart: () => {
          order.push('afterStart');
        },
      }),
    ).rejects.toThrow('image-unavailable');

    expect(order).toEqual(['onTerminal', 'start']);
  });
});

describe('syncSkillSymlinks', () => {
  function tmpClaudeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-skills-'));
  }

  it('links every selected skill to its container path', () => {
    const dir = tmpClaudeDir();
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    const link = path.join(dir, 'skills', 'welcome');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Dangling on the host, valid inside the container.
    expect(fs.readlinkSync(link)).toBe('/app/skills/welcome');
  });

  it('prunes symlinks that are no longer selected', () => {
    const dir = tmpClaudeDir();
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome', 'vercel-cli'] } as ContainerConfig);
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(fs.existsSync(path.join(dir, 'skills', 'vercel-cli'))).toBe(false);
  });

  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    // Template overlays depend on surviving the prune (see src/group-skills.ts);
    // a stale pre-refactor skill copy (#3001) otherwise gets served forever with
    // no trace.
    const dir = tmpClaudeDir();
    fs.mkdirSync(path.join(dir, 'skills', 'welcome'), { recursive: true });

    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Shared skill not symlinked'),
      expect.objectContaining({ skill: 'welcome' }),
    );
  });
});

describe('assertComposedDocUsable — compose failure must not spawn an uninstructed agent', () => {
  const group = { id: 'ag-x', folder: 'grp-x', name: 'X' } as never;

  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-compose-'));
  }

  // The regression: both compose paths logged a warning and let the spawn
  // proceed, so a group whose composition threw ran with NO project document —
  // no persona, no invariants, no chain-reporting rules — and nothing went red.
  it('throws when composition failed and no document exists', () => {
    const dir = tmpDir();
    expect(() => assertComposedDocUsable(path.join(dir, 'CLAUDE.md'), group, new Error('boom'))).toThrow(
      /no usable document exists/,
    );
  });

  it('throws when the existing document is empty (present but useless)', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(p, '');

    expect(() => assertComposedDocUsable(p, group, new Error('boom'))).toThrow(/no usable document exists/);
  });

  // Stale beats absent: the group keeps its last good instructions rather than
  // losing the session entirely while the cause is fixed.
  it('tolerates the failure when a previous non-empty document survives', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(p, '# previous good compose\n');

    expect(() => assertComposedDocUsable(p, group, new Error('boom'))).not.toThrow();
    expect(fs.readFileSync(p, 'utf-8')).toContain('previous good compose');
  });
});

describe('readStandingInstructions', () => {
  function tmpGroupDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-persona-'));
  }

  // The regression this whole helper exists for. `instructions.prepend.md` is
  // written by group-init, template stamping, restamp and init-first-agent, and
  // is the file every agent-facing doc tells the agent to edit — but its only
  // reader was the project-doc composer this fork replaced with the spine. A
  // template-stamped group and the OWNER group composed with no persona at all,
  // and nothing went red.
  it('reads instructions.prepend.md when no .instructions.md exists', () => {
    const dir = tmpGroupDir();
    fs.writeFileSync(path.join(dir, 'instructions.prepend.md'), 'you are terse\n');

    expect(readStandingInstructions(dir, path.join(dir, '.instructions.md'))?.trim()).toBe('you are terse');
  });

  // READ-ONLY, and this is the assertion that keeps it that way. The rename used
  // to live in here, which meant the 60s staleness sweep — four render call sites
  // share this helper — mutated the shared group directory every pass, on a timer,
  // while the seam's tests claimed it published nothing.
  it('reads a legacy .instructions.md in place, without renaming it', () => {
    const dir = tmpGroupDir();
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(dotfile, 'legacy persona\n');

    expect(readStandingInstructions(dir, dotfile)?.trim()).toBe('legacy persona');
    expect(fs.existsSync(dotfile)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'instructions.prepend.md'))).toBe(false);
  });

  it('prefers the canonical file over a stale legacy one', () => {
    const dir = tmpGroupDir();
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(dotfile, 'stale legacy\n');
    fs.writeFileSync(path.join(dir, 'instructions.prepend.md'), 'current persona\n');

    expect(readStandingInstructions(dir, dotfile)?.trim()).toBe('current persona');
    expect(fs.existsSync(dotfile)).toBe(true);
  });

  // PRESENCE decides precedence, not content. Reading both files (rather than
  // renaming, which made this unreachable) reintroduces the case where an
  // existing-but-empty canonical file hands precedence back to a stale legacy one —
  // resurrecting instructions an operator deliberately emptied.
  it('does not resurrect legacy instructions when the canonical file is empty', () => {
    const dir = tmpGroupDir();
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(path.join(dir, 'instructions.prepend.md'), '   \n');
    fs.writeFileSync(dotfile, 'stale legacy\n');

    expect(readStandingInstructions(dir, dotfile)).toBeNull();
  });

  // Both files sit in the group directory, which is mounted READ-WRITE into the
  // container, and both land verbatim in the next composed system prompt. A plain
  // `readFileSync` on the legacy name therefore turns "edit your own persona" into
  // an arbitrary host-file read; measured before the fix, this returned the target
  // file's contents.
  it('does not follow a symlinked legacy instructions file', () => {
    const dir = tmpGroupDir();
    const outside = path.join(dir, 'SECRET.md');
    fs.writeFileSync(outside, 'host secret\n');
    const dotfile = path.join(dir, '.instructions.md');
    fs.symlinkSync(outside, dotfile);

    expect(readStandingInstructions(dir, dotfile)).toBeNull();
  });

  it('trims the legacy file the same way as the canonical one', () => {
    const dir = tmpGroupDir();
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(dotfile, '  legacy  \n\n');

    // Untrimmed content would compose to different bytes either side of the
    // migration, so spawn's hash and the sweep's would disagree across it.
    expect(readStandingInstructions(dir, dotfile)).toBe('legacy');
  });

  it('returns null when the group has neither', () => {
    const dir = tmpGroupDir();

    expect(readStandingInstructions(dir, path.join(dir, '.instructions.md'))).toBeNull();
  });

  it('does not follow a symlinked persona', () => {
    const dir = tmpGroupDir();
    const secret = path.join(dir, 'secret.md');
    fs.writeFileSync(secret, 'not the persona\n');
    fs.symlinkSync(secret, path.join(dir, 'instructions.prepend.md'));

    // O_NOFOLLOW: the persona is the one input an agent can author, so a symlink
    // must not become an arbitrary-file read into the system prompt.
    expect(readStandingInstructions(dir, path.join(dir, '.instructions.md'))).toBeNull();
  });

  // A symlinked canonical file is PRESENT — ELOOP is not ENOENT — so it must not
  // hand precedence to the legacy file either. Without a legacy file on disk the
  // case above cannot tell the two contracts apart: it passes whether the symlink
  // is treated as present-but-unreadable or as absent.
  it('does not fall back to legacy when the canonical path is a symlink', () => {
    const dir = tmpGroupDir();
    const secret = path.join(dir, 'secret.md');
    fs.writeFileSync(secret, 'not the persona\n');
    fs.symlinkSync(secret, path.join(dir, 'instructions.prepend.md'));
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(dotfile, 'stale legacy\n');

    expect(readStandingInstructions(dir, dotfile)).toBeNull();
  });

  // Same contract for the other non-ENOENT shapes: a directory at either name is
  // present and unusable, never a reason to read the other file.
  it('does not fall back to legacy when the canonical path is a directory', () => {
    const dir = tmpGroupDir();
    fs.mkdirSync(path.join(dir, 'instructions.prepend.md'));
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(dotfile, 'stale legacy\n');

    expect(readStandingInstructions(dir, dotfile)).toBeNull();
  });
});

// Behavioural, against the mocked logger. These three cases came from
// `doc-size-cap.test.ts`, where they exercised `assertWithinDocSizeCap` — the
// helper the cap-in-assembler move made unreachable. Source-text assertions in
// `publication-contract.test.ts` pin WHERE the reporting lives; these pin that it
// fires on the right condition, which a regex cannot.
describe('reportProjectDocPressure', () => {
  function rendered(over: Partial<CapDiagnostics> & { dropped?: string[] } = {}) {
    const { dropped = [], ...diag } = over;
    return {
      dropped,
      diagnostics: {
        bytes: 1000,
        maxBytes: 4 * 1024 * 1024,
        sections: [{ name: 'A', bytes: 1000 }],
        nearCap: false,
        structurallyOmitted: [],
        ...diag,
      } as CapDiagnostics,
    };
  }

  it('warns exactly once near the cap', () => {
    vi.mocked(log.warn).mockClear();

    reportProjectDocPressure('g', 'default', rendered({ nearCap: true }));

    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0][1]).toMatchObject({ folder: 'g', coworkerType: 'default' });
  });

  it('warns when sections were evicted even with headroom', () => {
    vi.mocked(log.warn).mockClear();

    reportProjectDocPressure('g', 'default', rendered({ dropped: ['MCP Server: huge'] }));

    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0][1]).toMatchObject({ dropped: ['MCP Server: huge'] });
  });

  it('warns when a group header was structurally omitted', () => {
    vi.mocked(log.warn).mockClear();

    reportProjectDocPressure('g', 'default', rendered({ structurallyOmitted: ['MCP Servers'] }));

    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('stays quiet with headroom and nothing dropped', () => {
    vi.mocked(log.warn).mockClear();

    reportProjectDocPressure('g', 'default', rendered());

    expect(log.warn).not.toHaveBeenCalled();
  });
});

// The write half, split out of `readStandingInstructions` so that rendering — which
// the 60s sweep does for every group — cannot mutate the group directory. Called
// from the publication path only.
describe('migrateStandingInstructions', () => {
  function tmpGroupDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-migrate-'));
  }

  it('renames the legacy file onto the canonical name, once', () => {
    const dir = tmpGroupDir();
    const dotfile = path.join(dir, '.instructions.md');
    const canonical = path.join(dir, 'instructions.prepend.md');
    fs.writeFileSync(dotfile, 'legacy persona\n');

    migrateStandingInstructions(dir, dotfile);

    // Converged: one file, and the legacy name is gone so it cannot drift.
    expect(fs.existsSync(dotfile)).toBe(false);
    expect(fs.readFileSync(canonical, 'utf-8').trim()).toBe('legacy persona');

    // Idempotent, and the persona reads the same either side of the migration —
    // which is what lets the sweep's hash agree with spawn's across it.
    migrateStandingInstructions(dir, dotfile);
    expect(readStandingInstructions(dir, dotfile)?.trim()).toBe('legacy persona');
  });

  it('does not clobber an existing canonical file when both are present', () => {
    const dir = tmpGroupDir();
    const dotfile = path.join(dir, '.instructions.md');
    fs.writeFileSync(dotfile, 'stale legacy\n');
    fs.writeFileSync(path.join(dir, 'instructions.prepend.md'), 'current persona\n');

    migrateStandingInstructions(dir, dotfile);

    expect(fs.existsSync(dotfile)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'instructions.prepend.md'), 'utf-8').trim()).toBe('current persona');
  });

  it('writes nothing when there is no legacy file', () => {
    const dir = tmpGroupDir();

    migrateStandingInstructions(dir, path.join(dir, '.instructions.md'));

    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
