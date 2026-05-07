/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getSourceFor, recordSource } from '../../db/a2a-session-sources.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

/**
 * Ensure a per-(source, recipient) messaging_group exists with a per-thread
 * wiring for the recipient. Idempotent; returns the mg id.
 *
 * Platform-id format: `agent:<source-ag>:<recipient-ag>` so two distinct
 * sources delegating into the same recipient with the same thread_id
 * (e.g. both picking "review-PR-A") get two distinct recipient sessions,
 * one per pair. The older `agent:<recipient>` form (sourceAgentGroupId=null)
 * is kept for back-compat callers that intentionally share across senders —
 * none in-tree today, but the signature leaves the door open.
 *
 * Rationale: per-thread session resolution needs a messaging_group_id as
 * part of its lookup key. Old code used `agent-shared` which ignores
 * messaging_group + thread_id entirely — that's kept as the fallback for
 * unthreaded (thread_id=null) a2a calls. Threaded a2a calls route through
 * this synthetic group so `(recipient, a2a_mg, thread_id)` can key a
 * unique session per delegation.
 *
 * Back-compat: pre-existing a2a wirings (rare — most installs have none
 * since agent-shared doesn't create mga rows) are upgraded via migration
 * 019. This helper's own UPDATE catches any slipped-through `'shared'`
 * rows on the synthetic group too, so first threaded delivery self-heals.
 */
export function ensureA2aWiring(
  targetAgentGroupId: string,
  sourceAgentGroupId: string | null = null,
  now: string = new Date().toISOString(),
): string {
  const platformId = sourceAgentGroupId
    ? `agent:${sourceAgentGroupId}:${targetAgentGroupId}`
    : `agent:${targetAgentGroupId}`;
  let mg = getMessagingGroupByPlatform('agent', platformId);
  if (!mg) {
    const mgId = `mg-a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: mgId,
      channel_type: 'agent',
      platform_id: platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      admin_user_id: null,
      created_at: now,
    });
    mg = getMessagingGroupByPlatform('agent', platformId)!;
  }

  const existing = getMessagingGroupAgents(mg.id).find((a) => a.agent_group_id === targetAgentGroupId);
  if (!existing) {
    createMessagingGroupAgent({
      id: `mga-a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mg.id,
      agent_group_id: targetAgentGroupId,
      engage_mode: 'always',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now,
    } as never);
  }
  return mg.id;
}

export { isSafeAttachmentName };

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  fs.mkdirSync(targetInboxDir, { recursive: true });

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  /** Thread identifier carried from sender's context. When non-null, routes
   *  to a per-thread session under the recipient; when null, falls back to
   *  agent-shared for back-compat with pre-threading installs. */
  thread_id: string | null;
  content: string;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }

  // Reply-detection branch.
  //
  // If the sending session is itself the recipient side of a prior a2a
  // delegation (i.e. a2a_session_sources has a row for it), AND the
  // outbound is addressed to the original source's agent group, this is a
  // REPLY to that delegation. Deliver directly into the original source
  // session, bypassing mg + thread resolution — re-resolving would land
  // the reply in a brand-new synthetic session and lose the conversation.
  //
  // All other outbound agent messages (fresh delegations, lateral calls
  // to unrelated peers) fall through to the normal route below.
  const sourceHint = getSourceFor(session.id);
  if (sourceHint && sourceHint.source_agent_group_id === targetAgentGroupId) {
    const originalSourceSession = getSession(sourceHint.source_session_id);
    if (!originalSourceSession) {
      // Fail closed. The source session the recipient was supposed to
      // reply to is gone (deleted, archived, reset). We must NOT synthesise
      // a brand-new session on the sender's side — that would silently
      // stage reply content into an operator-less room. Drop the message
      // with an audit trail instead.
      log.warn('a2a reply dropped: source session no longer exists', {
        msgId: msg.id,
        recipientSessionId: session.id,
        sourceSessionId: sourceHint.source_session_id,
        sourceAgentGroupId: sourceHint.source_agent_group_id,
        sourceThreadId: sourceHint.source_thread_id,
      });
      return;
    }

    const a2aReplyId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const forwardedReplyContent = forwardFileAttachments(
      msg,
      a2aReplyId,
      session,
      originalSourceSession.agent_group_id,
      originalSourceSession.id,
    );
    writeSessionMessage(originalSourceSession.agent_group_id, originalSourceSession.id, {
      id: a2aReplyId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: sourceHint.source_thread_id,
      content: forwardedReplyContent,
    });
    log.info('Agent reply routed back to source session', {
      from: session.agent_group_id,
      recipientSessionId: session.id,
      to: originalSourceSession.agent_group_id,
      targetSession: originalSourceSession.id,
      threadId: sourceHint.source_thread_id,
      a2aMsgId: a2aReplyId,
      forwardedFileCount: countForwardedFiles(forwardedReplyContent),
    });
    const freshSource = getSession(originalSourceSession.id);
    if (freshSource) await wakeContainer(freshSource);
    return;
  }

  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }

  // Session resolution (fresh delegation path):
  //  - thread_id present → per-thread session keyed on (recipient,
  //    agent:<source>:<recipient> mg, thread_id). Each unique
  //    (source, thread) pair starts its own isolated recipient session
  //    so two sources picking the same thread_id don't merge.
  //  - thread_id null/empty → agent-shared (the original behaviour; every
  //    unthreaded a2a message funnels into one recipient session). This
  //    preserves back-compat for pre-threading installs.
  const threadId = msg.thread_id && msg.thread_id.trim() !== '' ? msg.thread_id : null;
  let targetSession;
  if (threadId) {
    const a2aMgId = ensureA2aWiring(targetAgentGroupId, session.agent_group_id);
    const { session: s } = resolveSession(targetAgentGroupId, a2aMgId, threadId, 'per-thread');
    targetSession = s;
  } else {
    const { session: s } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
    targetSession = s;
  }

  // Stamp the route-back hint so the recipient's reply can find its way
  // home. Covers both per-thread and agent-shared paths — even shared
  // sessions benefit from the reply-detection branch above, so long as
  // only one source is active at a time against that recipient.
  recordSource({
    recipientSessionId: targetSession.id,
    recipientAgentGroupId: targetAgentGroupId,
    recipientThreadId: threadId,
    sourceSessionId: session.id,
    sourceAgentGroupId: session.agent_group_id,
    sourceThreadId: threadId,
  });

  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId,
    content: forwardedContent,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    threadId,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
