/**
 * Poll outbound mailboxes and deliver undelivered messages through channel adapters.
 * SQLite reads runner-owned outbound state read-only and records delivery in
 * host-owned inbound state; other implementations preserve that ownership.
 */
import {
  getRunningSessions,
  getActiveSessions,
  getSession,
  createPendingQuestion,
  isTaskThread,
  TASKS_SYSTEM_THREAD_ID,
} from './db/sessions.js';
import { appendRunLog } from './modules/scheduling/run-log.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from './db/messaging-groups.js';
import { clearDeliveryAttempt, recordDeliveryAttempt } from './db/coordination.js';
import { runGuarded, type DeliveryGuardSpec, type GuardedDeliveryHandler } from './delivery-guard.js';
import { isUnguarded, unguarded, type Unguarded } from './guard/index.js';
import { fanOutboundMessage } from './modules/cross-session-context/index.js';
import { pickApprover, pickApprovalDelivery } from './modules/approvals/primitive.js';
import { getEpisode as getCostEpisode } from './db/cost-escalation-episodes.js';
import { ingestCostEscalation, requestCostDecisionCard } from './modules/cost-approval/index.js';
import {
  ingestCostCeilingAdjustmentReceipt,
  ingestCostReconcileReceipt,
} from './modules/cost-ceiling-adjustment/index.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, readOutboxFiles, withExistingMailboxSession } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { PendingApproval, Session } from './types.js';
import type { OutboundMessage } from './mailbox/index.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Attempt counts live in the `delivery_attempts` table, so they survive a
 * host restart: a poison message gets MAX_DELIVERY_ATTEMPTS total, not
 * MAX_DELIVERY_ATTEMPTS per process lifetime (the old in-memory counter
 * reset on every restart, so a crash-looping host retried it forever).
 * Bookkeeping failures must never break delivery: a failed record skips the
 * give-up decision for this tick (the message just retries next poll), and a
 * failed clear leaves a stale row the next lifecycle of the same id clears.
 */
