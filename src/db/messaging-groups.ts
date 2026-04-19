import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
// Transitional tier violation: core imports from optional agent-to-agent module.
// `createMessagingGroupAgent` auto-creates a destination row on wiring — the
// two concerns are currently bundled. When agent-to-agent isn't installed,
// the table doesn't exist and this import chain remains dormant because
// `createMessagingGroupAgent` is only called from setup/admin paths that
// also only run when wiring channels to agents (which implicitly requires
// agent-to-agent for the destination ACL to mean anything). A cleaner split
// (or making the destination side effect module-owned) is tracked in the
// refactor plan.
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import { getDb, hasTable } from './connection.js';

// ── Messaging Groups ──

export function createMessagingGroup(group: MessagingGroup): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @name, @is_group, @unknown_sender_policy, @created_at)`,
    )
    .run(group);
}

export function getMessagingGroup(id: string): MessagingGroup | undefined {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE id = ?').get(id) as MessagingGroup | undefined;
}

export function getMessagingGroupByPlatform(channelType: string, platformId: string): MessagingGroup | undefined {
  return getDb()
    .prepare('SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as MessagingGroup | undefined;
}

export function getAllMessagingGroups(): MessagingGroup[] {
  return getDb().prepare('SELECT * FROM messaging_groups ORDER BY name').all() as MessagingGroup[];
}

export function getMessagingGroupsByChannel(channelType: string): MessagingGroup[] {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE channel_type = ?').all(channelType) as MessagingGroup[];
}

export function updateMessagingGroup(
  id: string,
  updates: Partial<Pick<MessagingGroup, 'name' | 'is_group' | 'unknown_sender_policy'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE messaging_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteMessagingGroup(id: string): void {
  getDb().prepare('DELETE FROM messaging_groups WHERE id = ?').run(id);
}

// ── Messaging Group Agents ──

/**
 * Wire a messaging group to an agent group. Also auto-creates the matching
 * `agent_destinations` row so the agent can deliver to this chat as a
 * target, not just reply to the origin. Without this, routing to chats that
 * aren't the session's origin (agent-shared sessions, cross-channel sends)
 * would require an operator to hand-insert destination rows every time.
 *
 * The destination row is skipped if one already exists for the same target,
 * so re-wiring is a no-op. The local_name uses the messaging group's `name`
 * field when set, falling back to `${channel_type}-${mg_id prefix}`, with
 * a numeric suffix to break collisions within the agent's namespace. This
 * mirrors the backfill logic in migration 004.
 */
export function createMessagingGroupAgent(mga: MessagingGroupAgent): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id,
         engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id,
         @engage_mode, @engage_pattern, @sender_scope, @ignored_message_policy,
         @session_mode, @priority, @created_at
       )`,
    )
    .run(mga);

  // Auto-create an agent_destinations row so delivery's ACL doesn't block
  // outbound messages that target this chat. Guarded: when the agent-to-agent
  // module isn't installed the table doesn't exist — skip silently. Without
  // the module, the ACL check in delivery is also skipped (same guard), so
  // channel sends still work.
  //
  // ⚠️  DESTINATION PROJECTION NOTE: this function only writes the central
  // `agent_destinations` row. It does NOT project into any running
  // agent's session inbound.db (see top-of-file invariant in
  // src/modules/agent-to-agent/db/agent-destinations.ts). In practice this
  // is fine because the only real callers are one-shot setup scripts
  // (setup/register.ts, scripts/init-first-agent.ts, /manage-channels
  // skill) that run in a separate process from the host. Any already-
  // running container for `mga.agent_group_id` will keep serving the
  // stale projection until its next wake (idle timeout or next inbound
  // message) at which point spawnContainer's writeDestinations call
  // refreshes from central. If you call this from code that runs INSIDE
  // the host process and need the refresh to happen immediately,
  // explicitly call the module's `writeDestinations(mga.agent_group_id,
  // <sessionId>)` afterwards.
  if (!hasTable(getDb(), 'agent_destinations')) return;

  const existing = getDestinationByTarget(mga.agent_group_id, 'channel', mga.messaging_group_id);
  if (existing) return;

  const mg = getMessagingGroup(mga.messaging_group_id);
  if (!mg) return;

  const base = normalizeName(mg.name || `${mg.channel_type}-${mga.messaging_group_id.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  while (getDestinationByName(mga.agent_group_id, localName)) {
    localName = `${base}-${suffix}`;
    suffix++;
  }

  createDestination({
    agent_group_id: mga.agent_group_id,
    local_name: localName,
    target_type: 'channel',
    target_id: mga.messaging_group_id,
    created_at: mga.created_at,
  });
}

export function getMessagingGroupAgents(messagingGroupId: string): MessagingGroupAgent[] {
  return getDb()
    .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? ORDER BY priority DESC')
    .all(messagingGroupId) as MessagingGroupAgent[];
}

export function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): MessagingGroupAgent | undefined {
  return getDb()
    .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(messagingGroupId, agentGroupId) as MessagingGroupAgent | undefined;
}

export function getMessagingGroupAgent(id: string): MessagingGroupAgent | undefined {
  return getDb().prepare('SELECT * FROM messaging_group_agents WHERE id = ?').get(id) as
    | MessagingGroupAgent
    | undefined;
}

export function updateMessagingGroupAgent(
  id: string,
  updates: Partial<
    Pick<
      MessagingGroupAgent,
      'engage_mode' | 'engage_pattern' | 'sender_scope' | 'ignored_message_policy' | 'session_mode' | 'priority'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE messaging_group_agents SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteMessagingGroupAgent(id: string): void {
  getDb().prepare('DELETE FROM messaging_group_agents WHERE id = ?').run(id);
}

/** Get all messaging groups wired to an agent group (reverse lookup). */
export function getMessagingGroupsByAgentGroup(agentGroupId: string): MessagingGroup[] {
  return getDb()
    .prepare(
      `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as MessagingGroup[];
}
