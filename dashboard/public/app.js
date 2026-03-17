/**
 * NanoClaw Dashboard — Main Application
 *
 * Tab 1: Pixel Art Office — warm RPG-style office, characters at desks
 * Tab 2: Timeline / Audit — dev-mode timeline of all events + debug log
 */

// --- State ---
let state = { coworkers: [], tasks: [], taskRunLogs: [], registeredGroups: [], hookEvents: [], timestamp: 0 };
let selectedCoworker = null;
let frame = 0;
let ws = null;
let mouseX = 0, mouseY = 0;
let hoveredDesk = -1;

const { TILE, CHAR_W, CHAR_H, ZOOM, PALETTE } = PixelSprites;
const Z = ZOOM;

// --- WebSocket ---
function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => {
    document.getElementById('ws-status').textContent = 'Connected';
    document.querySelector('.status-dot').style.background = 'var(--green)';
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg.data;
        updateTimeline();
      }
    } catch {}
  };
  ws.onclose = () => {
    document.getElementById('ws-status').textContent = 'Reconnecting...';
    document.querySelector('.status-dot').style.background = 'var(--yellow)';
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => ws.close();
}

// --- Tab switching ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ===================================================================
// TAB 1: PIXEL ART OFFICE
// ===================================================================

const canvas = document.getElementById('office-canvas');
const ctx = canvas.getContext('2d');

// Office layout
const OFFICE_COLS = 4;          // desks per row
const DESK_W = 38 * Z;         // desk area width
const DESK_H = 32 * Z;         // desk area height
const WALL_H = (TILE + 8) * Z; // wall tile rendered height
const PADDING = 20;
const ROW_GAP = 24 * Z;        // gap between desk rows

// Per-coworker animation state
const charAnims = new Map(); // folder -> { x, y, targetX, targetY, walkFrame }

function getCharAnim(folder) {
  if (!charAnims.has(folder)) {
    charAnims.set(folder, { x: 0, y: 0, targetX: 0, targetY: 0, walkFrame: 0, initialized: false });
  }
  return charAnims.get(folder);
}

function resizeCanvas() {
  const parent = canvas.parentElement;
  canvas.width = parent.clientWidth;
  canvas.height = parent.clientHeight - 28;
}

function deskPosition(index) {
  const col = index % OFFICE_COLS;
  const row = Math.floor(index / OFFICE_COLS);
  const x = PADDING + col * (DESK_W + 12);
  const y = WALL_H + 16 + row * (DESK_H + ROW_GAP);
  return { x, y, col, row };
}

function drawFloor() {
  const tw = TILE * Z;
  const cols = Math.ceil(canvas.width / tw) + 1;
  const rows = Math.ceil(canvas.height / tw) + 1;

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const tile = PixelSprites.generateFloorTile((rx * 7 + ry * 3) % 9);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tile, rx * tw, ry * tw, tw, tw);
    }
  }
}

function drawWalls() {
  const tw = TILE * Z;
  const cols = Math.ceil(canvas.width / tw) + 1;
  const wallTile = PixelSprites.generateWallTile(true);

  for (let rx = 0; rx < cols; rx++) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(wallTile, rx * tw, 0, tw, WALL_H);
  }

  // Shadow under wall
  ctx.fillStyle = '#00000020';
  ctx.fillRect(0, WALL_H, canvas.width, 4 * Z);
}

function drawDeskSetup(x, y, cw, index) {
  const desk = PixelSprites.generateDesk();
  const monitor = PixelSprites.generateMonitor(cw.color || '#4ADE80');
  const chair = PixelSprites.generateChair(cw.color || '#5B6B7B');

  ctx.imageSmoothingEnabled = false;

  // Chair (behind desk, z-sorted by Y)
  ctx.drawImage(chair, x + 13 * Z, y + 18 * Z, 12 * Z, 18 * Z);

  // Desk
  ctx.drawImage(desk, x, y + 8 * Z, 32 * Z, 20 * Z);

  // Monitor on desk
  ctx.drawImage(monitor, x + 9 * Z, y, 14 * Z, 14 * Z);

  // Screen content when working
  if (cw.status === 'working' || cw.status === 'thinking') {
    // Screen glow
    ctx.fillStyle = (cw.color || '#4ADE80') + '15';
    ctx.fillRect(x + 10 * Z, y + 1 * Z, 12 * Z, 8 * Z);

    // Animated code lines
    PixelSprites.generateScreenContent(
      ctx,
      x + 10 * Z, y + 2 * Z,
      10 * Z, 6 * Z,
      frame, cw.type
    );
  }

  // Desk items
  const mug = PixelSprites.generateCoffeeMug();
  ctx.drawImage(mug, x + 2 * Z, y + 7 * Z, 6 * Z, 6 * Z);

  if (index % 3 === 0) {
    const books = PixelSprites.generateBookStack();
    ctx.drawImage(books, x + 25 * Z, y + 5 * Z, 8 * Z, 8 * Z);
  }
  if (index % 3 === 1) {
    const papers = PixelSprites.generatePapers();
    ctx.drawImage(papers, x + 26 * Z, y + 7 * Z, 8 * Z, 6 * Z);
  }
}

