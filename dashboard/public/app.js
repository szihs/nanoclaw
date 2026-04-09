
/**
 * NanoClaw Dashboard — Main Application
 *
 * Tab 1: Pixel Art Office — uses Pixel Agents PNG assets (MIT) with procedural fallback
 * Tab 2: Timeline / Audit — dev-mode timeline of all events + debug log
 */

const PixelSprites = window.PixelSprites;
if (!PixelSprites) {
  throw new Error('Pixel sprite engine failed to load');
}

let state = { coworkers: [], tasks: [], taskRunLogs: [], registeredGroups: [], hookEvents: [], timestamp: 0 };
const nativeFetch = window.fetch.bind(window);
const dashboardAuth = {
  checked: false,
  required: false,
  authenticated: false,
  prompting: null,
};

function isApiRequest(input) {
  const url = typeof input === 'string' ? input : input.url;
  return url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`);
}

function isAuthRequest(input) {
  const url = typeof input === 'string' ? input : input.url;
  return url.startsWith('/api/auth/') || url.startsWith(`${window.location.origin}/api/auth/`);
}

async function refreshDashboardAuthStatus() {
  try {
    const res = await nativeFetch('/api/auth/status', { cache: 'no-store' });
    if (!res.ok) return { required: false, authenticated: true };
    const status = await res.json();
    dashboardAuth.checked = true;
    dashboardAuth.required = !!status.required;
    dashboardAuth.authenticated = !!status.authenticated;
    return status;
  } catch {
    return { required: false, authenticated: true };
  }
}

async function promptForDashboardSecret() {
  if (dashboardAuth.prompting) return dashboardAuth.prompting;
  dashboardAuth.prompting = (async () => {
    const secret = window.prompt('Enter dashboard secret');
    if (!secret) return false;
    const res = await nativeFetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!res.ok) {
      let err = 'Invalid dashboard secret';
      try {
        const data = await res.json();
        err = data.error || err;
      } catch { /* ignore */ }
      alert(err);
      dashboardAuth.authenticated = false;
      return false;
    }
    dashboardAuth.checked = true;
    dashboardAuth.authenticated = true;
    return true;
  })();
  try {
    return await dashboardAuth.prompting;
  } finally {
    dashboardAuth.prompting = null;
  }
}

async function ensureDashboardAuth(forcePrompt = false) {
  const status = forcePrompt || !dashboardAuth.checked
    ? await refreshDashboardAuthStatus()
    : dashboardAuth;
  if (!status.required) return true;
  if (status.authenticated) return true;
  const loggedIn = await promptForDashboardSecret();
  if (!loggedIn) return false;
  const refreshed = await refreshDashboardAuthStatus();
  return !!refreshed.authenticated;
}

window.fetch = async function(input, init) {
  if (!isApiRequest(input) || isAuthRequest(input)) {
    return nativeFetch(input, init);
  }
  let res = await nativeFetch(input, init);
  if (res.status !== 401) return res;
  const authed = await ensureDashboardAuth(true);
  if (!authed) return res;
  res = await nativeFetch(input, init);
  return res;
};

// Unread message tracking via localStorage
const readCursors = {
  KEY: 'nanoclaw-read-cursors',
  _cache: null,
  get() { if (!this._cache) { try { this._cache = JSON.parse(localStorage.getItem(this.KEY) || '{}'); } catch { this._cache = {}; } } return this._cache; },
  getFor(folder) { return this.get()[folder] || null; },
  markRead(folder, timestamp) { const c = this.get(); c[folder] = timestamp; this._cache = c; localStorage.setItem(this.KEY, JSON.stringify(c)); },
};

function hasUnread(folder) {
  const cw = (state.coworkers || []).find(c => c.folder === folder);
  if (!cw || !cw.lastMessageTs) return false;
  const cursor = readCursors.getFor(folder);
  if (!cursor) return true;
  return cw.lastMessageTs > cursor;
}

let selectedCoworker = null;
let frame = 0;
let liveSource = null;
let pollTimer = null;
let hoveredDesk = -1;
let timelineFilter = null; // group folder filter for timeline
let cachedMessages = []; // messages fetched from /api/messages
let sessionFlowMode = false; // true when viewing a session flow
let sessionFlowData = null; // current session flow data
let cachedSessions = []; // sessions list from /api/hook-events/sessions
let timelineNoMoreEvents = false;
let timelineDisplayLimit = 200;
let timelineOlderEvents = []; // Events loaded via "Load older" — survive state polls

const Z = PixelSprites.ZOOM;
const OFFICE_TILE = PixelSprites.TILE;
const STATUS_CONFIG = {
  idle: ['#6B7280', 'IDLE'],
  active: ['#3B82F6', 'ACTIVE'],
  working: ['#10B981', 'WORKING'],
  thinking: ['#F59E0B', 'THINKING'],
  error: ['#EF4444', 'ERROR'],
};
const SUBAGENT_TYPE_COLORS = {
  worker: '#10B981',
  explorer: '#3B82F6',
  default: '#8B5CF6',
};

function getStatusConfig(status) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.idle;
}

function renderStatusBadge(status) {
  const [sColor, sLabel] = getStatusConfig(status);
  return `<span class="status-badge" style="background:${sColor}20;color:${sColor}">${sLabel}</span>`;
}

function updateDotHtml(isAutoUpdate, showLabel) {
  if (showLabel) {
    return isAutoUpdate
      ? '<span class="update-indicator auto" title="CLAUDE.md auto-refreshes from template on startup">auto-update</span>'
      : '<span class="update-indicator frozen" title="CLAUDE.md frozen at creation time">static</span>';
  }
  return isAutoUpdate
    ? '<span class="update-dot auto" title="Auto-update"></span>'
    : '<span class="update-dot frozen" title="Static"></span>';
}

function renderSubagentBadge(subagent) {
  if (subagent.phase === 'leaving') {
    return '<span class="status-badge" style="background:#64748b20;color:#94a3b8">EXITING</span>';
  }
  return renderStatusBadge(subagent.status);
}

function formatSubagentName(subagent) {
  const type = subagent.agentType && subagent.agentType !== 'default' ? subagent.agentType : 'child';
  const suffix = (subagent.agentId || '').slice(0, 8) || '?';
  return `${type}:${suffix}`;
}

function renderSubagentList(cw) {
  if (!cw.subagents || cw.subagents.length === 0) return 'None';
  return `<div class="subagent-list">${cw.subagents.map((subagent) => `
    <div class="subagent-card">
      <div class="subagent-head">
        <span class="subagent-name">${esc(formatSubagentName(subagent))}</span>
        ${renderSubagentBadge(subagent)}
      </div>
      <div class="subagent-type">${esc(subagent.agentType || 'default')}</div>
      <div class="subagent-meta">${esc(subagent.phase === 'leaving' ? (subagent.lastNotification || 'Leaving desk') : (subagent.lastToolUse || subagent.lastNotification || 'Standing by'))}</div>
    </div>
  `).join('')}</div>`;
}

function setLiveStatus(label, colorVar) {
  document.getElementById('ws-status').textContent = label;
  document.querySelector('.status-dot').style.background = colorVar;
}

// --- WebSocket ---
function switchToTab(tabId) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');
  document.getElementById(tabId)?.classList.add('active');
}

function renderDetailHooks(cw) {
  const groupEvents = state.hookEvents.filter((e) => e.group === cw.folder);
  // Find active session
  const sessionEvent = groupEvents.filter((e) => e.session_id).slice(-1)[0];
  const activeSession = sessionEvent?.session_id || null;

  // Build pre-tool map for durations
  const preTimes = new Map();
  for (const e of groupEvents) {
    if (e.event === 'PreToolUse' && e.tool_use_id) preTimes.set(e.tool_use_id, e.timestamp);
  }

  // Show last 5 tool calls with durations
  const recentTools = groupEvents.filter((e) => e.event === 'PostToolUse' || e.event === 'PostToolUseFailure').slice(-5);
  let html = '';

  if (activeSession) {
    html += `<div class="field"><label>Active Session</label>
      <div class="value" style="display:flex;align-items:center;gap:6px">
        <span style="font-size:9px;color:var(--text-dim)">${activeSession.slice(0, 12)}</span>
        <button class="admin-action-btn" style="font-size:8px;padding:1px 6px" data-view-session="${escAttr(activeSession)}" data-view-session-group="${escAttr(cw.folder)}">View Session</button>
      </div>
    </div>`;
  }

  if (recentTools.length === 0 && groupEvents.length === 0) return html;

  html += '<label style="color:var(--text-dim);font-size:9px;text-transform:uppercase">Recent Events</label>';
  const display = groupEvents.filter((e) => e.event !== 'PreToolUse').slice(-10);
  html += display.map((e) => {
    const dur = (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') && e.tool_use_id && preTimes.has(e.tool_use_id)
      ? ` <span style="color:var(--text-muted)">${formatDuration(e.timestamp - preTimes.get(e.tool_use_id))}</span>` : '';
    return `<button class="hook-entry hook-entry-link" data-event-group="${escAttr(cw.folder)}" data-event-time="${String(e.timestamp)}">
      <span class="ts">${formatTime(e.timestamp)}</span> <span class="tool-name">${esc(e.tool || e.event)}</span>${dur}
    </button>`;
  }).join('');
  return html;
}

function renderContextIndicator(cw) {
  if (cw.contextUsagePercent == null && cw.spineSkillCount == null) return '';
  let html = '';
  if (cw.contextUsagePercent != null) {
    const pct = cw.contextUsagePercent;
    const color = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)';
    const tokensK = cw.contextTokens ? Math.round(cw.contextTokens / 1000) + 'K' : '?';
    const maxK = cw.maxContextTokens ? Math.round(cw.maxContextTokens / 1000) + 'K' : '200K';
    const cacheHit = cw.cacheHitPercent != null ? ` (${cw.cacheHitPercent}% cache)` : '';
    html += `<div class="context-gauge">
      <div class="context-gauge-bar"><div class="context-gauge-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="context-gauge-label">${pct}%</span>
    </div>
    <div style="font-size:8px;color:var(--text-muted);margin-top:1px">${tokensK} / ${maxK} tokens${cacheHit}</div>`;
  }
  if (cw.spineSkillCount != null) {
    const chipData = [
      { count: cw.spineWorkflowCount, label: 'workflows', items: cw.spineWorkflows },
      { count: cw.spineSkillCount, label: 'skills', items: cw.spineSkills },
      { count: cw.spineOverlayCount, label: 'overlays', items: cw.spineOverlays },
      { count: cw.spineContextCount, label: 'context', items: cw.spineContextFragments },
      { count: cw.spineInvariantCount, label: 'invariants', items: cw.spineInvariants },
      { count: cw.spineToolCount, label: 'tools', items: cw.spineTools },
    ].filter(d => d.count);
    if (chipData.length > 0) {
      html += `<div class="context-breakdown">${chipData.map(d => {
        if (d.items && d.items.length > 0) {
          const id = 'ctx-expand-' + d.label;
          const list = d.items.map(i => `<div class="ctx-expand-item">${esc(i)}</div>`).join('');
          return `<span class="ctx-chip ctx-chip-clickable" data-expand="${id}" onclick="event.stopPropagation();this.parentElement.querySelector('#${id}').classList.toggle('ctx-expanded')">${d.count} ${d.label}</span><div class="ctx-expand-list" id="${id}">${list}</div>`;
        }
        return `<span class="ctx-chip">${d.count} ${d.label}</span>`;
      }).join('')}</div>`;
    }
  }
  return html;
}

function focusTimelineEntry(group, timestamp) {
  const entries = Array.from(document.querySelectorAll('#timeline-list .tl-entry'));
  const match = entries.find((el) =>
    el.dataset.eventGroup === group &&
    el.dataset.eventType === 'hook' &&
    el.dataset.eventTime === String(timestamp));
  if (!match) return;

  const expandBtn = match.querySelector('.tl-expand-btn');
  if (expandBtn && expandBtn.textContent !== '[-]') {
    expandBtn.click();
  }

  match.classList.add('tl-entry-focus');
  match.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => match.classList.remove('tl-entry-focus'), 1600);
}

function openTimelineForEvent(group, timestamp) {
  switchToTab('observability');
  setTimelineFilter(group);
  updateTimeline();
  requestAnimationFrame(() => focusTimelineEntry(group, timestamp));
}

function updateDetailHooks(cw) {
  const hooksEl = document.getElementById('detail-hooks');
  if (!hooksEl) return;
  hooksEl.innerHTML = renderDetailHooks(cw);
}

function applyState(nextState) {
  state = nextState;
  updateTimeline();
  // Live-update coworkers tab sidebar
  if (typeof scheduleCwRefresh === 'function') scheduleCwRefresh();
  // Live-update detail panel if open
  if (selectedCoworker) {
    const updated = state.coworkers.find((c) => c.folder === selectedCoworker.folder);
    if (updated) {
      updateDetailHooks(updated);
      document.getElementById('detail-tool').textContent = updated.lastToolUse || '-';
      const statusEl = document.getElementById('detail-status');
      if (statusEl) statusEl.innerHTML = renderStatusBadge(updated.status);
      document.getElementById('detail-activity').textContent = updated.lastActivity ? timeAgo(updated.lastActivity) : 'Never';
      const subagentsEl = document.getElementById('detail-subagents');
      if (subagentsEl) subagentsEl.innerHTML = renderSubagentList(updated);
      const ctxEl = document.getElementById('detail-context');
      if (ctxEl) {
        const fill = ctxEl.querySelector('.context-gauge-fill');
        const label = ctxEl.querySelector('.context-gauge-label');
        if (fill && label && updated.contextUsagePercent != null) {
          const pct = updated.contextUsagePercent;
          fill.style.width = pct + '%';
          fill.style.background = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)';
          label.textContent = pct + '%';
        }
      }
    }
  }
}

async function pollState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return false;
    applyState(await res.json());
    return true;
  } catch {
    return false;
  }
}

function startPolling() {
  if (pollTimer) return;
  setLiveStatus('Polling Fallback', 'var(--yellow)');
  pollState();
  pollTimer = setInterval(async () => {
    const ok = await pollState();
    if (!ok) {
      setLiveStatus('Reconnecting...', 'var(--yellow)');
    }
  }, 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function connectLiveUpdates() {
  if (!('EventSource' in window)) {
    startPolling();
    return;
  }
  if (liveSource) liveSource.close();
  liveSource = new EventSource('/api/events');
  liveSource.onopen = () => {
    stopPolling();
    setLiveStatus('Connected', 'var(--green)');
  };
  liveSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        applyState(msg.data);
      }
    } catch {}
  };
  liveSource.onerror = () => {
    startPolling();
    setLiveStatus('Reconnecting...', 'var(--yellow)');
  };
}

// --- Tab switching ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchToTab(tab.dataset.tab);
  });
});

// ===================================================================
// TAB 1: PIXEL ART OFFICE (Tile-based with pixel-agents assets)
// ===================================================================

const canvas = document.getElementById('office-canvas');
const ctx = canvas.getContext('2d');
const officeRoot = document.getElementById('pixel-office');
const detailPanel = document.getElementById('detail-panel');

const TW = PixelSprites.TILE * Z; // 48px per tile at zoom 3

// --- Layout data (loaded from JSON) ---
let layoutData = null;
fetch('assets/default-layout-1.json')
  .then(r => r.json())
  .then(d => { layoutData = d; })
  .catch(() => {});

const FIRST_VIS_ROW = 10;

// Layout furniture type → PixelSprites key
const FURN_MAP = {
  TABLE_FRONT: 'tableFront', COFFEE_TABLE: 'coffeeTable',
  SOFA_FRONT: 'sofa', SOFA_BACK: 'sofaBack', SOFA_SIDE: 'sofaSide',
  HANGING_PLANT: 'hangingPlant', DOUBLE_BOOKSHELF: 'doubleBookshelf',
  SMALL_PAINTING: 'smallPainting', SMALL_PAINTING_2: 'smallPainting2',
  LARGE_PAINTING: 'largePainting', CLOCK: 'clock',
  PLANT: 'plant', PLANT_2: 'plant2', LARGE_PLANT: 'largePlant',
  COFFEE: 'coffee', BOOKSHELF: 'bookshelf', CACTUS: 'cactus',
  WHITEBOARD: 'whiteboard', POT: 'pot', BIN: 'bin',
  WOODEN_BENCH: 'woodenBench', CUSHIONED_BENCH: 'cushionedBench',
  WOODEN_CHAIR_SIDE: 'woodenChairSide',
  DESK_FRONT: 'desk', PC_FRONT_OFF: 'pcOff',
  PC_SIDE: 'pcSide', PC_BACK: 'pcBack',
  SMALL_TABLE_FRONT: 'smallTable', SMALL_TABLE_SIDE: 'smallTableSide',
};

// Desk slot positions in tile grid coordinates
// stationType: 'desk' = full desk+PC+chair drawn; 'kitchen'/'lounge' = character placed at position only (layout furniture already present)
const DESK_SLOTS = [
  // Left room — 4 front-facing desks
  { col: 2, row: 12, stationType: 'desk' },
  { col: 6, row: 12, stationType: 'desk' },
  { col: 2, row: 16, stationType: 'desk' },
  { col: 6, row: 16, stationType: 'desk' },
  // Kitchen — character stands in front of the table (pushed forward so not hidden behind it)
  { col: 13, row: 14, stationType: 'kitchen', facing: 'front' },
  // Lounge — characters stand in front of the sofas (pushed forward to avoid z-order overlap)
  { col: 13, row: 18, stationType: 'lounge', facing: 'right' },
  { col: 16, row: 18, stationType: 'lounge', facing: 'left' },
];

// Types that should be skipped from layout furniture (animated PCs are handled per-coworker)
const SKIP_LAYOUT_TYPES = new Set([
  'PC_FRONT_ON_1', 'PC_FRONT_ON_2', 'PC_FRONT_ON_3',
]);

// --- Canvas sizing ---
let needsResize = true;

function resizeCanvas() {
  const parent = canvas.parentElement;
  if (!parent) return false;
  const rect = parent.getBoundingClientRect();
  const bar = parent.querySelector('.office-bar');
  const barH = bar?.getBoundingClientRect().height || 28;
  const sideW = detailPanel.classList.contains('visible')
    ? detailPanel.getBoundingClientRect().width || 0 : 0;
  const w = Math.floor(rect.width - sideW);
  const h = Math.floor(rect.height - barH);
  if (w < 64 || h < 64) return false;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.marginRight = `${sideW}px`;
  return true;
}

function setDetailPanelOpen(isOpen) {
  detailPanel.classList.toggle('visible', isOpen);
  officeRoot.classList.toggle('detail-open', isOpen);
  needsResize = true;
}

// --- Character animation state ---
const charAnims = new Map();
function getCharAnim(key) {
  if (!charAnims.has(key)) {
    charAnims.set(key, {
      phase: 'walk', // 'walk' | 'sit'
      x: 0, y: 0,
      startX: 0, startY: 0,
      targetX: 0, targetY: 0,
      progress: 0,
      facing: 'front',
      inited: false,
      lastStatus: 'idle',
      startCueUntil: 0,
    });
  }
  return charAnims.get(key);
}

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

// --- Desk assignment ---
function getDeskAssignments() {
  const maxSlots = state.maxConcurrentContainers || DESK_SLOTS.length;
  const activeSlots = DESK_SLOTS.slice(0, Math.max(maxSlots, DESK_SLOTS.length));
  return state.coworkers.map((cw, i) => {
    const slot = activeSlots[i % activeSlots.length];
    const stationType = slot.stationType || 'desk';
    const facing = slot.facing || (stationType === 'desk' ? 'back' : 'front');
    return {
      cw,
      index: i,
      stationType,
      dCol: slot.col,
      dRow: slot.row,
      seatCol: slot.col + (stationType === 'desk' ? 1 : 0),
      seatRow: slot.row + (stationType === 'desk' ? 2 : 0),
      facing,
    };
  });
}

// --- Coordinate helpers ---
function tileXY(col, row, ox, oy) {
  return { x: ox + col * TW, y: oy + (row - FIRST_VIS_ROW) * TW };
}

// Tile type → solid fill color (matching pixel-agents screenshot)
const TILE_COLORS = {
  0: '#2a3548',  // wall — dark navy
  1: '#8b9aaa',  // main room floor — cool gray
  7: '#9a7a55',  // left room floor — warm brown wood
  9: '#6e8899',  // lounge floor — muted blue-gray
};
function tileColor(tileType) {
  return TILE_COLORS[tileType] || '#7a6a55';
}

function isDrawable(img) {
  return img && ((img.naturalWidth > 0) || (img.width > 0));
}

function roundedRectPath(context, x, y, width, height, radius) {
  if (typeof context.roundRect === 'function') { context.roundRect(x, y, width, height, radius); return; }
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
}

// --- Subagent helpers ---
function mapSubagentColor(agentType) {
  return SUBAGENT_TYPE_COLORS[agentType] || SUBAGENT_TYPE_COLORS.default;
}

function getActorCue(notification, anim) {
  const n = (notification || '').toLowerCase();
  if (!n) {
    if (anim?.startCueUntil && Date.now() < anim.startCueUntil) {
      return { label: '[x]', color: '#10b981', text: 'Started' };
    }
    return null;
  }
  if (/(approval|permission|confirm|allow this|allow access|accept)/.test(n)) {
    return { label: '?', color: '#f59e0b', text: 'Approval needed' };
  }
  if (/(waiting|input required|awaiting|need input|paused)/.test(n)) {
    return { label: '...', color: '#3b82f6', text: 'Waiting' };
  }
  if (/(blocked|failed|error|denied)/.test(n)) {
    return { label: '!', color: '#ef4444', text: 'Blocked' };
  }
  return null;
}

// --- Tile rendering ---
function renderTiles(ox, oy) {
  ctx.fillStyle = '#2d3a4a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!layoutData) return;

  const { tiles, tileColors, cols, rows } = layoutData;
  ctx.imageSmoothingEnabled = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const t = tiles[idx];
      if (t === 255) continue;
      const px = ox + c * TW;
      const py = oy + (r - FIRST_VIS_ROW) * TW;
      if (px + TW < 0 || px > canvas.width || py + TW < 0 || py > canvas.height) continue;

      // Try colorized floor tile (pixel-agents style HSL colorization)
      const hsbc = tileColors?.[idx];
      const colorized = hsbc ? PixelSprites.colorizeTile(t, hsbc) : null;
      if (colorized) {
        ctx.drawImage(colorized, px, py, TW, TW);
      } else {
        ctx.fillStyle = tileColor(t);
        ctx.fillRect(px, py, TW, TW);
      }
    }
  }
}

// --- Collect Z-sorted drawables ---
function collectDrawables(assignments, ox, oy) {
  const drawables = [];

  // Static furniture from layout (decorative items — skip desks/PCs, we place those per-coworker)
  if (layoutData?.furniture) {
    for (const item of layoutData.furniture) {
      const baseType = item.type.replace(':left', '').replace(/_FRONT_OFF$/, '').replace(/_FRONT$/, '').replace(/_SIDE$/, '').replace(/_BACK$/, '');
      if (SKIP_LAYOUT_TYPES.has(item.type) || SKIP_LAYOUT_TYPES.has(baseType)) continue;
      const key = FURN_MAP[item.type.replace(':left', '')] || FURN_MAP[baseType];
      if (!key) continue;
      const sprite = PixelSprites.getFurniture(key);
      const info = PixelSprites.getFurnitureInfo(key);
      if (!isDrawable(sprite) || !info) continue;
      const pos = tileXY(item.col, item.row, ox, oy);
      const w = info.w * Z, h = info.h * Z;
      const mirrored = item.type.endsWith(':left');
      const isWhiteboard = item.type === 'WHITEBOARD';
      const isClock = item.type === 'CLOCK';
      drawables.push({
        zY: pos.y + h,
        draw() {
          ctx.imageSmoothingEnabled = false;
          if (mirrored) {
            ctx.save();
            ctx.translate(pos.x + w, pos.y);
            ctx.scale(-1, 1);
            ctx.drawImage(sprite, 0, 0, w, h);
            ctx.restore();
          } else {
            ctx.drawImage(sprite, pos.x, pos.y, w, h);
          }
          // Render "NVIDIA" pixel art text on whiteboards
          if (isWhiteboard) drawSlangText(pos.x, pos.y, w, h);
          // Render live time on clock
          if (isClock) drawClockTime(pos.x, pos.y, w, h);
        },
      });
    }
  }

  // Per-coworker desk stations + characters
  for (const a of assignments) {
    addDeskDrawables(drawables, a, ox, oy);
  }

  return drawables;
}

function addDeskDrawables(drawables, a, ox, oy) {
  const { cw, dCol, dRow, seatCol, seatRow, facing, stationType } = a;
  const isActive = cw.status === 'active' || cw.status === 'working' || cw.status === 'thinking';

  if (!stationType || stationType === 'desk') {
    // Desk
    const deskSprite = PixelSprites.getFurniture('desk');
    if (isDrawable(deskSprite)) {
      const dp = tileXY(dCol, dRow, ox, oy);
      const dw = 48 * Z, dh = 32 * Z;
      drawables.push({ zY: dp.y + dh, draw() {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(deskSprite, dp.x, dp.y, dw, dh);
      }});
    }

    // PC on desk
    const pcSprite = isActive ? PixelSprites.getPcFrame(frame) : PixelSprites.getFurniture('pcOff');
    if (isDrawable(pcSprite)) {
      const pp = tileXY(dCol + 1, dRow, ox, oy);
      const pw = 16 * Z, ph = 32 * Z;
      drawables.push({ zY: pp.y + ph + 1, draw() {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(pcSprite, pp.x, pp.y, pw, ph);
      }});
    }

    // Coffee mug on desk
    const coffeeSprite = PixelSprites.getFurniture('coffee');
    if (isDrawable(coffeeSprite)) {
      const cp = tileXY(dCol + 2, dRow + 1, ox, oy);
      drawables.push({ zY: cp.y + 16 * Z + 2, draw() {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(coffeeSprite, cp.x, cp.y, 16 * Z, 16 * Z);
      }});
    }

    // Chair below desk
    const chairSprite = PixelSprites.getFurniture('chair');
    if (isDrawable(chairSprite)) {
      const chp = tileXY(seatCol, seatRow, ox, oy);
      drawables.push({ zY: chp.y + 16 * Z - 1, draw() {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(chairSprite, chp.x, chp.y, 16 * Z, 16 * Z);
      }});
    }
  }
  // Kitchen/lounge: no desk/PC/chair — layout furniture already provides the set pieces

  // Parent character
  addCharacterDrawable(drawables, cw, a, ox, oy, false, null);

  // Subagents
  const subs = cw.subagents || [];
  for (let si = 0; si < subs.length; si++) {
    addCharacterDrawable(drawables, cw, a, ox, oy, true, { sub: subs[si], index: si });
  }
}

function addCharacterDrawable(drawables, cw, assignment, ox, oy, isSub, subInfo) {
  const { dCol, dRow, seatCol, seatRow, facing, index: cwIndex } = assignment;
  const key = isSub ? `${cw.folder}:sub:${subInfo.sub.agentId}` : cw.folder;
  const anim = getCharAnim(key);

  // Determine target position
  let tgtCol, tgtRow, tgtFacing;
  if (isSub) {
    // Subagents stand beside the desk
    const si = subInfo.index;
    const side = si % 2 === 0 ? 'left' : 'right';
    tgtCol = side === 'left' ? dCol - 0.5 : dCol + 3.5;
    tgtRow = dRow + 1.5 + Math.floor(si / 2) * 1.5;
    tgtFacing = side === 'left' ? 'right' : 'left';
  } else {
    tgtCol = seatCol;
    tgtRow = seatRow;
    tgtFacing = facing;
  }

  const tgtPos = tileXY(tgtCol, tgtRow, ox, oy);
  const sittingOffset = isSub ? 0 : 6 * Z; // sit down into chair

  // Initialize animation on first frame
  if (!anim.inited) {
    const entry = tileXY(5, 21, ox, oy);
    anim.startX = entry.x;
    anim.startY = entry.y;
    anim.targetX = tgtPos.x;
    anim.targetY = tgtPos.y + sittingOffset;
    anim.x = entry.x;
    anim.y = entry.y;
    anim.phase = 'walk';
    anim.progress = 0;
    anim.inited = true;
  }

  // Track status changes for cue
  const status = isSub ? (subInfo.sub.status || 'idle') : cw.status;
  if (anim.lastStatus !== status) {
    if (status !== 'idle') anim.startCueUntil = Date.now() + 1800;
    anim.lastStatus = status;
  }

  // Update animation — L-shaped path: walk horizontally first, then vertically
  if (anim.phase === 'walk') {
    anim.progress += 0.025;
    if (anim.progress >= 1) {
      anim.phase = 'sit';
      anim.x = anim.targetX;
      anim.y = anim.targetY;
      anim.facing = tgtFacing;
    } else {
      // Phase 1 (0-0.4): walk horizontally to target column
      // Phase 2 (0.4-1): walk vertically to target row
      if (anim.progress < 0.4) {
        const t = anim.progress / 0.4;
        anim.x = lerp(anim.startX, anim.targetX, t);
        anim.y = anim.startY;
        const dx = anim.targetX - anim.x;
        anim.facing = Math.abs(dx) > 1 ? (dx < 0 ? 'left' : 'right') : 'front';
      } else {
        const t = (anim.progress - 0.4) / 0.6;
        anim.x = anim.targetX;
        anim.y = lerp(anim.startY, anim.targetY, t);
        anim.facing = anim.targetY < anim.startY ? 'back' : 'front';
      }
    }
  } else {
    // Snap to current target (desk may have shifted)
    anim.targetX = tgtPos.x;
    anim.targetY = tgtPos.y + sittingOffset;
    anim.x = anim.targetX;
    anim.y = anim.targetY;
    anim.facing = tgtFacing;
  }

  // Handle exiting subagents
  if (isSub && subInfo.sub.phase === 'leaving') {
    const exit = tileXY(5, 21, ox, oy);
    anim.targetX = exit.x;
    anim.targetY = exit.y;
    if (anim.phase === 'sit') {
      anim.phase = 'walk';
      anim.startX = anim.x;
      anim.startY = anim.y;
      anim.progress = 0;
    }
  }

  // Determine sprite state
  let charStatus;
  if (anim.phase === 'walk') {
    charStatus = 'walking';
  } else if (isSub) {
    charStatus = status === 'working' ? 'working' : status === 'thinking' ? 'thinking' : status === 'active' ? 'idle' : 'idle';
  } else {
    charStatus = status === 'working' ? 'working' : status === 'thinking' ? 'thinking' : status === 'active' ? 'working' : 'sitting';
  }

  const animRate = charStatus === 'walking' ? 4 : (charStatus === 'working' || charStatus === 'thinking') ? 8 : 0;
  let charIdx;
  if (isSub && subInfo?.sub?.agentId) {
    // Deterministic hash of agentId → consistent random character per subagent
    const id = String(subInfo.sub.agentId);
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
    charIdx = h % 6;
  } else {
    charIdx = PixelSprites.TYPE_CHAR_INDEX[cw.type] ?? 0;
  }
  const animFrames = PixelSprites.ANIM_FRAMES[charStatus] || PixelSprites.ANIM_FRAMES.idle;
  const frameNum = animRate > 0 ? Math.floor(frame / animRate) % animFrames.length : 0;
  const dir = anim.facing;
  const spriteFrame = PixelSprites.getCharFrame(charIdx, charStatus, dir, frameNum);

  const charW = PixelSprites.CHAR_FRAME_W * Z;
  const charH = PixelSprites.CHAR_FRAME_H * Z;
  const drawX = Math.round(anim.x);
  const drawY = Math.round(anim.y - charH + TW);
  const charZY = Math.round(anim.y) + TW;
  const notification = isSub ? (subInfo.sub.lastNotification || '') : (cw.lastNotification || '');
  const cue = getActorCue(notification, anim);
  const speech = isSub ? (subInfo.sub.lastToolUse || subInfo.sub.lastNotification || '') : (cw.lastToolUse || cw.currentTask || '');
  const isWorking = status === 'active' || status === 'working' || status === 'thinking';

  drawables.push({
    zY: charZY,
    cwIndex: cwIndex,
    isSub,
    draw() {
      if (!spriteFrame) return;
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      if (dir === 'left') {
        ctx.translate(drawX + charW, drawY);
        ctx.scale(-1, 1);
        ctx.drawImage(spriteFrame, 0, 0, charW, charH);
      } else {
        ctx.drawImage(spriteFrame, drawX, drawY, charW, charH);
      }
      ctx.restore();

      // Subagent type badge
      if (isSub) {
        const badgeColor = mapSubagentColor(subInfo.sub.agentType);
        ctx.fillStyle = '#0f172aEE';
        ctx.fillRect(drawX + 6, drawY - 8, 30, 10);
        ctx.strokeStyle = badgeColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(drawX + 6, drawY - 8, 30, 10);
        ctx.fillStyle = badgeColor;
        ctx.font = '8px "Courier New", monospace';
        ctx.fillText((subInfo.sub.agentType || 'agent').slice(0, 5).toUpperCase(), drawX + 9, drawY);
      }

      // Cue bubble
      if (cue) {
        drawCueBubble(drawX, drawY, cue);
      }
    },
    // Overlay info for post-draw pass
    overlayX: drawX, overlayY: drawY,
    speech: isWorking ? speech : '',
    speechColor: isSub ? mapSubagentColor(subInfo.sub?.agentType) : (cw.color || '#475569'),
  });
}

// --- Drawing helpers ---

function drawClockTime(bx, by, bw, bh) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${mm}`;
  const fontSize = Math.max(8, Math.round(Z * 4));
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Clock face is in the lower visible portion of the sprite (sprite may start above canvas)
  const visibleTop = Math.max(by, 0);
  const visibleBottom = by + bh;
  if (visibleBottom <= 0) return;
  const cx = bx + bw / 2;
  // Draw at 60% down from visible top (center of clock face area)
  const cy = visibleTop + (visibleBottom - visibleTop) * 0.4;
  // Background for readability
  const tw = ctx.measureText(timeStr).width;
  ctx.fillStyle = 'rgba(240,240,220,0.85)';
  ctx.fillRect(cx - tw / 2 - 1, cy - fontSize / 2 - 1, tw + 2, fontSize + 2);
  ctx.fillStyle = '#1a1a2e';
  ctx.fillText(timeStr, cx, cy);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// 5×5 pixel art font for "NVIDIA" — each letter is a 5-row bitmap
const NVIDIA_FONT = {
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001],
  V: [0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b11111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  A: [0b01110, 0b10001, 0b11111, 0b10001, 0b10001],
};

function drawSlangText(bx, by, bw, bh) {
  const letters = ['N','V','I','D','I','A'];
  const px = Math.max(2, Math.round(Z * 0.9)); // scale with zoom
  const gap = px;
  const lw = 5;
  const lh = 5;
  const totalW = letters.length * (lw * px + gap) - gap;
  const totalH = lh * px;

  // Center horizontally; draw at the VISIBLE (lower) portion of the sprite
  // Whiteboard is at row 9 — part may be above canvas (by < 0), so clamp
  const bottomEdge = by + bh;
  const startX = bx + Math.round((bw - totalW) / 2);
  // Position text near center of visible area
  const visibleTop = Math.max(by, 0);
  const startY = visibleTop + Math.round((bottomEdge - visibleTop - totalH) / 2);
  if (startY + totalH <= 0 || startY >= canvas.height) return; // fully off-screen

  // Draw background rectangle for contrast
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(startX - px, startY - px, totalW + px * 2, totalH + px * 2);

  for (let li = 0; li < letters.length; li++) {
    const bits = NVIDIA_FONT[letters[li]];
    const lx = startX + li * (lw * px + gap);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        if (bits[row] & (1 << (4 - col))) {
          ctx.fillStyle = '#76B900';
          ctx.fillRect(lx + col * px, startY + row * px, px, px);
        }
      }
    }
  }
}

