/**
 * Driver selection.
 *
 * `NANOCLAW_RUNTIME_DRIVER` is read once, at first use, and defaults to
 * `docker` — so an install that never sets it behaves exactly as it did before
 * the seam existed. Nothing above this module may branch on the driver's
 * identity: features gate on `capabilities()`, never on `kind`.
 *
 * Selection is a registry, not a switch. Drivers self-register by kind; this
 * module pre-registers `docker`, the only realization that ships here. An
 * overlay adds its own with one `registerSessionDriver(...)` call and one
 * appended import — the same shape as the provider container-config barrel
 * (`src/providers/index.ts`) and the session-egress factory. Nothing outside
 * this file has to be rewritten to install a driver, so an overlay never has to
 * keep a patch of this file's internals in sync with it.
 *
 * A configured kind with no registered driver throws, uniformly. There is no
 * "recognized but uninstalled" tier and no typo tolerance, because there is no
 * difference worth encoding between the two: `=vm` on a host with no vm
 * driver and `=dcoker` on any host are the same operator error — a host
 * configured for one runtime that would otherwise silently run another. A
 * fallback here surfaces later as anything but a configuration problem.
 *
 * CAVEAT for whoever debugs this at 3am: a startup throw under a service
 * manager configured `Restart=always` is a crash loop, and `systemctl is-active`
 * reports `active` throughout one — the loud failure is invisible in the status
 * command an operator reaches for first. The discriminator is the boot-scoped
 * `Session runtime driver selected` line below: a unit that reports active with
 * no such line in the current boot is a host whose driver selection is
 * throwing. That log.info is load-bearing for this reason; do not demote it to
 * debug.
 *
 * Settings are read from `.env` with `process.env` taking precedence. That
 * precedence is not decoration: the host service has no `EnvironmentFile=`,
 * it parses `.env` in-process, so a setting that only consulted `process.env`
 * would be silently ignored when written to the file where every other
 * NanoClaw setting lives.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from '../egress-lockdown.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import '../provider-contracts/index.js';
import { protectedProviderDocumentSourcePaths } from '../provider-contracts/realize.js';

import { DockerSessionDriver, agentContainerName } from './docker-driver.js';
import {
  getSessionDriverFactory,
  listSessionDriverKinds,
  registerSessionDriver,
  type DriverKind,
} from './driver-registry.js';
// Side-effect import: the barrel overlays append their driver's registration to.
// Everything it pulls in registers before this module's body runs, which is the
// whole reason the registry lives in its own module — see `driver-registry.ts`.
import './installed.js';
import { withSessionEvents, type SessionEventsDriver } from './session-events.js';
import type { MountPolicy, SessionDriver, SessionSpec } from './types.js';

const DEFAULT_DRIVER_KIND = 'docker';

const SETTINGS = ['NANOCLAW_RUNTIME_DRIVER', 'NANOCLAW_SESSION_MATERIAL_ROOT'] as const;

/** `process.env` wins, then `.env`, then the default. */
export function readSetting(key: (typeof SETTINGS)[number], env: NodeJS.ProcessEnv = process.env): string {
  return env[key]?.trim() || readEnvFile([...SETTINGS])[key]?.trim() || '';
}

/**
 * Docker's network topology, decided at spawn: the egress-lockdown network
 * when the flag is on (throws rather than spawning with open egress), else the
 * host-gateway mapping Linux needs to reach host services. Injected at
 * registration — the driver stays constructible without it in tests, and
 * composition never sees an argv-shaped network selection: `spec.network`
 * states the intent, this realizes it, and nothing rides between them.
 */
function dockerNetworkArgs(spec: SessionSpec): string[] {
  if (ensureEgressNetwork()) {
    log.info('Egress lockdown active', { containerName: agentContainerName(spec), network: EGRESS_NETWORK });
    return egressNetworkArgs();
  }
  return os.platform() === 'linux' ? ['--add-host=host.docker.internal:host-gateway'] : [];
}

type GpuMode = 'runtime-nvidia' | 'gpus-all' | 'none';
let gpuModeCache: GpuMode | null = null;

/**
 * Which GPU passthrough this host can do. `ENABLE_GPU=1` forces the check on a
 * host whose driver lives outside /usr/bin; `GPU_RUNTIME_MODE` pins the answer
 * when detection guesses wrong. Cached — `docker info` per spawn is wasteful and
 * the answer cannot change without a daemon restart.
 */
function detectGpuMode(): GpuMode {
  if (gpuModeCache) return gpuModeCache;
  if (process.env.ENABLE_GPU !== '1' && !fs.existsSync('/usr/bin/nvidia-smi')) {
    return (gpuModeCache = 'none');
  }
  const forced = process.env.GPU_RUNTIME_MODE as GpuMode | undefined;
  if (forced === 'runtime-nvidia' || forced === 'gpus-all') return (gpuModeCache = forced);
  try {
    const runtimes = execSync('docker info --format "{{json .Runtimes}}"', { timeout: 3000 }).toString();
    if (/\bnvidia\b/.test(runtimes)) return (gpuModeCache = 'runtime-nvidia');
  } catch {
    /* fall through to --gpus */
  }
  return (gpuModeCache = 'gpus-all');
}

