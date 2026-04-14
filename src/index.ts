import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CONTAINER_PREFIX,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  MCP_PROXY_PORT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  discoverTools,
  setUpstreamPortResolver,
  startMcpAuthProxy,
} from './mcp-auth-proxy.js';
import {
  getRunningServerNames,
  getServerUpstreamPort,
  startMcpServers,
} from './mcp-registry.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureAgentNetwork,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Tracks optimistic cursor for piped messages — only committed to
// lastAgentTimestamp when the container actually responds.
const pipedCursor: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    async (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
      // Auto-assign all secrets to new agents so they have API access.
      // Agents default to secretMode=selective with no secrets — without this,
      // new coworkers spawned by the main agent would get 401 errors.
      if (res.created) {
        try {
          // Fetch all secrets and the new agent's ID
          const [secretsRes, agentsRes] = await Promise.all([
            fetch(`${ONECLI_URL}/api/secrets`),
            fetch(`${ONECLI_URL}/api/agents`),
          ]);
          const secrets = (await secretsRes.json()) as { id: string }[];
          const agents = (await agentsRes.json()) as {
            id: string;
            identifier: string;
          }[];
          const agent = agents.find((a) => a.identifier === identifier);
          if (agent && secrets.length > 0) {
            const secretIds = secrets.map((s) => s.id);
            await fetch(`${ONECLI_URL}/api/agents/${agent.id}/secrets`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ secretIds }),
            });
            logger.info(
              { identifier, secretCount: secretIds.length },
              'OneCLI secrets assigned to new agent',
            );
          }
        } catch (err) {
          logger.debug(
            { identifier, err: String(err) },
            'OneCLI secret assignment skipped',
          );
        }
      }
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

// Cached trigger patterns for multi-trigger routing (coworker @mentions)
let coworkerTriggers: {
  jid: string;
  pattern: RegExp;
  group: RegisteredGroup;
}[] = [];

// Maps coworker JID → original source JID for echo-back (e.g. dashboard:slang-cuda → tg:12345)
const routeEchoMap = new Map<string, string>();
const ROUTE_ECHO_MAP_MAX = 200;
function setRouteEcho(cwJid: string, sourceJid: string): void {
  if (routeEchoMap.size >= ROUTE_ECHO_MAP_MAX) {
    // Evict oldest entry (first key in insertion order)
    const oldest = routeEchoMap.keys().next().value;
    if (oldest) routeEchoMap.delete(oldest);
  }
  routeEchoMap.set(cwJid, sourceJid);
}