function drawCueBubble(x, y, cue) {
  const width = cue.label.length > 1 ? 26 : 18;
  const height = 14;
  const bx = x + 8, by = y - 18;
  ctx.fillStyle = '#0f172aEE';
  ctx.strokeStyle = cue.color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  roundedRectPath(ctx, bx, by, width, height, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = cue.color;
  ctx.font = '9px "Courier New", monospace';
  ctx.fillText(cue.label, bx + 5, by + 10);
}

function drawSpeechBubble(x, y, text, color) {
  if (!text) return;
  const maxLen = 28;
  const display = text.length > maxLen ? text.slice(0, maxLen - 2) + '..' : text;
  ctx.font = '9px "Courier New", monospace';
  const w = ctx.measureText(display).width + 10;
  const h = 16;
  const bx = x - w / 2 + 24;
  const by = y - 8;
  ctx.fillStyle = '#0f172aCC';
  ctx.strokeStyle = color || '#475569';
  ctx.lineWidth = 1;
  ctx.beginPath();
  roundedRectPath(ctx, bx, by, w, h, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0f172aCC';
  ctx.beginPath();
  ctx.moveTo(bx + w / 2 - 3, by + h);
  ctx.lineTo(bx + w / 2, by + h + 4);
  ctx.lineTo(bx + w / 2 + 3, by + h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#E2E8F0';
  ctx.fillText(display, bx + 5, by + 11);
}

function drawNameplate(assignment, ox, oy, isHovered) {
  const { cw, dCol, dRow } = assignment;
  const pos = tileXY(dCol, dRow + 3, ox, oy);
  const plateW = 3 * TW;
  const plateY = pos.y;

  const childCount = (cw.subagents || []).length;
  const extra = childCount > 0 ? ` +${childCount}` : '';
  const baseName = cw.name + extra;
  const name = baseName.length > 18 ? baseName.slice(0, 16) + '..' : baseName;

  const dotColors = { idle: '#6B7280', active: '#3B82F6', working: '#10B981', thinking: '#F59E0B', error: '#EF4444' };
  const dotColor = dotColors[cw.status] || '#6B7280';

  // Status-colored background for at-a-glance visibility
  const hasCtxBar = cw.contextUsagePercent != null;
  const plateH = hasCtxBar ? 22 : 18;
  const bgColors = { active: '#3B82F630', working: '#10B98130', thinking: '#F59E0B30', error: '#EF444430' };
  const baseBg = bgColors[cw.status] || '#0f172aCC';
  ctx.fillStyle = isHovered ? '#0f172aEE' : baseBg;
  ctx.fillRect(pos.x - 4, plateY - 2, plateW + 8, plateH);
  if (isHovered) {
    ctx.strokeStyle = (cw.color || '#475569') + '80';
    ctx.lineWidth = 1;
    ctx.strokeRect(pos.x - 4, plateY - 2, plateW + 8, plateH);
  }

  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(pos.x + 4, plateY + 6, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = isHovered ? '#E2E8F0' : '#c8d4e0';
  ctx.font = '10px "Courier New", monospace';
  ctx.fillText(name, pos.x + 12, plateY + 9);

  // Unread badge — blue dot after name
  if (hasUnread(cw.folder)) {
    const nameW = ctx.measureText(name).width;
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(pos.x + 12 + nameW + 6, plateY + 6, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mini context gauge bar below name
  if (hasCtxBar) {
    const barY = plateY + 14;
    const barW = plateW;
    const pct = Math.min(cw.contextUsagePercent, 100);
    const fillW = barW * pct / 100;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(pos.x, barY, barW, 2);
    ctx.fillStyle = pct > 85 ? '#EF4444AA' : pct > 60 ? '#F59E0BAA' : '#10B981AA';
    ctx.fillRect(pos.x, barY, fillW, 2);
  }
}

// --- Hover/click hit testing ---
function getDeskHitRect(assignment, ox, oy) {
  const pos = tileXY(assignment.dCol, assignment.dRow, ox, oy);
  return {
    x: pos.x - 8,
    y: pos.y - 8,
    w: 3 * TW + 16,
    h: 4 * TW + 16,
  };
}

// --- Main draw ---
function drawOffice() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const assignments = getDeskAssignments();

  // Center the map in the viewport, scaling down to fit if needed
  const mapCols = layoutData?.cols || 21;
  const mapVisRows = layoutData ? (layoutData.rows - FIRST_VIS_ROW) : 12;
  const mapW = mapCols * TW;
  const mapH = mapVisRows * TW;
  const scale = Math.min(canvas.width / mapW, canvas.height / mapH, 1);
  const effW = canvas.width / scale;
  const effH = canvas.height / scale;
  const ox = Math.round((effW - mapW) / 2);
  const oy = Math.round((effH - mapH) / 2);
  ctx.save();
  ctx.scale(scale, scale);

  // 1. Tile grid
  renderTiles(ox, oy);

  // 2. Collect drawables (furniture + characters)
  const drawables = collectDrawables(assignments, ox, oy);

  // 3. Sort by zY (back-to-front)
  drawables.sort((a, b) => a.zY - b.zY);

  // 4. Draw all
  for (const d of drawables) d.draw();

  // 5. Overlays: nameplates, speech bubbles, hover highlights
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];
    const isHovered = hoveredDesk === i;
    const isSelected = selectedCoworker && selectedCoworker.folder === a.cw.folder;

    drawNameplate(a, ox, oy, isHovered);

    // Hover/selection outline on desk area
    if (isHovered || isSelected) {
      const hr = getDeskHitRect(a, ox, oy);
      ctx.strokeStyle = (a.cw.color || '#3B82F6') + (isHovered ? '50' : '80');
      ctx.lineWidth = 2;
      ctx.strokeRect(hr.x, hr.y, hr.w, hr.h);
    }
  }

  // Speech bubbles (draw on top of everything)
  const speechDrawables = drawables.filter(d => d.speech && !d.isSub);
  // Prefer subagent speech if available
  const subSpeakers = drawables.filter(d => d.speech && d.isSub);
  for (const d of subSpeakers) {
    drawSpeechBubble(d.overlayX, d.overlayY - 6, d.speech, d.speechColor);
  }
  for (const d of speechDrawables) {
    // Skip parent speech if a subagent is already speaking for this desk
    if (!subSpeakers.some(s => s.cwIndex === d.cwIndex)) {
      drawSpeechBubble(d.overlayX, d.overlayY - 6, d.speech, d.speechColor);
    }
  }

  // Empty state
  if (state.coworkers.length === 0) {
    ctx.fillStyle = '#94A3B8';
    ctx.font = '14px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No coworkers online', canvas.width / 2, canvas.height / 2 - 8);
    ctx.font = '11px "Courier New", monospace';
    ctx.fillStyle = '#64748B';
    ctx.fillText('Create one from the Coworkers tab', canvas.width / 2, canvas.height / 2 + 12);
    ctx.textAlign = 'left';
  }

  ctx.restore();

  // Store assignments for mouse hit testing
  _lastAssignments = assignments;
  _lastOx = ox;
  _lastOy = oy;
  _lastScale = scale;
}

let _lastAssignments = [];
let _lastOx = 0, _lastOy = 0, _lastScale = 1;

// --- Canvas tooltip ---
const canvasTooltip = document.createElement('div');
canvasTooltip.style.cssText = 'position:absolute;display:none;pointer-events:none;background:#0f172aEE;border:1px solid #475569;border-radius:4px;padding:5px 8px;font-size:10px;color:#E2E8F0;font-family:"Courier New",monospace;white-space:nowrap;z-index:100;line-height:1.5';
canvas.parentElement.style.position = 'relative';
canvas.parentElement.appendChild(canvasTooltip);

// --- Legend toggle ---
document.getElementById('legend-toggle')?.addEventListener('click', () => {
  const legend = document.getElementById('office-legend');
  if (legend) legend.style.display = legend.style.display === 'none' ? 'block' : 'none';
});

// --- Mouse ---
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  hoveredDesk = -1;
  for (let i = 0; i < _lastAssignments.length; i++) {
    const hr = getDeskHitRect(_lastAssignments[i], _lastOx, _lastOy);
    if (mx >= hr.x && mx <= hr.x + hr.w && my >= hr.y && my <= hr.y + hr.h) {
      hoveredDesk = i;
      break;
    }
  }
  canvas.style.cursor = hoveredDesk >= 0 ? 'pointer' : 'default';

  // Update tooltip
  if (hoveredDesk >= 0) {
    const cw = state.coworkers[hoveredDesk];
    const [statusColor, statusLabel] = getStatusConfig(cw.status);
    const activity = cw.lastActivity ? timeAgo(cw.lastActivity) : 'no activity';
    const tool = cw.lastToolUse ? `Tool: ${cw.lastToolUse}` : '';
    const subs = (cw.subagents || []).length;
    const subsLine = subs > 0 ? `\nSubagents: ${subs}` : '';
    canvasTooltip.innerHTML = `<strong>${esc(cw.name)}</strong> <span style="color:${statusColor}">${statusLabel}</span>\n${activity}${tool ? '\n' + tool : ''}${subsLine}`.replace(/\n/g, '<br>');
    canvasTooltip.style.display = 'block';
    canvasTooltip.style.left = (mx + 16) + 'px';
    canvasTooltip.style.top = (my + 16) + 'px';
    // Keep tooltip inside canvas bounds
    const ttRect = canvasTooltip.getBoundingClientRect();
    const parentRect = canvas.parentElement.getBoundingClientRect();
    if (ttRect.right > parentRect.right) canvasTooltip.style.left = (mx - ttRect.width - 8) + 'px';
    if (ttRect.bottom > parentRect.bottom) canvasTooltip.style.top = (my - ttRect.height - 8) + 'px';
  } else {
    canvasTooltip.style.display = 'none';
  }
});

canvas.addEventListener('mouseleave', () => {
  canvasTooltip.style.display = 'none';
});

canvas.addEventListener('click', () => {
  if (hoveredDesk >= 0) {
    selectedCoworker = state.coworkers[hoveredDesk];
    showDetailPanel(selectedCoworker);
  } else {
    selectedCoworker = null;
    setDetailPanelOpen(false);
  }
});

document.getElementById('detail-close').addEventListener('click', () => {
  selectedCoworker = null;
  setDetailPanelOpen(false);
});

