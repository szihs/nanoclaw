/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_PREFIX } from './config.js';
import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the MCP proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** Detect whether the NVIDIA container runtime is available for GPU passthrough. */
let _gpuAvailable: boolean | null = null;
export function hasGpuRuntime(): boolean {
  if (_gpuAvailable !== null) return _gpuAvailable;
  try {
    const runtimes = execSync('docker info --format "{{json .Runtimes}}"', {
      stdio: 'pipe',
      timeout: 5000,
    }).toString();
    if (!runtimes.includes('nvidia'))
      throw new Error('nvidia runtime not found');
    // Also verify nvidia-smi works on the host
    execSync('nvidia-smi', { stdio: 'pipe', timeout: 5000 });
    _gpuAvailable = true;
    logger.info('NVIDIA GPU runtime detected — containers will get GPU access');
  } catch {
    _gpuAvailable = false;
    logger.debug('No NVIDIA GPU runtime available');
  }
  return _gpuAvailable;
}

/** CLI args to pass GPU access to containers (empty if no GPU available). */
export function gpuArgs(): string[] {
  if (!hasGpuRuntime()) return [];
  return ['--gpus', 'all'];
}

/** Docker network for container isolation (no inter-container traffic). */
export const AGENT_NETWORK = 'nanoclaw-agents';

/** Cached result of whether the agent network exists. Set by ensureAgentNetwork(). */
let _agentNetworkReady = false;

/**
 * Ensure the isolated agent network exists.
 * Creates it with --internal (no outbound internet) and ICC disabled
 * (no inter-container communication). Containers can still reach the
 * host gateway for MCP proxy, OneCLI, and dashboard.
 */
export function ensureAgentNetwork(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${AGENT_NETWORK}`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    _agentNetworkReady = true;
  } catch {
    try {
      execSync(
        `${CONTAINER_RUNTIME_BIN} network create ${AGENT_NETWORK} ` +
          `--internal --opt com.docker.network.bridge.enable_icc=false`,
        { stdio: 'pipe', timeout: 10000 },
      );
      _agentNetworkReady = true;
      logger.info({ network: AGENT_NETWORK }, 'Created isolated agent network');
    } catch (err) {
      _agentNetworkReady = false;
      logger.warn(
        { err: String(err) },
        'Failed to create agent network, falling back to default bridge',
      );
    }
  }
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  const args: string[] = [];

  // Use isolated network if available (cached at startup by ensureAgentNetwork)
  if (_agentNetworkReady) {
    args.push('--network', AGENT_NETWORK);
  }

  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }
  return args;
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, {
    stdio: 'pipe',
    timeout: 15000,
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=${CONTAINER_PREFIX}- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
