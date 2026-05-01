import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  migrateLegacyContinuation,
  setContinuation,
} from './db/session-state.js';
import { formatMessages, extractRouting, categorizeMessage, isClearCommand, stripInternalTags, type RoutingContext } from './formatter.js';
import { classifyAndPrepend } from './intent-router-bridge.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const IDLE_END_MS = 600_000; // End stream after 600s with no SDK events (background subagents need longer)

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/**
 * True iff the message is a scheduled task that explicitly OPTS OUT of the
 * fresh-session default by setting `content.new_session === false`. The
 * default across the system is now fresh-session-on for recurring task
 * batches (see isNewSessionBatch); tasks that genuinely need the stored
 * continuation (chained workflows that carry state in conversation memory,
 * rather than in files) must opt out explicitly.
 *
 * Strict `=== false` matters — an absent key or `true` both participate in
 * the default; only an explicit `false` blocks it. Swallows malformed JSON
 * rather than throwing.
 */
export function taskOptsOutOfNewSession(m: { kind: string; content: string }): boolean {
  if (m.kind !== 'task') return false;
  try {
    return (JSON.parse(m.content) as Record<string, unknown>).new_session === false;
  } catch {
    return false;
  }
}

/**
 * Default-on fresh-session policy for recurring task batches:
 *   - Empty batch: false (defensive — no spurious fresh sessions).
 *   - Any chat in the batch: false (mixed batches preserve chat history).
 *   - All-tasks AND at least one opts out via `new_session: false`: false
 *     (safer to preserve continuity than drop it when any task asks).
 *   - All-tasks AND none opts out: true (the common heartbeat/cron case,
 *     now the default without any flag needing to be set).
 *
 * Historical note: PR #58 introduced opt-in (`new_session: true`); PR #106
 * fixed the follow-up-push bypass; empirical prod rollout (slang-discord-
 * support: $0.57 after flip vs $1.00 before, on 11 turns vs 3) confirmed
 * the delta is real enough to make opt-out the sane default.
 */