// --- Detail panel ---
async function showDetailPanel(cw) {
  setDetailPanelOpen(true);
  document.getElementById('detail-name').textContent = cw.name;
  document.getElementById('detail-status').innerHTML = renderStatusBadge(cw.status);
  document.getElementById('detail-activity').textContent = cw.lastActivity ? timeAgo(cw.lastActivity) : 'Never';
  document.getElementById('detail-tool').textContent = cw.lastToolUse || '-';
  document.getElementById('detail-subagents').innerHTML = renderSubagentList(cw);

  // Tasks for this coworker
  const tasksEl = document.getElementById('detail-tasks-list');
  const cwTasks = (state.tasks || []).filter(t => t.group_folder === cw.folder);
  if (cwTasks.length === 0) {
    tasksEl.textContent = 'None';
  } else {
    tasksEl.innerHTML = cwTasks.map(t => {
      const label = t.prompt ? t.prompt.split('\n')[0].substring(0, 40) : '';
      const badge = t.status === 'active' ? '🟢' : t.status === 'paused' ? '⏸️' : '⚪';
      const sched = t.schedule_type === 'cron' ? t.schedule_value : t.schedule_type;
      const shortId = t.id.replace('task-', '').substring(0, 10);
      return `<div title="${esc(t.prompt?.substring(0, 200) || '')}" style="margin-bottom:2px">${badge} <span style="color:var(--accent)">${esc(shortId)}</span> <span style="color:var(--text-muted)">${esc(sched)}</span> ${esc(label)}</div>`;
    }).join('');
    tasksEl.style.cursor = 'pointer';
    tasksEl.title = 'Click to view in Admin > Tasks';
    tasksEl.onclick = () => {
      document.querySelector('[data-tab="admin"]')?.click();
      setTimeout(() => document.querySelector('[data-panel="admin-tasks"]')?.click(), 300);
    };
  }

  // Context indicator
  const ctxField = document.getElementById('detail-context-field');
  const ctxEl = document.getElementById('detail-context');
  const ctxHtml = renderContextIndicator(cw);
  if (ctxHtml) { ctxField.style.display = ''; ctxEl.innerHTML = ctxHtml; }
  else { ctxField.style.display = 'none'; }

  // Session ID from latest hook event
  const sessionEl = document.getElementById('detail-session');
  const groupEvents = (state.hookEvents || []).filter(e => e.group === cw.folder);
  const lastSessionEvent = groupEvents.filter(e => e.session_id).slice(-1)[0];
  if (lastSessionEvent?.session_id) {
    const sid = lastSessionEvent.session_id;
    sessionEl.innerHTML = `<a href="#" class="tl-session-link" data-session="${esc(sid)}" data-group="${esc(cw.folder)}" style="color:var(--accent)">${esc(sid.slice(0, 12))}...</a>`;
    sessionEl.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelector('[data-tab="observability"]')?.click();
      setTimeout(() => openSessionFlowById(cw.folder, sid), 300);
    });
  } else {
    sessionEl.textContent = '-';
  }

  const memEl = document.getElementById('detail-memory');
  memEl.innerHTML = '<span style="color:var(--text-muted)">Loading...</span>';
  try {
    const res = await fetch(`/api/memory/${cw.folder}`);
    if (res.ok) {
      memEl.innerHTML = renderMarkdown(await res.text());
    } else {
      memEl.textContent = '(no CLAUDE.md)';
    }
  } catch { memEl.textContent = '(error)'; }

  const memToggle = document.getElementById('memory-toggle');
  if (memToggle) {
    memToggle.textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
    memToggle.onclick = () => {
      memEl.classList.toggle('expanded');
      memToggle.textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
    };
  }

  const timelineBtn = document.getElementById('detail-view-timeline');
  if (timelineBtn) {
    timelineBtn.onclick = () => {
      setTimelineFilter(cw.folder);
      switchToTab('observability');
    };
  }

  const coworkerBtn = document.getElementById('detail-view-coworker');
  if (coworkerBtn) {
    coworkerBtn.onclick = () => {
      document.querySelector('[data-tab="coworkers"]')?.click();
      setTimeout(() => selectCoworker(cw.folder), 300);
    };
  }

  const hooksEl = document.getElementById('detail-hooks');
  hooksEl.innerHTML = renderDetailHooks(cw);
}

// Reuse the richer md() renderer (defined below esc/escAttr) for all markdown
function renderMarkdown(text) { return md(text); }

// Timeline filter management
function setTimelineFilter(group) {
  timelineFilter = group || null;
  timelineNoMoreEvents = false;
  timelineDisplayLimit = 200;
  timelineOlderEvents = [];
  const filterBar = document.getElementById('timeline-filter-bar');
  if (filterBar) {
    if (timelineFilter) {
      filterBar.style.display = 'flex';
      filterBar.querySelector('.filter-group').textContent = timelineFilter;
    } else {
      filterBar.style.display = 'none';
    }
  }
  updateTimeline();
}

function clearTimelineFilter() {
  setTimelineFilter(null);
}

// --- Status bar ---
function updateStatusBar() {
  const c = { active: 0, working: 0, thinking: 0, idle: 0, error: 0 };
  for (const cw of state.coworkers) c[cw.status] = (c[cw.status] || 0) + 1;
  const total = state.coworkers.length;
  document.getElementById('stat-working').textContent = c.working + c.active;
  document.getElementById('stat-thinking').textContent = c.thinking;
  document.getElementById('stat-idle').textContent = c.idle;
  document.getElementById('stat-error').textContent = c.error;
  document.getElementById('stat-time').textContent = new Date().toLocaleTimeString();
  const headerMap = {
    'hdr-actors-total': total,
    'hdr-actors-working': c.working + c.active,
    'hdr-actors-thinking': c.thinking,
    'hdr-actors-idle': c.idle,
    'hdr-actors-error': c.error,
  };
  for (const [id, value] of Object.entries(headerMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }
}

// --- Animation loop ---
function tick() {
  frame++;
  if (needsResize) {
    needsResize = !resizeCanvas();
  }
  drawOffice();
  updateStatusBar();
  if (selectedCoworker) {
    const u = state.coworkers.find((c) => c.folder === selectedCoworker.folder);
    if (u) selectedCoworker = u;
  }
}

function animate() {
  needsResize = true;
  tick();
  requestAnimationFrame(animate);
}

// ===================================================================
// TAB 2: TIMELINE / AUDIT LOG (debug mode, event history)
// ===================================================================

// Fetch messages periodically for timeline integration
async function fetchMessages() {
  try {
    const res = await fetch('/api/messages', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      cachedMessages = data.messages || data;
    }
  } catch { /* ignore */ }
}
// Fetch messages every 5s
setInterval(fetchMessages, 5000);
fetchMessages();

// Delegated handler for "Load older events" — survives timeline rebuilds
let timelineLoadingMore = false;
document.getElementById('timeline-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tl-load-more');
  if (!btn || btn.disabled || timelineLoadingMore) return;
  const container = document.getElementById('timeline-list');
  const entries = container.querySelectorAll('.tl-entry');
  const lastEntry = entries[entries.length - 1];
  const oldest = lastEntry?.dataset?.eventTime;
  if (!oldest) return;
  btn.textContent = 'Loading...';
  btn.disabled = true;
  timelineLoadingMore = true;
  try {
    const params = new URLSearchParams({ before: oldest, limit: '100' });
    if (timelineFilter) params.set('group', timelineFilter);
    const res = await fetch(`/api/hook-events/history?${params}`);
    const rows = await res.json();
    if (rows.length === 0) {
      timelineNoMoreEvents = true;
      btn.textContent = 'No older events';
      return;
    }
    for (const row of rows) {
      timelineOlderEvents.push({
        group: row.group_folder, event: row.event, tool: row.tool || undefined,
        tool_use_id: row.tool_use_id || undefined, message: row.message || undefined,
        tool_input: row.tool_input || undefined, tool_response: row.tool_response || undefined,
        session_id: row.session_id || undefined, agent_id: row.agent_id || undefined,
        agent_type: row.agent_type || undefined, timestamp: row.timestamp,
      });
    }
    timelineDisplayLimit += rows.length;
    // Preserve scroll position across DOM rebuild
    const scrollParent = container.closest('.panel-body') || container.parentElement;
    const scrollTop = scrollParent ? scrollParent.scrollTop : 0;
    const scrollHeight = scrollParent ? scrollParent.scrollHeight : 0;
    updateTimeline();
    // Restore: new content was appended at bottom, so keep scroll at same position
    if (scrollParent) {
      const newScrollHeight = scrollParent.scrollHeight;
      scrollParent.scrollTop = scrollTop + (newScrollHeight - scrollHeight);
    }
  } catch { btn.textContent = 'Error loading'; }
  finally { timelineLoadingMore = false; }
});

function updateTimeline() {
  // Don't overwrite when viewing a session flow
  if (sessionFlowMode) return;

  document.getElementById('obs-total-coworkers').textContent = state.coworkers.length;
  document.getElementById('obs-total-tasks').textContent = state.tasks.length;
  document.getElementById('obs-total-runs').textContent = state.taskRunLogs.length;

  const successes = state.taskRunLogs.filter((l) => l.status === 'success').length;
  const total = state.taskRunLogs.length;
  document.getElementById('obs-success-rate').textContent = total > 0 ? Math.round((successes / total) * 100) + '%' : '-';

  const durations = state.taskRunLogs.filter((l) => l.duration_ms).map((l) => l.duration_ms);
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  document.getElementById('obs-avg-duration').textContent = avg > 0 ? formatDuration(avg) : '-';

  // Merge events: tasks, hooks, and messages
  const timeline = [];
  for (const log of state.taskRunLogs) {
    const task = state.tasks.find((t) => t.id === log.task_id);
    timeline.push({
      time: new Date(log.run_at).getTime(),
      type: 'task-run',
      group: task?.group_folder || '?',
      iconColor: log.status === 'success' ? 'var(--green)' : log.status === 'error' ? 'var(--red)' : 'var(--yellow)',
      title: `Task ${log.status}`,
      detail: `${formatDuration(log.duration_ms)} — ${(log.result || log.error || '').slice(0, 100)}`,
      prompt: task?.prompt || '',
      badge: 'TASK',
      badgeClass: 'tl-type-task-run',
    });
  }
  // Merge live hook events with loaded-older events (deduplicate by timestamp+group+event)
  const seenHookKeys = new Set();
  const allHookEvents = [];
  for (const ev of state.hookEvents) {
    const key = `${ev.timestamp}|${ev.group}|${ev.event}|${ev.tool_use_id || ''}`;
    seenHookKeys.add(key);
    allHookEvents.push(ev);
  }
  for (const ev of timelineOlderEvents) {
    const key = `${ev.timestamp}|${ev.group}|${ev.event}|${ev.tool_use_id || ''}`;
    if (!seenHookKeys.has(key)) allHookEvents.push(ev);
  }

  // Build a map of PreToolUse timestamps by tool_use_id for duration calculation
  const preToolTimes = new Map();
  for (const ev of allHookEvents) {
    if (ev.event === 'PreToolUse' && ev.tool_use_id) {
      preToolTimes.set(ev.tool_use_id, ev.timestamp);
    }
  }

  for (const ev of allHookEvents) {
    // Skip PreToolUse from timeline display (used for pairing only)
    if (ev.event === 'PreToolUse') continue;

    // Color-code by event type
    let iconColor = 'var(--yellow)';
    let badge = 'HOOK';
    let badgeClass = 'tl-type-hook';
    let duration = null;
    if (ev.event === 'PostToolUseFailure') {
      iconColor = 'var(--yellow)';
      badge = 'WARN';
      badgeClass = 'tl-type-warning';
    } else if (ev.event === 'SubagentStart' || ev.event === 'SubagentStop') {
      iconColor = 'var(--purple)';
      badge = 'AGENT';
      badgeClass = 'tl-type-subagent';
    } else if (ev.event === 'SessionStart') {
      iconColor = 'var(--green)';
      badge = 'SESSION';
      badgeClass = 'tl-type-session';
    } else if (ev.event === 'UserPromptSubmit') {
      iconColor = '#06b6d4';
      badge = 'PROMPT';
      badgeClass = 'tl-type-prompt';
    } else if (ev.event === 'PreCompact') {
      iconColor = '#f97316';
      badge = 'COMPACT';
      badgeClass = 'tl-type-compact';
    } else if (ev.event === 'Stop' || ev.event === 'SessionEnd') {
      iconColor = 'var(--text-muted)';
      badge = 'STOP';
      badgeClass = 'tl-type-stop';
    }

    // Compute duration for PostToolUse by pairing with PreToolUse
    if ((ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure') && ev.tool_use_id) {
      const preTs = preToolTimes.get(ev.tool_use_id);
      if (preTs) duration = ev.timestamp - preTs;
    }

    timeline.push({
      time: ev.timestamp,
      type: 'hook',
      group: ev.group || '?',
      iconColor,
      title: ev.tool || ev.event || 'event',
      detail: ev.message || '',
      prompt: '',
      badge,
      badgeClass,
      toolInput: ev.tool_input || '',
      toolResponse: ev.tool_response || '',
      duration,
      sessionId: ev.session_id || '',
    });
  }

  // Add messages from SQLite
  for (const msg of cachedMessages) {
    timeline.push({
      time: new Date(msg.timestamp).getTime(),
      type: 'message',
      group: msg.group_folder || '?',
      iconColor: msg.direction === 'incoming' ? 'var(--accent)' : 'var(--green)',
      title: msg.direction === 'incoming' ? 'Message In' : 'Reply',
      detail: (msg.body || '').slice(0, 200),
      prompt: '',
      badge: 'MSG',
      badgeClass: 'tl-type-message',
    });
  }

  timeline.sort((a, b) => b.time - a.time);

  // Apply filter
  const filtered = timelineFilter
    ? timeline.filter((ev) => ev.group === timelineFilter)
    : timeline;

  const container = document.getElementById('timeline-list');

  // Snapshot expanded IDs before rebuild
  const expandedIds = new Set();
  container.querySelectorAll('.tl-expand-content[style*="block"]').forEach((el) => {
    expandedIds.add(el.id);
  });

  container.innerHTML = filtered.slice(0, timelineDisplayLimit).map((ev, idx) => {
    const gc = getGroupColor(ev.group);
    const hasExpand = ev.toolInput || ev.toolResponse;
    const expandId = `tl-expand-${idx}`;
    return `<div class="tl-entry" data-event-group="${escAttr(ev.group)}" data-event-time="${String(ev.time)}" data-event-type="${escAttr(ev.type)}">
      <div class="tl-time">${formatTimeFull(ev.time)}</div>
      <div class="tl-line"><div class="tl-dot" style="background:${ev.iconColor}"></div><div class="tl-connector"></div></div>
      <div class="tl-content">
        <div class="tl-header">
          <span class="tl-group tl-group-link" style="color:${gc}" data-group="${escAttr(ev.group)}">${esc(ev.group)}</span>
          <span class="tl-type ${ev.badgeClass || 'tl-type-hook'}">${ev.badge || 'HOOK'}</span>
          <span class="tl-title">${esc(ev.title)}</span>
          ${ev.duration != null ? `<span class="tl-duration">${formatDuration(ev.duration)}</span>` : ''}
          ${ev.sessionId ? `<span class="tl-session-link" data-session-id="${escAttr(ev.sessionId)}" data-session-group="${escAttr(ev.group)}">${ev.sessionId.slice(0, 8)}</span>` : ''}
          ${hasExpand ? `<button class="tl-expand-btn" data-target="${expandId}">[+]</button>` : ''}
        </div>
        ${ev.prompt ? `<div class="tl-prompt">${esc(ev.prompt.slice(0, 120))}</div>` : ''}
        <div class="tl-detail">${esc(ev.detail)}</div>
        ${hasExpand ? `<div class="tl-expand-content" id="${expandId}" style="display:none">
          ${ev.toolInput ? `<div class="tl-code-block"><label>Tool Input</label><pre>${esc(ev.toolInput)}</pre></div>` : ''}
          ${ev.toolResponse ? `<div class="tl-code-block"><label>Tool Response</label><pre>${esc(ev.toolResponse)}</pre></div>` : ''}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  if (filtered.length === 0) {
    container.innerHTML = '<div class="tl-empty">No events yet. Spawn a coworker or schedule a task.</div>';
  }

  // "Load More" button — rendered as HTML, handler via delegation
  if (filtered.length > 0) {
    container.insertAdjacentHTML(
      'beforeend',
      timelineNoMoreEvents
        ? '<button class="tl-load-more" disabled style="display:block;margin:12px auto;padding:6px 16px;background:var(--bg-card);border:1px solid var(--border);color:var(--text-dim);cursor:not-allowed;font-family:var(--font);font-size:10px;border-radius:4px;opacity:0.7;">No older events</button>'
        : '<button class="tl-load-more" style="display:block;margin:12px auto;padding:6px 16px;background:var(--bg-card);border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:var(--font);font-size:10px;border-radius:4px;">Load older events</button>',
    );
  }

  // Restore expanded state after rebuild
  for (const id of expandedIds) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'block';
      const btn = container.querySelector(`[data-target="${id}"]`);
      if (btn) btn.textContent = '[-]';
    }
  }

  drawSparkline();
}

function drawSparkline() {
  const tc = document.getElementById('sparkline-canvas');
  if (!tc?.parentElement?.clientWidth) return;
  tc.width = tc.parentElement.clientWidth - 4;
  tc.height = 48;
  const tctx = tc.getContext('2d');
  tctx.clearRect(0, 0, tc.width, tc.height);
  if (state.taskRunLogs.length === 0) return;

  const now = Date.now(), hours = 24, bucketMs = 3600000;
  const buckets = new Array(hours).fill(0), errBuckets = new Array(hours).fill(0);
  for (const log of state.taskRunLogs) {
    const bucket = hours - 1 - Math.floor((now - new Date(log.run_at).getTime()) / bucketMs);
    if (bucket >= 0 && bucket < hours) {
      buckets[bucket]++;
      if (log.status === 'error') errBuckets[bucket]++;
    }
  }
  const max = Math.max(...buckets, 1);
  const barW = Math.max(2, (tc.width - 4) / hours - 1);
  for (let i = 0; i < hours; i++) {
    const x = 2 + i * (barW + 1);
    tctx.fillStyle = '#3B82F660';
    tctx.fillRect(x, tc.height - 4 - (buckets[i] / max) * 40, barW, (buckets[i] / max) * 40);
    if (errBuckets[i] > 0) {
      tctx.fillStyle = '#EF444480';
      tctx.fillRect(x, tc.height - 4 - (errBuckets[i] / max) * 40, barW, (errBuckets[i] / max) * 40);
    }
  }
  tctx.fillStyle = '#64748B';
  tctx.font = '8px "Courier New", monospace';
  tctx.fillText('24h', 2, 8);
  tctx.fillText('now', tc.width - 18, 8);
}

function getGroupColor(f) {
  const c = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#14B8A6','#F97316'];
  let h = 0;
  for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) & 0xFFFF;
  return c[h % c.length];
}