function drawCharacter(cw, deskX, deskY) {
  const anim = getCharAnim(cw.folder);
  const charStatus = cw.status === 'idle' ? 'idle' : cw.status;

  // Target position: seated at desk
  anim.targetX = deskX + 12 * Z;
  anim.targetY = deskY + 8 * Z;

  if (!anim.initialized) {
    anim.x = anim.targetX;
    anim.y = anim.targetY;
    anim.initialized = true;
  }

  // Smooth interpolation
  anim.x += (anim.targetX - anim.x) * 0.08;
  anim.y += (anim.targetY - anim.y) * 0.08;

  // Generate and draw character
  const charSprite = PixelSprites.generateCharacter(
    cw.type, cw.color, frame, charStatus
  );
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(charSprite, Math.round(anim.x), Math.round(anim.y), CHAR_W * Z, CHAR_H * Z);
}

function drawNameplate(x, y, cw, isHovered) {
  const name = cw.name.length > 12 ? cw.name.slice(0, 10) + '..' : cw.name;

  // Status dot
  const dotColors = { idle: '#6B7280', working: '#10B981', thinking: '#F59E0B', error: '#EF4444' };
  const dotColor = dotColors[cw.status] || '#6B7280';

  // Background plate
  const plateY = y + 34 * Z;
  ctx.font = `${9 * Z / 3}px "Courier New", monospace`;
  const textW = ctx.measureText(name).width + 16;

  if (isHovered) {
    ctx.fillStyle = '#0f172aCC';
    ctx.fillRect(x, plateY - 2, textW + 8, 14);
    ctx.strokeStyle = cw.color || '#475569';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, plateY - 2, textW + 8, 14);
  }

  // Dot
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(x + 5, plateY + 4, 3, 0, Math.PI * 2);
  ctx.fill();

  // Name text
  ctx.fillStyle = isHovered ? '#E2E8F0' : '#94A3B8';
  ctx.fillText(name, x + 12, plateY + 7);
}

function drawSpeechBubble(x, y, text, color) {
  if (!text) return;
  const maxLen = 30;
  const display = text.length > maxLen ? text.slice(0, maxLen - 2) + '..' : text;

  ctx.font = '9px "Courier New", monospace';
  const w = ctx.measureText(display).width + 10;
  const h = 16;
  const bx = x - w / 2 + 8 * Z;
  const by = y - 6;

  // Shadow
  ctx.fillStyle = '#0f172a80';
  ctx.fillRect(bx + 2, by + 2, w, h);

  // Bubble
  ctx.fillStyle = '#1E293BEE';
  ctx.strokeStyle = color || '#475569';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, 3);
  ctx.fill();
  ctx.stroke();

  // Tail
  ctx.fillStyle = '#1E293BEE';
  ctx.beginPath();
  ctx.moveTo(bx + w / 2 - 3, by + h);
  ctx.lineTo(bx + w / 2, by + h + 5);
  ctx.lineTo(bx + w / 2 + 3, by + h);
  ctx.closePath();
  ctx.fill();

  // Text
  ctx.fillStyle = '#E2E8F0';
  ctx.fillText(display, bx + 5, by + 11);
}

