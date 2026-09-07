// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  is_admin: number; // 0 | 1
  /** @deprecated Use container_configs.provider instead. */
  agent_provider: string | null;
  container_config: string | null; // JSON: { additionalMounts, timeout }
  coworker_type: string | null; // coworker-types.yaml key, e.g. "slang-reader" or "slang-writer"
  // MCP tool policy — resolved ONLY through src/mcp-allowlist.ts, which owns
  // the three states: NULL = inherited (coworker-type manifest, or every
  // discovered tool for an admin group), '*' = unrestricted, JSON string[] =
  // an explicit list. NULL and '*' are NOT the same thing.
  allowed_mcp_tools: string | null;
  overlays: string | null; // JSON: string[] of overlay names (e.g. ["critique-gate", "buddy-monitor"])
  routing: string; // 'direct' | 'internal'
  disable_overlays: number; // 0 | 1 — when 1, skip overlay hook injection
  paused: number; // 0 | 1 — operator kill switch. When 1 the host refuses to spawn ANY container for this group, enforced in wakeContainer so every wake path (router fanout, a2a/host-direct, host-sweep, task fires) honours it. Inbound messages still accumulate; unpausing resumes them.
  created_at: string;
  /** Dashboard sidebar grouping: NULL/'prod' = shared prod group; else a user id. */
  sidebar_group?: string | null;
}

/**
 * A provider-declared speed tier name (`inference.speedTiers` on the provider's
 * host contract; `standard` | `fast` for Claude). Validated at `ncl groups
 * config update --speed` time against the group's provider, then stored and
 * passed through by core as an opaque token.
 */
export type ContainerSpeed = string;

/** Per-agent-group container runtime config. Source of truth in the DB;
 *  materialized to `groups/<folder>/container.json` at spawn time. */
export interface ContainerConfigRow {
  agent_group_id: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  image_tag: string | null;
  assistant_name: string | null;
  max_messages_per_prompt: number | null;
  skills: string; // JSON: '"all"' | '["skill1","skill2"]'
  mcp_servers: string; // JSON: Record<string, McpServerConfig>
  packages_apt: string; // JSON: string[]
  packages_npm: string; // JSON: string[]
  additional_mounts: string; // JSON: AdditionalMountConfig[]
  cli_scope: string; // 'disabled' | 'group' | 'global'
  timezone: string | null; // IANA id; NULL = follow the install-global timezone
  speed: ContainerSpeed | null; // NULL = install/provider default
  /**
   * Session isolation tier ('container' | 'vm') — see SessionSpec.runtimeTier.
   * Optional on the TS type because the trunk schema does not carry the
   * column: a deployment whose driver realizes more than one tier adds it,
   * and `SELECT *` rows surface it here. Absent means the default tier.
   */
  runtime_tier?: string | null;
  updated_at: string;
}

export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'decline_notify' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  /**
   * Adapter-instance name. Defaults to channel_type (the "default instance").
   * Column is NOT NULL (migration 016 backfills instance = channel_type);
   * optional on the TS type per the denied_at convention so fixtures that
   * build MessagingGroup objects don't need updating — createMessagingGroup
   * stamps the default.
   */
  instance?: string;
  name: string | null;
  is_group: number; // 0 | 1
  admin_user_id?: string | null;
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
  /**
   * When set, our own bot has LEFT the platform channel this row maps to
   * (written by a channel membership module, migration 022) — the wiring
   * survives, but delivery/typing should skip the row until the bot rejoins
   * (which clears it). Optional on the TS type per the denied_at convention.
   */
  detached_at?: string | null;
  created_at: string;
}

// Re-exported so importers (including upstream code pulled in on an update)
// resolve these symbols. The fork widened the underlying unions vs upstream
// ('always'/'never' engage modes, 'admin-only' sender scope); keeping the
// aliases — and referencing them from the interface below — restores the
// single source of truth and prevents a broken import on the next upstream pull.
export type EngageMode = 'always' | 'pattern' | 'mention' | 'mention-sticky' | 'never';
export type SenderScope = 'all' | 'known' | 'admin-only';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  trigger_rules?: string | null; // JSON: { pattern, mentionOnly, excludeSenders, includeSenders }
  response_scope?: 'all' | 'triggered' | 'allowlisted';
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  priority: number;
  engage_mode: EngageMode;
  engage_pattern: string | null;
  sender_scope: SenderScope | null;
  ignored_message_policy: IgnoredMessagePolicy | null;
  /**
   * Per-wiring thread-policy override (migration 019). NULL = inherit the
   * channel adapter's declared default for the wiring's context (DM vs
   * group); 1/0 = explicit override, hard-ANDed with the adapter's raw
   * capability at router fanout (resolveThreadPolicy). Optional on the TS
   * type per the denied_at convention so pre-migration fixtures don't need
   * updating.
   */
  threads?: number | null;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  display_title?: string | null;
  title_source?: 'auto' | 'manual' | 'heuristic' | null;
  title_updated_at?: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

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
  /**
   * Adapter instance the card was delivered through (migration 023). NULL
   * reads as the default instance (= channel_type). Delivery dispatch is
   * exact-key, so any follow-up edit to the card must address the identity
   * that posted it, not just the platform.
   */
  instance: string | null;
  platform_message_id: string | null;
  /**
   * For OneCLI credential rows, the gateway's request TTL. For a module
   * approval held by "Reject with reason…", the deadline after which the
   * host sweep finalizes a plain reject (set by markApprovalAwaitingReason).
   */
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'awaiting_reason';
  title: string;
  /** Original approval-card body, retained when the card reaches a terminal state. */
  question: string;
  options_json: string;
  /** When set, only this exact user may resolve the approval. */
  approver_user_id: string | null;
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

export interface AgentMessagePolicy {
  from_agent_group_id: string;
  to_agent_group_id: string;
  approver: string;
  created_at: string;
}