// --- Helpers ---
function timeAgo(v) {
  const d = Date.now() - (typeof v === 'number' ? v : new Date(v).getTime());
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}
function formatTime(v) {
  const d = new Date(typeof v === 'number' ? v : v);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
function formatTimeFull(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
function formatDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Lightweight markdown → HTML for chat bubbles. Handles the subset agents actually use. */
function md(s) {
  let h = esc(s);
  // Fenced code blocks: ```...```
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  // Inline code: `...`
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Headings: ## ...
  h = h.replace(/^#{1,4}\s+(.+)$/gm, (_m, t) => `<strong>${t}</strong>`);
  // Horizontal rules: --- or ***
  h = h.replace(/^[-*]{3,}\s*$/gm, '<hr>');
  // Bold: **text** or *text* (single asterisk = WhatsApp bold)
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<strong>$1</strong>');
  // Italic: _text_
  h = h.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
  // Links: [text](url)
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bare URLs
  h = h.replace(/(?<!")(?<!=)(https?:\/\/[^\s<)"]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // Tables: detect | header | ... | pattern and convert
  h = h.replace(/((?:^\|.+\|[ \t]*\n)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    // Skip separator rows (|---|---|)
    const dataRows = rows.filter(r => !/^\|[\s\-:|]+\|$/.test(r));
    if (dataRows.length === 0) return block;
    const parseRow = (r) => r.split('|').slice(1, -1).map(c => c.trim());
    let t = '<table>';
    dataRows.forEach((r, i) => {
      const cells = parseRow(r);
      const tag = i === 0 ? 'th' : 'td';
      t += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    return t + '</table>';
  });
  // List items: lines starting with - or • (preserve indent)
  h = h.replace(/^(\s*)[•\-]\s+(.+)$/gm, '$1<li>$2</li>');
  // Wrap consecutive <li> in <ul>
  h = h.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');
  // Paragraphs: double newline
  h = h.replace(/\n{2,}/g, '</p><p>');
  // Single newlines → <br> (but not inside <pre>)
  h = h.replace(/(?<!<\/pre>)\n/g, '<br>');
  return `<p>${h}</p>`;
}
function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMessageAttachmentsHtml(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const items = attachments.map((attachment) => {
    if (!attachment || !attachment.url || !attachment.name) return '';
    if (attachment.isImage) {
      return `<a href="${escAttr(attachment.url)}" target="_blank" rel="noopener" style="display:inline-flex;flex-direction:column;gap:4px;text-decoration:none;color:inherit">
        <img src="${escAttr(attachment.url)}" alt="${escAttr(attachment.name)}" style="max-width:220px;max-height:160px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#111;object-fit:cover" />
        <span style="font-size:10px;color:#9ca3af">${esc(attachment.name)}</span>
      </a>`;
    }
    return `<a href="${escAttr(attachment.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;text-decoration:none;color:inherit;background:rgba(255,255,255,0.03)">
      <span style="font-size:14px">📎</span>
      <span style="font-size:11px">${esc(attachment.name)}</span>
    </a>`;
  }).filter(Boolean);
  if (items.length === 0) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">${items.join('')}</div>`;
}

function renderMessageMetaSuffix(m) {
  const parts = [];
  if (m.edited) parts.push('<span style="font-size:7px;color:#9ca3af;font-style:italic">edited</span>');
  if (Array.isArray(m.reactions) && m.reactions.length > 0) {
    parts.push(`<span style="font-size:10px">${esc(m.reactions.join(' '))}</span>`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

// ===================================================================
// SESSION FLOW VIEW
// ===================================================================

async function fetchSessions() {
  try {
    const res = await fetch('/api/hook-events/sessions');
    if (res.ok) cachedSessions = await res.json();
  } catch { /* ignore */ }
  updateSessionSelector();
}

function updateSessionSelector() {
  const sel = document.getElementById('session-select');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">Timeline view (all events)</option>';
  for (const s of cachedSessions) {
    const ts = formatTimeFull(s.first_ts);
    const label = `${s.group_folder} | ${ts} | ${s.event_count} events | ${s.session_id.slice(0, 12)}`;
    sel.innerHTML += `<option value="${escAttr(s.session_id)}" data-group="${escAttr(s.group_folder)}">${esc(label)}</option>`;
  }
  if (currentVal) sel.value = currentVal;
}

// Fetch sessions periodically
setInterval(fetchSessions, 10000);
fetchSessions();

document.getElementById('session-select')?.addEventListener('change', (e) => {
  const sessionId = e.target.value;
  if (!sessionId) {
    exitSessionFlow();
    return;
  }
  const opt = e.target.selectedOptions[0];
  const group = opt?.dataset?.group || '';
  enterSessionFlow(group, sessionId);
});

document.getElementById('session-back-btn')?.addEventListener('click', () => {
  exitSessionFlow();
});

async function enterSessionFlow(group, sessionId) {
  sessionFlowMode = true;
  timelineNoMoreEvents = false;
  timelineDisplayLimit = 200;
  timelineOlderEvents = [];
  document.getElementById('session-back-btn').style.display = 'inline-block';
  document.getElementById('timeline-filter-bar').style.display = 'none';
  const container = document.getElementById('timeline-list');
  container.innerHTML = '<div class="tl-empty">Loading session flow...</div>';

  try {
    const params = new URLSearchParams({ session_id: sessionId });
    if (group) params.set('group', group);
    const res = await fetch(`/api/hook-events/session-flow?${params}`);
    if (!res.ok) throw new Error('fetch failed');
    sessionFlowData = await res.json();
    renderSessionFlow(sessionFlowData.entries);
  } catch {
    container.innerHTML = '<div class="tl-empty">Failed to load session flow.</div>';
  }
}

function exitSessionFlow() {
  sessionFlowMode = false;
  sessionFlowData = null;
  timelineNoMoreEvents = false;
  timelineDisplayLimit = 200;
  timelineOlderEvents = [];
  document.getElementById('session-back-btn').style.display = 'none';
  document.getElementById('session-select').value = '';
  updateTimeline();
}

function renderSessionFlow(entries) {
  const container = document.getElementById('timeline-list');
  if (!entries || entries.length === 0) {
    container.innerHTML = '<div class="tl-empty">No events in this session.</div>';
    return;
  }
  container.innerHTML = entries.map((e, i) => renderFlowEntry(e, i, 0)).join('');
}

function renderFlowEntry(entry, idx, depth) {
  const prefix = `flow-${depth}-${idx}`;
  if (entry.type === 'session_start') {
    const source = entry.extra?.source || 'new';
    return `<div class="flow-session-marker">
      <span class="flow-label">SESSION START</span>
      <span>${esc(source)}</span>
      <span style="color:var(--text-muted);font-size:9px">${formatTimeFull(entry.timestamp)}</span>
    </div>`;
  }
  if (entry.type === 'session_end') {
    const toolCount = entry.extra?.tool_count || '';
    const filesMod = entry.extra?.files_modified || '';
    const stats = [toolCount ? `${toolCount} tool calls` : '', filesMod ? `${filesMod} files modified` : ''].filter(Boolean).join(' | ');
    return `<div class="flow-session-marker end">
      <span class="flow-label">STOP</span>
      <span style="color:var(--text-muted)">${stats || 'session ended'}</span>
      <span style="color:var(--text-muted);font-size:9px">${formatTimeFull(entry.timestamp)}</span>
    </div>`;
  }
  if (entry.type === 'user_prompt') {
    return `<div class="flow-user-prompt">
      <span class="flow-label">PROMPT</span>
      <div class="flow-text">${esc(entry.message || '')}</div>
      <span style="color:var(--text-muted);font-size:9px;flex-shrink:0">${formatTimeFull(entry.timestamp)}</span>
    </div>`;
  }
  if (entry.type === 'tool_call') {
    const durStr = entry.duration != null ? formatDuration(entry.duration) : '';
    const inputPreview = (entry.tool_input || '').slice(0, 100);
    const outputPreview = (entry.tool_response || '').slice(0, 100);
    const hasInput = !!entry.tool_input;
    const hasOutput = !!entry.tool_response;
    return `<div class="flow-tool-call ${entry.failed ? 'failed' : ''}">
      <div class="flow-tool-header">
        <span style="color:var(--text-muted);font-size:9px">${formatTimeFull(entry.timestamp)}</span>
        <span class="flow-tool-name">${esc(entry.tool || '?')}</span>
        ${durStr ? `<span class="flow-duration">${durStr}</span>` : ''}
        ${entry.failed ? '<span style="color:var(--red);font-size:9px">FAILED</span>' : ''}
      </div>
      ${hasInput ? `<div class="flow-tool-io">
        <label>Input:</label>
        <span class="flow-preview">${esc(inputPreview)}</span>
        ${entry.tool_input.length > 100 ? `<button class="flow-expand-btn" data-target="${prefix}-in">[+]</button>` : ''}
        <pre class="flow-expanded-content" id="${prefix}-in">${esc(entry.tool_input)}</pre>
      </div>` : ''}
      ${hasOutput ? `<div class="flow-tool-io">
        <label>Output:</label>
        <span class="flow-preview">${esc(outputPreview)}</span>
        ${entry.tool_response.length > 100 ? `<button class="flow-expand-btn" data-target="${prefix}-out">[+]</button>` : ''}
        <pre class="flow-expanded-content" id="${prefix}-out">${esc(entry.tool_response)}</pre>
      </div>` : ''}
    </div>`;
  }
  if (entry.type === 'subagent_block') {
    const durStr = entry.duration != null ? formatDuration(entry.duration) : '';
    const children = (entry.children || []).map((c, ci) => renderFlowEntry(c, ci, depth + 1)).join('');
    return `<div class="flow-subagent-block">
      <div class="flow-subagent-header">
        <span class="flow-label">SUBAGENT</span>
        <span>${esc(entry.agent_id || '?')}</span>
        <span style="color:var(--text-muted);font-size:9px">${esc(entry.agent_type || '')}</span>
        ${durStr ? `<span class="flow-duration">${durStr}</span>` : ''}
      </div>
      ${children}
    </div>`;
  }
  if (entry.type === 'compact') {
    return `<div class="flow-compact">
      <span class="flow-label">COMPACT</span>
      <span>Context compacted</span>
      <span style="color:var(--text-muted);font-size:9px">${formatTimeFull(entry.timestamp)}</span>
    </div>`;
  }
  if (entry.type === 'notification') {
    return `<div class="flow-notification">
      <span style="color:var(--text-muted);font-size:9px">${formatTimeFull(entry.timestamp)}</span>
      ${esc(entry.message || '')}
    </div>`;
  }
  return '';
}

// Open session flow from a session_id link
function openSessionFlowById(group, sessionId) {
  const sel = document.getElementById('session-select');
  // Try to select the option, or just enter flow directly
  for (const opt of sel.options) {
    if (opt.value === sessionId) { sel.value = sessionId; break; }
  }
  enterSessionFlow(group, sessionId);
}

// --- Event delegation for timeline interactions ---
document.addEventListener('click', (e) => {
  // Expand/collapse toggle for tool_input/tool_response
  const expandBtn = e.target.closest('.tl-expand-btn');
  if (expandBtn) {
    const targetId = expandBtn.dataset.target;
    const target = document.getElementById(targetId);
    if (target) {
      const isVisible = target.style.display !== 'none';
      target.style.display = isVisible ? 'none' : 'block';
      expandBtn.textContent = isVisible ? '[+]' : '[-]';
    }
    return;
  }

  // Click group name in timeline to filter
  const groupLink = e.target.closest('.tl-group-link');
  if (groupLink) {
    const group = groupLink.dataset.group;
    if (group) setTimelineFilter(group);
    return;
  }

  // Click "View Session" button in detail panel
  const viewSessionBtn = e.target.closest('[data-view-session]');
  if (viewSessionBtn) {
    const sid = viewSessionBtn.dataset.viewSession;
    const grp = viewSessionBtn.dataset.viewSessionGroup;
    if (sid) {
      switchToTab('observability');
      openSessionFlowById(grp, sid);
    }
    return;
  }

  // Click recent hook in detail panel to open matching timeline entry
  const detailHookLink = e.target.closest('.hook-entry-link');
  if (detailHookLink) {
    const group = detailHookLink.dataset.eventGroup;
    const timestamp = parseInt(detailHookLink.dataset.eventTime || '', 10);
    if (group && Number.isFinite(timestamp)) {
      openTimelineForEvent(group, timestamp);
    }
    return;
  }

  // Click session_id link in timeline to open session flow
  const sessionLink = e.target.closest('.tl-session-link');
  if (sessionLink) {
    const sid = sessionLink.dataset.sessionId;
    const grp = sessionLink.dataset.sessionGroup;
    if (sid) openSessionFlowById(grp, sid);
    return;
  }

  // Flow view expand/collapse
  const flowExpand = e.target.closest('.flow-expand-btn');
  if (flowExpand) {
    const targetId = flowExpand.dataset.target;
    const target = document.getElementById(targetId);
    if (target) {
      const isVisible = target.style.display !== 'none';
      target.style.display = isVisible ? 'none' : 'block';
      flowExpand.textContent = isVisible ? '[+]' : '[-]';
    }
    return;
  }

  // Clear filter button
  if (e.target.closest('.filter-clear-btn')) {
    clearTimelineFilter();
    return;
  }
});

// ===================================================================
// TAB 3: ADMIN PANEL
// ===================================================================

const adminState = {
  panel: 'overview',
  messages: [],
  messagesHasMore: false,
  tasks: [],
  sessions: [],
  skills: [],
  groups: [],
  debug: null,
  overview: null,
  loaded: new Set(),
  chatMessages: [],
  chatGroup: null,
  chatPolling: null,
  logs: [],
  channels: [],
  config: null,
};

// --- Admin pill navigation ---
document.querySelectorAll('.admin-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    // Stop chat polling when leaving chat panel
    if (adminState.chatPolling) { clearInterval(adminState.chatPolling); adminState.chatPolling = null; }
    document.querySelectorAll('.admin-pill').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.admin-panel').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    const panelId = pill.dataset.panel;
    document.getElementById(panelId).classList.add('active');
    const name = panelId.replace('admin-', '');
    adminState.panel = name;
    if (!adminState.loaded.has(name)) loadAdminPanel(name);
  });
});

function loadAdminPanel(name) {
  const loaders = {
    overview: loadAdminOverview,
    messages: loadAdminMessages,
    tasks: loadAdminTasks,
    sessions: loadAdminSessions,
    skills: loadAdminSkills,
    groups: loadAdminGroups,
    debug: loadAdminDebug,
    chat: loadAdminChat,
    logs: loadAdminLogs,
    channels: loadAdminChannels,
    config: loadAdminConfig,
    infra: loadAdminInfra,
  };
  if (loaders[name]) loaders[name]();
}

// --- Overview ---
async function loadAdminOverview() {
  const el = document.getElementById('admin-overview-content');
  try {
    const res = await fetch('/api/overview');
    if (!res.ok) throw new Error('fetch failed');
    adminState.overview = await res.json();
    adminState.loaded.add('overview');
    renderAdminOverview();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load overview</div>'; }
}

function renderAdminOverview() {
  const d = adminState.overview;
  if (!d) return;
  const el = document.getElementById('admin-overview-content');
  const uptimeStr = formatDuration(d.uptime * 1000);
  el.innerHTML = `
    <div class="admin-stat-grid">
      <div class="admin-stat-card"><div class="num">${uptimeStr}</div><div class="label">Uptime</div></div>
      <div class="admin-stat-card"><div class="num">${d.groups.total}</div><div class="label">Groups</div></div>
      <div class="admin-stat-card"><div class="num">${d.tasks.active}</div><div class="label">Active Tasks</div></div>
      <div class="admin-stat-card"><div class="num">${d.tasks.paused}</div><div class="label">Paused Tasks</div></div>
      <div class="admin-stat-card"><div class="num">${d.messages.total}</div><div class="label">Messages</div></div>
      <div class="admin-stat-card"><div class="num">${d.sessions}</div><div class="label">Sessions</div></div>
    </div>`;
}

// --- Messages ---
async function loadAdminMessages(append) {
  const el = document.getElementById('admin-messages-content');
  if (!append) el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    let url = '/api/messages?limit=50';
    if (append && adminState.messages.length > 0) {
      const last = adminState.messages[adminState.messages.length - 1];
      url += '&before=' + encodeURIComponent(last.timestamp);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    if (append) {
      adminState.messages = adminState.messages.concat(data.messages);
    } else {
      adminState.messages = data.messages;
    }
    adminState.messagesHasMore = data.hasMore;
    adminState.loaded.add('messages');
    renderAdminMessages();
  } catch { if (!append) el.innerHTML = '<div class="admin-empty">Failed to load messages</div>'; }
}

function renderAdminMessages() {
  const el = document.getElementById('admin-messages-content');
  if (adminState.messages.length === 0) {
    el.innerHTML = '<div class="admin-empty">No messages found</div>';
    return;
  }
  let html = `<table class="admin-table">
    <tr><th>Time</th><th>Group</th><th>Dir</th><th>Kind</th><th>Content</th></tr>`;
  for (const m of adminState.messages) {
    const dir = m.direction === 'incoming' ? 'IN' : 'OUT';
    const dirClass = m.direction === 'incoming' ? 'color:var(--accent)' : 'color:var(--green)';
    const kindBadge = m.kind === 'system' ? '<span style="color:var(--yellow)">sys</span>'
      : m.kind === 'card' ? '<span style="color:var(--purple,#8B5CF6)">card</span>'
      : '<span style="color:var(--text-muted)">chat</span>';
    const attachmentLabel =
      Array.isArray(m.attachments) && m.attachments.length > 0
        ? ` [${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]`
        : '';
    const reactionLabel =
      Array.isArray(m.reactions) && m.reactions.length > 0 ? ` ${m.reactions.join(' ')}` : '';
    const editedLabel = m.edited ? ' (edited)' : '';
    const content = `${m.displayContent || m.body || m.content || ''}${attachmentLabel}${editedLabel}${reactionLabel}`;
    const time = m.timestamp;
    html += `<tr>
      <td style="white-space:nowrap">${esc(formatTime(time))}</td>
      <td>${esc(m.group_folder || '-')}</td>
      <td style="${dirClass};font-weight:600">${dir}</td>
      <td>${kindBadge}</td>
      <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(content.slice(0, 500))}">${esc(content.slice(0, 200))}</td>
    </tr>`;
  }
  html += '</table>';
  if (adminState.messagesHasMore) {
    html += '<button class="admin-load-more" id="admin-messages-more">Load older messages</button>';
  }
  el.innerHTML = html;
}

// --- Tasks ---
async function loadAdminTasks() {
  const el = document.getElementById('admin-tasks-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('fetch failed');
    adminState.tasks = await res.json();
    adminState.loaded.add('tasks');
    renderAdminTasks();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load tasks</div>'; }
}

function renderAdminTasks() {
  const el = document.getElementById('admin-tasks-content');
  if (adminState.tasks.length === 0) {
    el.innerHTML = '<div class="admin-empty">No scheduled tasks</div>';
    return;
  }
  let html = `<table class="admin-table">
    <tr><th>ID</th><th>Group</th><th>Prompt</th><th>Schedule</th><th>Status</th><th>Last Run</th><th>Actions</th></tr>`;
  for (const t of adminState.tasks) {
    const statusClass = t.status === 'active' ? 'active' : 'paused';
    const pauseResumeBtn = t.status === 'active'
      ? `<button class="admin-action-btn" data-action="pause-task" data-id="${t.id}">Pause</button>`
      : `<button class="admin-action-btn success" data-action="resume-task" data-id="${t.id}">Resume</button>`;
    const actionBtn = pauseResumeBtn + `<button class="admin-action-btn danger" data-action="delete-task" data-id="${t.id}">Delete</button>`;
    html += `<tr>
      <td>${t.id}</td>
      <td>${esc(t.group_folder)}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.prompt)}">${esc((t.prompt || '').slice(0, 80))}</td>
      <td>${esc(t.schedule_type || '')} ${esc(t.schedule_value || '')}</td>
      <td><span class="admin-chip ${statusClass}">${t.status}</span></td>
      <td>${t.last_run ? formatTime(t.last_run) : '-'}</td>
      <td>${actionBtn}</td>
    </tr>`;
    // Show recent run logs inline
    if (t.recentLogs && t.recentLogs.length > 0) {
      html += `<tr><td colspan="7" style="padding:2px 10px 8px 30px;background:var(--bg)">
        <span style="font-size:8px;color:var(--text-muted);text-transform:uppercase">Recent Runs</span>
        ${t.recentLogs.map((l) => {
          const c = l.status === 'success' ? 'var(--green)' : l.status === 'error' ? 'var(--red)' : 'var(--yellow)';
          return `<div style="font-size:9px;color:var(--text-dim);padding:1px 0">
            <span style="color:${c}">${l.status}</span> ${formatTime(l.run_at)} — ${formatDuration(l.duration_ms)}
            ${l.error ? ` <span style="color:var(--red)">${esc(l.error.slice(0, 80))}</span>` : ''}
          </div>`;
        }).join('')}
      </td></tr>`;
    }
  }
  html += '</table>';
  el.innerHTML = html;
}

// --- Sessions ---
async function loadAdminSessions() {
  const el = document.getElementById('admin-sessions-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error('fetch failed');
    adminState.sessions = await res.json();
    adminState.loaded.add('sessions');
    renderAdminSessions();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load sessions</div>'; }
}

function renderAdminSessions() {
  const el = document.getElementById('admin-sessions-content');
  if (adminState.sessions.length === 0) {
    el.innerHTML = '<div class="admin-empty">No active sessions</div>';
    return;
  }
  let html = `<table class="admin-table">
    <tr><th>Group Folder</th><th>Group Name</th><th>Session ID</th><th>Actions</th></tr>`;
  for (const s of adminState.sessions) {
    html += `<tr>
      <td>${esc(s.group_folder)}</td>
      <td>${esc(s.group_name || '-')}</td>
      <td style="font-size:9px;color:var(--text-muted)">${esc(s.session_id || '-')}</td>
      <td><button class="admin-action-btn danger" data-action="delete-session" data-folder="${esc(s.group_folder)}">Delete</button></td>
    </tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
}

// --- Skills ---
async function loadAdminSkills() {
  const el = document.getElementById('admin-skills-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/skills');
    if (!res.ok) throw new Error('fetch failed');
    adminState.skills = await res.json();
    adminState.loaded.add('skills');
    renderAdminSkills();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load skills</div>'; }
}

function renderAdminSkills() {
  const el = document.getElementById('admin-skills-content');
  let html = `<div style="margin-bottom:10px"><button class="admin-action-btn success" data-action="new-skill">+ New Skill</button></div>`;
  if (adminState.skills.length === 0) {
    html += '<div class="admin-empty">No skills found in container/skills/</div>';
    el.innerHTML = html;
    return;
  }
  html += `<table class="admin-table">
    <tr><th>Skill</th><th>Description</th><th>Files</th><th>Status</th><th>Actions</th></tr>`;
  for (const s of adminState.skills) {
    const chipClass = s.enabled ? 'enabled' : 'disabled';
    const chipText = s.enabled ? 'Enabled' : 'Disabled';
    const btnClass = s.enabled ? 'danger' : 'success';
    const btnText = s.enabled ? 'Disable' : 'Enable';
    html += `<tr>
      <td><strong>${esc(s.title || s.name)}</strong><br><span style="color:var(--text-muted)">${esc(s.name)}</span></td>
      <td class="md-content" style="max-width:250px">${md(s.description || '-')}</td>
      <td style="font-size:9px;color:var(--text-muted)">${(s.files || []).map(esc).join(', ')}</td>
      <td><span class="admin-chip ${chipClass}">${chipText}</span></td>
      <td>
        <button class="admin-action-btn ${btnClass}" data-action="toggle-skill" data-name="${esc(s.name)}">${btnText}</button>
        <button class="admin-action-btn" data-action="preview-skill" data-name="${esc(s.name)}">Preview</button>
        <button class="admin-action-btn" data-action="edit-skill" data-name="${esc(s.name)}">Edit</button>
        <button class="admin-action-btn danger" data-action="delete-skill" data-name="${esc(s.name)}">Delete</button>
      </td>
    </tr>`;
  }
  html += '</table>';
  // Skill editor (hidden by default, shown on edit/new)
  html += `<div id="skill-editor" style="display:none;margin-top:12px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <h4 id="skill-editor-title" style="font-size:11px;margin:0">Edit Skill</h4>
      <button class="admin-action-btn" id="skill-toggle-preview" style="font-size:9px;padding:2px 8px">Preview</button>
    </div>
    <input id="skill-editor-name" type="text" placeholder="skill-name" style="display:none;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:4px 8px;font-family:var(--font);font-size:10px;width:200px;margin-bottom:6px">
    <div id="skill-editor-preview" class="md-content md-preview" style="display:none;max-height:400px;overflow-y:auto;margin-bottom:8px"></div>
    <textarea id="skill-editor-content" class="admin-editor" style="min-height:200px" placeholder="# Skill Name\n\nSkill description and instructions..."></textarea>
    <div style="display:flex;gap:6px;margin-top:4px">
      <button class="admin-save-btn" data-action="save-skill">Save</button>
      <button class="admin-action-btn" data-action="cancel-skill-edit">Cancel</button>
    </div>
  </div>`;
  el.innerHTML = html;

  // Skill editor preview toggle
  document.getElementById('skill-toggle-preview')?.addEventListener('click', () => {
    const preview = document.getElementById('skill-editor-preview');
    const textarea = document.getElementById('skill-editor-content');
    const btn = document.getElementById('skill-toggle-preview');
    if (preview.style.display === 'none') {
      preview.innerHTML = md(textarea.value);
      preview.style.display = 'block';
      textarea.style.display = 'none';
      btn.textContent = 'Edit';
    } else {
      preview.style.display = 'none';
      textarea.style.display = 'block';
      btn.textContent = 'Preview';
    }
  });
}

// --- Groups ---
async function loadAdminGroups() {
  const el = document.getElementById('admin-groups-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/groups/detail');
    if (!res.ok) throw new Error('fetch failed');
    adminState.groups = await res.json();
    adminState.loaded.add('groups');
    renderAdminGroups();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load groups</div>'; }
}

function renderGroupDestinations(destinations) {
  if (!destinations || destinations.length === 0) return '';
  const peers = destinations.filter(d => d.target_type === 'agent');
  const channels = destinations.filter(d => d.target_type === 'channel');
  if (peers.length === 0 && channels.length === 0) return '';
  let html = '<div style="margin-top:4px;font-size:10px;color:var(--text-dim)">';
  if (peers.length > 0) {
    const peerTags = peers.map(d => {
      const name = esc(d.local_name);
      return `<span class="admin-chip" style="background:#3B82F620;color:#3B82F6;font-size:9px" title="Peer agent: ${name}">&#x2194; ${name}</span>`;
    }).join(' ');
    html += `<span>Peers: </span>${peerTags} `;
  }
  if (channels.length > 0) {
    const chTags = channels.map(d => {
      const name = esc(d.local_name);
      return `<span class="admin-chip" style="background:#10B98120;color:#10B981;font-size:9px" title="Channel: ${name}">&#x25CB; ${name}</span>`;
    }).join(' ');
    html += `<span>Channels: </span>${chTags}`;
  }
  html += '</div>';
  return html;
}

function renderAdminGroups() {
  const el = document.getElementById('admin-groups-content');
  if (adminState.groups.length === 0) {
    el.innerHTML = '<div class="admin-empty">No registered groups</div>';
    return;
  }
  let html = '';
  for (const g of adminState.groups) {
    const containerChip = g.containerRunning
      ? '<span class="admin-chip running">Running</span>'
      : '<span class="admin-chip stopped">Stopped</span>';
    const mainBadge = g.is_main ? ' <span class="admin-chip active">Main</span>' : '';
    const matchedCw = (state.coworkers || []).find(c => c.folder === g.folder);
    const isAutoUpdate = matchedCw ? matchedCw.isAutoUpdate : false;
    const updateChip = isAutoUpdate
      ? '<span class="admin-chip auto-update">auto-update</span>'
      : '<span class="admin-chip static">static</span>';
    html += `<div class="admin-group-card">
      <h4>${esc(g.name || g.folder)}${mainBadge} ${containerChip} ${updateChip}</h4>
      <div class="admin-group-meta">
        <span>Folder: <strong>${esc(g.folder)}</strong></span>
        <span>Sessions: ${g.sessionCount || 0}</span>
        <span>Trigger: ${esc(g.trigger_pattern || 'default')}</span>
        <span>Added: ${g.added_at ? formatTime(g.added_at) : '-'}</span>
      </div>
      ${renderGroupDestinations(g.destinations || [])}
      <details>
        <summary style="cursor:pointer;font-size:10px;color:var(--text-dim)">CLAUDE.md Preview / Editor</summary>
        <div class="md-content md-preview" style="max-height:200px;overflow-y:auto;margin:6px 0">${g.memory ? md(g.memory) : '<span style="color:var(--text-muted)">(no CLAUDE.md)</span>'}</div>
        <details style="margin-top:4px" data-raw-editor="1">
          <summary style="cursor:pointer;font-size:9px;color:var(--text-muted)">Edit raw markdown</summary>
          <textarea class="admin-editor" data-folder="${esc(g.folder)}" data-raw="1">${esc(g.rawMemory || '')}</textarea>
          <button class="admin-save-btn" data-action="save-memory" data-folder="${esc(g.folder)}">Save</button>
        </details>
      </details>
    </div>`;
  }
  el.innerHTML = html;
}

// --- Debug ---
async function loadAdminDebug() {
  const el = document.getElementById('admin-debug-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/debug');
    if (!res.ok) throw new Error('fetch failed');
    adminState.debug = await res.json();
    adminState.loaded.add('debug');
    renderAdminDebug();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load debug info</div>'; }
}

function renderAdminDebug() {
  const d = adminState.debug;
  if (!d) return;
  const el = document.getElementById('admin-debug-content');
  const fmtBytes = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
  el.innerHTML = `
    <div class="admin-stat-grid">
      <div class="admin-stat-card"><div class="num">${d.pid}</div><div class="label">PID</div></div>
      <div class="admin-stat-card"><div class="num">${formatDuration(d.uptime * 1000)}</div><div class="label">Uptime</div></div>
      <div class="admin-stat-card"><div class="num">${fmtBytes(d.memory.rss)}</div><div class="label">RSS</div></div>
      <div class="admin-stat-card"><div class="num">${fmtBytes(d.memory.heapUsed)}</div><div class="label">Heap Used</div></div>
      <div class="admin-stat-card"><div class="num">${d.wsClients}</div><div class="label">WS Clients</div></div>
      <div class="admin-stat-card"><div class="num">${d.hookEventsBuffered}</div><div class="label">Hook Events</div></div>
    </div>
    <h4 style="font-size:11px;margin:10px 0 6px">Database Row Counts</h4>
    <table class="admin-table">
      <tr><th>Table</th><th>Rows</th></tr>
      ${Object.entries(d.rowCounts || {}).map(([t, c]) => `<tr><td>${esc(t)}</td><td>${c}</td></tr>`).join('')}
    </table>
    <h4 style="font-size:11px;margin:10px 0 6px">Memory Details</h4>
    <div class="admin-code">${JSON.stringify(d.memory, null, 2)}</div>
    <h4 style="font-size:11px;margin:10px 0 6px">DB Path</h4>
    <div class="admin-code">${esc(d.dbPath)} (${d.dbAvailable ? 'available' : 'unavailable'})</div>`;
}

// --- Admin event delegation ---
document.getElementById('admin')?.addEventListener('click', async (e) => {
  const summary = e.target.closest('details[data-raw-editor] > summary');
  if (summary) {
    const details = summary.parentElement;
    const textarea = details?.querySelector('.admin-editor[data-raw="1"]');
    const folder = textarea?.getAttribute('data-folder');
    if (textarea && folder && !textarea.getAttribute('data-loaded')) {
      textarea.setAttribute('data-loaded', '1');
      try {
        const res = await fetch(`/api/memory/${encodeURIComponent(folder)}?raw=1`);
        if (res.ok) textarea.value = await res.text();
      } catch {
        /* ignore */
      }
    }
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) {
    // Load more messages
    if (e.target.id === 'admin-messages-more') {
      loadAdminMessages(true);
      return;
    }
    // Refresh buttons
    const refreshBtn = e.target.closest('.admin-refresh-btn');
    if (refreshBtn) {
      const name = refreshBtn.dataset.load;
      adminState.loaded.delete(name);
      loadAdminPanel(name);
    }
    return;
  }

  const action = btn.dataset.action;

  if (action === 'pause-task') {
    const id = btn.dataset.id;
    btn.disabled = true;
    try {
      await fetch(`/api/tasks/${id}/pause`, { method: 'POST' });
      adminState.loaded.delete('tasks');
      loadAdminTasks();
    } catch { btn.disabled = false; }
    return;
  }

  if (action === 'resume-task') {
    const id = btn.dataset.id;
    btn.disabled = true;
    try {
      await fetch(`/api/tasks/${id}/resume`, { method: 'POST' });
      adminState.loaded.delete('tasks');
      loadAdminTasks();
    } catch { btn.disabled = false; }
    return;
  }

  if (action === 'delete-session') {
    const folder = btn.dataset.folder;
    if (!confirm(`Delete all sessions for "${folder}"?`)) return;
    btn.disabled = true;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(folder)}`, { method: 'DELETE' });
      adminState.loaded.delete('sessions');
      loadAdminSessions();
    } catch { btn.disabled = false; }
    return;
  }

  if (action === 'toggle-skill') {
    const name = btn.dataset.name;
    btn.disabled = true;
    try {
      await fetch(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST' });
      adminState.loaded.delete('skills');
      loadAdminSkills();
    } catch { btn.disabled = false; }
    return;
  }

  if (action === 'save-memory') {
    const folder = btn.dataset.folder;
    const textarea = document.querySelector(`.admin-editor[data-folder="${folder}"]`);
    if (!textarea) return;
    const raw = textarea.getAttribute('data-raw') === '1';
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const url = raw ? `/api/memory/${encodeURIComponent(folder)}?raw=1` : `/api/memory/${encodeURIComponent(folder)}`;
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: textarea.value,
      });
      btn.textContent = 'Saved!';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    } catch {
      btn.textContent = 'Error';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    }
    return;
  }

  // Task delete
  if (action === 'delete-task') {
    const id = btn.dataset.id;
    if (!confirm(`Delete task #${id} and all its run logs?`)) return;
    btn.disabled = true;
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      adminState.loaded.delete('tasks');
      loadAdminTasks();
    } catch { btn.disabled = false; }
    return;
  }

  // Skill CRUD actions
  if (action === 'new-skill') {
    const editor = document.getElementById('skill-editor');
    const nameInput = document.getElementById('skill-editor-name');
    const contentInput = document.getElementById('skill-editor-content');
    const title = document.getElementById('skill-editor-title');
    editor.style.display = 'block';
    nameInput.style.display = 'block';
    nameInput.value = '';
    contentInput.value = '# New Skill\n\nSkill description and instructions.\n';
    title.textContent = 'Create New Skill';
    editor.dataset.mode = 'create';
    editor.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (action === 'preview-skill') {
    const name = btn.dataset.name;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
      const content = res.ok ? await res.text() : '';
      const editor = document.getElementById('skill-editor');
      const preview = document.getElementById('skill-editor-preview');
      const contentInput = document.getElementById('skill-editor-content');
      const toggleBtn = document.getElementById('skill-toggle-preview');
      const title = document.getElementById('skill-editor-title');
      const nameInput = document.getElementById('skill-editor-name');
      editor.style.display = 'block';
      nameInput.style.display = 'none';
      contentInput.value = content;
      contentInput.style.display = 'none';
      preview.innerHTML = md(content);
      preview.style.display = 'block';
      toggleBtn.textContent = 'Edit';
      title.textContent = `Preview: ${name}`;
      editor.dataset.mode = 'edit';
      editor.dataset.skillName = name;
      editor.scrollIntoView({ behavior: 'smooth' });
    } catch { /* ignore */ }
    btn.disabled = false;
    return;
  }

  if (action === 'edit-skill') {
    const name = btn.dataset.name;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
      const content = res.ok ? await res.text() : '';
      const editor = document.getElementById('skill-editor');
      const nameInput = document.getElementById('skill-editor-name');
      const contentInput = document.getElementById('skill-editor-content');
      const preview = document.getElementById('skill-editor-preview');
      const toggleBtn = document.getElementById('skill-toggle-preview');
      const title = document.getElementById('skill-editor-title');
      editor.style.display = 'block';
      nameInput.style.display = 'none';
      contentInput.value = content;
      contentInput.style.display = 'block';
      preview.style.display = 'none';
      toggleBtn.textContent = 'Preview';
      title.textContent = `Edit: ${name}`;
      editor.dataset.mode = 'edit';
      editor.dataset.skillName = name;
      editor.scrollIntoView({ behavior: 'smooth' });
    } catch { /* ignore */ }
    btn.disabled = false;
    return;
  }

  if (action === 'delete-skill') {
    const name = btn.dataset.name;
    if (!confirm(`Delete skill "${name}" permanently?`)) return;
    btn.disabled = true;
    try {
      await fetch(`/api/skills/${encodeURIComponent(name)}?confirm=true`, { method: 'DELETE' });
      adminState.loaded.delete('skills');
      loadAdminSkills();
    } catch { btn.disabled = false; }
    return;
  }

  if (action === 'save-skill') {
    const editor = document.getElementById('skill-editor');
    const mode = editor.dataset.mode;
    const contentInput = document.getElementById('skill-editor-content');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      if (mode === 'create') {
        const nameInput = document.getElementById('skill-editor-name');
        const name = nameInput.value.trim();
        if (!name || !/^[a-z0-9-]+$/.test(name)) {
          alert('Invalid name: use lowercase letters, numbers, and hyphens only');
          btn.disabled = false;
          btn.textContent = 'Save';
          return;
        }
        await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, content: contentInput.value }),
        });
      } else {
        const name = editor.dataset.skillName;
        await fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: contentInput.value,
        });
      }
      editor.style.display = 'none';
      btn.textContent = 'Save';
      btn.disabled = false;
      adminState.loaded.delete('skills');
      loadAdminSkills();
    } catch {
      btn.textContent = 'Error';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    }
    return;
  }

  if (action === 'cancel-skill-edit') {
    document.getElementById('skill-editor').style.display = 'none';
    return;
  }

  // Config CLAUDE.md save
  if (action === 'save-config-md') {
    const scope = document.getElementById('config-md-scope')?.value || 'root';
    const content = document.getElementById('config-md-editor')?.value || '';
    const url = scope === 'root' ? '/api/config/claude-md' : `/api/memory/global`;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      });
      btn.textContent = 'Saved!';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    } catch {
      btn.textContent = 'Error';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    }
    return;
  }
});