async function recordAttemptRow(messageId: string, sessionId: string, err: unknown): Promise<number | null> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    return await recordDeliveryAttempt({
      messageId,
      sessionId,
      now: new Date().toISOString(),
      nextAttemptAt: null,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (recordErr) {
    log.error('Failed to record delivery attempt — retrying next poll without a count', {
      messageId,
      sessionId,
      err: recordErr,
    });
    return null;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function clearAttemptRow(messageId: string): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    await clearDeliveryAttempt(messageId);
  } catch (err) {
    log.warn('Failed to clear delivery attempt row', { messageId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

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
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
  ): Promise<string | undefined>;
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
    statusKind?: 'auto' | 'agent',
  ): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  void pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  void pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = await getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(() => void pollActive(), ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(() => void pollSweep(), SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  // Read the queue in one short mailbox session, then deliver with NO
  // session held open: delivery handlers (agent-to-agent routing, approval
  // notifications, cli_request → dispatch) open their own sessions on this
  // same key, and implementations may serialize session() per key — holding
  // the session across delivery would deadlock them. Same re-entry class the
  // reconciler avoids around requestWake (see reconcile-session.ts).
  let delivered: Set<string>;
  let pending: OutboundMessage[];
  try {
    const existing = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => {
      const delivered = mailbox.getDeliveredIds();
      return {
        delivered,
        pending: mailbox.getDueMessages(delivered).filter((candidate) => !delivered.has(candidate.id)),
      };
    });
    if (!existing) return;
    ({ delivered, pending } = existing);
  } catch (err) {
    log.error('Session mailbox delivery failed', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      err,
    });
    return;
  }

  for (const hook of batchPreviewHooks) {
    try {
      await hook(
        pending.map(({ kind, content }) => ({ kind, content })),
        session,
      );
    } catch (err) {
      log.warn('Delivery batch-preview hook failed', { sessionId: session.id, err });
    }
  }

  for (const msg of pending) {
    try {
      const platformMsgId = await deliverMessage(msg, session);
      await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) =>
        mailbox.markDelivered(msg.id, platformMsgId ?? null),
      );
      const firstDelivery = delivered.size === 0;
      delivered.add(msg.id);
      await clearAttemptRow(msg.id);
      if (msg.kind !== 'system' && msg.channelType !== 'agent') {
        pauseTypingRefreshAfterDelivery(session.id);
        if (msg.kind !== 'task_log') {
          await fanOutboundMessage(
            {
              id: msg.id,
              kind: msg.kind,
              platform_id: msg.platformId,
              channel_type: msg.channelType,
              content: msg.content,
            },
            session,
            agentGroup,
          );
          for (const hook of postDeliveryHooks) {
            try {
              await hook(msg, session, { firstDelivery });
            } catch (err) {
              log.warn('Post-delivery hook failed', { messageId: msg.id, sessionId: session.id, err });
            }
          }
        }
      }
    } catch (err) {
      const attempts = await recordAttemptRow(msg.id, session.id, err);
      if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS) {
        log.error('Message delivery failed permanently, giving up', {
          messageId: msg.id,
          sessionId: session.id,
          attempts,
          err,
        });
        try {
          await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => mailbox.markDeliveryFailed(msg.id));
          await clearAttemptRow(msg.id);
        } catch (markErr) {
          log.error('Failed to record permanent delivery failure', {
            messageId: msg.id,
            sessionId: session.id,
            err: markErr,
          });
        }
      } else {
        log.warn('Message delivery failed, will retry', {
          messageId: msg.id,
          sessionId: session.id,
          // null: the bookkeeping write itself failed; count unknown this tick.
          attempt: attempts,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
          err,
        });
      }
    }
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    inReplyTo: string | null;
  },
  session: Session,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (cli_request, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session);
    return;
  }

  // Task-run log: the runner mirrors a run's final text here (one-door
  // delivery — final text never reaches a channel; the send_message tool is
  // the only delivery path from a task session). Append to the series log,
  // never deliver. The caller marks it delivered so it isn't retried.
  if (msg.kind === 'task_log') {
    if (session.messaging_group_id === null && isTaskThread(session.thread_id) && session.thread_id) {
      const series = session.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length);
      try {
        await appendRunLog(session.agent_group_id, series, typeof content.text === 'string' ? content.text : '');
      } catch (err) {
        log.warn('Failed to append task run log', { id: msg.id, sessionId: session.id, err });
      }
    } else {
      log.warn('task_log row outside a task session — ignoring', { id: msg.id, sessionId: session.id });
    }
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channelType === 'agent') {
    if (!(await hasTable(getDb(), 'agent_destinations'))) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    // `target_session_id` rides along inside the content body (no schema
    // migration needed — the field is read only by the routing layer and
    // is not surfaced to the recipient agent). Pluck it here so the
    // routing layer treats it as a first-class field on the message.
    const targetSessionId =
      typeof content.target_session_id === 'string' && content.target_session_id.trim() !== ''
        ? content.target_session_id.trim()
        : null;
    await routeAgentMessage(
      {
        id: msg.id,
        platform_id: msg.platformId,
        thread_id: msg.threadId,
        content: msg.content,
        in_reply_to: msg.inReplyTo,
        target_session_id: targetSessionId,
      },
      session,
    );
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  if (msg.channelType && msg.platformId) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // prefer the sender's own destination-mapped instance (correct even when
    // sibling instances share the same channel address), falling back to the
    // by-platform lookup (default-instance-first) when the sender has no
    // matching destination.
    const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channelType && originMg.platform_id === msg.platformId
        ? originMg
        : ((await getMessagingGroupForOwnDestination(session.agent_group_id, msg.channelType, msg.platformId)) ??
          (await getMessagingGroupByPlatform(msg.channelType, msg.platformId)));
    if (!mg) {
      // GitHub arrives as host-injected webhooks with no messaging group
      // (see webhook-github.ts) and has no outbound *chat* channel — a coworker
      // posts back to GitHub through the github MCP tools / gh CLI, never
      // through host delivery. So a channel_type='github' outbound is a
      // status/report that inherited the github-origin thread and has no
      // deliverable destination; the real GitHub write (comment, PR) already
      // happened via its own tool call. Consume it as an observable no-op
      // rather than throwing into the 3× retry → 'failed' path, which only
      // produced permanently-failed rows and error-log noise (there is no
      // github channel-delivery path to regress).
      if (msg.channelType === 'github') {
        log.warn('github outbound has no delivery channel — consuming status message as no-op', {
          messageId: msg.id,
          platformId: msg.platformId,
          sessionId: session.id,
        });
        return;
      }
      throw new Error(`unknown messaging group for ${msg.channelType}/${msg.platformId} (message ${msg.id})`);
    }
    if (mg.detached_at) {
      // The bot was removed from this conversation (a channel membership
      // module stamps detached_at when the bot leaves). Fail into the retry
      // path rather than sending into a channel that will reject us; rejoin
      // clears the stamp.
      throw new Error(
        `messaging group ${mg.id} is detached (bot removed from ${mg.channel_type}/${mg.platform_id} at ${mg.detached_at})`,
      );
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && (await hasTable(getDb(), 'agent_destinations'))) {
      const row = await getDb().get(
        'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        session.agent_group_id,
        'channel',
        mg.id,
      );
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
    deliverInstance = mg.instance;
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && (await hasTable(getDb(), 'pending_questions'))) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = await createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platformId,
        channel_type: msg.channelType,
        thread_id: msg.threadId,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channelType || !msg.platformId) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channelType,
    msg.platformId,
    msg.threadId,
    msg.kind,
    msg.content,
    files,
    deliverInstance,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channelType,
    platformId: msg.platformId,
    platformMsgId,
    fileCount: files?.length,
  });

  // Dashboard reads attachment files directly from the session outbox, so those
  // files must persist after delivery instead of being treated as transport-only.
  if (!shouldRetainOutboxFiles(msg.channelType, files)) {
    clearOutbox(session.agent_group_id, session.id, msg.id);
  }

  // Cross-coworker dashboard message: the sender routed to another agent's
  // dashboard messaging group (e.g. NeuralGraphics → dashboard:orchestrator).
  // The adapter delivered it (marks the outbound as delivered), but the
  // recipient agent never sees it because the dashboard adapter is outbound-only.
  // Write the message into the recipient's session inbound so (a) the agent
  // can process it and (b) the dashboard shows it in the recipient's chat.
  // File attachments are copied from sender's outbox to recipient's inbox.
  if (msg.channelType === 'dashboard' && msg.platformId) {
    const mg = await getMessagingGroupByPlatform(msg.channelType, msg.platformId);
    if (mg) {
      // The dashboard MG platform_id is "dashboard:<folder>". The owner is the
      // agent group whose folder matches. Only forward to the owner — other
      // agents wired to this MG (e.g. via shared admin group) are bystanders.
      const ownerFolder = mg.platform_id.replace(/^dashboard:/, '');
      const { getAgentGroupByFolder } = await import('./db/agent-groups.js');
      const ownerAg = ownerFolder ? await getAgentGroupByFolder(ownerFolder) : null;
      if (ownerAg && ownerAg.id !== session.agent_group_id) {
        try {
          // Find the recipient session that originally delegated TO the
          // sender. a2a_session_sources maps (source_session → recipient_session)
          // where source is the delegator and recipient is the delegate.
          // We want the reverse: sender (delegate) → find the source session
          // (delegator) so the reply lands in the same thread.
          const { resolveSession } = await import('./session-manager.js');
          let crossThreadId = msg.threadId || null;
          if (!crossThreadId && (await hasTable(getDb(), 'a2a_session_sources'))) {
            const sourceRow = await getDb().get<{ source_session_id: string; thread_id: string | null }>(
              `SELECT ssr.source_session_id, s.thread_id
                 FROM a2a_session_sources ssr
                 JOIN sessions s ON s.id = ssr.source_session_id
                 WHERE ssr.source_agent_group_id = ? AND ssr.recipient_agent_group_id = ?
                   AND s.thread_id IS NOT NULL AND s.status = 'active'
                 ORDER BY ssr.created_at DESC LIMIT 1`,
              ownerAg.id,
              session.agent_group_id,
            );
            if (sourceRow?.thread_id) crossThreadId = sourceRow.thread_id;
          }
          const { session: recipientSession } = await resolveSession(
            ownerAg.id,
            mg.id,
            crossThreadId,
            crossThreadId ? 'per-thread' : 'shared',
          );
          const crossId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const forwardedContent = msg.content;
          if (Array.isArray(content.files) && content.files.length > 0) {
            try {
              const { forwardAttachedFiles } = await import('./modules/agent-to-agent/agent-route.js');
              forwardAttachedFiles(
                {
                  agentGroupId: session.agent_group_id,
                  sessionId: session.id,
                  messageId: msg.id,
                  filenames: content.files as string[],
                },
                { agentGroupId: ownerAg.id, sessionId: recipientSession.id, messageId: crossId },
              );
            } catch {
              /* a2a module may not be installed */
            }
          }
          const { writeSessionMessage } = await import('./session-manager.js');
          await writeSessionMessage(ownerAg.id, recipientSession.id, {
            id: crossId,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            platformId: session.agent_group_id,
            channelType: 'agent',
            threadId: crossThreadId,
            content: forwardedContent,
          });
          const recipientFresh = await getSession(recipientSession.id);
          if (recipientFresh) {
            const { wakeContainer } = await import('./container-runner.js');
            wakeContainer(recipientFresh).catch(() => {});
          }
          log.info('Cross-coworker dashboard message forwarded', {
            from: session.agent_group_id,
            to: ownerAg.id,
            recipientSession: recipientSession.id,
            crossThreadId,
            crossId,
          });
        } catch (err) {
          log.warn('Failed to forward cross-coworker dashboard message', {
            from: session.agent_group_id,
            to: ownerAg.id,
            err,
          });
        }
      }
    }
  }

  return platformMsgId;
}

