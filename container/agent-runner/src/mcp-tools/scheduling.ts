/**
 * Scheduling MCP tools: schedule_task, list_tasks, cancel_task, pause_task, resume_task.
 *
 * With the two-DB split, the container cannot write to inbound.db (host-owned).
 * Scheduling operations are sent as system actions via messages_out — the host
 * reads them during delivery and applies the changes to inbound.db.
 */
import { getInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description:
      `Schedule a one-shot or recurring task. The user's timezone is declared in the <context timezone="..."/> header of your prompt — interpret the user's "9pm" etc. in that zone. Cron expressions are interpreted in the user's timezone too.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description:
            `ISO 8601 timestamp for the first run. Accepts either UTC (ending in "Z" or "+00:00") or a naive local timestamp (no offset) which is interpreted in the user's timezone (e.g. "2026-01-15T21:00:00" = 9pm user-local). Prefer naive local.`,
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" = weekdays at 9am user-local). Evaluated in the user\'s timezone.',
        },
        script: { type: 'string', description: 'Optional pre-agent script to run before processing' },
        new_session: {
          type: 'boolean',
          description:
            'Scheduled-task session policy. DEFAULT TRUE for all scheduled tasks — each fire runs in a fresh Claude session so heartbeat/cron conversations do not accumulate prior fires\' context (which drives repeated compactions and growing cache-creation tokens). Set to FALSE explicitly only for multi-fire workflows that rely on in-conversation memory across fires (rare — most state belongs in files on disk). Omit to take the default.',
        },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfterIn = args.processAfter as string;
    if (!prompt || !processAfterIn) return err('prompt and processAfter are required');

    let processAfter: string;
    try {
      const d = parseZonedToUtc(processAfterIn, TIMEZONE);
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
      processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${processAfterIn}`);
    }

    const id = generateId();
    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;
    // Tri-state: only persist an explicit boolean. Omission = default (true)
    // is applied by the poll-loop reader; storing nothing keeps the content
    // blob minimal and preserves "omitted means default" semantics across
    // future default changes.
    const newSessionField =
      args.new_session === true ? { new_session: true } : args.new_session === false ? { new_session: false } : {};

    // Write as a system action — host will insert into inbound.db.
    writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'schedule_task',
        taskId: id,
        prompt,
        script,
        processAfter,
        recurrence,
        ...newSessionField,
      }),
    });

    const sessionTag =
      args.new_session === true ? ' [new_session=true]' : args.new_session === false ? ' [new_session=false]' : '';
    log(
      `schedule_task: ${id} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''}${sessionTag}`,
    );
    return ok(
      `Task scheduled (id: ${id}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''}${sessionTag})`,
    );
  },
};

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description:
      'List scheduled tasks. Returns one row per series — the live (pending or paused) occurrence. The id shown is the series id, which is what update_task / cancel_task / pause_task / resume_task expect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending or paused (default: both)' },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    const db = getInboundDb();
    // One row per series — the live (pending or paused) occurrence. Recurring
    // tasks accumulate one completed row per firing plus one live follow-up;
    // exposing the whole pile to the agent is noisy and confuses task identity
    // ("which id do I cancel?"). The series_id is the stable handle.
    //
    // SQLite quirk: when MAX(seq) appears in the SELECT list of a GROUP BY
    // query, the bare columns take values from the row that contains that max
    // — that's how we pick "the latest live row per series" in one pass.
    let rows;
    if (status) {
      rows = db
        .prepare(
          `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
             FROM messages_in
            WHERE kind = 'task' AND status = ?
            GROUP BY series_id
            ORDER BY process_after ASC`,
        )
        .all(status);
    } else {
      rows = db
        .prepare(
          `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
             FROM messages_in
            WHERE kind = 'task' AND status IN ('pending', 'paused')
            GROUP BY series_id
            ORDER BY process_after ASC`,
        )
        .all();
    }

    if ((rows as unknown[]).length === 0) return ok('No tasks found.');

    const lines = (rows as Array<{ id: string; status: string; process_after: string | null; recurrence: string | null; content: string }>).map((r) => {
      const content = JSON.parse(r.content);
      const prompt = (content.prompt as string || '').slice(0, 80);
      return `- ${r.id} [${r.status}] at=${r.process_after || 'now'} ${r.recurrence ? `recur=${r.recurrence} ` : ''}→ ${prompt}`;
    });

    return ok(lines.join('\n'));
  },
};

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    // Write as a system action — host will update inbound.db
    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'cancel_task', taskId }),
    });

    log(`cancel_task: ${taskId}`);
    return ok(`Task cancellation requested: ${taskId}`);
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to pause' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'pause_task', taskId }),
    });

    log(`pause_task: ${taskId}`);
    return ok(`Task pause requested: ${taskId}`);
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to resume' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'resume_task', taskId }),
    });

    log(`resume_task: ${taskId}`);
    return ok(`Task resume requested: ${taskId}`);
  },
};

export const updateTask: McpToolDefinition = {
  tool: {
    name: 'update_task',
    description:
      'Update a scheduled task. Pass the series id from list_tasks. Any field omitted is left unchanged. Use this instead of cancel + reschedule when adjusting an existing task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Series id of the task to update (as shown by list_tasks)' },
        prompt: { type: 'string', description: 'New task prompt (optional)' },
        recurrence: {
          type: 'string',
          description: 'New cron expression (optional). Pass empty string to clear and make the task one-shot.',
        },
        processAfter: {
          type: 'string',
          description:
            `New ISO 8601 timestamp for the next run (optional). Accepts either UTC (ending in "Z" / "+00:00") or a naive local timestamp interpreted in the user's timezone.`,
        },
        script: {
          type: 'string',
          description: 'New pre-agent script (optional). Pass empty string to clear.',
        },
        new_session: {
          type: 'boolean',
          description:
            'Set or clear the new_session flag on the stored task content (optional). true: persist `new_session: true` explicitly. false: persist `new_session: false` as an opt-out (future fires resume the stored continuation). Omit to leave the current stored value unchanged. The system-wide default when no value is stored is true. See schedule_task docs for when to opt out.',
        },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const update: Record<string, unknown> = { taskId };
    if (typeof args.prompt === 'string') update.prompt = args.prompt;
    if (typeof args.processAfter === 'string') {
      try {
        const d = parseZonedToUtc(args.processAfter, TIMEZONE);
        if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${args.processAfter}`);
        update.processAfter = d.toISOString();
      } catch {
        return err(`invalid processAfter: ${args.processAfter}`);
      }
    }
    // Empty string clears recurrence/script; undefined leaves them as-is.
    if (typeof args.recurrence === 'string') update.recurrence = args.recurrence === '' ? null : args.recurrence;
    if (typeof args.script === 'string') update.script = args.script === '' ? null : args.script;
    if (args.new_session === true || args.new_session === false) update.new_session = args.new_session;

    if (Object.keys(update).length === 1) return err('at least one field to update is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'update_task', ...update }),
    });

    log(`update_task: ${taskId}`);
    return ok(`Task update requested: ${taskId}`);
  },
};

registerTools([scheduleTask, listTasks, updateTask, cancelTask, pauseTask, resumeTask]);