// ===================================================================
// CHAT PANEL
// ===================================================================

async function loadAdminChat() {
  // Populate group dropdown — use WS state or fetch from API
  let groups = state.registeredGroups;
  if (!groups || groups.length === 0) {
    try {
      const res = await fetch('/api/groups/detail');
      if (res.ok) groups = await res.json();
    } catch { /* ignore */ }
  }
  const select = document.getElementById('chat-group-select');
  select.innerHTML = '<option value="">Select group...</option>';
  for (const g of (groups || [])) {
    const opt = document.createElement('option');
    opt.value = g.folder;
    opt.textContent = g.name || g.folder;
    opt.dataset.isMain = g.is_main ? '1' : '0';
    if (adminState.chatGroup === g.folder) opt.selected = true;
    select.appendChild(opt);
  }
  adminState.loaded.add('chat');
  if (adminState.chatGroup) fetchChatMessages();
  else document.getElementById('chat-messages').innerHTML = '<div class="admin-empty">Select a group above to start chatting</div>';
}

async function fetchChatMessages() {
  if (!adminState.chatGroup) return;
  try {
    const res = await fetch(`/api/messages?group=${encodeURIComponent(adminState.chatGroup)}&limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    adminState.chatMessages = (data.messages || []).reverse();
    renderChatMessages();
  } catch { /* ignore */ }
}

function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  if (adminState.chatMessages.length === 0) {
    el.innerHTML = '<div class="admin-empty">No messages yet. Send a message to start.</div>';
    return;
  }
  el.innerHTML = adminState.chatMessages.map((m) => {
    const isUser = m.is_from_me === 0 && !m.is_bot_message;
    const isAssistant = m.is_from_me === 1 || m.is_bot_message === 1;
    const cls = isAssistant ? 'assistant' : 'user';
    const sender = m.sender_name || m.sender || (isAssistant ? 'Assistant' : 'User');
    const time = m.timestamp ? formatTime(m.timestamp) : '';
    return `<div class="chat-bubble ${cls}">
      <div>${isAssistant ? md(m.content || m.body || '') : esc(m.content || m.body || '')}</div>
      <div class="chat-meta">${esc(sender)} ${time}</div>
    </div>`;
  }).join('');
  // Check for typing indicator
  const recentHooks = state.hookEvents.filter((e) => e.group === adminState.chatGroup && Date.now() - e.timestamp < 10000);
  if (recentHooks.length > 0) {
    el.innerHTML += '<div class="chat-typing"><span></span><span></span><span></span></div>';
  }
  el.scrollTop = el.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!adminState.chatGroup) {
    document.getElementById('chat-messages').innerHTML = '<div class="admin-empty">Select a group first</div>';
    return;
  }
  if (!content) return;
  input.value = '';
  const optimisticMessage = {
    content, sender: 'web@dashboard', sender_name: 'Dashboard',
    is_from_me: 0, is_bot_message: 0, timestamp: new Date().toISOString(),
  };
  adminState.chatMessages.push(optimisticMessage);
  renderChatMessages();
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: adminState.chatGroup, content }),
    });
    if (!res.ok) {
      adminState.chatMessages = adminState.chatMessages.filter((m) => m !== optimisticMessage);
      renderChatMessages();
      let err = 'Failed to send message';
      try {
        const data = await res.json();
        err = data.error || err;
      } catch { /* ignore */ }
      alert(err);
      return;
    }
    fetchChatMessages();
  } catch (e) {
    adminState.chatMessages = adminState.chatMessages.filter((m) => m !== optimisticMessage);
    renderChatMessages();
    alert('Failed to send message: ' + e.message);
  }
}

// Chat events
document.getElementById('chat-group-select')?.addEventListener('change', (e) => {
  adminState.chatGroup = e.target.value || null;
  adminState.chatMessages = [];
  if (adminState.chatPolling) { clearInterval(adminState.chatPolling); adminState.chatPolling = null; }
  if (adminState.chatGroup) {
    fetchChatMessages();
    adminState.chatPolling = setInterval(fetchChatMessages, 3000);
  } else {
    document.getElementById('chat-messages').innerHTML = '';
  }
  // Update placeholder/tooltip based on whether this is the main group
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    const sel = e.target;
    const opt = sel.options[sel.selectedIndex];
    // Check if selected group is main (stored during populateChatGroups)
    const isMain = opt?.dataset?.isMain === '1';
    if (isMain) {
      chatInput.placeholder = 'Message main — use @Coworker to route directly, or plain text for main to orchestrate';
      chatInput.title = '@Coworker = routed directly (main skipped)\nPlain text = main picks it up and can read coworker files + send_message to coordinate';
    } else {
      chatInput.placeholder = 'Type a message...';
      chatInput.title = '';
    }
  }
});

document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);

document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// ===================================================================
// COWORKERS TAB
// ===================================================================

const cwState = {
  selected: null,       // currently selected coworker folder
  messages: [],         // chat messages for selected coworker
  polling: null,        // chat polling interval
  types: null,          // coworker-types.json cache
  approvalCountByFolder: {},  // { folder: count } for sidebar dot
};

function getCwCoworkers() {
  // Combine state.coworkers (from WebSocket) with state.registeredGroups
  const validTypes = (cwState.types && cwState.types !== 'loading') ? Object.keys(cwState.types) : [];
  const coworkers = [];
  const seen = new Set();
  // Registered groups with dashboard:* JIDs are coworkers
  for (const g of (state.registeredGroups || [])) {
    const folder = g.folder;
    seen.add(folder);
    // Find matching coworker from state for live status
    const live = (state.coworkers || []).find((c) => c.folder === folder);
    coworkers.push({
      folder,
      name: g.name || folder,
      jid: g.jid,
      trigger: g.trigger_pattern,
      isMain: g.is_admin === 1 || g.is_main === 1,
      status: live?.status || 'idle',
      lastActivity: live?.lastActivity || live?.hookTimestamp || null,
      hookTimestamp: live?.hookTimestamp || null,
      type: (() => {
        const raw = (live?.type && live.type !== 'unknown' ? live.type : null) || g.coworker_type;
        if (!raw) return g.is_main === 1 ? 'main' : 'static';
        if (validTypes.length > 0 && !validTypes.includes(raw)) return 'static';
        return raw;
      })(),
      routing: g.routing || 'direct',
      taskCount: live?.taskCount || 0,
      isAutoUpdate: live?.isAutoUpdate || false,
      allowedMcpTools: live?.allowedMcpTools || (g.allowed_mcp_tools ? JSON.parse(g.allowed_mcp_tools) : []),
      disallowedMcpTools: live?.disallowedMcpTools || [],
    });
  }
  return coworkers;
}

function renderCwSidebar() {
  const list = document.getElementById('cw-list');
  if (!list) return;
  // Eagerly fetch coworker-types.json for type validation
  if (!cwState.types) {
    cwState.types = 'loading'; // sentinel to prevent duplicate fetches
    fetch('/api/types').then(r => r.ok ? r.json() : {}).then(t => {
      cwState.types = t;
      renderCwSidebar(); // re-render with valid types
    }).catch(() => { cwState.types = {}; });
  }
  const coworkers = getCwCoworkers();
  if (coworkers.length === 0) {
    list.innerHTML = '<div class="cw-empty">No coworkers yet. Click "+ New" to create one.</div>';
    return;
  }
  const statusPriority = { working: 0, active: 1, thinking: 2, error: 3, idle: 4 };
  coworkers.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;
    const sa = statusPriority[a.status] ?? 5;
    const sb = statusPriority[b.status] ?? 5;
    if (sa !== sb) return sa - sb;
    const ta = a.lastActivity || '';
    const tb = b.lastActivity || '';
    if (ta !== tb) return tb.localeCompare(ta);
    return a.name.localeCompare(b.name);
  });
  list.innerHTML = coworkers.map((cw) => {
    const selected = cwState.selected === cw.folder ? ' selected' : '';
    const label = cw.isMain ? `${cw.name} (main)` : cw.name;
    const meta = cw.lastActivity ? timeAgo(cw.lastActivity) : cw.type;
    const updateDot = updateDotHtml(cw.isAutoUpdate);
    const unread = hasUnread(cw.folder);
    const approvalCount = cwState.approvalCountByFolder[cw.folder] || 0;
    const statusTitle = { idle: 'Idle', active: 'Active', working: 'Working', thinking: 'Thinking', error: 'Error' }[cw.status] || cw.status;
    return `<div class="cw-item${selected}" data-folder="${esc(cw.folder)}">
      <div class="cw-dot ${cw.status}" title="${statusTitle}"></div>
      <div class="cw-item-info">
        <div class="cw-item-name">${esc(label)}${updateDot}</div>
        <div class="cw-item-meta">${esc(meta)}</div>
      </div>
      ${approvalCount > 0 ? `<div class="cw-approval-dot" title="Pending approval \u2014 ${approvalCount} action${approvalCount > 1 ? 's' : ''} waiting for admin review"></div>` : ''}
      ${unread ? '<div class="cw-unread-badge" title="Unread messages">\u25CF</div>' : ''}
    </div>`;
  }).join('');
  // Click handlers — use onclick for Playwright/agent-browser compatibility
  list.querySelectorAll('.cw-item').forEach((el) => {
    el.onclick = () => selectCoworker(el.dataset.folder);
  });
}

function selectCoworker(folder) {
  cwState.selected = folder;
  cwState.messages = [];
  if (cwState.polling) { clearInterval(cwState.polling); cwState.polling = null; }
  renderCwSidebar();
  if (folder) {
    document.getElementById('cw-chat-input-area').style.display = 'flex';
    document.getElementById('cw-detail').style.display = 'block';
    document.getElementById('cw-view-toggle').style.display = 'flex';
    // Update input placeholder based on main vs coworker
    const cwInput = document.getElementById('cw-chat-input');
    const cw = getCwCoworkers().find((c) => c.folder === folder);
    // Always reset disabled state first, then apply per-type overrides
    if (cwInput) { cwInput.disabled = false; cwInput.title = ''; }
    const sendBtn = document.getElementById('cw-chat-send');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.title = ''; }

    if (cwInput && cw?.isMain) {
      cwInput.placeholder = 'Message main \u2014 @Coworker routes directly (main skipped), plain text = main orchestrates';
      cwInput.title = '@Coworker = routed directly to that coworker, main never sees it\nPlain text = main picks it up and can read coworker files + send_message to coordinate';
    } else if (cwInput && cw?.routing === 'internal') {
      cwInput.placeholder = `Internal agent — message via @${cw.folder} from Orchestrator`;
      cwInput.disabled = true;
      const sendBtn = document.getElementById('cw-chat-send');
      if (sendBtn) { sendBtn.disabled = true; sendBtn.title = `Internal agent — message via @${cw.folder} from Orchestrator`; }
    } else if (cwInput) {
      cwInput.placeholder = 'Type a message...';
      cwInput.title = '';
      cwInput.disabled = false;
      const sendBtn = document.getElementById('cw-chat-send');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.title = ''; }
    }
    // Reset to chat view
    document.getElementById('cw-chat-messages').style.display = '';
    document.getElementById('cw-shell-view').style.display = 'none';
    document.getElementById('cw-work-view').style.display = 'none';
    document.querySelectorAll('.cw-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'chat'));
    fetchCwMessages();
    cwState.polling = setInterval(fetchCwMessages, 3000);
    updateCwDetail();
    updateCwHeader();
    // Update shell button state (don't auto-spawn — message send handles that via the message loop)
    fetch(`/api/coworkers/${encodeURIComponent(folder)}/container`).then(r => r.json()).then(d => {
      const shellBtn = document.querySelector('[data-view=shell]');
      if (shellBtn) {
        shellBtn.style.opacity = d.running ? '1' : '0.4';
        shellBtn.title = d.running ? 'Container running' : 'Send a message to start container';
      }
    }).catch(() => {});
  } else {
    document.getElementById('cw-chat-input-area').style.display = 'none';
    document.getElementById('cw-detail').style.display = 'none';
    document.getElementById('cw-view-toggle').style.display = 'none';
    document.getElementById('cw-shell-view').style.display = 'none';
    document.getElementById('cw-work-view').style.display = 'none';
    document.getElementById('cw-chat-messages').innerHTML = '<div class="cw-empty">Select a coworker from the sidebar to start chatting.</div>';
  }
}

function updateCwHeader() {
  const cw = getCwCoworkers().find((c) => c.folder === cwState.selected);
  if (!cw) return;
  document.getElementById('cw-chat-name').textContent = cw.name;
  const badge = document.getElementById('cw-chat-status');
  badge.textContent = cw.status;
  badge.style.background = cw.status === 'working' ? 'var(--green)' :
    cw.status === 'active' ? '#3B82F6' :
    cw.status === 'thinking' ? 'var(--yellow)' :
    cw.status === 'error' ? 'var(--red)' : 'var(--text-muted)';
  badge.style.color = '#fff';
}

async function fetchCwMessages() {
  if (!cwState.selected) return;
  try {
    const res = await fetch(`/api/messages?group=${encodeURIComponent(cwState.selected)}&limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    cwState.messages = (data.messages || []).reverse();
    try {
      const ar = await fetch(`/api/approvals?group=${encodeURIComponent(cwState.selected)}`);
      cwState.pendingApprovals = ar.ok ? await ar.json() : [];
    } catch {
      cwState.pendingApprovals = [];
    }
    try {
      const cr = await fetch(`/api/credentials?group=${encodeURIComponent(cwState.selected)}`);
      cwState.pendingCredentials = cr.ok ? await cr.json() : [];
    } catch {
      cwState.pendingCredentials = [];
    }
    // Sync into global approval counter for sidebar dot
    cwState.approvalCountByFolder[cwState.selected] = (cwState.pendingApprovals || []).length + (cwState.pendingCredentials || []).length;
    renderCwMessages();
    // Mark as read using latest message timestamp
    if (cwState.messages.length > 0 && cwState.selected) {
      const latest = cwState.messages[cwState.messages.length - 1];
      if (latest.timestamp) {
        readCursors.markRead(cwState.selected, latest.timestamp);
        renderCwSidebar();
      }
    }
  } catch { /* ignore */ }
}

function renderApprovalItem(item) {
  // Server returns normalized DTOs: { approvalId, action, reason, packages, createdAt, status }
  // item.reason and item.packages originate from container (user-influenced) — escape them
  const safeReason = item.reason ? `\n\n*Reason:* ${esc(item.reason)}` : '';
  const desc = item.action === 'install_packages'
    ? `**Install packages:** ${(item.packages || []).map(p => esc(p)).join(', ')}${safeReason}`
    : item.action === 'request_rebuild'
    ? `**Rebuild container**${safeReason}`
    : item.action === 'add_mcp_server'
    ? `**Add MCP server**`
    : `**${esc(item.action)}**`;
  const controls = `<div style="margin-top:8px">
        <button class="approval-btn" data-qid="${esc(item.approvalId)}" data-decision="Approve" style="background:#238636;color:#fff;border:none;border-radius:3px;padding:4px 14px;margin-right:6px;cursor:pointer;font-size:10px">Approve</button>
        <button class="approval-btn" data-qid="${esc(item.approvalId)}" data-decision="Reject" style="background:#da3633;color:#fff;border:none;border-radius:3px;padding:4px 14px;cursor:pointer;font-size:10px">Reject</button>
      </div>`;
  return `<div class="cw-msg assistant">
    <div class="cw-msg-bubble" style="border-left:3px solid #f59e0b;padding-left:8px">
      ${md(desc)}
      ${controls}
    </div>
    <div class="cw-msg-time">${formatTime(item.createdAt)} <span style="font-size:7px;color:#f59e0b;font-style:italic">approval</span></div>
  </div>`;
}

function renderCredentialItem(item) {
  const desc = `**Credential request:** ${esc(item.name)}\n\nHost: \`${esc(item.hostPattern)}\`${item.headerName ? `\nHeader: \`${esc(item.headerName)}\`` : ''}${item.valueFormat ? `\nFormat: \`${esc(item.valueFormat)}\`` : ''}${item.description ? `\n\n${esc(item.description)}` : ''}`;
  const controls = `<div style="margin-top:8px">
        <button class="cred-enter-btn" data-cid="${esc(item.credentialId)}" data-name="${esc(item.name)}" data-desc="${esc(item.description || item.name)}" style="background:#238636;color:#fff;border:none;border-radius:3px;padding:4px 14px;margin-right:6px;cursor:pointer;font-size:10px">Enter credential</button>
        <button class="cred-reject-btn" data-cid="${esc(item.credentialId)}" style="background:#da3633;color:#fff;border:none;border-radius:3px;padding:4px 14px;cursor:pointer;font-size:10px">Reject</button>
      </div>`;
  return `<div class="cw-msg assistant">
    <div class="cw-msg-bubble" style="border-left:3px solid #d97706;padding-left:8px">
      ${md(desc)}
      ${controls}
    </div>
    <div class="cw-msg-time">${formatTime(item.createdAt)} <span style="font-size:7px;color:#d97706;font-style:italic">credential</span></div>
  </div>`;
}

function renderCwMessages() {
  const el = document.getElementById('cw-chat-messages');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const approvalHtml = (cwState.pendingApprovals || []).map(renderApprovalItem).join('');
  const credentialHtml = (cwState.pendingCredentials || []).map(renderCredentialItem).join('');
  const messageHtml = cwState.messages.map((m) => {
    const isOutgoing = m.direction === 'outgoing';
    const cls = isOutgoing ? 'assistant' : 'user';
    const time = m.timestamp ? formatTime(m.timestamp) : '';
    const text = m.displayContent || m.content || '';
    const attachmentsHtml = renderMessageAttachmentsHtml(m.attachments);
    const metaSuffix = renderMessageMetaSuffix(m);
    const isSystem = m.kind === 'task' || m.kind === 'system';
    const kindLabel = m.kind && m.kind !== 'chat' ? ` <span style="font-size:7px;color:#999;font-style:italic">${esc(m.kind)}</span>` : '';
    const systemStyle = isSystem ? ' style="opacity:0.5;font-size:9px;border-left:2px solid #555;padding-left:6px"' : '';

    // Ask question card — render with option buttons if still pending
    if (m.cardType === 'ask_question' && m.questionId && m.options && m.options.length > 0) {
      const questionText = m.displayContent || m.content || '';
      if (m.isPending) {
        const btns = m.options.map(opt => {
          const label = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
          const value = typeof opt === 'string' ? opt : (opt.value || opt.label || String(opt));
          return `<button class="question-btn" data-qid="${esc(m.questionId)}" data-option="${esc(value)}" style="background:#3B82F6;color:#fff;border:none;border-radius:3px;padding:4px 14px;margin-right:6px;margin-top:4px;cursor:pointer;font-size:10px">${esc(label)}</button>`;
        }).join('');
        return `<div class="cw-msg assistant">
          <div class="cw-msg-bubble" style="border-left:3px solid #3B82F6;padding-left:8px">
            ${md(questionText)}
            <div style="margin-top:8px">${btns}</div>
          </div>
          <div class="cw-msg-time">${time} <span style="font-size:7px;color:#3B82F6;font-style:italic">question</span></div>
        </div>`;
      }
      return `<div class="cw-msg assistant">
        <div class="cw-msg-bubble" style="border-left:3px solid #555;padding-left:8px;opacity:0.7">
          ${md(questionText)}
          <div style="margin-top:4px;font-size:9px;color:#666">(answered)</div>
        </div>
        <div class="cw-msg-time">${time} <span style="font-size:7px;color:#555;font-style:italic">question</span></div>
      </div>`;
    }

    const bubbleBody = `${text ? (isOutgoing ? md(text) : esc(text)) : ''}${attachmentsHtml}`;
    return `<div class="cw-msg ${cls}"${systemStyle}>
      <div class="cw-msg-bubble">${bubbleBody || '<span style="color:#9ca3af">(empty message)</span>'}</div>
      <div class="cw-msg-time">${time}${kindLabel}${metaSuffix}</div>
    </div>`;
  }).join('');
  if (!approvalHtml && !credentialHtml && !messageHtml) {
    el.innerHTML = '<div class="cw-empty">No messages yet. Send a message to start.</div>';
    return;
  }
  const approvalCount = (cwState.pendingApprovals || []).length;
  const credentialCount = (cwState.pendingCredentials || []).length;
  const totalPending = approvalCount + credentialCount;
  const bannerHtml = totalPending > 0
    ? `<div class="approval-banner"><div class="approval-banner-label">⚠ Pending Actions (${totalPending})</div>${approvalHtml}${credentialHtml}</div>`
    : '';
  el.innerHTML = messageHtml + bannerHtml;

  if (!cwState._inflightApprovals) cwState._inflightApprovals = new Set();
  // Event delegation: attach once on the stable parent, survives innerHTML rebuilds
  if (!el._approvalDelegateAttached) {
    el._approvalDelegateAttached = true;
    el.addEventListener('click', async (e) => {
      // ── Approval buttons ──
      const approvalBtn = e.target.closest('.approval-btn');
      if (approvalBtn) {
        const qid = approvalBtn.dataset.qid;
        const decision = approvalBtn.dataset.decision;
        if (!qid || !decision) return;
        if (cwState._inflightApprovals.has(qid)) return;
        cwState._inflightApprovals.add(qid);
        const card = approvalBtn.closest('.cw-msg');
        const allBtns = card ? card.querySelectorAll('.approval-btn') : [approvalBtn];
        allBtns.forEach(b => { b.disabled = true; });
        approvalBtn.textContent = 'Submitting…';
        try {
          const res = await fetch('/api/approvals/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvalId: qid, decision }),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            approvalBtn.textContent = errData.error || 'Error';
            allBtns.forEach(b => { b.disabled = false; });
          }
        } catch {
          approvalBtn.textContent = 'Error';
          allBtns.forEach(b => { b.disabled = false; });
        } finally {
          setTimeout(() => { cwState._inflightApprovals.delete(qid); fetchCwMessages(); }, 1000);
        }
        return;
      }

      // ── Question option buttons ──
      const questionBtn = e.target.closest('.question-btn');
      if (questionBtn) {
        const qid = questionBtn.dataset.qid;
        const option = questionBtn.dataset.option;
        if (!qid || !option) return;
        if (cwState._inflightApprovals.has(qid)) return;
        cwState._inflightApprovals.add(qid);
        const card = questionBtn.closest('.cw-msg');
        const allBtns = card ? card.querySelectorAll('.question-btn') : [questionBtn];
        allBtns.forEach(b => { b.disabled = true; });
        questionBtn.textContent = 'Submitting…';
        try {
          const res = await fetch('/api/questions/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId: qid, selectedOption: option }),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            questionBtn.textContent = errData.error || 'Error';
            allBtns.forEach(b => { b.disabled = false; });
          }
        } catch {
          questionBtn.textContent = 'Error';
          allBtns.forEach(b => { b.disabled = false; });
        } finally {
          setTimeout(() => { cwState._inflightApprovals.delete(qid); fetchCwMessages(); }, 1000);
        }
        return;
      }

      // ── Credential enter button → show modal ──
      const credEnterBtn = e.target.closest('.cred-enter-btn');
      if (credEnterBtn) {
        const cid = credEnterBtn.dataset.cid;
        if (!cid) return;
        const modal = document.getElementById('cred-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        modal.dataset.cid = cid;
        document.getElementById('cred-modal-name').textContent = credEnterBtn.dataset.name || 'Credential';
        document.getElementById('cred-modal-desc').textContent = credEnterBtn.dataset.desc || '';
        const input = document.getElementById('cred-modal-value');
        input.value = '';
        input.focus();
        return;
      }

      // ── Credential reject button ──
      const credRejectBtn = e.target.closest('.cred-reject-btn');
      if (credRejectBtn) {
        const cid = credRejectBtn.dataset.cid;
        if (!cid) return;
        if (cwState._inflightApprovals.has(cid)) return;
        cwState._inflightApprovals.add(cid);
        const card = credRejectBtn.closest('.cw-msg');
        const allBtns = card ? card.querySelectorAll('.cred-enter-btn,.cred-reject-btn') : [credRejectBtn];
        allBtns.forEach(b => { b.disabled = true; });
        credRejectBtn.textContent = 'Rejecting…';
        try {
          await fetch('/api/credentials/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credentialId: cid }),
          });
        } catch { /* ignore */ }
        finally {
          setTimeout(() => { cwState._inflightApprovals.delete(cid); fetchCwMessages(); }, 1000);
        }
        return;
      }
    });
  }
  const recentHooks = (state.hookEvents || []).filter(
    (e) => e.group === cwState.selected && Date.now() - e.timestamp < 10000
  );
  if (recentHooks.length > 0) {
    el.innerHTML += '<div class="cw-msg assistant"><div class="cw-msg-bubble" style="opacity:0.5"><span class="chat-typing"><span></span><span></span><span></span></span></div></div>';
  }
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

// ── Credential modal handlers (attached once globally) ──
(function initCredentialModal() {
  document.addEventListener('click', async (e) => {
    const modal = document.getElementById('cred-modal');
    if (!modal) return;

    // Save button
    if (e.target.id === 'cred-modal-save') {
      const cid = modal.dataset.cid;
      const value = document.getElementById('cred-modal-value')?.value || '';
      if (!cid || !value) return;
      e.target.disabled = true;
      e.target.textContent = 'Saving…';
      try {
        await fetch('/api/credentials/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentialId: cid, value }),
        });
      } catch { /* ignore */ }
      modal.style.display = 'none';
      e.target.disabled = false;
      e.target.textContent = 'Save';
      document.getElementById('cred-modal-value').value = '';
      setTimeout(fetchCwMessages, 1000);
      return;
    }

    // Cancel button or overlay click
    if (e.target.id === 'cred-modal-cancel' || e.target === modal) {
      modal.style.display = 'none';
      document.getElementById('cred-modal-value').value = '';
    }
  });
})();

/**
 * Ensure a container is running for the selected coworker.
 * If not running, requests an interactive spawn (resumes existing session
 * without triggering a query) and waits for it to come up.
 * Returns true if container is running, false if spawn failed.
 */
async function ensureContainerRunning(folder) {
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/container`);
    const data = await res.json();
    if (data.running) return true;

    // Request interactive spawn
    const spawnRes = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/spawn-interactive`, { method: 'POST' });
    if (!spawnRes.ok) return false;

    // Poll until container appears (max 15s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/container`);
      const status = await check.json();
      if (status.running) return true;
    }
    return false;
  } catch { return false; }
}