export function isNewSessionBatch(keep: Array<{ kind: string; content: string }>): boolean {
  return keep.length > 0 && keep.every((m) => m.kind === 'task') && !keep.some(taskOptsOutOfNewSession);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Scheduled tasks with new_session:true run in a fresh context so
    // heartbeat/cron history doesn't accumulate across runs. Only applies
    // when the entire batch is tasks (no chat messages mixed in) — mixed
    // batches default to the stored continuation so chat history is preserved.
    const newSessionBatch = isNewSessionBatch(keep);

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    let prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    // Non-native providers: run intent router on the initial prompt too.
    // Claude SDK fires UserPromptSubmit hooks natively; for Codex/OpenCode
    // we call the same bridge so workflow classification applies to every
    // user message regardless of provider.
    if (!config.provider.supportsNativeSlashCommands) {
      prompt = await classifyAndPrepend(prompt);
    }

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);
    if (newSessionBatch) log('new_session flag set — running task in fresh context');

    const query = config.provider.query({
      prompt,
      continuation: newSessionBatch ? undefined : continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName, newSessionBatch);
      // Don't overwrite the stored chat continuation with a task's ephemeral session.
      if (!newSessionBatch && result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * For non-native providers, resolve a slash command to its SKILL.md body.
 * Claude Code's SDK loads SKILL.md on demand via its Skill tool; for Codex
 * and other providers we inject the body directly into the prompt so the
 * agent gets the same information without needing to `cat` the file.
 */
function resolveSkillBody(command: string): string | null {
  const skillName = command.replace(/^\//, '').split(/\s/)[0];
  if (!skillName) return null;

  const workspaceAgent = process.env.WORKSPACE_AGENT || '/workspace/agent';
  const candidates = [
    path.join('/home/node/.claude/skills', skillName, 'SKILL.md'),
    // Additional dirs: cloned repos may put skills under the agent workspace.
    // existsSync guard keeps the poll loop alive if the dir is missing — e.g.
    // in local mode during a broken setup — instead of throwing on readdirSync.
    ...(fs.existsSync(workspaceAgent)
      ? fs.readdirSync(workspaceAgent).flatMap((dir) => {
          const p = path.join(workspaceAgent, dir, '.claude', 'skills', skillName, 'SKILL.md');
          return fs.existsSync(p) ? [p] : [];
        })
      : []),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      let body = fs.readFileSync(candidate, 'utf-8');
      // Strip YAML frontmatter
      body = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
      return body.trim();
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. For non-native providers, skill bodies are resolved and
 * injected so the agent gets the full SKILL.md content on invocation.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if ((msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        if (nativeSlashCommands) {
          // Flush normal batch first
          if (normalBatch.length > 0) {
            parts.push(formatMessages(normalBatch));
            normalBatch.length = 0;
          }
          // Pass raw command text (no XML wrapping) — SDK handles it natively
          parts.push(cmdInfo.text);
          continue;
        }

        // Non-native provider: resolve SKILL.md body and inject it
        if (cmdInfo.category === 'passthrough') {
          const body = resolveSkillBody(cmdInfo.command);
          if (body) {
            if (normalBatch.length > 0) {
              parts.push(formatMessages(normalBatch));
              normalBatch.length = 0;
            }
            const args = cmdInfo.text.slice(cmdInfo.command.length).trim();
            parts.push(
              `<skill-invocation name="${cmdInfo.command.slice(1)}"${args ? ` args="${args}"` : ''}>\n${body}\n</skill-invocation>`,
            );
            continue;
          }
        }
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  skipPersistContinuation = false,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let lastEventTime = Date.now();

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open is
  // strictly cheaper than close+reopen (no cold prompt cache, no reconnect).
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  const pollHandle = setInterval(async () => {
    if (done) return;

    // Skip system messages (MCP tool responses) and /clear (needs fresh query).
    // Thread routing is the router's concern — if a message landed in this
    // session, the agent should see it. Per-thread sessions already isolate
    // threads into separate containers; shared sessions intentionally merge
    // everything. Filtering on thread_id here caused deadlocks when the
    // initial batch and follow-ups had mismatched thread_ids (e.g. a
    // host-generated welcome trigger with null thread vs a Discord DM reply).
    const newMessages = getPendingMessages().filter((m) => {
      if (m.kind === 'system') return false;
      if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
      return true;
    });
    if (newMessages.length > 0) {
      // new_session bypass guard: if any arriving task defaults to fresh
      // session (a task kind with no `new_session: false` opt-out), DO NOT
      // push into the active query — that would resume the stored
      // continuation and defeat the default (the cost-growth-from-accumulated-
      // context problem PRs #58/#103/#106 were meant to solve).
      // Instead, end the active query; the next poll iteration's initial-batch
      // path will pick up the pending rows, `isNewSessionBatch` will return
      // true, and the provider.query call will run with continuation:
      // undefined.
      //
      // Without this guard, any heartbeat-style recurring task fires within
      // IDLE_END_MS (10 min) of each other and bypasses the default — making
      // new_session effectively a no-op for all realistic prod cadences.
      // Empirically reproduced on dev 2026-05-05 (see PR #106 description).
      //
      // We leave rows as 'pending' (no markProcessing/markCompleted) so the
      // next loop iteration re-reads them fresh.
      const wantsFreshSession = (m: { kind: string; content: string }) =>
        m.kind === 'task' && !taskOptsOutOfNewSession(m);
      if (newMessages.some(wantsFreshSession)) {
        log(
          `fresh-session task arrived mid-query (${newMessages.length} msg) — ending active query to route through fresh-session path`,
        );
        query.end();
        done = true;
        return;
      }

      // Update the shared routing when a follow-up brings richer routing
      // than the initial batch had. Common case: the initial batch was a
      // scheduled task (no channel/platform) and a chat arrives mid-turn —
      // we want the chat's reply to land back on that channel, not get
      // silently dropped because the initial routing was null. Prefer any
      // non-null channelType+platformId from the new batch; otherwise keep
      // the existing routing.
      const followUpRouting = extractRouting(newMessages);
      if (followUpRouting.channelType && followUpRouting.platformId) {
        if (!routing.channelType || !routing.platformId) {
          log(
            `Promoting routing from follow-up (${followUpRouting.channelType}:${followUpRouting.platformId}); initial routing was null`,
          );
        }
        routing = followUpRouting;
      }

      const newIds = newMessages.map((m) => m.id);
      markProcessing(newIds);

      const prompt = formatMessages(newMessages);
      // The SDK fires UserPromptSubmit (and the intent-router hook) only on
      // the initial query prompt. Mid-query pushes bypass the hook, so run
      // the router ourselves here so workflow classification is applied to
      // every user message — not just the first.
      const routedPrompt = await classifyAndPrepend(prompt);
      log(`Pushing ${newMessages.length} follow-up message(s) into active query`);
      query.push(routedPrompt);

      markCompleted(newIds);
      lastEventTime = Date.now(); // new input counts as activity
    }

    // End stream when agent is idle: no SDK events and no pending messages
    if (Date.now() - lastEventTime > IDLE_END_MS) {
      log(`No SDK events for ${IDLE_END_MS / 1000}s, ending query`);
      query.end();
    }
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      lastEventTime = Date.now();
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        if (!skipPersistContinuation) setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(`Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`);
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'usage':
      // Structured per-turn accounting. Grep-friendly: every field is a
      // bare keyword=value token, same line. Stable schema so downstream
      // tooling (ccusage / ad-hoc awk / the 2×2 stress-test harness)
      // can parse without JSON.
      log(
        `Usage: sessionId=${event.sessionId ?? 'null'} ` +
          `durationMs=${event.durationMs} ` +
          `numTurns=${event.numTurns} ` +
          `input=${event.inputTokens} ` +
          `output=${event.outputTokens} ` +
          `cacheCreate=${event.cacheCreationInputTokens} ` +
          `cacheRead=${event.cacheReadInputTokens} ` +
          `ephemeral1h=${event.ephemeral1hInputTokens} ` +
          `ephemeral5m=${event.ephemeral5mInputTokens} ` +
          `costUsd=${event.totalCostUsd}`,
      );
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  // Single-destination shortcut: the agent wrote plain text — send to
  // the session's originating channel (from session_routing) if available,
  // otherwise fall back to the single destination.
  if (sent === 0 && scratchpad) {
    if (routing.channelType && routing.platformId) {
      // Reply to the channel/thread the message came from
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Inherit thread_id from the inbound routing context so replies land in the
  // same thread the conversation is in. For non-threaded adapters the router
  // strips thread_id at ingest, so this will already be null.
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
