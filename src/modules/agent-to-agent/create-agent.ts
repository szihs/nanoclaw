/**
 * `create_agent` delivery-action handler.
 *
 * Spawns a new agent group on demand from the parent agent, wires bidirectional
 * agent_destinations rows, projects the new destination into the parent's
 * running container, and notifies the parent.
 *
 * Lego additions: coworker_type validation against the coworker-types registry,
 * instruction_overlay parameter, and channel wiring into the conversation that
 * created the agent.
 */
import fs from 'fs';
import path from 'path';

import { readCoworkerTypes } from '../../claude-composer.js';
import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  getMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  createMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import {
  allocateDestinationName,
  createDestination,
  getDestinationByName,
  normalizeName,
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

export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = content.requestId as string;
  const name = content.name as string;
  const instructions = content.instructions as string | null;

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `create_agent failed: source agent group not found.`);
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
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
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  // Validate coworker_type against the registry (lego coworker system).
  // If no type requested, infer the best leaf type from the registry.
  const requestedCoworkerType =
    typeof content.coworkerType === 'string' && content.coworkerType.trim() ? content.coworkerType.trim() : null;
  let coworkerType = requestedCoworkerType;
  let creationNote: string | null = null;

  if (!requestedCoworkerType) {
    // List available leaf types so the creation note tells the caller what's available
    const knownTypes = readCoworkerTypes();
    const SKIP = new Set(['main', 'global', 'base-common']);
    const leafTypes = Object.keys(knownTypes).filter(
      (name) => !SKIP.has(name) && !(knownTypes[name] as Record<string, unknown>).flat,
    );
    if (leafTypes.length > 0) {
      creationNote = `No coworkerType specified — created as untyped. Available types: ${leafTypes.join(', ')}. The agent will use the global base prompt. To get project-specific skills, traits, and MCP tools, recreate with a coworkerType.`;
      log.info('create_agent: no coworkerType, available types', { leafTypes });
    }
  }

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

  const internalOnly = content.internalOnly === true;
  const directChannel = !internalOnly;
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
    routing: (content.routing as string) || (directChannel ? 'direct' : 'internal'),
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
      // Use engage_mode columns (migration 010 dropped trigger_rules/response_scope).
      // Pattern-based engage with the @localName trigger — only fires when mentioned.
      createMessagingGroupAgent({
        id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        messaging_group_id: mg.id,
        agent_group_id: agentGroupId,
        engage_mode: 'pattern',
        engage_pattern: `@${localName}\\b`,
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      } as never);
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

  // For direct routing: create the coworker's own dashboard channel
  if (directChannel) {
    const platformId = `dashboard:${folder}`;
    let ownMg = getMessagingGroupByPlatform('dashboard', platformId);
    if (!ownMg) {
      const ownMgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createMessagingGroup({
        id: ownMgId,
        channel_type: 'dashboard',
        platform_id: platformId,
        name,
        is_group: 0,
        unknown_sender_policy: 'public',
        admin_user_id: null,
        created_at: now,
      });
      ownMg = getMessagingGroupByPlatform('dashboard', platformId)!;
    }
    if (ownMg) {
      const existingOwnMga = getMessagingGroupAgents(ownMg.id).some((a) => a.agent_group_id === agentGroupId);
      if (!existingOwnMga) {
        createMessagingGroupAgent({
          id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          messaging_group_id: ownMg.id,
          agent_group_id: agentGroupId,
          engage_mode: 'always',
          engage_pattern: `@${name.replace(/\s+/g, '')}`,
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: now,
        } as never);
      }
      const ownDestName = allocateDestinationName(agentGroupId, `${folder}-dashboard`);
      createDestination({
        agent_group_id: agentGroupId,
        local_name: ownDestName,
        target_type: 'channel',
        target_id: ownMg.id,
        created_at: now,
      });
    }
  }

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  // Refresh channel adapters so they learn about the new coworker's
  // trigger rules without requiring a restart.
  try {
    const { refreshAdapterConversations } = await import('../../index.js');
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
}