/**
 * Post-delivery hooks.
 *
 * Registered modules observe each successfully delivered user-facing
 * message (non-system, non-agent, non-task_log) right after it is marked
 * delivered, with a first-delivery flag. This gives channel modules a
 * supported seam for one-time follow-through on a session's first outbound
 * message (e.g. onboarding affordances) without hardcoding platform
 * behavior in the delivery core.
 *
 * Hooks are decoration only: each invocation is wrapped in try/catch, so a
 * failing hook can never affect delivery, markDelivered, or retries.
 */
export interface PostDeliveryInfo {
  /**
   * True when this is the first message ever marked delivered in this
   * session — exactly one row per session carries it. Every delivered row
   * counts toward the flag (including system rows the hook itself never
   * fires for); the hook only ever observes user-facing rows.
   */
  firstDelivery: boolean;
}

export type PostDeliveryHook = (msg: OutboundMessage, session: Session, info: PostDeliveryInfo) => void | Promise<void>;

const postDeliveryHooks: PostDeliveryHook[] = [];

export function registerPostDeliveryHook(hook: PostDeliveryHook): void {
  postDeliveryHooks.push(hook);
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Unknown actions log "Unknown system action".
 *
 * Privileged delivery actions (create_agent, install_packages,
 * add_mcp_server) register with a guard spec: every path to the handler body
 * — dispatch, approved replay, test lookup — goes through the guard consult
 * (allow / hold / deny), so there is no unguarded route to it. On approve,
 * the continuation re-enters the same entry carrying the approval row as its
 * grant (`reenterGuardedDeliveryAction`), so the structural checks are
 * re-run live. Plain actions (the cli_request bridge — its inner
 * commands are guarded at dispatch) register with an
 * explicit `unguarded(<reason>)` declaration instead of a spec — omission is
 * not representable, so the decision to run unguarded is visible, and
 * justified, at the registration site.
 */
/**
 * Handlers run with NO mailbox session held — they (and anything they call,
 * e.g. writeSessionMessage or dispatch) open their own sessions. Never
 * accept or capture an open MailboxSession here: implementations may
 * serialize session() per key, and a held session would deadlock them.
 */
export type DeliveryActionHandler = (content: Record<string, unknown>, session: Session) => Promise<void>;

type DeliveryEntry =
  | { guard: Unguarded; handler: DeliveryActionHandler }
  | { guard: DeliveryGuardSpec; handler: GuardedDeliveryHandler };

const deliveryActions = new Map<string, DeliveryEntry>();

function isUnguardedEntry(entry: DeliveryEntry): entry is Extract<DeliveryEntry, { guard: Unguarded }> {
  return isUnguarded(entry.guard);
}

/** See the batch-preview invocation in the delivery poll for semantics. */
type DeliveryBatchPreviewHook = (
  batch: Array<{ kind: string; content: string }>,
  session: Session,
) => void | Promise<void>;
const batchPreviewHooks: DeliveryBatchPreviewHook[] = [];
export function registerDeliveryBatchPreview(hook: DeliveryBatchPreviewHook): void {
  batchPreviewHooks.push(hook);
}

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler, unguardedDecl: Unguarded): void;
export function registerDeliveryAction(action: string, handler: GuardedDeliveryHandler, spec: DeliveryGuardSpec): void;
export function registerDeliveryAction(
  action: string,
  handler: DeliveryActionHandler | GuardedDeliveryHandler,
  guardDecl: DeliveryGuardSpec | Unguarded,
): void {
  const existing = deliveryActions.get(action);
  if (existing) {
    // Replacing a guard-wrapped action with an unguarded handler would
    // disarm the guard while its catalog entry still exists — refuse. A
    // skill that wants to extend a guarded action must compose at the
    // module's exported functions instead, or re-register with a guard spec
    // of its own.
    if (isUnguarded(guardDecl) && !isUnguardedEntry(existing)) {
      throw new Error(
        `delivery action "${action}" is guard-wrapped; re-registering it without a guard spec would disarm the guard`,
      );
    }
    log.warn('Delivery action handler overwritten', { action });
  }
  // The overloads pair each handler shape with its declaration; the merged
  // implementation signature erases that pairing, hence the one cast.
  deliveryActions.set(action, { guard: guardDecl, handler } as DeliveryEntry);
}