/**
 * GPU passthrough, decided at spawn like the network topology above and for the
 * same reason: whether this host has an NVIDIA runtime is a property of the
 * host, not of the session, so composition has nothing to say about it and
 * `SessionResources` gains no field a non-Docker realization would have to fake.
 *
 * The two `NVIDIA_*` vars ride this lane rather than `ContainerSpec.env`
 * because they are meaningless without the flags beside them — one host
 * capability, decided once. Non-secret by inspection; `-e` here is the same
 * append the pre-seam argv did.
 */
function dockerGpuArgs(): string[] {
  const mode = detectGpuMode();
  if (mode === 'none') return [];
  return [
    ...(mode === 'runtime-nvidia' ? ['--runtime=nvidia'] : ['--gpus', 'all']),
    '-e',
    'NVIDIA_VISIBLE_DEVICES=all',
    '-e',
    'NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics',
  ];
}

/** Reset the cached GPU probe. Tests only. */
export function resetGpuModeCacheForTests(): void {
  gpuModeCache = null;
}

registerSessionDriver(
  DEFAULT_DRIVER_KIND,
  (policy) => new DockerSessionDriver({ ...policy, networkArgsFor: dockerNetworkArgs, hostDeviceArgs: dockerGpuArgs }),
);

export function configuredDriverKind(env: NodeJS.ProcessEnv = process.env): DriverKind {
  return readSetting('NANOCLAW_RUNTIME_DRIVER', env).toLowerCase() || DEFAULT_DRIVER_KIND;
}

/**
 * The mount policy every driver enforces. `surfaceRoots` is an enumerated list,
 * never a bare install-root prefix: in this layout the state roots nest inside
 * the project root, so a prefix check would admit the central DB as a
 * mountable "surface".
 */
export function mountPolicy(env: NodeJS.ProcessEnv = process.env): MountPolicy {
  // `config.ts` derives every root from `process.cwd()` (the unit's
  // WorkingDirectory) and does not export it; `buildMounts` reads it the same
  // way, so the two cannot disagree.
  const projectRoot = process.cwd();
  return {
    groupsRoot: GROUPS_DIR,
    dataRoot: DATA_DIR,
    surfaceRoots: [
      path.join(projectRoot, 'container', 'agent-runner', 'src'),
      path.join(projectRoot, 'container', 'skills'),
      // Base documents are read by the host composer, not mounted. Declared
      // protected sources stay here so an overlapping operator mount cannot
      // make prompt-defining install content writable — without this, an
      // operator additionalMount whose allowlisted root covers the project tree
      // gets a WRITABLE mount of the document inlined into the agent's prompt.
      // On this fork the reader is the lego spine composer
      // (`claude-composer/runtime-contract.ts`), not upstream's project-doc
      // composer, which this fork does not wire.
      ...protectedProviderDocumentSourcePaths(projectRoot),
    ],
    // Must resolve to the same path an egress overlay's provisioner writes
    // material to, and a provisioner reads this key from `.env`. Reading it
    // from `process.env` alone would leave the two agreeing only by
    // coincidence of their defaults: move it in `.env` and every
    // identity-material mount is denied by a policy naming a path that looks
    // correct.
    materialsRoot: readSetting('NANOCLAW_SESSION_MATERIAL_ROOT', env) || path.join(DATA_DIR, 'session-materials'),
  };
}

let installed: SessionEventsDriver | null = null;

export function getSessionDriver(): SessionEventsDriver {
  if (!installed) installed = createSessionDriver(configuredDriverKind());
  return installed;
}

export function createSessionDriver(kind: DriverKind, overrides: Partial<MountPolicy> = {}): SessionEventsDriver {
  const factory = getSessionDriverFactory(kind);
  if (!factory) {
    // Name the fix in the first line: the setting, the value it holds, and what
    // this build can actually run. An operator reading only this line has to be
    // able to act on it.
    throw new Error(
      `NANOCLAW_RUNTIME_DRIVER='${kind}' but no driver is registered for '${kind}'; ` +
        `installed: ${listSessionDriverKinds().join(', ')}. ` +
        'Other drivers arrive as overlays — install the driver skill or unset the variable.',
    );
  }
  const policy = { ...mountPolicy(), ...overrides };
  // The session-events hub wraps whatever the factory produced — overlays
  // included — so `onTerminal`/stop-intent semantics are trunk-owned, never
  // re-implemented per driver (see `session-events.ts`).
  const driver: SessionEventsDriver = withSessionEvents(factory(policy));
  // Boot-scoped marker; see the crash-loop caveat at the top of this file.
  log.info('Session runtime driver selected', { driver: driver.kind, capabilities: driver.capabilities() });
  return driver;
}

/**
 * The already-selected driver, or null — never instantiates. For consumers
 * that must arm only when a runtime is actually in use: the boot sequence
 * selects the driver before the sweep starts, while a unit suite that never
 * selected one sees null instead of triggering selection as a side effect.
 */
export function peekSessionDriver(): SessionEventsDriver | null {
  return installed;
}

/** Test seam: drop the memoized driver so a suite can select another one. */
export function resetSessionDriver(next: SessionDriver | null = null): void {
  // Tests may inject raw fakes; the probe (isSessionEventsDriver) guards resync,
  // and fake handles carry their own onTerminal where flows need it.
  installed = next as SessionEventsDriver | null;
}

export * from './driver-registry.js';
export * from './session-events.js';
export * from './types.js';
