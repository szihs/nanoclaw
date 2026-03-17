/**
 * NanoClaw Dashboard Server
 *
 * Two-tab dashboard:
 *   Tab 1: Pixel Art Office — real-time interactive coworker visualization
 *   Tab 2: Timeline — all-time metrics, task history, analytics
 *
 * Reads NanoClaw state read-only (SQLite + IPC files + coworker-types.json).
 * Receives real-time hook events via POST /api/hook-event.
 */

import { createServer } from 'http';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve, extname } from 'path';
import Database from 'better-sqlite3';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = resolve(import.meta.dirname, 'public');
const DB_PATH = join(PROJECT_ROOT, 'store', 'messages.db');
const GROUPS_DIR = join(PROJECT_ROOT, 'groups');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const SKILLS_DIR = join(PROJECT_ROOT, 'container', 'skills');
const COWORKER_TYPES_PATH = join(GROUPS_DIR, 'coworker-types.json');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3737', 10);

// --- SQLite (read-only) ---

function openDb(): Database.Database | null {
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    console.warn(`[dashboard] Cannot open DB at ${DB_PATH} — running without DB`);
    return null;
  }
}

let db = openDb();

function openWriteDb(): Database.Database | null {
  try {
    return new Database(DB_PATH, { fileMustExist: true });
  } catch {
    return null;
  }
}

// --- State snapshot ---

interface CoworkerState {
  folder: string;
  name: string;
  type: string;
  description: string;
  status: 'idle' | 'working' | 'error' | 'thinking';
  currentTask: string | null;
  lastActivity: string | null;
  taskCount: number;
  color: string;
  // live hook data
  lastToolUse: string | null;
  lastNotification: string | null;
  hookTimestamp: number | null;
}

interface DashboardState {
  coworkers: CoworkerState[];
  tasks: any[];
  taskRunLogs: any[];
  registeredGroups: any[];
  hookEvents: HookEvent[];
  timestamp: number;
}

interface HookEvent {
  group: string;
  event: string;
  tool?: string;
  message?: string;
  tool_input?: string;
  tool_response?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  timestamp: number;
}

// Ring buffer for recent hook events
const hookEvents: HookEvent[] = [];
const MAX_HOOK_EVENTS = 200;

// Live status from hooks (group_folder -> latest state)
const liveHookState = new Map<string, { tool?: string; notification?: string; ts: number }>();

