import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let _tempDir = '';
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return path.join(_tempDir, 'groups');
  },
  get DATA_DIR() {
    return path.join(_tempDir, 'data');
  },
}));

vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: vi.fn(),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(async () => {}),
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
}));

vi.mock('../../claude-composer.js', () => ({
  readCoworkerTypes: vi.fn(() => ({
    main: { base: true },
    'slang-reader': {},
  })),
}));

vi.mock('./write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../index.js', () => ({
  refreshAdapterConversations: vi.fn(),
}));

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { getDestinationByTarget } from './db/agent-destinations.js';
import { handleCreateAgent } from './create-agent.js';
import type { Session } from '../../types.js';

let tempDir: string;
const realCwd = process.cwd();

function setupFixtures(): { parentGroup: ReturnType<typeof getAgentGroupByFolder>; session: Session; mgId: string } {
  const now = new Date().toISOString();
  const parentId = 'ag-parent-001';
  const mgId = 'mg-test-001';
  const sessionId = 'sess-test-001';

  createAgentGroup({
    id: parentId,
    name: 'Orchestrator',
    folder: 'main',
    is_admin: 1,
    coworker_type: 'main',
    routing: 'direct',
    created_at: now,
  });

  createMessagingGroup({
    id: mgId,
    channel_type: 'dashboard',
    platform_id: 'dashboard:main',
    name: 'Dashboard Main',
    is_group: 1,
    unknown_sender_policy: 'public',
    admin_user_id: null,
    created_at: now,
  });

  createMessagingGroupAgent({
    id: 'mga-test-001',
    messaging_group_id: mgId,
    agent_group_id: parentId,
    engage_mode: 'always',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  } as never);

  const session: Session = {
    id: sessionId,
    agent_group_id: parentId,
    messaging_group_id: mgId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  };
  createSession(session);

  return { parentGroup: getAgentGroupByFolder('main'), session, mgId };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-agent-test-'));
  _tempDir = tempDir;
  fs.mkdirSync(path.join(tempDir, 'groups', 'templates', 'instructions'), { recursive: true });
  process.chdir(tempDir);

  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  process.chdir(realCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('handleCreateAgent', () => {
  it('default (no internalOnly) sets routing=direct and creates own dashboard channel', async () => {
    const { session, mgId } = setupFixtures();

    await handleCreateAgent({ name: 'Test Worker', requestId: 'req-1' }, session);

    const child = getAgentGroupByFolder('test-worker');
    expect(child).toBeDefined();
    expect(child!.routing).toBe('direct');

    const agents = getMessagingGroupAgents(mgId);
    const childWiring = agents.find((a) => a.agent_group_id === child!.id);
    expect(childWiring).toBeDefined();
    expect(childWiring!.engage_mode).toBe('pattern');
    expect(childWiring!.engage_pattern).toBe('@test-worker\\b');
  });

  it('internalOnly=true sets routing=internal', async () => {
    const { session } = setupFixtures();

    await handleCreateAgent(
      { name: 'Internal Bot', instructions: null, internalOnly: true, requestId: 'req-2' },
      session,
    );

    const child = getAgentGroupByFolder('internal-bot');
    expect(child).toBeDefined();
    expect(child!.routing).toBe('internal');
  });

  it('creates bidirectional destinations between parent and child', async () => {
    const { parentGroup, session } = setupFixtures();

    await handleCreateAgent({ name: 'Destination Test', requestId: 'req-3' }, session);

    const child = getAgentGroupByFolder('destination-test');
    expect(child).toBeDefined();

    expect(getDestinationByTarget(parentGroup!.id, 'agent', child!.id)).toBeDefined();
    expect(getDestinationByTarget(child!.id, 'agent', parentGroup!.id)).toBeDefined();
  });

  it('grants the child a channel destination back to the parent messaging group', async () => {
    const { session, mgId } = setupFixtures();

    await handleCreateAgent({ name: 'Channel Dest', requestId: 'req-4' }, session);

    const child = getAgentGroupByFolder('channel-dest');
    expect(child).toBeDefined();
    expect(getDestinationByTarget(child!.id, 'channel', mgId)).toBeDefined();
  });
});