function rebuildCoworkerTriggers(): void {
  coworkerTriggers = [];
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.isMain) continue; // don't match main against itself
    if (!group.trigger) continue;
    try {
      const escaped = group.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      coworkerTriggers.push({ jid, pattern: new RegExp(escaped, 'i'), group });
    } catch {
      // Invalid pattern — skip
    }
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  rebuildCoworkerTriggers();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  rebuildCoworkerTriggers();

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // CLAUDE.md is composed by the IPC register_group handler (for new groups)
  // or by container-runner.ts at container startup (for typed coworkers).
  // We don't create it here to avoid racing with manifest-based composition.

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
  rebuildCoworkerTriggers();
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        // Echo-back: if this coworker was triggered from another channel (e.g. Telegram),
        // forward the reply there too so the user sees it in the original chat.
        const echoJid = routeEchoMap.get(chatJid);
        if (echoJid) {
          const echoChannel = findChannel(channels, echoJid);
          if (echoChannel) {
            const prefix = `[${group.name}] `;
            await echoChannel
              .sendMessage(echoJid, prefix + text)
              .catch((err) =>
                logger.warn(
                  { echoJid, err },
                  'Failed to echo-back to source channel',
                ),
              );
          }
        }
        outputSentToUser = true;
        // Store agent reply in DB so dashboard can display it
        storeMessage({
          id: `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'assistant',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
      // Commit piped cursor — the container actually processed piped messages
      if (pipedCursor[chatJid]) {
        lastAgentTimestamp[chatJid] = pipedCursor[chatJid];
        delete pipedCursor[chatJid];
        saveState();
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Clear uncommitted piped cursor — if the container exited without
  // responding to piped messages, lastAgentTimestamp still points before
  // them so they'll be retried on the next container run.
  delete pipedCursor[chatJid];

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Spawn a container in interactive mode — session loaded, no initial query.
 * The container enters IPC polling immediately, ready for follow-up messages.
 */
async function spawnInteractiveContainer(
  group: RegisteredGroup,
  chatJid: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: '',
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        interactive: true,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.result) {
          const raw =
            typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            const channel = findChannel(channels, chatJid);
            if (channel) await channel.sendMessage(chatJid, text);
            storeMessage({
              id: `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              chat_jid: chatJid,
              sender: 'assistant',
              sender_name: ASSISTANT_NAME,
              content: text,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            });
          }
        }
        if (output.status === 'success') {
          queue.notifyIdle(chatJid);
        }
      },
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );
      if (isStaleSession) {
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
      logger.error(
        { group: group.name, error: output.error },
        'Interactive container error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Interactive container error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  let lastHeartbeat = Date.now();
  const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes

  while (true) {
    // Periodic heartbeat so "alive but blind" states are visible in logs
    if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      const groupCount = Object.keys(registeredGroups).length;
      logger.info(
        { groupCount, activeContainers: queue.getActiveCount() },
        'Heartbeat: message loop alive',
      );
      lastHeartbeat = Date.now();
    }
    try {
      // Reload registered groups from DB so externally-added groups
      // (e.g. from the dashboard process) are picked up without restart.
      const freshGroups = getAllRegisteredGroups();
      const freshJids = Object.keys(freshGroups);
      const staleJids = Object.keys(registeredGroups);
      if (
        freshJids.length !== staleJids.length ||
        freshJids.some((j) => !registeredGroups[j])
      ) {
        registeredGroups = freshGroups;
        rebuildCoworkerTriggers();
        const added = freshJids.filter((j) => !staleJids.includes(j));
        if (added.length > 0) {
          logger.info({ added }, 'Picked up new groups from DB');
          for (const jid of added) {
            ensureOneCLIAgent(jid, freshGroups[jid]);
          }
        }
      }

      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // Multi-trigger routing: when a message in the main chat contains
          // @CoworkerName, re-route it to that coworker's group instead.
          if (isMainGroup && coworkerTriggers.length > 0) {
            const routedMessages: Set<string> = new Set();
            for (const msg of groupMessages) {
              if (msg.is_bot_message || msg.is_from_me) continue;
              for (const {
                jid: cwJid,
                pattern,
                group: cwGroup,
              } of coworkerTriggers) {
                if (pattern.test(msg.content)) {
                  // Re-store message under coworker's JID
                  storeMessage({
                    ...msg,
                    id: `route-${msg.id}`,
                    chat_jid: cwJid,
                  });
                  // Enqueue the coworker or pipe to its active container
                  const cwChannel = findChannel(channels, cwJid);
                  if (cwChannel) {
                    const cwPending = getMessagesSince(
                      cwJid,
                      lastAgentTimestamp[cwJid] || '',
                      ASSISTANT_NAME,
                    );
                    const cwFormatted = formatMessages(
                      cwPending.length > 0
                        ? cwPending
                        : [{ ...msg, chat_jid: cwJid }],
                      TIMEZONE,
                    );
                    if (!queue.sendMessage(cwJid, cwFormatted)) {
                      queue.enqueueMessageCheck(cwJid);
                    }
                  }
                  routedMessages.add(msg.id);
                  // Track source JID for echo-back (so coworker replies go back to Telegram)
                  setRouteEcho(cwJid, chatJid);
                  logger.info(
                    { from: chatJid, to: cwJid, trigger: cwGroup.trigger },
                    'Multi-trigger: routed message to coworker',
                  );
                  break; // first match wins
                }
              }
            }
            // If all messages were routed to coworkers, skip main processing
            if (
              routedMessages.size > 0 &&
              groupMessages.every(
                (m) =>
                  routedMessages.has(m.id) || m.is_bot_message || m.is_from_me,
              )
            ) {
              continue;
            }
          }

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since the latest cursor (piped or committed)
          // so non-trigger context that accumulated between triggers is included.
          const effectiveCursor =
            pipedCursor[chatJid] || lastAgentTimestamp[chatJid] || '';
          const allPending = getMessagesSince(
            chatJid,
            effectiveCursor,
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Only advance the optimistic piped cursor — lastAgentTimestamp
            // stays put until the container actually responds, so if the
            // container dies the messages are retried on the next run.
            pipedCursor[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }

        // Advance cursor only after all messages have been dispatched
        lastTimestamp = newTimestamp;
        saveState();
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  ensureAgentNetwork();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Start MCP server stack:
  // 1. Registry auto-detects servers from container/mcp-servers/
  // 2. Each server gets a supergateway on loopback (unreachable from containers)
  // 3. Auth proxy binds to bridge IP with path-based routing (/mcp/<server>)
  const MCP_INTERNAL_BASE_PORT = MCP_PROXY_PORT + 100;
  const mcpServers = await startMcpServers(MCP_INTERNAL_BASE_PORT);
  const mcpAuthProxy = startMcpAuthProxy(PROXY_BIND_HOST, MCP_PROXY_PORT);

  // Connect auth proxy to registry for path-based routing
  setUpstreamPortResolver((serverName) => {
    if (serverName) return getServerUpstreamPort(serverName);
    // Backwards compat: no server name → use first registered server
    const names = getRunningServerNames();
    return names.length > 0 ? getServerUpstreamPort(names[0]) : null;
  });

  // Discover tools from each running MCP server
  for (const name of getRunningServerNames()) {
    const port = getServerUpstreamPort(name);
    if (port) await discoverTools(name, port);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    mcpServers.stop();
    mcpAuthProxy.stop();
    // Stop all running nanoclaw containers so systemd doesn't have to SIGKILL them
    try {
      const names = execSync(
        `docker ps --filter name=${CONTAINER_PREFIX}- --format '{{.Names}}'`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (names) {
        const containers = names.split('\n').filter(Boolean);
        logger.info(
          { count: containers.length },
          'Stopping containers on shutdown',
        );
        execFileSync('docker', ['stop', ...containers], { timeout: 30000 });
      }
    } catch {
      // Best effort — containers will be cleaned up by --rm on exit
    }
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    spawnInteractive: async (jid: string) => {
      const group = registeredGroups[jid];
      if (!group) return false;
      return queue.spawnInteractive(jid, async () => {
        const result = await spawnInteractiveContainer(group, jid);
        return result === 'success';
      });
    },
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
