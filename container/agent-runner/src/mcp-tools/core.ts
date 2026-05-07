/**
 * Core MCP tools: send_message, send_file, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread.
 *
 * For cross-channel sends and agent-to-agent (a2a) destinations, the
 * sender's current `thread_id` auto-propagates so parallel delegations
 * don't collapse into one shared recipient session ("I'm working on
 * PR-A in my thread, reviewer gets a PR-A-scoped session; I delegate
 * PR-B in a different thread, reviewer gets a PR-B-scoped session").
 *
 * `explicitThreadId`, if provided by the caller, always wins — enables
 * fan-out (sender sends N distinct sub-delegations from one thread) and
 * fan-in (two sender-threads collapse into one recipient session).
 * Pass `null` or `undefined` to fall through to the auto-propagation
 * rules above.
 */
function resolveRouting(
  to: string | undefined,
  explicitThreadId: string | null,
):
  | { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string }
  | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: explicitThreadId ?? session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const sameChannel =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId;
    const threadId = explicitThreadId ?? (sameChannel ? session.thread_id : null);
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  // Agent-to-agent destination: auto-propagate sender's thread so each
  // sender-thread → one recipient-session. Explicit override wins for
  // fan-out / fan-in flows. Null → recipient's agent-shared root session
  // (back-compat with unthreaded installs).
  const session = getSessionRouting();
  const threadId = explicitThreadId ?? session.thread_id ?? null;
  return {
    channel_type: 'agent',
    platform_id: dest.agentGroupId!,
    thread_id: threadId,
    resolvedName: to,
  };
}

/** Normalise an optional thread_id tool argument. Matches the ingress
 *  contract: trim, empty → null, non-string → reject. */
function normalizeThreadIdArg(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'thread_id must be a string when provided' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 200) return { ok: false, error: 'thread_id too long (max 200 chars)' };
  return { ok: true, value: trimmed };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a message to a named destination. If you have only one destination, you can omit `to`. For threaded contexts, thread_id auto-propagates from the sender\'s current thread unless explicitly overridden.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.' },
        text: { type: 'string', description: 'Message content' },
        thread_id: {
          type: 'string',
          description:
            'Optional thread identifier. Defaults to the current session\'s thread_id so parallel delegations (e.g. one PR review per thread) stay isolated. Pass an explicit value for fan-out ("review-PR-A"), fan-in (shared id), or leave empty string / omit for auto.',
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');

    const threadIdArg = normalizeThreadIdArg(args.thread_id);
    if (!threadIdArg.ok) return err(threadIdArg.error);

    const routing = resolveRouting(args.to as string | undefined, threadIdArg.value);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}${routing.thread_id ? ` (thread=${routing.thread_id})` : ''}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
        thread_id: {
          type: 'string',
          description:
            'Optional thread identifier. Same semantics as send_message: auto-propagates from the sender\'s current thread unless explicitly set.',
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const threadIdArg = normalizeThreadIdArg(args.thread_id);
    if (!threadIdArg.ok) return err(threadIdArg.error);

    const routing = resolveRouting(args.to as string | undefined, threadIdArg.value);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, addReaction]);
