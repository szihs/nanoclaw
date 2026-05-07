import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/group-init.js', () => ({
  initGroupFilesystem: vi.fn(),
}));

vi.mock('../src/session-manager.js', () => ({
  resolveSession: vi.fn(() => ({ session: { id: 'test-session' } })),
  writeSessionMessage: vi.fn(),
}));

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./status.js', () => ({
  emitStatus: vi.fn(),
}));

import {
  closeDb,
  getAgentGroupByFolder,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from '../src/db/index.js';
import { getDestinationByTarget } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { run } from './register.js';

const realCwd = process.cwd();
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-'));
  fs.mkdirSync(path.join(tempDir, 'groups'), { recursive: true });
  process.chdir(tempDir);
});

afterEach(() => {
  closeDb();
  process.chdir(realCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('setup/register', () => {
  it('defaults admin coworker_type to main', async () => {
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
    ]);
    const agent = getAgentGroupByFolder('main');
    expect(agent).toBeDefined();
    expect(agent!.is_admin).toBe(1);
    expect(agent!.coworker_type).toBe('main');
  });

  it('creates bidirectional admin destinations for a non-admin coworker', async () => {
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
    ]);
    await run([
      '--platform-id', 'discord-chan-1',
      '--name', 'Slang Fixer',
      '--folder', 'slang-fixer',
      '--channel', 'discord',
    ]);

    const admin = getAgentGroupByFolder('main')!;
    const child = getAgentGroupByFolder('slang-fixer')!;
    expect(admin).toBeDefined();
    expect(child).toBeDefined();

    expect(getDestinationByTarget(admin.id, 'agent', child.id)).toBeDefined();
    expect(getDestinationByTarget(child.id, 'agent', admin.id)).toBeDefined();
  });

  it('routing=internal skips messaging group creation and wiring', async () => {
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
    ]);
    await run([
      '--platform-id', 'discord-chan-2',
      '--name', 'Internal Worker',
      '--folder', 'internal-worker',
      '--channel', 'discord',
      '--routing', 'internal',
    ]);

    const child = getAgentGroupByFolder('internal-worker')!;
    expect(child).toBeDefined();
    expect(child.routing).toBe('internal');

    expect(getMessagingGroupByPlatform('discord', 'discord:discord-chan-2')).toBeUndefined();

    const admin = getAgentGroupByFolder('main')!;
    expect(getDestinationByTarget(admin.id, 'agent', child.id)).toBeDefined();
    expect(getDestinationByTarget(child.id, 'agent', admin.id)).toBeDefined();
  });

  it('routing=direct creates messaging group and wiring', async () => {
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
    ]);
    await run([
      '--platform-id', 'discord-chan-3',
      '--name', 'Direct Worker',
      '--folder', 'direct-worker',
      '--channel', 'discord',
    ]);

    const child = getAgentGroupByFolder('direct-worker')!;
    const mg = getMessagingGroupByPlatform('discord', 'discord:discord-chan-3');
    expect(child.routing).toBe('direct');
    expect(mg).toBeDefined();
    expect(getMessagingGroupAgentByPair(mg!.id, child.id)).toBeDefined();
  });
});