function getCoworkerTypes(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(COWORKER_TYPES_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

// Color palette for coworker types
const TYPE_COLORS: Record<string, string> = {
  'slang-base': '#5B8DEF',
  'slang-ir': '#3B82F6',
  'slang-frontend': '#10B981',
  'slang-cuda': '#F59E0B',
  'slang-optix': '#EF4444',
  'slang-langfeat': '#8B5CF6',
  'slang-docs': '#EC4899',
  'slang-coverage': '#14B8A6',
  'slang-test': '#F97316',
};

function getState(): DashboardState {
  const types = getCoworkerTypes();
  const coworkers: CoworkerState[] = [];

  // Scan groups/ for spawned instances (slang_* folders)
  try {
    const folders = readdirSync(GROUPS_DIR).filter(
      (f) => statSync(join(GROUPS_DIR, f)).isDirectory() && !f.startsWith('.'),
    );

    for (const folder of folders) {
      // Determine coworker type
      let type = 'unknown';
      let description = '';
      let name = folder;

      // Check if this is a template folder (matches a type key)
      if (types[folder]) {
        // This is a template, skip unless it's also a running instance
        continue;
      }

      // Match spawned instances (e.g., slang_ir-generics -> slang-ir type)
      for (const [typeName, typeInfo] of Object.entries(types) as [string, any][]) {
        if (folder.startsWith(typeName.replace(/-/g, '_') + '_') || folder.startsWith(typeName + '_')) {
          type = typeName;
          description = typeInfo.description || '';
          name = folder.replace(/^slang_/, '');
          break;
        }
      }

      // Also include template folders that have instances
      if (type === 'unknown') {
        // Check registered groups for this folder
        if (db) {
          try {
            const row = db.prepare('SELECT name, folder FROM registered_groups WHERE folder = ?').get(folder) as any;
            if (row) {
              name = row.name || folder;
              // Try to match type from folder name
              for (const typeName of Object.keys(types)) {
                if (folder.includes(typeName.replace(/-/g, '_')) || folder.includes(typeName)) {
                  type = typeName;
                  description = (types[typeName] as any).description || '';
                  break;
                }
              }
            }
          } catch { /* ignore */ }
        }
        if (type === 'unknown' && folder !== 'main' && folder !== 'global') {
          type = 'slang-base';
          description = 'Coworker instance';
        }
      }

      // Skip non-coworker folders
      if (folder === 'global') continue;

      // Determine status from IPC and task state
      let status: CoworkerState['status'] = 'idle';
      let currentTask: string | null = null;
      let lastActivity: string | null = null;
      let taskCount = 0;

      if (db) {
        try {
          // Check for active tasks
          const activeTasks = db
            .prepare("SELECT prompt, last_run FROM scheduled_tasks WHERE group_folder = ? AND status = 'active' ORDER BY next_run LIMIT 1")
            .all(folder) as any[];
          if (activeTasks.length > 0) {
            currentTask = activeTasks[0].prompt;
            status = 'working';
          }

          // Count total tasks
          const countRow = db
            .prepare('SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE group_folder = ?')
            .get(folder) as any;
          taskCount = countRow?.cnt || 0;

          // Last activity from task run logs
          const lastLog = db
            .prepare('SELECT run_at, status as log_status FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?) ORDER BY run_at DESC LIMIT 1')
            .get(folder) as any;
          if (lastLog) {
            lastActivity = lastLog.run_at;
            if (lastLog.log_status === 'error') status = 'error';
          }
        } catch { /* ignore query errors */ }
      }

      // Check for active container via IPC input directory
      const inputDir = join(DATA_DIR, 'ipc', folder, 'input');
      if (existsSync(inputDir)) {
        try {
          const files = readdirSync(inputDir);
          if (files.some((f) => f.endsWith('.json'))) {
            status = 'thinking'; // has pending input
          }
        } catch { /* ignore */ }
      }

      // Check for running Docker container matching this group folder
      if (status === 'idle') {
        try {
          const containerName = folder.replace(/_/g, '-');
          const out = execSync(
            `docker ps --filter "name=nanoclaw-${containerName}" --format "{{.Names}}" 2>/dev/null`,
            { timeout: 2000, encoding: 'utf-8' },
          ).trim();
          if (out) status = 'working';
        } catch { /* ignore — docker not available or no match */ }
      }

      // Overlay live hook state
      const hookState = liveHookState.get(folder);
      if (hookState && Date.now() - hookState.ts < 30000) {
        status = 'working';
      }

      coworkers.push({
        folder,
        name,
        type,
        description,
        status,
        currentTask,
        lastActivity,
        taskCount,
        color: TYPE_COLORS[type] || '#6B7280',
        lastToolUse: hookState?.tool || null,
        lastNotification: hookState?.notification || null,
        hookTimestamp: hookState?.ts || null,
      });
    }
  } catch { /* groups dir may not exist */ }

  // Get all tasks and run logs
  let tasks: any[] = [];
  let taskRunLogs: any[] = [];
  let registeredGroups: any[] = [];

  if (db) {
    try {
      tasks = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC LIMIT 100').all();
      taskRunLogs = db.prepare('SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT 500').all();
      registeredGroups = db.prepare('SELECT * FROM registered_groups').all();
    } catch { /* ignore */ }
  }

  return {
    coworkers,
    tasks,
    taskRunLogs,
    registeredGroups,
    hookEvents: hookEvents.slice(-50),
    timestamp: Date.now(),
  };
}

// --- WebSocket (manual, no external dep) ---

function computeAcceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC6552AA')
    .digest('base64');
}

const wsClients = new Set<any>();

function broadcastState(): void {
  if (wsClients.size === 0) return;
  const state = JSON.stringify({ type: 'state', data: getState() });
  for (const ws of wsClients) {
    try {
      const buf = Buffer.from(state);
      const frame = createWsFrame(buf);
      ws.write(frame);
    } catch {
      wsClients.delete(ws);
    }
  }
}

function createWsFrame(data: Buffer): Buffer {
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function parseWsFrame(buf: Buffer): { payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    return { payload, consumed: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { payload: buf.subarray(offset, offset + payloadLen), consumed: offset + payloadLen };
}

// --- HTTP Server ---

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // API: receive hook events from containers
  if (req.method === 'POST' && url.pathname === '/api/hook-event') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const event = JSON.parse(body) as HookEvent;
        event.timestamp = Date.now();

        // Server-side truncation guard (500 chars max per field)
        const truncate = (s?: string) => s ? s.slice(0, 500) : s;
        event.tool_input = truncate(event.tool_input);
        event.tool_response = truncate(event.tool_response);

        // PreToolUse updates live state only — skip ring buffer to avoid timeline flood
        const isPreToolUse = event.event === 'PreToolUse';
        if (!isPreToolUse) {
          hookEvents.push(event);
          if (hookEvents.length > MAX_HOOK_EVENTS) hookEvents.shift();
        }

        // Update live state
        if (event.group) {
          liveHookState.set(event.group, {
            tool: event.tool || liveHookState.get(event.group)?.tool,
            notification: event.message || liveHookState.get(event.group)?.notification,
            ts: Date.now(),
          });
        }

        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  // API: get current state
  if (url.pathname === '/api/state') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(getState()));
    return;
  }

  // API: get coworker types
  if (url.pathname === '/api/types') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getCoworkerTypes()));
    return;
  }

  // API: get coworker CLAUDE.md
  if (url.pathname.startsWith('/api/memory/')) {
    const folder = decodeURIComponent(url.pathname.replace('/api/memory/', ''));
    const mdPath = resolve(GROUPS_DIR, folder, 'CLAUDE.md');
    // Prevent path traversal
    if (!mdPath.startsWith(GROUPS_DIR)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const content = readFileSync(mdPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // API: get hook events filtered by group
  if (url.pathname === '/api/hook-events') {
    const group = url.searchParams.get('group');
    const filtered = group
      ? hookEvents.filter((e) => e.group === group)
      : hookEvents;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(filtered.slice(-200)));
    return;
  }

  // API: get recent messages from SQLite (for timeline integration + admin panel)
  // Messages table: id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
  // Group folder resolved via registered_groups.jid -> folder
  if (url.pathname === '/api/messages') {
    const group = url.searchParams.get('group'); // group folder name
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    const before = url.searchParams.get('before'); // ISO timestamp for pagination
    let messages: any[] = [];
    let hasMore = false;
    if (db) {
      try {
        // Join to get group_folder, add direction/body aliases for client compat
        const base = `SELECT m.*, rg.folder as group_folder,
          CASE WHEN m.is_from_me = 1 THEN 'outgoing' ELSE 'incoming' END as direction,
          m.content as body, m.timestamp as created_at
          FROM messages m LEFT JOIN registered_groups rg ON m.chat_jid = rg.jid`;
        if (group && before) {
          messages = db.prepare(`${base} WHERE rg.folder = ? AND m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`).all(group, before, limit + 1);
        } else if (group) {
          messages = db.prepare(`${base} WHERE rg.folder = ? ORDER BY m.timestamp DESC LIMIT ?`).all(group, limit + 1);
        } else if (before) {
          messages = db.prepare(`${base} WHERE m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`).all(before, limit + 1);
        } else {
          messages = db.prepare(`${base} ORDER BY m.timestamp DESC LIMIT ?`).all(limit + 1);
        }
        if (messages.length > limit) {
          hasMore = true;
          messages = messages.slice(0, limit);
        }
      } catch { /* messages table may not exist */ }
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ messages, hasMore }));
    return;
  }

  // API: admin overview stats
  if (url.pathname === '/api/overview') {
    const result: any = { uptime: process.uptime(), groups: { total: 0 }, tasks: { active: 0, paused: 0, completed: 0 }, messages: { total: 0 }, sessions: 0 };
    if (db) {
      try {
        result.groups.total = (db.prepare('SELECT COUNT(*) as c FROM registered_groups').get() as any)?.c || 0;
        const taskCounts = db.prepare("SELECT status, COUNT(*) as c FROM scheduled_tasks GROUP BY status").all() as any[];
        for (const r of taskCounts) {
          if (r.status === 'active') result.tasks.active = r.c;
          else if (r.status === 'paused') result.tasks.paused = r.c;
          else result.tasks.completed = r.c;
        }
        result.messages.total = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c || 0;
        result.sessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any)?.c || 0;
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: admin tasks with recent run logs
  if (url.pathname === '/api/tasks') {
    let tasks: any[] = [];
    if (db) {
      try {
        tasks = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[];
        for (const task of tasks) {
          task.recentLogs = db.prepare('SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 5').all(task.id);
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return;
  }

  // API: pause task
  if (req.method === 'POST' && /^\/api\/tasks\/(\d+)\/pause$/.test(url.pathname)) {
    const id = url.pathname.match(/\/api\/tasks\/(\d+)\/pause/)![1];
    const wdb = openWriteDb();
    if (wdb) {
      try {
        wdb.prepare("UPDATE scheduled_tasks SET status='paused' WHERE id=?").run(id);
        wdb.close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        wdb.close();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: resume task
  if (req.method === 'POST' && /^\/api\/tasks\/(\d+)\/resume$/.test(url.pathname)) {
    const id = url.pathname.match(/\/api\/tasks\/(\d+)\/resume/)![1];
    const wdb = openWriteDb();
    if (wdb) {
      try {
        wdb.prepare("UPDATE scheduled_tasks SET status='active' WHERE id=?").run(id);
        wdb.close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        wdb.close();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: list sessions
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    let sessions: any[] = [];
    if (db) {
      try {
        sessions = db.prepare('SELECT s.group_folder, s.session_id, rg.name as group_name FROM sessions s LEFT JOIN registered_groups rg ON s.group_folder = rg.folder').all();
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // API: delete sessions for a group folder
  if (req.method === 'DELETE' && /^\/api\/sessions\//.test(url.pathname)) {
    const folder = decodeURIComponent(url.pathname.replace('/api/sessions/', ''));
    const wdb = openWriteDb();
    if (wdb) {
      try {
        wdb.prepare('DELETE FROM sessions WHERE group_folder=?').run(folder);
        wdb.close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        wdb.close();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: list skills
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    const skills: any[] = [];
    try {
      if (existsSync(SKILLS_DIR)) {
        for (const name of readdirSync(SKILLS_DIR)) {
          const skillDir = join(SKILLS_DIR, name);
          if (!statSync(skillDir).isDirectory()) continue;
          const info: any = { name, enabled: !existsSync(join(skillDir, '.disabled')), files: [] };
          const skillMd = join(skillDir, 'SKILL.md');
          if (existsSync(skillMd)) {
            const content = readFileSync(skillMd, 'utf-8');
            const titleMatch = content.match(/^#\s+(.+)/m);
            info.title = titleMatch ? titleMatch[1] : name;
            info.description = content.split('\n').find((l: string) => l.trim() && !l.startsWith('#'))?.trim() || '';
          }
          info.files = readdirSync(skillDir).filter((f: string) => !f.startsWith('.'));
          skills.push(info);
        }
      }
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(skills));
    return;
  }

  // API: toggle skill enabled/disabled
  if (req.method === 'POST' && /^\/api\/skills\/[^/]+\/toggle$/.test(url.pathname)) {
    const name = decodeURIComponent(url.pathname.match(/\/api\/skills\/([^/]+)\/toggle/)![1]);
    const skillDir = resolve(SKILLS_DIR, name);
    if (!skillDir.startsWith(SKILLS_DIR)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const disabledFile = join(skillDir, '.disabled');
    let enabled: boolean;
    try {
      if (existsSync(disabledFile)) {
        unlinkSync(disabledFile);
        enabled = true;
      } else {
        writeFileSync(disabledFile, '');
        enabled = false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: group details
  if (req.method === 'GET' && url.pathname === '/api/groups/detail') {
    let groups: any[] = [];
    if (db) {
      try {
        groups = db.prepare('SELECT * FROM registered_groups').all() as any[];
        for (const g of groups) {
          // Count sessions
          g.sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions WHERE group_folder = ?').get(g.folder) as any)?.c || 0;
          // Read CLAUDE.md
          const mdPath = join(GROUPS_DIR, g.folder, 'CLAUDE.md');
          try {
            g.memory = readFileSync(mdPath, 'utf-8');
          } catch {
            g.memory = null;
          }
          // Check for running container
          g.containerRunning = false;
          try {
            const containerName = g.folder.replace(/_/g, '-');
            const out = execSync(
              `docker ps --filter "name=nanoclaw-${containerName}" --format "{{.Names}}" 2>/dev/null`,
              { timeout: 2000, encoding: 'utf-8' },
            ).trim();
            if (out) g.containerRunning = true;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(groups));
    return;
  }

  // API: debug info
  if (req.method === 'GET' && url.pathname === '/api/debug') {
    const mem = process.memoryUsage();
    const result: any = {
      pid: process.pid,
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      dbPath: DB_PATH,
      dbAvailable: !!db,
      rowCounts: {} as Record<string, number>,
      wsClients: wsClients.size,
      hookEventsBuffered: hookEvents.length,
    };
    if (db) {
      try {
        for (const table of ['messages', 'scheduled_tasks', 'task_run_logs', 'sessions', 'registered_groups', 'chats']) {
          result.rowCounts[table] = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any)?.c || 0;
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: write CLAUDE.md for a group (admin panel)
  if (req.method === 'PUT' && url.pathname.startsWith('/api/memory/')) {
    const folder = decodeURIComponent(url.pathname.replace('/api/memory/', ''));
    const mdPath = resolve(GROUPS_DIR, folder, 'CLAUDE.md');
    if (!mdPath.startsWith(GROUPS_DIR)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        writeFileSync(mdPath, body, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  filePath = resolve(PUBLIC_DIR, '.' + filePath);
  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n',
  );

  wsClients.add(socket);

  // Send initial state
  const state = JSON.stringify({ type: 'state', data: getState() });
  socket.write(createWsFrame(Buffer.from(state)));

  let buffer = Buffer.alloc(0);
  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const frame = parseWsFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      // Handle ping/pong or ignore client messages
    }
  });

  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
});

// Poll and broadcast state every 500ms
setInterval(() => {
  // Reopen DB if it was unavailable
  if (!db) db = openDb();
  broadcastState();
}, 500);

// Expire stale hook state (>30s old)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of liveHookState) {
    if (now - val.ts > 30000) liveHookState.delete(key);
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`\n  NanoClaw Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Tab 1: Pixel Art Office (real-time)`);
  console.log(`  Tab 2: Timeline (all-time metrics)\n`);
});