/**
 * Approve continuation for a guard-wrapped delivery action: re-enter the
 * entry with the approval row as the grant. The guard treats the grant as
 * hold-satisfied but re-runs the structural checks, so approve-then-revoke
 * does not execute. Domains register this as their approval handler in the
 * same line that registers the action.
 */
export function reenterGuardedDeliveryAction(action: string) {
  return async (ctx: { session: Session; payload: Record<string, unknown>; approval: PendingApproval }) => {
    const entry = deliveryActions.get(action);
    if (!entry || isUnguardedEntry(entry)) {
      log.warn('Approved replay for an action that is not guard-wrapped — dropping', { action });
      return;
    }
    await runGuarded(action, entry.guard, entry.handler, ctx.payload, ctx.session, ctx.approval);
  };
}

/**
 * How a registered action is guarded, as declared at registration.
 *
 * Exists so the built-in MCP tools' gate inventory can be ASSERTED rather than
 * described. `docs/mcp-allowlist.md` claims each built-in answers to its own
 * gate; that claim is what justifies keeping them out of the allow-list, so it
 * is checked by a test (`src/builtin-mcp-gates.test.ts`) instead of being
 * re-verified by hand whenever someone adds an action.
 */
export function describeDeliveryActionGuard(
  action: string,
): { registered: false } | { registered: true; guarded: true } | { registered: true; guarded: false; reason: string } {
  const entry = deliveryActions.get(action);
  if (!entry) return { registered: false };
  if (isUnguardedEntry(entry)) return { registered: true, guarded: false, reason: entry.guard.reason };
  return { registered: true, guarded: true };
}