async function sendCwMessage() {
  const input = document.getElementById('cw-chat-input');
  const content = input.value.trim();
  if (!cwState.selected || !content) return;
  input.value = '';
  const optimisticMessage = {
    content, sender: 'web@dashboard', sender_name: 'Dashboard',
    is_from_me: 0, is_bot_message: 0, timestamp: new Date().toISOString(),
  };
  cwState.messages.push(optimisticMessage);
  renderCwMessages();
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: cwState.selected, content }),
    });
    if (!res.ok) {
      cwState.messages = cwState.messages.filter((m) => m !== optimisticMessage);
      renderCwMessages();
      let err = 'Failed to send message';
      try {
        const data = await res.json();
        err = data.error || err;
      } catch { /* ignore */ }
      alert(err);
      return;
    }
    fetchCwMessages();
  } catch (e) {
    cwState.messages = cwState.messages.filter((m) => m !== optimisticMessage);
    renderCwMessages();
    alert('Failed to send message: ' + e.message);
  }
}

async function updateCwDetail() {
  const folder = cwState.selected;
  if (!folder) return;
  const cw = getCwCoworkers().find((c) => c.folder === folder);
  if (!cw) return;
  document.getElementById('cw-detail-name').textContent = cw.name;
  document.getElementById('cw-detail-type').innerHTML = esc(cw.type) + ' ' + updateDotHtml(cw.isAutoUpdate, true);
  document.getElementById('cw-detail-trigger').textContent = (cw.trigger?.replace(/\\b$/, '') || '-');
  document.getElementById('cw-detail-jid').textContent = cw.jid || `dashboard:${cw.folder}`;
  document.getElementById('cw-detail-status').textContent = cw.status;
  document.getElementById('cw-detail-tasks').textContent = String(cw.taskCount);

  // MCP tools — show allowed (green) then blocked (struck-through)
  const mcpEl = document.getElementById('cw-detail-mcp');
  if (mcpEl) {
    const shortName = (t) => t.replace(/^mcp__\w+__/, '');
    const allowed = (cw.allowedMcpTools || []).map(t =>
      `<span class="mcp-tag allowed">${esc(shortName(t))}</span>`
    ).join('');
    const blocked = (cw.disallowedMcpTools || []).map(t =>
      `<span class="mcp-tag blocked">${esc(shortName(t))}</span>`
    ).join('');
    mcpEl.innerHTML = allowed + blocked || '<span style="color:var(--text-dim)">none</span>';
  }

  // Last Activity: use hook timestamp, message timestamp, or task run — whichever is newest
  const liveCw = (state.coworkers || []).find((c) => c.folder === folder);
  let lastAct = cw.lastActivity ? new Date(cw.lastActivity).getTime() : 0;
  if (liveCw?.hookTimestamp && liveCw.hookTimestamp > lastAct) lastAct = liveCw.hookTimestamp;
  // Also check the most recent message in chat
  if (cwState.messages.length > 0) {
    const lastMsg = new Date(cwState.messages[cwState.messages.length - 1].timestamp).getTime();
    if (lastMsg > lastAct) lastAct = lastMsg;
  }
  document.getElementById('cw-detail-activity').textContent = lastAct > 0
    ? new Date(lastAct).toLocaleString() : '-';

  // Subagents from live state
  const subagents = liveCw?.subagents || [];
  document.getElementById('cw-detail-subagents').textContent = subagents.length > 0
    ? subagents.map((s) => `${s.agentType || 'agent'} (${s.status || 'unknown'})`).join(', ')
    : 'None';

  // Recent tool calls: reuse the Pixel Office detail panel renderer for consistency
  const liveCwForHooks = (state.coworkers || []).find(c => c.folder === folder);
  const toolsEl = document.getElementById('cw-detail-tools');
  if (liveCwForHooks) {
    const hooksHtml = renderDetailHooks(liveCwForHooks);
    toolsEl.innerHTML = hooksHtml || 'None';
    // Wire up hook-entry-link click handlers (same as Pixel Office detail panel)
    toolsEl.querySelectorAll('.hook-entry-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.eventGroup;
        const time = btn.dataset.eventTime;
        if (group && time) openTimelineForEvent(group, parseInt(time, 10));
      });
    });
    // Wire up "View Session" button if present
    toolsEl.querySelectorAll('[data-view-session]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.viewSession;
        const grp = btn.dataset.viewSessionGroup;
        if (sid && grp) {
          document.querySelector('[data-tab="observability"]')?.click();
          setTimeout(() => openSessionFlowById(grp, sid), 300);
        }
      });
    });
  } else {
    toolsEl.textContent = 'None';
  }

  // Load artifacts (files in group folder)
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/files`);
    if (res.ok) {
      const files = await res.json();
      const filesEl = document.getElementById('cw-detail-files');
      if (files.length === 0) {
        filesEl.textContent = 'No files';
      } else {
        filesEl.innerHTML = files.map((f) => {
          const icon = f.isDir ? '📁' : '📄';
          const size = f.isDir ? '' : ` (${f.size > 1024 ? Math.round(f.size/1024)+'KB' : f.size+'B'})`;
          return `<div class="cw-file-link" data-name="${esc(f.name)}" data-isdir="${f.isDir}" style="cursor:pointer;color:#60a5fa">${icon} ${esc(f.name)}${size}</div>`;
        }).join('');
        filesEl.querySelectorAll('.cw-file-link').forEach(el => {
          el.addEventListener('click', () => {
            // Switch to Artifacts tab
            document.querySelectorAll('.cw-toggle-btn').forEach(b => b.classList.remove('active'));
            const workBtn = document.querySelector('[data-view="work"]');
            if (workBtn) workBtn.classList.add('active');
            document.getElementById('cw-chat-messages').style.display = 'none';
            const inputEl = document.getElementById('cw-chat-input-area');
            if (inputEl) inputEl.style.display = 'none';
            document.getElementById('cw-work-view').style.display = 'flex';
            renderCwWork(el.dataset.name, el.dataset.isdir === 'true');
          });
        });
      }
    }
  } catch { /* ignore */ }

  // Load memory (API returns plain text, not JSON)
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(folder)}`);
    if (res.ok) {
      const text = await res.text();
      const memEl = document.getElementById('cw-memory-preview');
      memEl.innerHTML = md(text || '');
      // Wire up expand/collapse toggle (same pattern as Pixel Office)
      const memToggle = document.getElementById('cw-memory-toggle');
      if (memToggle) {
        memToggle.textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
        memToggle.onclick = () => {
          memEl.classList.toggle('expanded');
          memToggle.textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
        };
      }
    } else {
      document.getElementById('cw-memory-preview').innerHTML = '<span style="color:var(--text-muted)">(no CLAUDE.md found)</span>';
    }
  } catch { /* ignore */ }
}

