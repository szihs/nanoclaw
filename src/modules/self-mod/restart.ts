/**
 * Container restart delivery action.
 *
 * When a container (or the orchestrator via agent-to-agent) sends a system
 * message with `action: 'request_restart'`, the host kills the container and
 * writes a follow-up message so the sweep respawns it with a fresh CLAUDE.md.
 */
import { killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { DeliveryActionHandler } from '../../delivery.js';

export const handleRequestRestart: DeliveryActionHandler = async (content, session, _inDb) => {
  const reason = (content.reason as string) || 'restart requested';
  log.info('Container restart requested', { sessionId: session.id, reason });
  killContainer(session.id, `request_restart: ${reason}`);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: `Container restarted: ${reason}. Continue your current task.`,
      sender: 'system',
      senderId: 'system',
    }),
    processAfter: new Date(Date.now() + 5000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ''),
  });
};