/**
 * The invocable for a registered action — the raw handler for unguarded
 * entries, the guard-consulting path for guarded ones. Dispatch and tests
 * both come through here; there is no route around the guard.
 */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  const entry = deliveryActions.get(action);
  if (!entry) return undefined;
  if (isUnguardedEntry(entry)) return entry.handler;
  return (content, session) => runGuarded(action, entry.guard, entry.handler, content, session, null);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 *
 * Reachable from tests via `__testHooks` — the MCP allow-list gate below has to
 * be exercised at the boundary it defends, not only as a predicate.
 */
async function handleSystemAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = getDeliveryAction(action);
  if (registered) {
    await registered(content, session);
    return;
  }

  log.warn('Unknown system action', { action });
}

/**
 * Cost-cap escalation (NanoClaw #1, v2 two-window). The runner fires a
 * kind:'system' outbound row
 * `{action:'cost_escalation', sessionId, spentUsd, capUsd, immortal, window}`
 * when a session's spend crosses its cap. This host action resolves a human
 * approver (scoped admin → global admin → owner, via the same primitive the
 * OneCLI approval bridge uses) and DMs them the decision card, branching on the
 * window:
 *   - lifetime (non-immortal): a per-run cap with Continue / Stop choices.
 *   - daily (immortal): a per-day visibility bound — Continue only; immortal
 *     sessions are never stopped, so the DM itself IS the bound (once/day).
 *
 * Unguarded: this is a HOST-initiated, read-only notification — it mutates no
 * central-DB state and grants the agent nothing. The privileged surface (the
 * override write-back) is the dashboard's authenticated cost-override endpoint,
 * not this handler.
 */
