/**
 * `wire_agents` delivery-action handler.
 *
 * Creates bidirectional agent_destinations rows between two agents,
 * allowing them to message each other. Admin-only. Idempotent — re-wiring
 * an existing pair reuses existing rows.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  allocateDestinationName,
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
} from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export async function handleWireAgents(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup?.is_admin) {
    notifyAgent(session, 'wire_agents denied: admin permission required.');
    return;
  }

  const agentAName = content.agentA as string;
  const agentBName = content.agentB as string;

  // Resolve both names in the admin's destination map
  const destA = getDestinationByName(sourceGroup.id, agentAName);
  const destB = getDestinationByName(sourceGroup.id, agentBName);
  if (!destA || destA.target_type !== 'agent') {
    notifyAgent(session, `wire_agents failed: "${agentAName}" is not an agent destination.`);
    return;
  }
  if (!destB || destB.target_type !== 'agent') {
    notifyAgent(session, `wire_agents failed: "${agentBName}" is not an agent destination.`);
    return;
  }
  if (destA.target_id === destB.target_id) {
    notifyAgent(session, `wire_agents failed: both names resolve to the same agent.`);
    return;
  }

  const agGroupA = destA.target_id;
  const agGroupB = destB.target_id;
  const now = new Date().toISOString();
  const results: string[] = [];

  // A -> B (idempotent: check if link already exists)
  const existingAtoB = getDestinationByTarget(agGroupA, 'agent', agGroupB);
  if (existingAtoB) {
    results.push(`"${agentAName}" already reaches "${agentBName}" as "${existingAtoB.local_name}" (reused).`);
  } else {
    const nameForB = allocateDestinationName(agGroupA, agentBName);
    createDestination({
      agent_group_id: agGroupA,
      local_name: nameForB,
      target_type: 'agent',
      target_id: agGroupB,
      created_at: now,
    });
    results.push(`"${agentAName}" can now reach "${agentBName}" as "${nameForB}".`);
  }

  // B -> A (idempotent)
  const existingBtoA = getDestinationByTarget(agGroupB, 'agent', agGroupA);
  if (existingBtoA) {
    results.push(`"${agentBName}" already reaches "${agentAName}" as "${existingBtoA.local_name}" (reused).`);
  } else {
    const nameForA = allocateDestinationName(agGroupB, agentAName);
    createDestination({
      agent_group_id: agGroupB,
      local_name: nameForA,
      target_type: 'agent',
      target_id: agGroupA,
      created_at: now,
    });
    results.push(`"${agentBName}" can now reach "${agentAName}" as "${nameForA}".`);
  }

  // Refresh destination maps for all active sessions of both agents
  const allSessions = getActiveSessions();
  for (const s of allSessions) {
    if (s.agent_group_id === agGroupA || s.agent_group_id === agGroupB) {
      writeDestinations(s.agent_group_id, s.id);
    }
  }

  notifyAgent(session, `Peer wiring complete:\n${results.join('\n')}`);
  log.info('Peer agents wired', { agentA: agentAName, agentB: agentBName, groupA: agGroupA, groupB: agGroupB });
}