function drawDecorations() {
  // Plants along the wall
  const plant = PixelSprites.generatePlant();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(plant, PADDING, WALL_H - 6, 12 * Z, 18 * Z);
  ctx.drawImage(plant, canvas.width - PADDING - 12 * Z, WALL_H - 6, 12 * Z, 18 * Z);

  // Additional plants every few desks
  const numRows = Math.ceil(state.coworkers.length / OFFICE_COLS);
  for (let r = 0; r < numRows; r++) {
    const py = WALL_H + 16 + r * (DESK_H + ROW_GAP) + DESK_H;
    if (r % 2 === 0) {
      ctx.drawImage(plant, canvas.width - PADDING - 10 * Z, py, 12 * Z, 18 * Z);
    }
  }

  // Wall decorations
  ctx.fillStyle = '#475569';
  ctx.font = '10px "Courier New", monospace';
  ctx.fillText('NANOCLAW', PADDING + 16 * Z, WALL_H - 12);

  // Clock on wall
  const clockX = canvas.width - PADDING - 30 * Z;
  const clockY = 6 * Z;
  ctx.fillStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.arc(clockX, clockY, 6 * Z, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.arc(clockX, clockY, 5 * Z, 0, Math.PI * 2);
  ctx.fill();
  // Clock hands
  const now = new Date();
  const hourAngle = (now.getHours() % 12) / 12 * Math.PI * 2 - Math.PI / 2;
  const minAngle = now.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(clockX, clockY);
  ctx.lineTo(clockX + Math.cos(hourAngle) * 3 * Z, clockY + Math.sin(hourAngle) * 3 * Z);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(clockX, clockY);
  ctx.lineTo(clockX + Math.cos(minAngle) * 4 * Z, clockY + Math.sin(minAngle) * 4 * Z);
  ctx.stroke();
}

function drawOffice() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawFloor();
  drawWalls();
  drawDecorations();

  // Z-sort: collect all renderable entities
  const entities = [];

  state.coworkers.forEach((cw, i) => {
    const pos = deskPosition(i);
    entities.push({
      y: pos.y + 20 * Z, // sort key
      type: 'desk',
      cw,
      pos,
      index: i,
    });
  });

  // Sort by Y for proper overlap
  entities.sort((a, b) => a.y - b.y);

  // Draw sorted
  for (const ent of entities) {
    const { cw, pos, index } = ent;
    const isHovered = hoveredDesk === index;

    drawDeskSetup(pos.x, pos.y, cw, index);
    drawCharacter(cw, pos.x, pos.y);
    drawNameplate(pos.x, pos.y, cw, isHovered);

    // Speech bubble
    if (cw.status === 'working' || cw.status === 'thinking') {
      const bubbleText = cw.lastToolUse || cw.currentTask;
      if (bubbleText) {
        drawSpeechBubble(pos.x, pos.y - 4, bubbleText, cw.color);
      }
    }

    // Hover highlight
    if (isHovered) {
      ctx.strokeStyle = (cw.color || '#3B82F6') + '60';
      ctx.lineWidth = 2;
      ctx.strokeRect(pos.x - 4, pos.y - 4, DESK_W + 8, DESK_H + ROW_GAP - 8);
    }

    // Selection highlight
    if (selectedCoworker && selectedCoworker.folder === cw.folder) {
      ctx.strokeStyle = cw.color || '#3B82F6';
      ctx.lineWidth = 2;
      ctx.strokeRect(pos.x - 4, pos.y - 4, DESK_W + 8, DESK_H + ROW_GAP - 8);
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
    ctx.fillText('./scripts/spawn-coworker.sh or /onboard-coworker', canvas.width / 2, canvas.height / 2 + 12);
    ctx.textAlign = 'left';
  }
}

// --- Mouse handling ---
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;

  hoveredDesk = -1;
  state.coworkers.forEach((cw, i) => {
    const pos = deskPosition(i);
    if (mouseX >= pos.x - 4 && mouseX <= pos.x + DESK_W + 4 &&
        mouseY >= pos.y - 4 && mouseY <= pos.y + DESK_H + ROW_GAP - 4) {
      hoveredDesk = i;
    }
  });

  canvas.style.cursor = hoveredDesk >= 0 ? 'pointer' : 'default';
});

canvas.addEventListener('click', (e) => {
  if (hoveredDesk >= 0) {
    selectedCoworker = state.coworkers[hoveredDesk];
    showDetailPanel(selectedCoworker);
  } else {
    selectedCoworker = null;
    document.getElementById('detail-panel').classList.remove('visible');
  }
});