registerDeliveryAction(
  'cost_escalation',
  async (content, session) => {
    const spentUsd = Number(content.spentUsd);
    const capUsd = Number(content.capUsd);
    const immortal = content.immortal === true;

    // Ingest into the durable episode table (idempotent, fail-soft). Under S2 the
    // interactive card owns the notification — send it (prompt path) and skip the legacy
    // plain-text DM below; the host-sweep reconciler is the delivery backstop. Under S1
    // (flag OFF) this records an observation-era row and the DM still fires. A stale
    // runner emits no episodeId → ingest no-ops → DM fires (back-compat).
    const ingest = await ingestCostEscalation(content, session);
    if (ingest.cardOwnsNotification) {
      if (ingest.episodeId && ingest.isNew) {
        const ep = await getCostEpisode(ingest.episodeId);
        if (ep) await requestCostDecisionCard(session, ep);
      }
      return;
    }

    const approvers = await pickApprover(session.agent_group_id);
    if (approvers.length === 0) {
      log.warn('cost_escalation: no owner/admin to notify', { sessionId: session.id });
      return;
    }
    const originChannelType = session.messaging_group_id
      ? ((await getMessagingGroup(session.messaging_group_id))?.channel_type ?? '')
      : '';
    const target = await pickApprovalDelivery(approvers, originChannelType);
    if (!target) {
      log.warn('cost_escalation: no DM channel for any approver', { sessionId: session.id });
      return;
    }

    const group = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
    const spent = Number.isFinite(spentUsd) ? spentUsd.toFixed(2) : '?';
    const cap = Number.isFinite(capUsd) ? capUsd.toFixed(2) : '?';
    // Two DM shapes, branched on immortal/window. Whitespace is intentional —
    // these mirror the dashboard cost-cap cell so the two surfaces read alike.
    const text = immortal
      ? [
          '📊  Daily cost — orchestrator over p90/day  (visibility bound, ∞ never stopped)',
          `Group ${group}  ∞ immortal · Session ${session.id}  (per-DAY cap)`,
          `Spent $${spent} today  ›  cap $${cap}/day  (p90)`,
          "▶ Continue  raise today's cap",
          '(no Stop — immortal runs by design; this DM IS the bound; fires at most once/day)',
        ].join('\n')
      : [
          '⚠️  Cost cap — decision needed',
          `Group ${group} · Session ${session.id}  (per-run cap)`,
          `Spent $${spent}  ›  cap $${cap}  (p90)`,
          '▶ Continue  raise cap and resume',
          '■ Stop      finish this turn, take no new work',
        ].join('\n');

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.warn('cost_escalation: no delivery adapter set — skipping DM', { sessionId: session.id });
      return;
    }
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat',
        JSON.stringify({ text }),
      );
      log.info('cost_escalation delivered', {
        sessionId: session.id,
        approver: target.userId,
        spentUsd,
        capUsd,
        immortal,
      });
    } catch (err) {
      log.error('cost_escalation: DM delivery failed', { sessionId: session.id, err });
    }
  },
  unguarded('cost_escalation is a host-initiated read-only notification — no privileged mutation'),
);

/**
 * Live cost-ceiling-adjustment receipt (NanoClaw #1, "set ceiling v2"). The
 * runner fires a kind:'system' outbound row
 * `{action:'cost_ceiling_adjustment_result', adjustmentId, sessionId, outcome, ...}`
 * in the SAME outbound-DB transaction that persists any live-state change it
 * made — this host action is the counterpart that records the outcome in the
 * central ledger (`cost_ceiling_adjustments`), validating every echoed field
 * against the request the host itself created before accepting it as
 * authoritative.
 *
 * Unguarded: this is a HOST-initiated receipt reporting the outcome of a
 * request THIS host already validated and enqueued — it grants nothing new.
 * The privileged surface is the submission endpoint
 * (`POST /api/dashboard/session-cost-ceiling`, `src/modules/cost-ceiling-
 * adjustment/index.ts`), not this handler, which only ever records a
 * completion for a ledger row that already exists.
 */
registerDeliveryAction(
  'cost_ceiling_adjustment_result',
  async (content, session) => {
    await ingestCostCeilingAdjustmentReceipt(content, session);
  },
  unguarded(
    'cost_ceiling_adjustment_result is a host-initiated receipt for a request this host already authorized — no privileged mutation',
  ),
);

/**
 * `cost_reconcile` receipt (issue #1327) — the runner's confirmation of a
 * `cost_reconcile` control message (set live enforcement spend to the transcript
 * oracle). Same ledger + CAS as the set-ceiling receipt above; unguarded for the
 * same reason (a host-initiated receipt for a request THIS host already
 * authorized and enqueued — the privileged surface is `submitCostReconcile` /
 * `ncl cost-cap reconcile`, not this handler).
 */
registerDeliveryAction(
  'cost_reconcile_result',
  async (content, session) => {
    await ingestCostReconcileReceipt(content, session);
  },
  unguarded(
    'cost_reconcile_result is a host-initiated receipt for a request this host already authorized — no privileged mutation',
  ),
);

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}

export const __testHooks = {
  handleSystemAction,
};