async function showCreateModal() {
  // Fetch types and instruction templates
  if (!cwState.types) {
    try {
      const res = await fetch('/api/types');
      if (res.ok) cwState.types = await res.json();
    } catch { cwState.types = {}; }
  }
  let instructionTemplates = [];
  try {
    const res = await fetch('/api/instruction-templates');
    if (res.ok) instructionTemplates = await res.json();
  } catch { /* none available */ }

  const overlay = document.createElement('div');
  overlay.className = 'cw-modal-overlay';
  const typeCheckboxes = Object.entries(cwState.types || {}).map(
    ([k, v]) => `<label class="cw-type-checkbox"><input type="checkbox" value="${esc(k)}"><span>${esc(k)}</span><span style="color:var(--text-muted)">— ${esc(v.description || '')}</span></label>`
  ).join('');
  const instructionOptions = instructionTemplates.map(
    (t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`
  ).join('');
  overlay.innerHTML = `<div class="cw-modal">
    <h3>Create Coworker</h3>
    <label>Name</label>
    <input id="cw-new-name" placeholder="e.g. Slang CUDA">
    <label>Folder</label>
    <input id="cw-new-folder" placeholder="e.g. slang-cuda">
    <label>Type (select one or more templates)</label>
    <div id="cw-new-types" style="max-height:200px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--border);border-radius:4px;padding:8px;font-size:11px">${typeCheckboxes}</div>
    <label>Instruction style (optional)</label>
    <select id="cw-new-instruction-style" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
      <option value="">(none — custom only)</option>
      ${instructionOptions}
    </select>
    <label>Agent provider</label>
    <select id="cw-new-provider" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
      <option value="">claude (default)</option>
      <option value="codex">codex</option>
    </select>
    <label>Routing</label>
    <select id="cw-new-routing" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
      <option value="direct">Direct — own channel (default)</option>
      <option value="internal">Internal — via Orchestrator only</option>
    </select>
    <label>Custom instructions (optional)</label>
    <textarea id="cw-new-instructions" rows="3" placeholder="Additional instructions appended after the selected style..." style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-family:monospace;font-size:11px;resize:vertical"></textarea>
    <label>Trigger pattern</label>
    <input id="cw-new-trigger" placeholder="e.g. @SlangCuda">
    <div class="cw-modal-actions">
      <button id="cw-modal-cancel" style="background:var(--bg-hover);color:var(--text)">Cancel</button>
      <button id="cw-modal-create" style="background:var(--green);color:#fff">Create</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  // Auto-fill folder from name
  const nameInput = overlay.querySelector('#cw-new-name');
  const folderInput = overlay.querySelector('#cw-new-folder');
  const triggerInput = overlay.querySelector('#cw-new-trigger');
  nameInput.addEventListener('input', () => {
    const slug = nameInput.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    folderInput.value = slug;
    triggerInput.value = '@' + nameInput.value.replace(/\s+/g, '');
  });
  // Auto-fill from first checked type
  overlay.querySelector('#cw-new-types').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    const checked = Array.from(overlay.querySelectorAll('#cw-new-types input:checked')).map(c => c.value);
    if (checked.length > 0 && !nameInput.value) {
      const t = checked[0];
      const typeName = t.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
      nameInput.value = typeName;
      folderInput.value = t;
      triggerInput.value = '@' + typeName.replace(/\s+/g, '');
    }
  });
  overlay.querySelector('#cw-modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cw-modal-create').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const folder = folderInput.value.trim();
    const checkedTypes = Array.from(overlay.querySelectorAll('#cw-new-types input:checked')).map(c => c.value);
    const trigger = triggerInput.value.trim();
    const instructionStyle = overlay.querySelector('#cw-new-instruction-style')?.value || '';
    const agentProvider = overlay.querySelector('#cw-new-provider')?.value || '';
    const customInstructions = overlay.querySelector('#cw-new-instructions')?.value?.trim() || '';
    // Compose instructions: selected overlay + custom text
    let instructions = '';
    if (instructionStyle) {
      const tmpl = instructionTemplates.find(t => t.name === instructionStyle);
      if (tmpl) instructions += tmpl.content + '\n\n';
    }
    if (customInstructions) instructions += customInstructions;
    if (!name || !folder) return alert('Name and folder are required');
    try {
      const res = await fetch('/api/coworkers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, folder,
          types: checkedTypes.length ? checkedTypes : undefined,
          trigger: trigger || undefined,
          instructions: instructions || undefined,
          instructionTemplate: instructionStyle || undefined,
          agentProvider: agentProvider || undefined,
          routing: document.getElementById('cw-new-routing')?.value || 'direct',
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert('Error: ' + (err.error || 'Unknown error'));
        return;
      }
      overlay.remove();
      // Refresh and select the new coworker
      setTimeout(() => {
        renderCwSidebar();
        selectCoworker(folder);
      }, 500);
    } catch (e) { alert('Error: ' + e.message); }
  });
  nameInput.focus();
}

// Coworker tab event listeners
document.getElementById('cw-create-btn')?.addEventListener('click', showCreateModal);
document.getElementById('cw-chat-send')?.addEventListener('click', sendCwMessage);
document.getElementById('cw-chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCwMessage(); }
});

// Memory editor is read-only (CLAUDE.md re-composed at container startup from coworkerType)

// Chat/Artifacts toggle in Coworkers tab
document.querySelectorAll('.cw-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.cw-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const chatEl = document.getElementById('cw-chat-messages');
    const inputEl = document.getElementById('cw-chat-input-area');
    const workEl = document.getElementById('cw-work-view');
    chatEl.style.display = 'none';
    if (inputEl) inputEl.style.display = 'none';
    workEl.style.display = 'none';
    if (view === 'work') {
      workEl.style.display = 'flex';
      renderCwWork();
    } else {
      chatEl.style.display = '';
      if (inputEl && cwState.selected) inputEl.style.display = 'flex';
    }
  });
});

// Work output browser
async function renderCwWork(subpath, isDir) {
  const breadcrumb = document.getElementById('cw-work-breadcrumb');
  const content = document.getElementById('cw-work-content');
  if (!cwState.selected) { content.innerHTML = '<span style="color:var(--text-muted)">Select a coworker first.</span>'; return; }
  const folder = cwState.selected;
  const path = subpath || '';
  // Track current directory for the work-shell
  cwState.workPath = path;
  cwState.workIsDir = isDir !== false;
  const wsInput = document.getElementById('cw-work-shell-input');
  if (wsInput) {
    const cwd = path && path.includes('.') ? path.replace(/\/[^/]+$/, '') || '' : path;
    wsInput.placeholder = cwd ? `runs in /workspace/agent/${cwd}` : 'runs in /workspace/agent/';
  }

  // Build breadcrumb
  const parts = path ? path.split('/') : [];
  let crumbs = `<a href="#" data-path="" style="color:#58a6ff;text-decoration:none;cursor:pointer">${esc(folder)}</a>`;
  let cumulative = '';
  for (const p of parts) {
    cumulative += (cumulative ? '/' : '') + p;
    crumbs += ` / <a href="#" data-path="${escAttr(cumulative)}" style="color:#58a6ff;text-decoration:none;cursor:pointer">${esc(p)}</a>`;
  }
  breadcrumb.innerHTML = crumbs;
  breadcrumb.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); renderCwWork(a.dataset.path); });
  });

  // Render file content if not a directory (isDir===false from browse, or fallback to extension check)
  if (path && isDir === false) {
    const fileExt = (path.split('.').pop() || '').toLowerCase();
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
    if (imageExts.has(fileExt)) {
      content.innerHTML = `<div style="padding:8px;text-align:center"><img src="/api/coworkers/${encodeURIComponent(folder)}/download/${encodeURIComponent(path)}" style="max-width:100%;border-radius:4px" alt="${esc(path)}"><div style="color:var(--text-muted);font-size:9px;margin-top:4px">${esc(path)}</div></div>`;
      return;
    }
    content.innerHTML = '<span style="color:var(--text-muted)">Loading...</span>';
    try {
      const res = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/read?path=${encodeURIComponent(path)}`);
      if (!res.ok) { content.innerHTML = `<span style="color:#f87171">Error: ${(await res.json()).error}</span>`; return; }
      const file = await res.json();
      const isMarkdown = ['md', 'markdown'].includes(file.ext);
      const isDiff = ['diff', 'patch'].includes(file.ext);
      const isJson = file.ext === 'json';
      if (isMarkdown) {
        content.innerHTML = `<div style="padding:8px;background:var(--bg);border-radius:4px;line-height:1.6">${md(file.content)}</div>`;
      } else if (isJson) {
        try {
          const pretty = JSON.stringify(JSON.parse(file.content), null, 2);
          content.innerHTML = `<pre style="padding:8px;background:#0d1117;color:#c9d1d9;border-radius:4px;overflow-x:auto;font-size:10px;white-space:pre-wrap">${esc(pretty)}</pre>`;
        } catch { content.innerHTML = `<pre style="padding:8px;background:#0d1117;color:#c9d1d9;border-radius:4px;font-size:10px;white-space:pre-wrap">${esc(file.content)}</pre>`; }
      } else if (isDiff) {
        content.innerHTML = `<pre style="padding:8px;background:#0d1117;border-radius:4px;font-size:10px;white-space:pre-wrap;overflow-x:auto">${file.content.split('\n').map(l => {
          if (l.startsWith('+')) return `<span style="color:#3fb950">${esc(l)}</span>`;
          if (l.startsWith('-')) return `<span style="color:#f85149">${esc(l)}</span>`;
          if (l.startsWith('@@')) return `<span style="color:#a371f7">${esc(l)}</span>`;
          return esc(l);
        }).join('\n')}</pre>`;
      } else {
        content.innerHTML = `<pre style="padding:8px;background:#0d1117;color:#c9d1d9;border-radius:4px;font-size:10px;white-space:pre-wrap;overflow-x:auto">${esc(file.content)}</pre>`;
      }
    } catch (e) { content.innerHTML = `<span style="color:#f87171">Failed to load file</span>`; }
    return;
  }

  // Directory listing
  content.innerHTML = '<span style="color:var(--text-muted)">Loading...</span>';
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/browse?path=${encodeURIComponent(path)}`);
    if (!res.ok) { content.innerHTML = '<span style="color:#f87171">Failed to load</span>'; return; }
    const files = await res.json();
    if (files.length === 0) {
      content.innerHTML = '<span style="color:var(--text-muted)">Empty folder</span>';
      return;
    }
    content.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:10px">
      <tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">
        <th style="text-align:left;padding:4px 8px">Name</th>
        <th style="text-align:right;padding:4px 8px">Size</th>
        <th style="text-align:right;padding:4px 8px">Modified</th>
      </tr>
      ${files.map(f => {
        const icon = f.isDir ? '\uD83D\uDCC1' : (f.name.endsWith('.md') ? '\uD83D\uDCDD' : f.name.endsWith('.json') ? '\uD83D\uDCCA' : f.name.endsWith('.diff') || f.name.endsWith('.patch') ? '\uD83D\uDD00' : '\uD83D\uDCC4');
        const size = f.isDir ? '-' : f.size > 1024 ? Math.round(f.size/1024) + 'KB' : f.size + 'B';
        const time = new Date(f.modified).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'});
        return `<tr style="border-bottom:1px solid var(--border);cursor:pointer" class="cw-work-row" data-path="${escAttr(f.path)}" data-isdir="${f.isDir}">
          <td style="padding:4px 8px">${icon} ${esc(f.name)}</td>
          <td style="text-align:right;padding:4px 8px;color:var(--text-muted)">${size}</td>
          <td style="text-align:right;padding:4px 8px;color:var(--text-muted)">${time}</td>
        </tr>`;
      }).join('')}
    </table>`;
    content.querySelectorAll('.cw-work-row').forEach(row => {
      row.addEventListener('click', () => renderCwWork(row.dataset.path, row.dataset.isdir === 'true'));
      row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
      row.addEventListener('mouseleave', () => row.style.background = '');
    });
  } catch { content.innerHTML = '<span style="color:#f87171">Failed to load</span>'; }

  // Init work-shell panel
  const shellStatus = document.getElementById('cw-work-shell-status');
  const shellOutput = document.getElementById('cw-work-shell-output');
  const shellInput = document.getElementById('cw-work-shell-input');
  if (shellStatus && shellOutput.dataset.folder !== folder) {
    shellOutput.dataset.folder = folder;
    shellOutput.textContent = '';
    try {
      const res = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/container`);
      const data = await res.json();
      if (data.running) {
        shellStatus.innerHTML = `<span style="color:#34d399">Live</span> <span style="color:var(--text-dim)">${esc(data.container)}</span>`;
        shellInput.disabled = false;
      } else {
        shellStatus.innerHTML = '<span style="color:var(--text-muted)">No container</span>';
        shellInput.disabled = true;
      }
    } catch { shellStatus.innerHTML = '<span style="color:var(--text-muted)">No container</span>'; shellInput.disabled = true; }
  }
}

async function renderCwShell() {
  const statusEl = document.getElementById('cw-shell-status');
  const outputEl = document.getElementById('cw-shell-output');
  const inputEl = document.getElementById('cw-shell-input');
  if (!cwState.selected) { statusEl.innerHTML = '<span style="color:var(--text-muted)">Select a coworker first.</span>'; return; }
  statusEl.innerHTML = 'Checking container...';
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(cwState.selected)}/container`);
    const data = await res.json();
    if (data.running) {
      statusEl.innerHTML = `<span style="color:#34d399">Connected</span> <span style="color:var(--text-muted)">${esc(data.container)}</span>`;
      if (!outputEl.dataset.initialized) {
        outputEl.textContent = `Connected to ${data.container}\nType commands below. Try: ls /workspace/agent/\n\n`;
        outputEl.dataset.initialized = '1';
      }
      inputEl.disabled = false;
      inputEl.focus();
    } else {
      statusEl.innerHTML = '<span style="color:#facc15">Starting container...</span>';
      inputEl.disabled = true;
      const ok = await ensureContainerRunning(cwState.selected);
      if (ok) {
        const r2 = await fetch(`/api/coworkers/${encodeURIComponent(cwState.selected)}/container`);
        const d2 = await r2.json();
        statusEl.innerHTML = `<span style="color:#34d399">Connected</span> <span style="color:var(--text-muted)">${esc(d2.container)}</span>`;
        outputEl.textContent = `Connected to ${d2.container}\nType commands below. Try: ls /workspace/agent/\n\n`;
        outputEl.dataset.initialized = '1';
        inputEl.disabled = false;
        inputEl.focus();
      } else {
        statusEl.innerHTML = '<span style="color:#f87171">Failed to start container.</span>';
      }
    }
  } catch (e) { statusEl.textContent = 'Error: ' + e.message; }
}

async function execShellCommand(cmd, outputId, inputId) {
  const outputEl = document.getElementById(outputId || 'cw-shell-output');
  const inputEl = document.getElementById(inputId || 'cw-shell-input');
  if (!cwState.selected || !cmd.trim()) return;
  outputEl.textContent += `$ ${cmd}\n`;
  inputEl.disabled = true;
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(cwState.selected)}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await res.json();
    if (data.error) {
      outputEl.textContent += `Error: ${data.error}\n\n`;
    } else {
      if (data.stdout) outputEl.textContent += data.stdout + (data.stdout.endsWith('\n') ? '' : '\n');
      if (data.stderr) outputEl.textContent += data.stderr + (data.stderr.endsWith('\n') ? '' : '\n');
      if (!data.stdout && !data.stderr) outputEl.textContent += '\n';
    }
  } catch (e) { outputEl.textContent += `Error: ${e.message}\n\n`; }
  inputEl.disabled = false;
  inputEl.focus();
  outputEl.scrollTop = outputEl.scrollHeight;
}

document.getElementById('cw-shell-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = e.target.value.trim();
    if (cmd) { execCwShellCommand(cmd); e.target.value = ''; }
  }
});
document.getElementById('cw-shell-run')?.addEventListener('click', () => {
  const input = document.getElementById('cw-shell-input');
  const cmd = input.value.trim();
  if (cmd) { execCwShellCommand(cmd); input.value = ''; }
});

// Main shell: track cwd so consecutive commands respect cd
cwState.shellCwd = '/workspace/agent';
function execCwShellCommand(cmd) {
  const cdMatch = cmd.match(/^\s*cd\s+(.+)$/);
  if (cdMatch) {
    let target = cdMatch[1].trim().replace(/^['"]|['"]$/g, '');
    if (target === '..') {
      cwState.shellCwd = cwState.shellCwd.replace(/\/[^/]+$/, '') || '/';
    } else if (target.startsWith('/')) {
      cwState.shellCwd = target;
    } else {
      cwState.shellCwd = cwState.shellCwd + '/' + target;
    }
    // Also sync work view path if it's a /workspace/agent subpath
    if (cwState.shellCwd.startsWith('/workspace/agent')) {
      const rel = cwState.shellCwd.slice('/workspace/agent'.length).replace(/^\//, '');
      cwState.workPath = rel;
    }
    const outputEl = document.getElementById('cw-shell-output');
    if (outputEl) { outputEl.textContent += `$ cd ${target}\n`; outputEl.scrollTop = outputEl.scrollHeight; }
    return;
  }
  const wrappedCmd = `cd '${cwState.shellCwd.replace(/'/g, "'\\''")}' && ${cmd}`;
  execShellCommand(wrappedCmd);
}

// Work-shell handlers — commands run in the directory shown in the Work breadcrumb
function execWorkShellCommand(cmd) {
  // Intercept `cd` commands and update the file browser path
  const cdMatch = cmd.match(/^\s*cd\s+(.+)$/);
  if (cdMatch) {
    let target = cdMatch[1].trim().replace(/^['"]|['"]$/g, '');
    let newPath;
    if (target === '/' || target === '/workspace/agent') {
      newPath = '';
    } else if (target === '..') {
      newPath = cwState.workPath ? cwState.workPath.replace(/\/?[^/]+$/, '') : '';
    } else if (target.startsWith('/workspace/agent/')) {
      newPath = target.slice('/workspace/agent/'.length);
    } else if (target.startsWith('/')) {
      // Absolute path outside group — can't browse it, just run the command
    } else {
      // Relative path
      newPath = cwState.workPath ? cwState.workPath + '/' + target : target;
    }
    if (newPath !== undefined) {
      renderCwWork(newPath, true);
      const outputEl = document.getElementById('cw-work-shell-output');
      if (outputEl) outputEl.textContent += `$ cd ${target}\n`;
      return;
    }
  }

  const dir = '/workspace/agent' + (cwState.workPath ? '/' + cwState.workPath : '');
  // If browsing a file (not a directory), use its parent directory
  const cwd = cwState.workPath && !cwState.workIsDir ? dir.replace(/\/[^/]+$/, '') : dir;
  const wrappedCmd = `cd '${cwd.replace(/'/g, "'\\''")}' && ${cmd}`;
  execShellCommand(wrappedCmd, 'cw-work-shell-output', 'cw-work-shell-input');
}
document.getElementById('cw-work-shell-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = e.target.value.trim();
    if (cmd) { execWorkShellCommand(cmd); e.target.value = ''; }
  }
});
document.getElementById('cw-work-shell-run')?.addEventListener('click', () => {
  const input = document.getElementById('cw-work-shell-input');
  const cmd = input.value.trim();
  if (cmd) { execWorkShellCommand(cmd); input.value = ''; }
});

// Drag-to-resize between file browser and shell
(function() {
  const divider = document.getElementById('cw-work-divider');
  const shell = document.getElementById('cw-work-shell');
  const container = document.getElementById('cw-work-view');
  if (!divider || !shell || !container) return;
  let dragging = false, startY = 0, startH = 0;
  divider.addEventListener('mousedown', (e) => {
    dragging = true; startY = e.clientY; startH = shell.offsetHeight;
    document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(60, Math.min(startH + delta, container.offsetHeight - 100));
    shell.style.flex = 'none'; shell.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
  });
})();

// View Timeline button (opens full Timeline tab filtered)
document.getElementById('cw-view-timeline')?.addEventListener('click', () => {
  if (!cwState.selected) return;
  switchToTab('observability');
  if (typeof setTimelineFilter === 'function') setTimelineFilter(cwState.selected);
});


