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

  it('defaults dashboard channel session_mode to per-thread', async () => {
    // The Slack-style thread UI requires per-thread sessions; without
    // this default, replies land in the root session keyed on
    // thread_id=NULL and the thread panel shows "no replies yet" even
    // though the agent processed the message. See PR #155 for context.
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
    ]);
    const mg = getMessagingGroupByPlatform('dashboard', 'dashboard:dashboard_main')!;
    const agent = getAgentGroupByFolder('main')!;
    const mga = getMessagingGroupAgentByPair(mg.id, agent.id)!;
    expect(mga.session_mode).toBe('per-thread');
  });

  it('keeps non-dashboard channels on the conservative shared default', async () => {
    // Telegram/WhatsApp/iMessage/Discord/Slack don't need per-thread
    // isolation for the dashboard UI; shared preserves existing behaviour.
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
    ]);
    await run([
      '--platform-id', 'discord-chan-sm',
      '--name', 'Discord Worker',
      '--folder', 'discord-worker',
      '--channel', 'discord',
    ]);
    const mg = getMessagingGroupByPlatform('discord', 'discord:discord-chan-sm')!;
    const agent = getAgentGroupByFolder('discord-worker')!;
    const mga = getMessagingGroupAgentByPair(mg.id, agent.id)!;
    expect(mga.session_mode).toBe('shared');
  });

  it('--session-mode explicitly passed wins over the channel-aware default', async () => {
    // Escape hatch: an operator can force any session mode regardless of
    // channel. Verified for both directions (dashboard → shared, non-dashboard → per-thread).
    await run([
      '--platform-id', 'dashboard_main',
      '--name', 'Dashboard Main',
      '--folder', 'main',
      '--channel', 'dashboard',
      '--is-admin',
      '--session-mode', 'shared',
    ]);
    const dashMg = getMessagingGroupByPlatform('dashboard', 'dashboard:dashboard_main')!;
    const dashAgent = getAgentGroupByFolder('main')!;
    const dashMga = getMessagingGroupAgentByPair(dashMg.id, dashAgent.id)!;
    expect(dashMga.session_mode).toBe('shared');

    await run([
      '--platform-id', 'discord-chan-explicit',
      '--name', 'Discord Explicit',
      '--folder', 'discord-explicit',
      '--channel', 'discord',
      '--session-mode', 'per-thread',
    ]);
    const dMg = getMessagingGroupByPlatform('discord', 'discord:discord-chan-explicit')!;
    const dAgent = getAgentGroupByFolder('discord-explicit')!;
    const dMga = getMessagingGroupAgentByPair(dMg.id, dAgent.id)!;
    expect(dMga.session_mode).toBe('per-thread');
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
