import fs from 'fs';

import type { Session } from './types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  resetContainerIdleTimer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-wire-agents' };
});

import { createAgentGroup } from './db/agent-groups.js';
import {
  createDestination,
  getDestinationByTarget,
  getDestinations,
} from './modules/agent-to-agent/db/agent-destinations.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { openInboundDb, resolveSession } from './session-manager.js';
import { writeDestinations } from './modules/agent-to-agent/write-destinations.js';
// Import the module to register delivery actions (wire_agents, create_agent, etc.)
import './modules/agent-to-agent/index.js';
import { __testHooks } from './delivery.js';

const TEST_DATA_DIR = '/tmp/nanoclaw-test-wire-agents';

function now(): string {
  return new Date().toISOString();
}

function seedGroups(admin = true): void {
  createAgentGroup({
    id: 'ag-main',
    name: 'Main',
    folder: 'main',
    is_admin: admin ? 1 : 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    created_at: now(),
  });
  createAgentGroup({
    id: 'ag-a',
    name: 'Worker A',
    folder: 'worker-a',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    created_at: now(),
  });
  createAgentGroup({
    id: 'ag-b',
    name: 'Worker B',
    folder: 'worker-b',
    is_admin: 0,
    agent_provider: null,
    container_config: null,
    coworker_type: null,
    allowed_mcp_tools: null,
    created_at: now(),
  });
}

function seedAdminDestinations(): void {
  createDestination({
    agent_group_id: 'ag-main',
    local_name: 'worker-a',
    target_type: 'agent',
    target_id: 'ag-a',
    created_at: now(),
  });
  createDestination({
    agent_group_id: 'ag-main',
    local_name: 'worker-b',
    target_type: 'agent',
    target_id: 'ag-b',
    created_at: now(),
  });
}

function readSystemMessages(session: Session): string[] {
  const db = openInboundDb(session.agent_group_id, session.id);
  try {
    const rows = db.prepare("SELECT content FROM messages_in WHERE kind = 'chat'").all() as Array<{ content: string }>;
    return rows.map((r) => {
      try {
        return (JSON.parse(r.content) as { text?: string }).text || '';
      } catch {
        return '';
      }
    });
  } finally {
    db.close();
  }
}

describe('wire_agents host action', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('creates bidirectional peer links and refreshes active destination maps', async () => {
    seedGroups(true);
    seedAdminDestinations();

    createDestination({
      agent_group_id: 'ag-a',
      local_name: 'parent',
      target_type: 'agent',
      target_id: 'ag-main',
      created_at: now(),
    });
    createDestination({
      agent_group_id: 'ag-b',
      local_name: 'parent',
      target_type: 'agent',
      target_id: 'ag-main',
      created_at: now(),
    });

    const { session: mainSession } = resolveSession('ag-main', null, null, 'agent-shared');
    const { session: sessionA } = resolveSession('ag-a', null, null, 'agent-shared');
    const { session: sessionB } = resolveSession('ag-b', null, null, 'agent-shared');
    writeDestinations('ag-a', sessionA.id);
    writeDestinations('ag-b', sessionB.id);

    const inDb = openInboundDb(mainSession.agent_group_id, mainSession.id);
    try {
      await __testHooks.handleSystemAction(
        { action: 'wire_agents', agentA: 'worker-a', agentB: 'worker-b' },
        mainSession,
        inDb,
      );
    } finally {
      inDb.close();
    }

    const aToB = getDestinationByTarget('ag-a', 'agent', 'ag-b');
    const bToA = getDestinationByTarget('ag-b', 'agent', 'ag-a');
    expect(aToB).toBeDefined();
    expect(bToA).toBeDefined();

    const aMapDb = openInboundDb('ag-a', sessionA.id);
    const bMapDb = openInboundDb('ag-b', sessionB.id);
    try {
      const aMap = aMapDb.prepare("SELECT agent_group_id FROM destinations WHERE type = 'agent'").all() as Array<{
        agent_group_id: string | null;
      }>;
      const bMap = bMapDb.prepare("SELECT agent_group_id FROM destinations WHERE type = 'agent'").all() as Array<{
        agent_group_id: string | null;
      }>;
      expect(aMap.some((r) => r.agent_group_id === 'ag-b')).toBe(true);
      expect(bMap.some((r) => r.agent_group_id === 'ag-a')).toBe(true);
    } finally {
      aMapDb.close();
      bMapDb.close();
    }

    const systemMessages = readSystemMessages(mainSession);
    expect(systemMessages.some((m) => m.includes('Peer wiring complete'))).toBe(true);
  });

  it('is idempotent when called repeatedly for the same pair', async () => {
    seedGroups(true);
    seedAdminDestinations();
    const { session: mainSession } = resolveSession('ag-main', null, null, 'agent-shared');

    const db1 = openInboundDb(mainSession.agent_group_id, mainSession.id);
    try {
      await __testHooks.handleSystemAction(
        { action: 'wire_agents', agentA: 'worker-a', agentB: 'worker-b' },
        mainSession,
        db1,
      );
    } finally {
      db1.close();
    }

    const db2 = openInboundDb(mainSession.agent_group_id, mainSession.id);
    try {
      await __testHooks.handleSystemAction(
        { action: 'wire_agents', agentA: 'worker-a', agentB: 'worker-b' },
        mainSession,
        db2,
      );
    } finally {
      db2.close();
    }

    const aLinks = getDestinations('ag-a').filter((d) => d.target_type === 'agent' && d.target_id === 'ag-b');
    const bLinks = getDestinations('ag-b').filter((d) => d.target_type === 'agent' && d.target_id === 'ag-a');
    expect(aLinks).toHaveLength(1);
    expect(bLinks).toHaveLength(1);
  });

  it('rejects non-admin callers', async () => {
    seedGroups(false);
    seedAdminDestinations();
    const { session: mainSession } = resolveSession('ag-main', null, null, 'agent-shared');

    const inDb = openInboundDb(mainSession.agent_group_id, mainSession.id);
    try {
      await __testHooks.handleSystemAction(
        { action: 'wire_agents', agentA: 'worker-a', agentB: 'worker-b' },
        mainSession,
        inDb,
      );
    } finally {
      inDb.close();
    }

    expect(getDestinationByTarget('ag-a', 'agent', 'ag-b')).toBeUndefined();
    expect(getDestinationByTarget('ag-b', 'agent', 'ag-a')).toBeUndefined();
    const systemMessages = readSystemMessages(mainSession);
    expect(systemMessages.some((m) => m.includes('admin permission required'))).toBe(true);
  });
});
