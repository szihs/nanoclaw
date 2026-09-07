#!/usr/bin/env node
// coworker-mcp — dependency-free MCP server to talk to NanoClaw coworkers on this box.
// Each tool is one HTTP call to the LOCAL dashboard (127.0.0.1:3838), which ensures
// wiring + wakes a cold container via the host router. Replies are async: poll
// read_replies or block on wait_for_reply. Auth is edge (Brev SSO); on-box = loopback.
//
// Transport: stateless Streamable-HTTP (MCP 2025-06-18). POST JSON-RPC 2.0 -> JSON.
// Node stdlib only (Node >=18 for global fetch; lego is v24).
//
// Env: NANOCLAW_DASH_URL (default http://127.0.0.1:3838) · COWORKER_MCP_HOST (default 127.0.0.1)
//      COWORKER_MCP_PORT (8830) · COWORKER_MCP_TOKEN (optional Bearer; REQUIRED if non-loopback)
//      NANOCLAW_DASHBOARD_SECRET (forwarded to dashboard if set) · NCL_BIN (default 'ncl')
//      COWORKER_MCP_ALLOWED_ORIGINS (comma list; default none — MCP clients send no Origin)

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const DASH = (process.env.NANOCLAW_DASH_URL || 'http://127.0.0.1:3838').replace(/\/$/, '');
const HOST = process.env.COWORKER_MCP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.COWORKER_MCP_PORT || '8830', 10);
const TOKEN = process.env.COWORKER_MCP_TOKEN || '';
const DASH_SECRET = process.env.NANOCLAW_DASHBOARD_SECRET || '';
const NCL_BIN = process.env.NCL_BIN || 'ncl';
const ALLOWED_ORIGINS = new Set(
  (process.env.COWORKER_MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const SERVER_INFO = { name: 'nanoclaw-coworkers', version: '0.8.0' };
// Cost model: `cost_per_coworker` and `cost_history` each take a `source`.
// The DEFAULT is `transcript` (cost of record — the engine whose monthly total
// matched the Anthropic bill ~103%). Alternate sources (litellm gateway, #65
// ledger) are opt-in via `source`, with their caveats in the descriptions.
// No env flag, no hidden tools — one tool per shape, source picks the engine.
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_OUT = 100_000;

// Fail closed: binding to a network interface without a token exposes mutations.
const isLoopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
if (!isLoopback && !TOKEN) {
  console.error('refusing to start: COWORKER_MCP_TOKEN is required when COWORKER_MCP_HOST is not loopback');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function safeEq(a, b) {
  const ab = Buffer.from(String(a)),
    bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function okText(obj) {
  let s = JSON.stringify(obj, null, 2);
  if (s.length > MAX_OUT) s = s.slice(0, MAX_OUT) + '\n... [truncated; narrow your query]';
  return s;
}

// ── dashboard HTTP helper (auth-forwarding, per-call timeout, sanitized errors) ──
async function dash(method, path, body, timeoutMs = 15000) {
  const opts = { method, headers: {}, signal: AbortSignal.timeout(timeoutMs) };
  if (DASH_SECRET) opts.headers.Authorization = `Bearer ${DASH_SECRET}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(`${DASH}${path}`, opts);
  } catch (e) {
    console.error('dashboard request failed', { method, path, error: e?.message || String(e) });
    throw new Error('dashboard unavailable');
  }
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const appMsg = data && typeof data === 'object' && data.error ? data.error : `HTTP ${r.status}`;
    throw new Error(`${r.status}: ${String(appMsg).slice(0, 300)}`); // app-level message only, no internal URL
  }
  return data;
}

// ── tools ─────────────────────────────────────────────────────────────────
const str = (v) => (typeof v === 'string' ? v : undefined);
const reqStr = (v, n) => {
  const s = str(v);
  if (!s || !s.trim()) throw new Error(`${n} (string) required`);
  return s.trim();
};

// Run an `ncl` subcommand (expects `--json`), unwrap the {ok,data} envelope.
async function runNcl(cmd, label, timeout = 60000) {
  try {
    const { stdout } = await execFileP(NCL_BIN, cmd, { timeout });
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: String(stdout).slice(0, 4000) };
    }
    if (parsed && parsed.ok === false) return okText({ error: parsed.error?.message || 'ncl error' });
    return okText(parsed && parsed.data ? parsed.data : parsed);
  } catch (e) {
    return okText({ error: `${label} unavailable`, detail: String(e?.message || e).slice(0, 200) });
  }
}

const TOOLS = [
  {
    name: 'list_coworkers',
    description: 'List coworker agents on this box (folder, name, type, status). Use "folder" as the coworker id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cw = await dash('GET', '/api/coworkers');
      const slim = Array.isArray(cw)
        ? cw.map((c) => ({ folder: c.folder, name: c.name, type: c.type, status: c.status }))
        : cw;
      return okText(slim);
    },
  },
  {
    name: 'talk_to_coworker',
    description:
      'Send a message to a coworker (wakes a cold container). Async: reply is not returned here — use wait_for_reply, or poll read_replies. `coworker` is the folder from list_coworkers.',
    inputSchema: {
      type: 'object',
      properties: {
        coworker: { type: 'string', description: 'coworker folder' },
        message: { type: 'string' },
        thread_id: { type: 'string', description: 'optional Slack-style thread; omit for main channel' },
      },
      required: ['coworker', 'message'],
      additionalProperties: false,
    },
    async run(a) {
      const body = { group: reqStr(a.coworker, 'coworker'), content: reqStr(a.message, 'message') };
      const t = str(a.thread_id);
      if (t && t.trim()) body.thread_id = t.trim().slice(0, 200);
      await dash('POST', '/api/chat/send', body);
      return okText({
        ok: true,
        note: `delivered to ${body.group}; call wait_for_reply({coworker:"${body.group}"}) for the reply`,
      });
    },
  },
  {
    name: 'read_replies',
    description:
      'Read the recent transcript for a coworker (or a session). Returns newest messages incl. agent replies (direction=outgoing).',
    inputSchema: {
      type: 'object',
      properties: {
        coworker: { type: 'string' },
        session_id: { type: 'string' },
        limit: { type: 'number', description: 'max messages (default 25, 1..500)' },
        include_system: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async run(a) {
      const qs = new URLSearchParams();
      if (str(a.session_id)) qs.set('session_id', reqStr(a.session_id, 'session_id'));
      else if (str(a.coworker)) qs.set('group', reqStr(a.coworker, 'coworker'));
      else throw new Error('provide coworker or session_id');
      const lim = Math.max(1, Math.min(Number.isFinite(+a.limit) ? Math.trunc(+a.limit) : 25, 500));
      qs.set('limit', String(lim));
      if (a.include_system === true) qs.set('includeSystem', '1');
      const data = await dash('GET', `/api/messages?${qs.toString()}`);
      const messages = data && data.messages ? data.messages : data;
      const slim = Array.isArray(messages)
        ? messages.map((m) => ({
            ts: m.timestamp,
            direction: m.direction,
            kind: m.kind,
            session_id: m.session_id,
            content: m.content,
          }))
        : messages;
      return okText({ count: Array.isArray(slim) ? slim.length : undefined, messages: slim });
    },
  },
  {
    name: 'wait_for_reply',
    description:
      'Block (server-side poll) until the coworker/session produces a NEW reply (direction=outgoing) after now, or timeout. Call right after talk_to_coworker to get the reply in one shot.',
    inputSchema: {
      type: 'object',
      properties: {
        coworker: { type: 'string' },
        session_id: { type: 'string' },
        timeout_ms: { type: 'number', description: 'max wait (default 60000, 2000..120000)' },
        after_ts: { type: 'string', description: 'ISO ts baseline; default = now' },
      },
      additionalProperties: false,
    },
    async run(a) {
      const qs = new URLSearchParams();
      if (str(a.session_id)) qs.set('session_id', reqStr(a.session_id, 'session_id'));
      else if (str(a.coworker)) qs.set('group', reqStr(a.coworker, 'coworker'));
      else throw new Error('provide coworker or session_id');
      qs.set('limit', '15');
      const timeout = Math.min(
        Math.max(Number.isFinite(+a.timeout_ms) ? Math.trunc(+a.timeout_ms) : 60000, 2000),
        120000,
      );
      const after = str(a.after_ts) && !Number.isNaN(Date.parse(a.after_ts)) ? Date.parse(a.after_ts) : Date.now();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const data = await dash('GET', `/api/messages?${qs.toString()}`);
        const msgs = (data && data.messages ? data.messages : data) || [];
        const fresh = (Array.isArray(msgs) ? msgs : [])
          .filter((m) => m.direction === 'outgoing' && m.timestamp && Date.parse(m.timestamp) > after)
          .map((m) => ({ ts: m.timestamp, content: m.content }));
        if (fresh.length) return okText({ replied: true, messages: fresh });
        await sleep(2500);
      }
      return okText({ replied: false, note: 'no reply within timeout; call read_replies later' });
    },
  },
  {
    name: 'list_sessions',
    description: 'List active sessions (optionally filtered to one coworker folder).',
    inputSchema: { type: 'object', properties: { coworker: { type: 'string' } }, additionalProperties: false },
    async run(a) {
      const data = await dash('GET', '/api/sessions');
      let sessions = data && data.sessions ? data.sessions : data;
      const cw = str(a.coworker);
      if (cw && Array.isArray(sessions)) sessions = sessions.filter((s) => s.group_folder === cw || s.folder === cw);
      return okText(sessions);
    },
  },
  {
    name: 'talk_to_session',
    description: 'Send a message directly into a specific session by id (e.g. an a2a session) and wake it.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, message: { type: 'string' } },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
    async run(a) {
      const sid = reqStr(a.session_id, 'session_id');
      await dash('POST', '/api/chat/send-to-session', { session_id: sid, content: reqStr(a.message, 'message') });
      return okText({ ok: true, note: `delivered to session ${sid}; wait_for_reply({session_id:"${sid}"})` });
    },
  },
  {
    name: 'cost',
    description:
      "The single cost tool — pick a `view`:\n" +
      "• view='by_coworker' (DEFAULT) — spend per coworker. This is SPEND OF RECORD when source='transcript' (default): prices every session's Claude+Codex transcript incl. subagents/skills, the engine whose monthly total matched the Anthropic bill ~103%. Window: `period` (1d|7d|30d|all, default 30d) OR a date range `from`+`to` (YYYY-MM-DD, inclusive) with `by` (day|week|total). `group` filters one coworker.\n" +
      "• view='session' — LIVE cap ENFORCEMENT state of one `session_id` (status ok/warn/escalated/stopped, cap, ceiling, windowed enforcement spend). NOTE: that spend is the ENFORCEMENT counter (cap basis), NOT spend of record — it is windowed and can diverge; for real spend use by_coworker.\n" +
      "• view='stopped' — sessions cost-stopped RIGHT NOW (optional `group`).\n" +
      "• view='escalations' — append-only HISTORY of cap/ceiling trips (filters: `state`, `group`, `author`, `limit`); not the live set.\n" +
      "`source` (by_coworker only) — DEFAULT 'transcript' (the cost of record; use this). The other two are CURRENTLY BROKEN and only for cross-check: 'litellm' (OneCLI gateway body-usage) UNDERCOUNTS because the gateway records $0 for streamed responses (≈all coworker traffic) — accurate only once the body-usage tap ships; 'ledger' (#65 per-turn events) is PARTIAL because its writer only rolled out 2026-08-31, so pre-rollout windows are ~5% covered. Unless you are explicitly reconciling, omit `source` and get transcript. To resume a stopped session use continue_session (separate, it's a mutation).",
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: "by_coworker (default) | session | stopped | escalations" },
        source: { type: 'string', description: "by_coworker only: transcript (default) | litellm | ledger" },
        period: { type: 'string', description: 'by_coworker fixed window: 1d|7d|30d|all (default 30d)' },
        from: { type: 'string', description: 'by_coworker date-range start YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'by_coworker date-range end YYYY-MM-DD (inclusive, default today)' },
        by: { type: 'string', description: 'by_coworker date-range bucket: day|week|total (default week)' },
        group: { type: 'string', description: 'coworker folder/name/id filter' },
        session_id: { type: 'string', description: "required for view='session'" },
        state: { type: 'string', description: 'escalations filter: pending|continued|stopped|expired|superseded|observed' },
        author: { type: 'string', description: 'escalations GitHub-author filter' },
        limit: { type: 'number', description: 'escalations max rows (default 50)' },
      },
      additionalProperties: false,
    },
    async run(a) {
      const view = (str(a.view) || 'by_coworker').toLowerCase();
      const push = (cmd, flag, v) => {
        if (str(v)) cmd.push(flag, reqStr(v, flag));
      };
      if (view === 'session') {
        return runNcl(['cost-cap', 'status', '--session', reqStr(a.session_id, 'session_id'), '--json'], 'cost(session)', 10000);
      }
      if (view === 'stopped') {
        const cmd = ['cost-cap', 'stopped', '--json'];
        push(cmd, '--group', a.group);
        return runNcl(cmd, 'cost(stopped)', 30000);
      }
      if (view === 'escalations') {
        const cmd = ['cost-cap', 'escalations', '--json'];
        push(cmd, '--state', a.state);
        push(cmd, '--group', a.group);
        push(cmd, '--author', a.author);
        if (a.limit != null && Number.isFinite(+a.limit)) cmd.push('--limit', String(Math.trunc(+a.limit)));
        return runNcl(cmd, 'cost(escalations)', 20000);
      }
      // view = by_coworker
      const source = (str(a.source) || 'transcript').toLowerCase();
      const isRange = str(a.from) || str(a.to);
      if (isRange) {
        // Date-range per-coworker.
        if (source === 'transcript') {
          const qs = new URLSearchParams();
          qs.set('from', reqStr(a.from, 'from'));
          if (str(a.to)) qs.set('to', reqStr(a.to, 'to'));
          if (str(a.by)) qs.set('by', reqStr(a.by, 'by'));
          if (str(a.group)) qs.set('group', reqStr(a.group, 'group'));
          try {
            return okText(await dash('GET', `/api/cost-history?${qs.toString()}`));
          } catch (e) {
            return okText({ error: 'cost(by_coworker,transcript,range) unavailable', detail: String(e?.message || e).slice(0, 200) });
          }
        }
        if (source === 'ledger') {
          const cmd = ['cost-cap', 'history', '--json'];
          push(cmd, '--group', a.group);
          push(cmd, '--from', a.from);
          push(cmd, '--to', a.to);
          push(cmd, '--by', a.by);
          return runNcl(cmd, 'cost(by_coworker,ledger)');
        }
        return okText({ error: `source='${source}' has no date-range support yet — use source=transcript (cost of record) or source=ledger` });
      }
      // Fixed-period per-coworker.
      if (source === 'transcript') {
        const cmd = ['cost-cap', 'sessions', '--json'];
        push(cmd, '--period', a.period);
        push(cmd, '--group', a.group);
        return runNcl(cmd, 'cost(by_coworker,transcript)');
      }
      if (source === 'litellm' || source === 'onecli' || source === 'gateway') {
        const cmd = ['cost-cap', 'coworkers', '--json'];
        push(cmd, '--period', a.period);
        push(cmd, '--group', a.group);
        return runNcl(cmd, 'cost(by_coworker,litellm)');
      }
      return okText({ error: `unknown source '${source}' — use transcript | litellm | ledger` });
    },
  },
  {
    name: 'continue_session',
    description:
      'V2: resume a session that was stopped by the cost cap (cost-override continue). Show the user cost_status first — do not blind-resume.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
    async run(a) {
      const sid = reqStr(a.session_id, 'session_id');
      await dash('POST', '/api/cost-override', { session_id: sid, decision: 'continue' });
      return okText({ ok: true, note: `continued session ${sid}` });
    },
  },
  {
    name: 'resolve_approval',
    description: 'Resolve a pending approval card. approval_id from the dashboard approvals list.',
    inputSchema: {
      type: 'object',
      properties: { approval_id: { type: 'string' }, decision: { type: 'string', description: 'e.g. approve | deny' } },
      required: ['approval_id', 'decision'],
      additionalProperties: false,
    },
    async run(a) {
      await dash(
        'POST',
        '/api/approvals/action',
        { approvalId: reqStr(a.approval_id, 'approval_id'), decision: reqStr(a.decision, 'decision') },
        35000,
      );
      return okText({ ok: true });
    },
  },
  {
    name: 'answer_question',
    description: 'Answer an ask_user_question card by selecting one of its options.',
    inputSchema: {
      type: 'object',
      properties: { question_id: { type: 'string' }, selected_option: { type: 'string' } },
      required: ['question_id', 'selected_option'],
      additionalProperties: false,
    },
    async run(a) {
      await dash('POST', '/api/questions/respond', {
        questionId: reqStr(a.question_id, 'question_id'),
        selectedOption: reqStr(a.selected_option, 'selected_option'),
      });
      return okText({ ok: true });
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const APPROVAL_TOOLS = new Set(['resolve_approval', 'answer_question', 'continue_session']);

// ── JSON-RPC / MCP dispatch ────────────────────────────────────────────────
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const isPlainObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

async function handleRpc(msg) {
  if (!isPlainObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(null, -32600, 'invalid request');
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (hasId && !(typeof msg.id === 'string' || (typeof msg.id === 'number' && Number.isInteger(msg.id)))) {
    return rpcError(null, -32600, 'invalid request id'); // null id is NOT a valid notification per MCP
  }
  if (msg.params !== undefined && !isPlainObj(msg.params))
    return hasId ? rpcError(msg.id, -32602, 'invalid params') : null;
  const id = msg.id;
  const params = msg.params || {};

  if (!hasId) return null; // notification / legacy response: ack, no reply, never execute a method

  if (msg.method === 'initialize') {
    const want = params.protocolVersion;
    const proto = typeof want === 'string' && SUPPORTED_PROTOCOLS.has(want) ? want : DEFAULT_PROTOCOL;
    return rpcResult(id, {
      protocolVersion: proto,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (msg.method === 'ping') return rpcResult(id, {});
  if (msg.method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (msg.method === 'tools/call') {
    const name = params.name;
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${String(name)}`);
    const args = isPlainObj(params.arguments) ? params.arguments : {};
    try {
      return rpcResult(id, { content: [{ type: 'text', text: await tool.run(args) }] });
    } catch (e) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Error: ${String(e?.message || e).slice(0, 400)}` }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `method not found: ${msg.method}`);
}

// ── rate limiting (fixed window, keyed by token/ip) ─────────────────────────
const buckets = new Map();
function overLimit(key, max, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) buckets.clear();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return b.count > max;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      settled = false;
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        fn(v);
      }
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > 1024 * 1024) {
        const e = new Error('body too large');
        e.code = 'BODY_TOO_LARGE';
        done(reject, e);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => done(reject, e));
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj, headers = {}) => {
    try {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(obj === null ? '' : JSON.stringify(obj));
    } catch {
      /* socket gone */
    }
  };
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return send(400, { error: 'bad request' });
  }

  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, tools: TOOLS.length });
  if (url.pathname !== '/mcp' && url.pathname !== '/') return send(404, { error: 'not found' });

  const ip = req.socket?.remoteAddress || 'unknown';
  if (overLimit(`g:${ip}`, 240, 60000)) return send(429, { error: 'rate limited' });
  if (TOKEN) {
    const auth = req.headers['authorization'] || '';
    if (!safeEq(auth, `Bearer ${TOKEN}`)) return send(401, { error: 'unauthorized' });
  }
  // CSRF / DNS-rebinding: browsers send Origin; MCP clients do not. Reject unknown origins.
  const origin = req.headers['origin'];
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(403, { error: 'forbidden origin' });

  if (req.method !== 'POST') return send(405, { error: 'method not allowed' }, { Allow: 'POST' });
  const ctype = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim();
  if (ctype !== 'application/json') return send(415, { error: 'content-type must be application/json' });

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return e?.code === 'BODY_TOO_LARGE'
      ? send(413, { error: 'payload too large' })
      : send(400, { error: 'read error' });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return send(400, rpcError(null, -32700, 'parse error'));
  }
  if (Array.isArray(parsed)) return send(400, rpcError(null, -32600, 'JSON-RPC batches are not supported')); // MCP 2025-06-18 removed batching

  // stricter limit for state-changing tools
  if (
    isPlainObj(parsed) &&
    parsed.method === 'tools/call' &&
    isPlainObj(parsed.params) &&
    APPROVAL_TOOLS.has(parsed.params.name)
  ) {
    if (overLimit(`a:${ip}`, 30, 60000))
      return send(429, rpcError(parsed.id ?? null, -32000, 'rate limited (mutations)'));
  }
  try {
    const r = await handleRpc(parsed);
    return r === null ? send(202, null) : send(200, r);
  } catch (e) {
    console.error('dispatch error', e);
    return send(500, rpcError(isPlainObj(parsed) ? (parsed.id ?? null) : null, -32603, 'internal error'));
  }
});

server.on('clientError', (_err, socket) => {
  try {
    socket.destroy();
  } catch {}
});
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

server.listen(PORT, HOST, () => {
  console.log(
    `coworker-mcp v${SERVER_INFO.version} on http://${HOST}:${PORT}/mcp -> ${DASH} (${TOOLS.length} tools${TOKEN ? ', token' : ''}${DASH_SECRET ? ', dash-auth' : ''})`,
  );
});