// Export coworker as YAML bundle (saved to host). Prompt for mode:
//   lightweight — metadata only; new instance rehydrates from the local lego registry
//   standard    — default; includes .instructions.md overlay and memory snapshot
document.getElementById('cw-export-btn')?.addEventListener('click', async () => {
  if (!cwState.selected) return;
  const useLight = confirm(
    'Export as lightweight bundle?\n\n' +
    'OK  → lightweight (metadata only — the new instance rehydrates identity/invariants/' +
    'context/workflows from its coworker type)\n' +
    'Cancel → standard (metadata + .instructions.md overlay + memory snapshot)'
  );
  const mode = useLight ? 'lightweight' : 'standard';
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(cwState.selected)}/export?mode=${mode}`);
    const result = await res.json();
    if (!res.ok || !result.ok) { alert('Export failed: ' + (result.error || 'Unknown')); return; }
    const sizeKB = (result.size / 1024).toFixed(1);
    alert(`Exported to host (${mode}):\n${result.path}\n\nSize: ${sizeKB} KB`);
  } catch (e) { alert('Export error: ' + e.message); }
});

// Full Archive export (saved to host)
document.getElementById('cw-full-archive-btn')?.addEventListener('click', async () => {
  // Prompt for folder — button is in admin tab, not coworker detail
  const folder = prompt('Coworker folder to export:\n(e.g. slang-triage)');
  if (!folder) return;
  const pauseTasks = confirm('Pause scheduled tasks on source after export?\n\n(Recommended to prevent duplicate execution)');
  try {
    const qp = `full=true${pauseTasks ? '&pauseTasks=true' : ''}`;
    const res = await fetch(`/api/coworkers/${encodeURIComponent(folder)}/export?${qp}`);
    const result = await res.json();
    if (!res.ok || !result.ok) {
      alert('Full archive export failed: ' + (result.error || 'Unknown'));
      return;
    }
    const sizeMB = (result.size / (1024 * 1024)).toFixed(1);
    let msg = `Exported to host:\n${result.path}\n\nSize: ${sizeMB} MB`;
    if (result.pausedTasks) msg += '\n\nSource tasks have been paused.';
    alert(msg);
  } catch (e) { alert('Full archive export error: ' + e.message); }
});

// Import coworker from YAML, JSON, or full archive (.tar.gz)
document.getElementById('cw-import-btn')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.yaml,.yml,.json,.tar.gz,.tgz';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const isArchive = file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz');

      if (isArchive) {
        // Binary archive import
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        if (!confirm(`Import full archive "${file.name}"?\n\nSize: ${sizeMB} MB\nThis will restore sessions, tasks, and Claude state.`)) return;
        const buf = await file.arrayBuffer();
        const res = await fetch('/api/coworkers/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/gzip' },
          body: buf,
        });
        const result = await res.json();
        if (result.ok) {
          let msg = `Imported "${result.name}" (full archive)\nFolder: ${result.folder}`;
          msg += `\nSessions restored: ${result.sessionsRestored || 0}`;
          msg += `\nTasks imported: ${result.tasksImported || 0} (all paused)`;
          msg += `\nDestinations: ${result.destsCreated || 0}`;
          if (result.backupPath) msg += `\n\nDB backup: ${result.backupPath}`;
          if (result.resolvedDests && result.resolvedDests.length > 0) {
            msg += '\n\nDestination mappings:\n' + result.resolvedDests.map(d => `  ${d.name} (${d.type}) \u2192 ${d.resolvedTo}`).join('\n');
          }
          if (result.warnings && result.warnings.length > 0) {
            msg += '\n\nWarnings:\n' + result.warnings.map(w => '  - ' + w).join('\n');
          }
          alert(msg);
          setTimeout(renderCwSidebar, 500);
        } else {
          alert('Import error: ' + (result.error || 'Unknown'));
        }
        return;
      }

      // Lightweight YAML/JSON import
      const text = await file.text();
      let name = 'Unknown';
      let folder = 'unknown';
      let fileCount = 0;
      try {
        const preview = JSON.parse(text);
        name = preview.agent?.name || preview.coworker?.name || name;
        folder = preview.agent?.folder || preview.coworker?.folder || folder;
        fileCount = Object.keys(preview.files || {}).length;
      } catch {
        const nameMatch = text.match(/name:\s*['"]?([^'"\n]+)/);
        const folderMatch = text.match(/folder:\s*['"]?([^'"\n]+)/);
        if (nameMatch) name = nameMatch[1].trim();
        if (folderMatch) folder = folderMatch[1].trim();
      }
      if (!confirm(`Import "${name}"?\n\nFolder: ${folder}\n${fileCount > 0 ? fileCount + ' files' : ''}`)) return;
      const res = await fetch('/api/coworkers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      const result = await res.json();
      if (result.ok) {
        let msg = `Imported "${result.name}"\nFolder: ${result.folder}\nFiles: ${result.filesWritten}\nDestinations: ${result.destsCreated || 0}`;
        if (result.resolvedDests && result.resolvedDests.length > 0) {
          msg += '\n\nDestination mappings:\n' + result.resolvedDests.map(d => `  ${d.name} (${d.type}) \u2192 ${d.resolvedTo}`).join('\n');
        }
        if (result.warnings && result.warnings.length > 0) {
          msg += '\n\nWarnings:\n' + result.warnings.map(w => '  - ' + w).join('\n');
        }
        alert(msg);
        setTimeout(renderCwSidebar, 500);
      } else {
        alert('Import error: ' + (result.error || 'Unknown'));
      }
    } catch (e) { alert('Import error: ' + e.message); }
  };
  input.click();
});

// Import from V1 instance
document.getElementById('cw-import-v1-btn')?.addEventListener('click', async () => {
  const v1Path = prompt('V1 NanoClaw instance path:\n(e.g. /home/ubuntu/jhelferty/nanoclaw)');
  if (!v1Path) return;
  const folder = prompt('Agent folder name:\n(e.g. slang-triage)');
  if (!folder) return;
  if (!confirm(`Import from V1?\n\nPath: ${v1Path}\nFolder: ${folder}\n\nThis will migrate all data: instructions, sessions, learnings, tasks, conversations.`)) return;
  try {
    const res = await fetch('/api/coworkers/import-v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v1Path, folder }),
    });
    const result = await res.json();
    if (result.ok) {
      let msg = `Imported "${result.name}" from V1\nFolder: ${result.folder}\nID: ${result.id}`;
      msg += `\n\nMigration stats:`;
      if (result.stats) {
        msg += `\n  Group files: ${result.stats.groupFiles || 0}`;
        msg += `\n  Claude session files: ${result.stats.claudeFiles || 0}`;
        msg += `\n  Scheduled tasks: ${result.stats.tasks || 0}`;
      }
      msg += `\nSessions restored: ${result.sessionsRestored || 0}`;
      msg += `\nTasks imported: ${result.tasksImported || 0} (all paused)`;
      if (result.backupPath) msg += `\n\nDB backup: ${result.backupPath}`;
      if (result.warnings && result.warnings.length > 0) {
        msg += '\n\nWarnings:\n' + result.warnings.map(w => '  - ' + w).join('\n');
      }
      alert(msg);
      setTimeout(renderCwSidebar, 500);
    } else {
      alert('V1 Import error: ' + (result.error || 'Unknown'));
    }
  } catch (e) { alert('V1 Import error: ' + e.message); }
});

document.getElementById('cw-delete-btn')?.addEventListener('click', async () => {
  if (!cwState.selected) return;
  if (!confirm(`Remove coworker "${cwState.selected}"? (DB entries will be cleaned up)`)) return;
  const deleteData = confirm('Also delete the group folder and artifacts from disk?');
  const qs = deleteData ? '?deleteData' : '';
  try {
    const res = await fetch(`/api/coworkers/${encodeURIComponent(cwState.selected)}${qs}`, { method: 'DELETE' });
    if (res.ok) {
      selectCoworker(null);
      setTimeout(renderCwSidebar, 500);
    } else {
      const err = await res.json();
      alert('Error: ' + (err.error || 'Unknown error'));
    }
  } catch (e) { alert('Error: ' + e.message); }
});

// Refresh coworker sidebar when switching to the tab
document.querySelector('[data-tab="coworkers"]')?.addEventListener('click', () => {
  renderCwSidebar();
});

// Fetch pending approval counts for all main groups (for sidebar amber dot + global toast)
let approvalCountFetchPending = false;
async function refreshApprovalCounts() {
  if (approvalCountFetchPending) return;
  approvalCountFetchPending = true;
  try {
    const mainGroups = getCwCoworkers().filter(c => c.isMain);
    for (const g of mainGroups) {
      try {
        const r = await fetch(`/api/approvals?group=${encodeURIComponent(g.folder)}`);
        const arr = r.ok ? await r.json() : [];
        cwState.approvalCountByFolder[g.folder] = arr.length;
      } catch { cwState.approvalCountByFolder[g.folder] = 0; }
    }
  } finally { approvalCountFetchPending = false; }
}

// Also refresh on state updates (called from WebSocket handler)
let cwSidebarRefreshPending = false;
function scheduleCwRefresh() {
  if (cwSidebarRefreshPending) return;
  cwSidebarRefreshPending = true;
  requestAnimationFrame(() => {
    cwSidebarRefreshPending = false;
    if (document.getElementById('coworkers')?.classList.contains('active')) {
      refreshApprovalCounts().then(() => renderCwSidebar());
      if (cwState.selected) {
        updateCwHeader();
        updateCwDetail();
      }
    }
  });
}

// ===================================================================
// LOGS PANEL
// ===================================================================

let logSearchTimer = null;

async function loadAdminLogs() {
  const source = document.getElementById('log-source-select')?.value || 'app';
  const group = document.getElementById('log-group-select')?.value || '';
  const search = document.getElementById('log-search-input')?.value || '';

  let url = `/api/logs?source=${source}&limit=500`;
  if (source === 'container' && group) url += `&group=${encodeURIComponent(group)}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    adminState.logs = data.lines || [];
    adminState.loaded.add('logs');
    renderLogs();
  } catch {
    document.getElementById('log-viewer').textContent = 'Failed to load logs';
  }
}

function renderLogs() {
  const viewer = document.getElementById('log-viewer');
  if (!viewer) return;
  if (adminState.logs.length === 0) {
    viewer.innerHTML = '<span style="color:var(--text-muted)">No log lines found</span>';
    return;
  }
  viewer.innerHTML = adminState.logs.map((line) => {
    let cls = 'log-info';
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('err]')) cls = 'log-error';
    else if (lower.includes('warn')) cls = 'log-warn';
    else if (lower.includes('debug')) cls = 'log-debug';
    return `<div class="log-line ${cls}">${esc(line)}</div>`;
  }).join('');
  viewer.scrollTop = viewer.scrollHeight;
}

// Logs events
document.getElementById('log-source-select')?.addEventListener('change', (e) => {
  const groupSelect = document.getElementById('log-group-select');
  if (e.target.value === 'container') {
    groupSelect.style.display = '';
    // Populate with groups
    groupSelect.innerHTML = '<option value="">Select group...</option>';
    for (const g of state.registeredGroups) {
      const opt = document.createElement('option');
      opt.value = g.folder;
      opt.textContent = g.name || g.folder;
      groupSelect.appendChild(opt);
    }
  } else {
    groupSelect.style.display = 'none';
  }
  loadAdminLogs();
});

document.getElementById('log-group-select')?.addEventListener('change', () => loadAdminLogs());

document.getElementById('log-search-input')?.addEventListener('input', () => {
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(loadAdminLogs, 300);
});

// ===================================================================
// CHANNELS PANEL
// ===================================================================

async function loadAdminChannels() {
  const el = document.getElementById('admin-channels-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/channels');
    if (!res.ok) throw new Error('fetch failed');
    adminState.channels = await res.json();
    adminState.loaded.add('channels');
    renderChannels();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load channels</div>'; }
}

function renderChannels() {
  const el = document.getElementById('admin-channels-content');
  if (adminState.channels.length === 0) {
    el.innerHTML = '<div class="admin-empty">No channels found in src/channels/</div>';
    return;
  }
  el.innerHTML = adminState.channels.map((ch) => {
    const dotColor = ch.configured ? 'var(--green)' : 'var(--text-muted)';
    const statusText = ch.configured ? 'Connected' : 'Not configured';
    const groupsList = ch.groups.length > 0
      ? ch.groups.map((g) => esc(g.name || g.folder)).join(', ')
      : 'No groups';
    return `<div class="channel-card">
      <div class="channel-status-dot" style="background:${dotColor}"></div>
      <div class="channel-info">
        <h4>${esc(ch.name)}</h4>
        <div style="font-size:9px;color:${ch.configured ? 'var(--green)' : 'var(--text-muted)'};margin-bottom:4px">${statusText}</div>
        <div class="channel-groups">${groupsList}</div>
      </div>
    </div>`;
  }).join('');
}

// ===================================================================
// CONFIG PANEL
// ===================================================================

async function loadAdminConfig() {
  const el = document.getElementById('admin-config-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const [configRes, claudeMdRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/config/claude-md').then((r) => r.ok ? r.text() : '(not found)').catch(() => '(not found)'),
    ]);
    if (!configRes.ok) throw new Error('fetch failed');
    adminState.config = await configRes.json();
    adminState.loaded.add('config');
    renderConfig(claudeMdRes);
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load config</div>'; }
}

function renderConfig(claudeMdContent) {
  const el = document.getElementById('admin-config-content');
  let html = `<h4 style="font-size:11px;margin-bottom:8px">Environment Configuration</h4>
    <table class="admin-table">
    <tr><th>Key</th><th>Value</th><th>Env Var</th><th>Description</th></tr>`;
  for (const c of adminState.config) {
    html += `<tr>
      <td style="font-weight:600">${esc(c.key)}</td>
      <td style="color:${c.value ? 'var(--text)' : 'var(--text-muted)'}">${esc(c.value || '(not set)')}</td>
      <td style="font-size:9px;color:var(--text-muted)">${esc(c.env)}</td>
      <td style="color:var(--text-dim)">${esc(c.description)}</td>
    </tr>`;
  }
  html += '</table>';

  // CLAUDE.md editor
  html += `<h4 style="font-size:11px;margin:16px 0 8px">CLAUDE.md Editor</h4>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <select id="config-md-scope" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:2px 8px;font-family:var(--font);font-size:10px">
        <option value="root">Root CLAUDE.md</option>
        <option value="global">Global Memory (groups/global)</option>
      </select>
      <button class="admin-action-btn" id="config-md-toggle-view" style="font-size:9px;padding:2px 8px">Edit</button>
    </div>
    <div id="config-md-preview" class="md-content md-preview" style="max-height:400px;overflow-y:auto;margin-bottom:8px">${md(claudeMdContent)}</div>
    <textarea id="config-md-editor" class="admin-editor" style="min-height:200px;display:none">${esc(claudeMdContent)}</textarea>
    <button class="admin-save-btn" data-action="save-config-md">Save</button>`;
  el.innerHTML = html;

  // Scope change handler
  document.getElementById('config-md-scope')?.addEventListener('change', async (e) => {
    const editor = document.getElementById('config-md-editor');
    const preview = document.getElementById('config-md-preview');
    const scope = e.target.value;
    try {
      const url = scope === 'root' ? '/api/config/claude-md' : '/api/memory/global';
      const res = await fetch(url);
      const text = res.ok ? await res.text() : '(not found)';
      editor.value = text;
      if (preview) preview.innerHTML = md(text);
    } catch { editor.value = '(error loading)'; }
  });

  // Preview toggle
  document.getElementById('config-md-toggle-view')?.addEventListener('click', () => {
    const editor = document.getElementById('config-md-editor');
    const preview = document.getElementById('config-md-preview');
    const btn = document.getElementById('config-md-toggle-view');
    if (preview.style.display === 'none') {
      preview.innerHTML = md(editor.value);
      preview.style.display = 'block';
      editor.style.display = 'none';
      btn.textContent = 'Edit';
    } else {
      preview.style.display = 'none';
      editor.style.display = '';
      btn.textContent = 'Preview';
    }
  });
}

// Auto-load overview when admin tab is first shown
document.querySelector('[data-tab="admin"]')?.addEventListener('click', () => {
  if (!adminState.loaded.has('overview')) loadAdminOverview();
});

// --- Init ---
window.addEventListener('resize', () => { needsResize = true; });
// Ensure canvas is sized after layout settles (fixes race in some browsers)
function scheduleResize() { needsResize = true; }
window.addEventListener('load', scheduleResize);
setTimeout(scheduleResize, 100);
setTimeout(scheduleResize, 500);
needsResize = !resizeCanvas();

async function bootstrapDashboardApp() {
  const authed = await ensureDashboardAuth();
  if (!authed) {
    setLiveStatus('Locked', 'var(--yellow)');
    return;
  }
  connectLiveUpdates();
  animate();
}

bootstrapDashboardApp().catch(() => {
  setLiveStatus('Auth Error', 'var(--red)');
});

window.addEventListener('beforeunload', () => {
  if (liveSource) liveSource.close();
});

// --- Infrastructure Panel ---
async function loadAdminInfra() {
  const el = document.getElementById('admin-infra-content');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const res = await fetch('/api/infrastructure');
    if (!res.ok) throw new Error('fetch failed');
    adminState.infra = await res.json();
    adminState.loaded.add('infra');
    renderAdminInfra();
  } catch { el.innerHTML = '<div class="admin-empty">Failed to load infrastructure status</div>'; }
}

function renderAdminInfra() {
  const d = adminState.infra;
  if (!d) return;
  const el = document.getElementById('admin-infra-content');

  const dot = (ok) => ok ? '<span style="color:var(--green)">&#9679;</span>' : '<span style="color:var(--red)">&#9679;</span>';
  const mcpOk = d.mcpAuthProxy?.status === 'running';
  const onecliOk = d.onecli?.status === 'running';
  const netOk = d.network?.status === 'active';

  // Local MCP servers (auto-discovered) with stop/restart controls
  const localServers = (d.mcpAuthProxy?.servers || []).map(s => `
    <tr><td>${esc(s)}</td><td>Local (stdio)</td><td>${d.mcpAuthProxy?.toolCount || 0} tools</td>
    <td><span class="admin-chip active">Running</span>
    <button class="admin-action-btn" style="font-size:9px;padding:1px 6px;margin-left:4px" onclick="restartMcp('${esc(s)}')">Restart</button>
    <button class="admin-action-btn danger" style="font-size:9px;padding:1px 6px" onclick="stopMcp('${esc(s)}')">Stop</button></td></tr>`).join('');

  // Remote MCP servers (registered via dashboard) — check token status per server
  const tokenStatus = d.oauth?.tokenStatus || {};
  const remoteServers = (d.remoteMcpServers || []).map(s => {
    const hasToken = tokenStatus[s.name];
    const authBadge = hasToken
      ? `<span class="admin-chip active" style="font-size:8px">Authorized</span>`
      : `<span class="admin-chip stopped" style="font-size:8px">No token</span>`;
    const authBtn = hasToken
      ? `<button class="admin-action-btn danger" style="font-size:9px;padding:1px 6px" onclick="revokeOAuth('${esc(s.name)}')">Revoke</button>`
      : `<button class="admin-action-btn success" style="font-size:9px;padding:1px 6px" onclick="pasteToken('${esc(s.name)}')">Add Token</button>`;
    return `<tr><td>${esc(s.name)}</td><td>${authBadge}</td><td style="font-size:8px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(s.url)}</td>
    <td>${authBtn} <button class="admin-action-btn danger" style="font-size:9px;padding:1px 6px" onclick="removeRemoteMcp('${esc(s.name)}')">Remove</button></td></tr>`;
  }).join('');

  // OAuth servers
  const oauthServers = d.oauth?.servers || [];
  const oauthRows = oauthServers.map(s => `
    <tr><td>${esc(s.name)}</td>
    <td><span class="admin-chip ${s.authorized ? 'active' : 'stopped'}">${s.authorized ? 'Authorized' : 'Not authorized'}</span></td>
    <td>${s.authorized
      ? `<button class="admin-action-btn danger" onclick="revokeOAuth('${esc(s.name)}')">Revoke</button>`
      : `<button class="admin-action-btn success" onclick="authorizeOAuth('${esc(s.name)}')">Browser Auth</button>
         <button class="admin-action-btn" onclick="pasteToken('${esc(s.name)}')">Paste Token</button>`
    }</td></tr>`).join('')
    || '<tr><td colspan="3" style="color:var(--text-muted)">No OAuth servers. Import MCP servers below to auto-create.</td></tr>';

  // Containers
  const containers = (d.containers?.list || []).map(c => `
    <tr><td>${esc(c.name.replace('nanoclaw-', ''))}</td>
    <td><span class="admin-chip running">${esc(c.status)}</span></td>
    <td>${esc(c.networks || 'default')}</td></tr>`).join('')
    || '<tr><td colspan="3" style="color:var(--text-muted)">No containers running</td></tr>';

  el.innerHTML = `
    <div class="admin-stat-grid">
      <div class="admin-stat-card"><div class="num">${dot(mcpOk)} ${mcpOk ? 'Up' : 'Down'}</div><div class="label">MCP Auth Proxy</div></div>
      <div class="admin-stat-card"><div class="num">${d.mcpAuthProxy?.toolCount || 0}</div><div class="label">Discovered Tools</div></div>
      <div class="admin-stat-card"><div class="num">${dot(onecliOk)} ${onecliOk ? 'Up' : 'Down'}</div><div class="label">OneCLI Gateway</div></div>
      <div class="admin-stat-card"><div class="num">${dot(netOk)} ${netOk ? 'On' : 'Off'}</div><div class="label">Network Isolation</div></div>
      <div class="admin-stat-card"><div class="num">${d.containers?.count || 0}</div><div class="label">Containers</div></div>
      <div class="admin-stat-card"><div class="num">${(d.remoteMcpServers || []).length}</div><div class="label">Remote Servers</div></div>
    </div>

    <h4 style="font-size:11px;margin:10px 0 6px">MCP Servers</h4>
    <table class="admin-table">
      <tr><th>Server</th><th>Type</th><th>Details</th><th></th></tr>
      ${localServers}${remoteServers}
      ${!localServers && !remoteServers ? '<tr><td colspan="4" style="color:var(--text-muted)">No servers</td></tr>' : ''}
    </table>

    <h4 style="font-size:11px;margin:14px 0 6px">Import Remote MCP Servers</h4>
    <p style="font-size:9px;color:var(--text-dim);margin:0 0 6px">Paste your mcpServers JSON config (from Cursor, Claude, etc.) to register remote servers.</p>
    <textarea id="infra-import-json" class="admin-editor" style="height:80px;font-size:9px" placeholder='{"mcpServers": {"MaaS NVBugs": {"url": "https://..."}, ...}}'></textarea>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="admin-save-btn" onclick="importMcpServers()" style="margin:0">Import Servers</button>
    </div>

    <h4 style="font-size:11px;margin:14px 0 6px">OAuth Authorization</h4>
    <table class="admin-table">
      <tr><th>Server</th><th>Status</th><th>Action</th></tr>
      ${oauthRows}
    </table>

    <h4 style="font-size:11px;margin:14px 0 6px">Running Containers</h4>
    <table class="admin-table">
      <tr><th>Name</th><th>Status</th><th>Network</th></tr>
      ${containers}
    </table>

    <h4 style="font-size:11px;margin:14px 0 6px">Security Layers</h4>
    <table class="admin-table">
      <tr><th>Layer</th><th>Status</th><th>Details</th></tr>
      <tr><td>MCP Auth Proxy</td><td><span class="admin-chip ${mcpOk ? 'active' : 'stopped'}">${mcpOk ? 'Enforcing' : 'Down'}</span></td><td>Per-container tokens + tool ACL</td></tr>
      <tr><td>OneCLI MITM</td><td><span class="admin-chip ${onecliOk ? 'active' : 'stopped'}">${onecliOk ? 'Enforcing' : 'Down'}</span></td><td>API key injection (Anthropic, GitHub)</td></tr>
      <tr><td>Network Isolation</td><td><span class="admin-chip ${netOk ? 'active' : 'stopped'}">${netOk ? 'Enforcing' : 'Off'}</span></td><td>icc=false (no inter-container traffic)</td></tr>
      <tr><td>Credential Isolation</td><td><span class="admin-chip active">Enforcing</span></td><td>.env shadowed, tokens on host only</td></tr>
    </table>
  `;
}

// --- Infra panel actions ---
window.authorizeOAuth = function(serverName) {
  window.open('/oauth/authorize?server=' + encodeURIComponent(serverName), '_blank');
};

window.pasteToken = function(serverName) {
  const token = prompt('Paste your access token for ' + serverName + ':');
  if (!token) return;
  const refresh = prompt('Paste refresh token (optional, press Cancel to skip):');
  fetch('/oauth/manual-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverName, accessToken: token, refreshToken: refresh || undefined }),
  }).then(r => {
    if (r.ok) { adminState.loaded.delete('infra'); loadAdminInfra(); alert('Token saved for ' + serverName); }
    else r.json().then(j => alert('Error: ' + j.error));
  }).catch(e => alert('Failed: ' + e.message));
};

window.revokeOAuth = function(serverName) {
  if (!confirm('Revoke tokens for ' + serverName + '?')) return;
  fetch('/oauth/revoke?server=' + encodeURIComponent(serverName), { method: 'POST' })
    .then(() => { adminState.loaded.delete('infra'); loadAdminInfra(); })
    .catch(e => alert('Revoke failed: ' + e.message));
};

window.removeRemoteMcp = function(name) {
  if (!confirm('Remove remote MCP server ' + name + '?')) return;
  fetch('/api/mcp-servers?name=' + encodeURIComponent(name), { method: 'DELETE' })
    .then(() => { adminState.loaded.delete('infra'); loadAdminInfra(); })
    .catch(e => alert('Remove failed: ' + e.message));
};

window.stopMcp = function(name) {
  if (!confirm('Stop MCP server ' + name + '? Agents will lose access to its tools.')) return;
  // Auth proxy management endpoints are on the MCP port — read from infra data
  const mcpPort = location.port; // Dashboard proxies, or use direct
  fetch('/api/mcp-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', name }) })
    .then(r => r.json()).then(j => { if (j.ok) { adminState.loaded.delete('infra'); loadAdminInfra(); } else alert(j.error); })
    .catch(e => alert('Failed: ' + e.message));
};

window.restartMcp = function(name) {
  fetch('/api/mcp-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restart', name }) })
    .then(r => r.json()).then(j => { if (j.ok) { adminState.loaded.delete('infra'); loadAdminInfra(); } else alert(j.error); })
    .catch(e => alert('Failed: ' + e.message));
};

window.importMcpServers = function() {
  const textarea = document.getElementById('infra-import-json');
  try {
    const raw = JSON.parse(textarea.value);
    const payload = raw.mcpServers ? raw : { mcpServers: raw };
    fetch('/api/mcp-servers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json()).then(j => {
      if (j.ok) {
        textarea.value = '';
        adminState.loaded.delete('infra');
        loadAdminInfra();
        alert('Imported ' + j.count + ' servers: ' + j.imported.join(', '));
      } else alert('Error: ' + j.error);
    }).catch(e => alert('Import failed: ' + e.message));
  } catch { alert('Invalid JSON. Paste a valid mcpServers config.'); }
};

// Custom CSS zoom removed — use browser zoom (Ctrl+/- or Cmd+/-) instead.
// Clean up stale localStorage from previous custom zoom.
localStorage.removeItem('nanoclaw-zoom');