document.getElementById('detail-close').addEventListener('click', () => {
  selectedCoworker = null;
  document.getElementById('detail-panel').classList.remove('visible');
});

async function showDetailPanel(cw) {
  const panel = document.getElementById('detail-panel');
  panel.classList.add('visible');

  document.getElementById('detail-name').textContent = cw.name;
  document.getElementById('detail-type').textContent = `${cw.type}`;

  const sc = { idle: ['#6B7280', 'IDLE'], working: ['#10B981', 'WORKING'], thinking: ['#F59E0B', 'THINKING'], error: ['#EF4444', 'ERROR'] };
  const [sColor, sLabel] = sc[cw.status] || sc.idle;
  document.getElementById('detail-status').innerHTML =
    `<span class="status-badge" style="background:${sColor}20;color:${sColor}">${sLabel}</span>`;

  document.getElementById('detail-task').textContent = cw.currentTask || 'None';
  document.getElementById('detail-activity').textContent = cw.lastActivity ? timeAgo(cw.lastActivity) : 'Never';
  document.getElementById('detail-task-count').textContent = cw.taskCount;
  document.getElementById('detail-tool').textContent = cw.lastToolUse || '—';

  // Load memory
  const memEl = document.getElementById('detail-memory');
  memEl.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/memory/${cw.folder}`);
    memEl.textContent = res.ok
      ? (await res.text()).slice(0, 2000)
      : '(no CLAUDE.md)';
  } catch {
    memEl.textContent = '(error)';
  }

  // Hook events for this coworker
  const hooksEl = document.getElementById('detail-hooks');
  const events = state.hookEvents.filter((e) => e.group === cw.folder).slice(-10);
  hooksEl.innerHTML = events.length > 0
    ? '<label style="color:var(--text-dim);font-size:10px;text-transform:uppercase">Recent Events</label>' +
      events.map((e) =>
        `<div class="hook-entry"><span class="ts">${formatTime(e.timestamp)}</span> <span class="tool-name">${e.tool || e.event}</span> ${e.message || ''}</div>`
      ).join('')
    : '';
}

function updateStatusBar() {
  const counts = { working: 0, thinking: 0, idle: 0, error: 0 };
  for (const cw of state.coworkers) counts[cw.status] = (counts[cw.status] || 0) + 1;
  document.getElementById('stat-working').textContent = counts.working;
  document.getElementById('stat-thinking').textContent = counts.thinking;
  document.getElementById('stat-idle').textContent = counts.idle;
  document.getElementById('stat-error').textContent = counts.error;
  document.getElementById('stat-time').textContent = new Date().toLocaleTimeString();
}

// Animation loop
function animate() {
  frame++;
  resizeCanvas();
  drawOffice();
  updateStatusBar();

  if (selectedCoworker) {
    const updated = state.coworkers.find((c) => c.folder === selectedCoworker.folder);
    if (updated) selectedCoworker = updated;
  }

  requestAnimationFrame(animate);
}

// ===================================================================
// TAB 2: TIMELINE / AUDIT LOG (Dev Mode)
// ===================================================================

function updateTimeline() {
  // Stats
  document.getElementById('obs-total-coworkers').textContent = state.coworkers.length;
  document.getElementById('obs-total-tasks').textContent = state.tasks.length;
  document.getElementById('obs-total-runs').textContent = state.taskRunLogs.length;

  const successes = state.taskRunLogs.filter((l) => l.status === 'success').length;
  const total = state.taskRunLogs.length;
  document.getElementById('obs-success-rate').textContent = total > 0 ? Math.round((successes / total) * 100) + '%' : '—';

  const durations = state.taskRunLogs.filter((l) => l.duration_ms).map((l) => l.duration_ms);
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  document.getElementById('obs-avg-duration').textContent = avg > 0 ? formatDuration(avg) : '—';

  // Timeline — merge all events into unified sorted list
  const timeline = [];

  // Task runs
  for (const log of state.taskRunLogs) {
    const task = state.tasks.find((t) => t.id === log.task_id);
    timeline.push({
      time: new Date(log.run_at).getTime(),
      type: 'task-run',
      group: task?.group_folder || '?',
      icon: log.status === 'success' ? '✓' : log.status === 'error' ? '✗' : '●',
      iconColor: log.status === 'success' ? 'var(--green)' : log.status === 'error' ? 'var(--red)' : 'var(--yellow)',
      title: `Task ${log.status}`,
      detail: `${formatDuration(log.duration_ms)} — ${(log.result || log.error || '').slice(0, 100)}`,
      prompt: task?.prompt || '',
    });
  }

  // Hook events
  for (const ev of state.hookEvents) {
    timeline.push({
      time: ev.timestamp,
      type: 'hook',
      group: ev.group || '?',
      icon: '⚡',
      iconColor: 'var(--yellow)',
      title: ev.tool || ev.event || 'event',
      detail: ev.message || '',
      prompt: '',
    });
  }

  // Sort descending (newest first)
  timeline.sort((a, b) => b.time - a.time);

  // Render timeline
  const container = document.getElementById('timeline-list');
  container.innerHTML = timeline.slice(0, 200).map((ev) => {
    const groupColor = getGroupColor(ev.group);
    return `<div class="tl-entry">
      <div class="tl-time">${formatTimeFull(ev.time)}</div>
      <div class="tl-line">
        <div class="tl-dot" style="background:${ev.iconColor}"></div>
        <div class="tl-connector"></div>
      </div>
      <div class="tl-content">
        <div class="tl-header">
          <span class="tl-group" style="color:${groupColor}">${escapeHtml(ev.group)}</span>
          <span class="tl-type tl-type-${ev.type}">${ev.type === 'task-run' ? 'TASK' : 'HOOK'}</span>
          <span class="tl-title">${escapeHtml(ev.title)}</span>
        </div>
        ${ev.prompt ? `<div class="tl-prompt">${escapeHtml(ev.prompt.slice(0, 120))}</div>` : ''}
        <div class="tl-detail">${escapeHtml(ev.detail)}</div>
      </div>
    </div>`;
  }).join('');

  if (timeline.length === 0) {
    container.innerHTML = '<div class="tl-empty">No events yet. Spawn a coworker or schedule a task to see the timeline.</div>';
  }

  // Draw timeline sparkline
  drawSparkline();
}

function drawSparkline() {
  const tc = document.getElementById('sparkline-canvas');
  if (!tc || !tc.parentElement.clientWidth) return;
  tc.width = tc.parentElement.clientWidth - 4;
  tc.height = 48;
  const tctx = tc.getContext('2d');

  tctx.clearRect(0, 0, tc.width, tc.height);

  if (state.taskRunLogs.length === 0) return;

  const now = Date.now();
  const hours = 24;
  const bucketMs = 3600000;
  const buckets = new Array(hours).fill(0);
  const errorBuckets = new Array(hours).fill(0);

  for (const log of state.taskRunLogs) {
    const age = now - new Date(log.run_at).getTime();
    const bucket = hours - 1 - Math.floor(age / bucketMs);
    if (bucket >= 0 && bucket < hours) {
      buckets[bucket]++;
      if (log.status === 'error') errorBuckets[bucket]++;
    }
  }

  const maxVal = Math.max(...buckets, 1);
  const barW = Math.max(2, (tc.width - 4) / hours - 1);

  for (let i = 0; i < hours; i++) {
    const x = 2 + i * (barW + 1);
    const h = (buckets[i] / maxVal) * (tc.height - 8);
    const eh = (errorBuckets[i] / maxVal) * (tc.height - 8);

    tctx.fillStyle = '#3B82F660';
    tctx.fillRect(x, tc.height - 4 - h, barW, h);

    if (eh > 0) {
      tctx.fillStyle = '#EF444480';
      tctx.fillRect(x, tc.height - 4 - eh, barW, eh);
    }
  }

  // Label
  tctx.fillStyle = '#64748B';
  tctx.font = '8px "Courier New", monospace';
  tctx.fillText('24h', 2, 8);
  tctx.fillText('now', tc.width - 18, 8);
}

function getGroupColor(folder) {
  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = (hash * 31 + folder.charCodeAt(i)) & 0xFFFF;
  return colors[hash % colors.length];
}

// --- Helpers ---
function timeAgo(isoOrMs) {
  const t = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
  const diff = Date.now() - t;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
function formatTime(isoOrMs) {
  return new Date(typeof isoOrMs === 'number' ? isoOrMs : isoOrMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function formatTimeFull(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Init ---
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
connectWs();
animate();
