// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  is_admin: number; // 0 | 1
  agent_provider: string | null;
  container_config: string | null; // JSON: { additionalMounts, timeout }
  coworker_type: string | null; // coworker-types.yaml key, e.g. "slang-reader" or "slang-writer"
  allowed_mcp_tools: string | null; // JSON: string[] of allowed MCP tool names
  routing: string; // 'direct' | 'internal'
  disable_overlays: number; // 0 | 1 — when 1, skip overlay hook injection
  created_at: string;
}

export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  admin_user_id: string | null;
  unknown_sender_policy: UnknownSenderPolicy;
  /**
   * When set, the owner explicitly denied registering this channel — the
   * router drops silently and does not re-escalate. Cleared by any explicit
   * wiring mutation (admin command). See migration 012.
   *
   * Optional on the TS type so pre-migration-012 callers that build
   * MessagingGroup objects in code (fixtures, etc.) don't need to update;
   * the column itself defaults to NULL in SQLite.
   */
  denied_at?: string | null;
  created_at: string;
}

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  trigger_rules: string | null; // JSON: { pattern, mentionOnly, excludeSenders, includeSenders }
  response_scope: 'all' | 'triggered' | 'allowlisted';
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  priority: number;
  engage_mode: 'always' | 'pattern' | 'mention' | 'mention-sticky' | 'never';
  engage_pattern: string | null;
  sender_scope: 'all' | 'known' | 'admin-only' | null;
  ignored_message_policy: 'drop' | 'accumulate' | null;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Pending questions (central DB) ──

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  created_at: string;
}

// ── Pending approvals (central DB) ──

export interface PendingApproval {
  approval_id: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string; // JSON
  created_at: string;
  agent_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  platform_message_id: string | null;
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  title: string | null;
  options_json: string | null;
}

// ── Pending credentials (central DB) ──

export type PendingCredentialStatus = 'pending' | 'submitted' | 'saved' | 'rejected' | 'failed';

export interface PendingCredential {
  id: string;
  agent_group_id: string;
  session_id: string | null;
  name: string;
  type: 'generic' | 'anthropic';
  host_pattern: string;
  path_pattern: string | null;
  header_name: string | null;
  value_format: string | null;
  description: string | null;
  channel_type: string;
  platform_id: string;
  platform_message_id: string | null;
  status: PendingCredentialStatus;
  created_at: string;
}

// ── Users (central DB) ──

export interface User {
  id: string;
  kind: string;
  display_name: string | null;
  created_at: string;
}

export type UserRoleKind = 'owner' | 'admin';

export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

export interface UserDm {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

// ── Agent destinations (central DB) ──

export interface AgentDestination {
  agent_group_id: string;
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
}
