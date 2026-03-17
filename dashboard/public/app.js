/**
 * NanoClaw Dashboard — Main Application
 *
 * Tab 1: Pixel Art Office — uses Pixel Agents PNG assets (MIT) with procedural fallback
 * Tab 2: Timeline / Audit — dev-mode timeline of all events + debug log
 */

let state = { coworkers: [], tasks: [], taskRunLogs: [], registeredGroups: [], hookEvents: [], timestamp: 0 };
let selectedCoworker = null;
let frame = 0;
let ws = null;
let hoveredDesk = -1;

const Z = PixelSprites.ZOOM;
const TILE = PixelSprites.TILE;

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

// Layout constants
const OFFICE_COLS = 4;
const CELL_W = 5 * TILE * Z;   // 5 tiles wide per desk cell
const CELL_H = 4 * TILE * Z;   // 4 tiles tall per desk cell
const WALL_ROWS = 2;            // wall is 2 tiles tall
const PADDING_X = TILE * Z;
const PADDING_Y = (WALL_ROWS * TILE + TILE) * Z; // below wall + gap

// Animation state per coworker
const charAnims = new Map();
function getCharAnim(folder) {
  if (!charAnims.has(folder)) {
    charAnims.set(folder, { x: 0, y: 0, targetX: 0, targetY: 0, init: false });
  }
  return charAnims.get(folder);
}

function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight - 28;
}

function deskPos(index) {
  const col = index % OFFICE_COLS;
  const row = Math.floor(index / OFFICE_COLS);
  return {
    x: PADDING_X + col * CELL_W,
    y: PADDING_Y + row * (CELL_H + 16 * Z),
  };
}

// --- Drawing ---

function drawFloor() {
  const tw = TILE * Z;
  const cols = Math.ceil(canvas.width / tw) + 1;
  const rows = Math.ceil(canvas.height / tw) + 1;
  ctx.imageSmoothingEnabled = false;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const tile = PixelSprites.getFloorSprite((rx * 7 + ry * 3) % 9);
      ctx.drawImage(tile, rx * tw, ry * tw, tw, tw);
    }
  }
}

function drawWalls() {
  const tw = TILE * Z;
  const wallImg = PixelSprites.getWallImage();

  if (wallImg) {
    // Wall PNG is 64x128 (4x4 grid of 16x32 tiles). Use a simple tile from it.
    // Each piece is 16x32. We'll use the center piece (row 1, col 1) as a repeating wall.
    const srcW = 16, srcH = 32;
    const cols = Math.ceil(canvas.width / tw) + 1;
    for (let rx = 0; rx < cols; rx++) {
      // Pick a wall piece — use col=(rx%4), row=1 for variety
      const srcX = (rx % 4) * srcW;
      const srcY = 1 * srcH;
      ctx.drawImage(wallImg, srcX, srcY, srcW, srcH, rx * tw, 0, tw, srcH * Z);
    }
  } else {
    // Fallback: solid wall
    ctx.fillStyle = '#6B7B8D';
    ctx.fillRect(0, 0, canvas.width, WALL_ROWS * TILE * Z);
    ctx.fillStyle = '#4A5A6A';
    ctx.fillRect(0, WALL_ROWS * TILE * Z - 4, canvas.width, 4);
  }

  // Shadow under wall
  ctx.fillStyle = '#00000018';
  ctx.fillRect(0, WALL_ROWS * TILE * Z, canvas.width, 6 * Z);
}

function drawWallDecorations() {
  const tw = TILE * Z;
  const wallH = WALL_ROWS * TILE * Z;

  // Wall paintings
  const painting = PixelSprites.getFurniture('largePainting');
  if (painting) {
    ctx.drawImage(painting, PADDING_X + 2 * tw, 2, 32 * Z, 32 * Z);
  }
  const sp1 = PixelSprites.getFurniture('smallPainting');
  if (sp1) {
    ctx.drawImage(sp1, PADDING_X + 8 * tw, tw * 0.5, tw, tw);
  }
  const sp2 = PixelSprites.getFurniture('smallPainting2');
  if (sp2) {
    ctx.drawImage(sp2, PADDING_X + 14 * tw, tw * 0.5, tw, tw);
  }

  // Clock
  const clock = PixelSprites.getFurniture('clock');
  if (clock) {
    ctx.drawImage(clock, canvas.width - PADDING_X - 2 * tw, tw * 0.3, tw, tw);
  }

  // Whiteboard
  const wb = PixelSprites.getFurniture('whiteboard');
  if (wb) {
    ctx.drawImage(wb, PADDING_X + 5 * tw, 0, 48 * Z, 48 * Z);
  }

  // Title text on wall
  ctx.fillStyle = '#94A3B880';
  ctx.font = `${10}px "Courier New", monospace`;
  ctx.fillText('NANOCLAW OFFICE', PADDING_X + 12 * tw, wallH - 8);
}

function drawFloorDecorations() {
  const tw = TILE * Z;
  const wallH = WALL_ROWS * TILE * Z;

  // Plants along edges
  const plant = PixelSprites.getFurniture('largePlant') || PixelSprites.getFurniture('plant');
  if (plant) {
    const ph = PixelSprites.getFurnitureInfo('largePlant')?.h || 32;
    ctx.drawImage(plant, PADDING_X - tw * 0.5, wallH + tw * 0.5, tw, ph * Z);
    ctx.drawImage(plant, canvas.width - PADDING_X - tw * 0.5, wallH + tw * 0.5, tw, ph * Z);
  }

  // Bookshelf against wall
  const bookshelf = PixelSprites.getFurniture('bookshelf');
  if (bookshelf) {
    ctx.drawImage(bookshelf, canvas.width - PADDING_X - 3 * tw, wallH - 16 * Z, tw, 48 * Z);
  }

  // Cactus
  const cactus = PixelSprites.getFurniture('cactus');
  if (cactus) {
    ctx.drawImage(cactus, PADDING_X + 18 * tw, wallH + tw * 0.5, tw, 32 * Z);
  }

  // Bin near entrance
  const bin = PixelSprites.getFurniture('bin');
  if (bin) {
    ctx.drawImage(bin, PADDING_X + tw * 0.2, canvas.height - 50, tw, tw);
  }
}

function drawDeskSetup(x, y, cw, index) {
  ctx.imageSmoothingEnabled = false;
  const tw = TILE * Z;

  // Chair (behind desk — drawn first for z-order)
  const chair = PixelSprites.getFurniture('chair');
  if (chair) {
    ctx.drawImage(chair, x + 1 * tw, y + 2 * tw, tw, tw);
  } else {
    ctx.fillStyle = '#5B6B7B';
    ctx.fillRect(x + tw, y + 2 * tw, tw, tw);
  }

  // Desk
  const desk = PixelSprites.getDeskSprite();
  ctx.drawImage(desk, x, y + tw, 48 * Z, 32 * Z);

  // PC/Monitor on desk
  const isActive = cw.status === 'working' || cw.status === 'thinking';
  if (isActive) {
    const pc = PixelSprites.getPcFrame(frame);
    if (pc) {
      ctx.drawImage(pc, x + tw, y - 4, tw, 32 * Z);
    } else {
      // Fallback monitor
      ctx.fillStyle = '#2D3748';
      ctx.fillRect(x + tw, y + 2, tw, 24 * Z);
      ctx.fillStyle = '#1A2332';
      ctx.fillRect(x + tw + 2, y + 4, tw - 4, 20 * Z);
      PixelSprites.generateScreenContent(ctx, x + tw + 2, y + 6, tw - 6, 16 * Z, frame);
    }
  } else {
    const pcOff = PixelSprites.getFurniture('pcOff');
    if (pcOff) {
      ctx.drawImage(pcOff, x + tw, y - 4, tw, 32 * Z);
    } else {
      ctx.fillStyle = '#2D3748';
      ctx.fillRect(x + tw, y + 2, tw, 24 * Z);
      ctx.fillStyle = '#1A2332';
      ctx.fillRect(x + tw + 2, y + 4, tw - 4, 20 * Z);
    }
  }

  // Coffee on desk
  const coffee = PixelSprites.getFurniture('coffee');
  if (coffee && index % 2 === 0) {
    ctx.drawImage(coffee, x + 2.5 * tw, y + tw + 2, tw * 0.7, tw * 0.7);
  }

  // Pot/plant on some desks
  const pot = PixelSprites.getFurniture('pot');
  if (pot && index % 3 === 1) {
    ctx.drawImage(pot, x + 2.4 * tw, y + tw - 4, tw * 0.7, tw * 0.7);
  }
}

function drawCharacter(cw, deskX, deskY) {
  const anim = getCharAnim(cw.folder);
  const tw = TILE * Z;

  // Seated position at desk
  anim.targetX = deskX + 0.5 * tw;
  anim.targetY = deskY + 1.2 * tw;

  if (!anim.init) {
    anim.x = anim.targetX;
    anim.y = anim.targetY;
    anim.init = true;
  }

  anim.x += (anim.targetX - anim.x) * 0.1;
  anim.y += (anim.targetY - anim.y) * 0.1;

  const sprite = PixelSprites.getCharacterSprite(cw.type, cw.color, frame, cw.status);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sprite,
    Math.round(anim.x), Math.round(anim.y),
    PixelSprites.CHAR_FRAME_W * Z, PixelSprites.CHAR_FRAME_H * Z
  );
}

function drawNameplate(x, y, cw, isHovered) {
  const tw = TILE * Z;
  const plateY = y + 3.6 * tw;
  const name = cw.name.length > 13 ? cw.name.slice(0, 11) + '..' : cw.name;

  const dotColors = { idle: '#6B7280', working: '#10B981', thinking: '#F59E0B', error: '#EF4444' };
  const dotColor = dotColors[cw.status] || '#6B7280';

  if (isHovered) {
    ctx.fillStyle = '#0f172aDD';
    ctx.fillRect(x, plateY - 2, CELL_W - 8, 16);
    ctx.strokeStyle = (cw.color || '#475569') + '80';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, plateY - 2, CELL_W - 8, 16);
  }

  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(x + 6, plateY + 5, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = isHovered ? '#E2E8F0' : '#94A3B8';
  ctx.font = '10px "Courier New", monospace';
  ctx.fillText(name, x + 14, plateY + 8);

  // Status text for hovered
  if (isHovered) {
    ctx.fillStyle = dotColor;
    ctx.font = '9px "Courier New", monospace';
    ctx.fillText(cw.status.toUpperCase(), x + CELL_W - 60, plateY + 8);
  }
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
  ctx.roundRect(bx, by, w, h, 3);
  ctx.fill();
  ctx.stroke();

  // Tail
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

function drawOffice() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawFloor();
  drawWalls();
  drawWallDecorations();
  drawFloorDecorations();

  // Collect entities for z-sort
  const entities = state.coworkers.map((cw, i) => ({
    y: deskPos(i).y,
    cw,
    pos: deskPos(i),
    index: i,
  }));
  entities.sort((a, b) => a.y - b.y);

  for (const { cw, pos, index } of entities) {
    const isHovered = hoveredDesk === index;

    drawDeskSetup(pos.x, pos.y, cw, index);
    drawCharacter(cw, pos.x, pos.y);
    drawNameplate(pos.x, pos.y, cw, isHovered);

    if (cw.status === 'working' || cw.status === 'thinking') {
      const bubbleText = cw.lastToolUse || cw.currentTask;
      if (bubbleText) drawSpeechBubble(pos.x, pos.y - 6, bubbleText, cw.color);
    }

    if (isHovered || (selectedCoworker && selectedCoworker.folder === cw.folder)) {
      ctx.strokeStyle = (cw.color || '#3B82F6') + (isHovered ? '50' : '80');
      ctx.lineWidth = 2;
      ctx.strokeRect(pos.x - 2, pos.y - 2, CELL_W - 4, CELL_H + 8);
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

// --- Mouse ---
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  hoveredDesk = -1;
  state.coworkers.forEach((_, i) => {
    const pos = deskPos(i);
    if (mx >= pos.x - 2 && mx <= pos.x + CELL_W && my >= pos.y - 2 && my <= pos.y + CELL_H + 8) {
      hoveredDesk = i;
    }
  });
  canvas.style.cursor = hoveredDesk >= 0 ? 'pointer' : 'default';
});

canvas.addEventListener('click', () => {
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
  document.getElementById('detail-type').textContent = cw.type;

  const sc = { idle: ['#6B7280', 'IDLE'], working: ['#10B981', 'WORKING'], thinking: ['#F59E0B', 'THINKING'], error: ['#EF4444', 'ERROR'] };
  const [sColor, sLabel] = sc[cw.status] || sc.idle;
  document.getElementById('detail-status').innerHTML =
    `<span class="status-badge" style="background:${sColor}20;color:${sColor}">${sLabel}</span>`;

  document.getElementById('detail-task').textContent = cw.currentTask || 'None';
  document.getElementById('detail-activity').textContent = cw.lastActivity ? timeAgo(cw.lastActivity) : 'Never';
  document.getElementById('detail-task-count').textContent = cw.taskCount;
  document.getElementById('detail-tool').textContent = cw.lastToolUse || '-';

  const memEl = document.getElementById('detail-memory');
  memEl.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/memory/${cw.folder}`);
    memEl.textContent = res.ok ? (await res.text()).slice(0, 2000) : '(no CLAUDE.md)';
  } catch { memEl.textContent = '(error)'; }

  const hooksEl = document.getElementById('detail-hooks');
  const events = state.hookEvents.filter((e) => e.group === cw.folder).slice(-10);
  hooksEl.innerHTML = events.length > 0
    ? '<label style="color:var(--text-dim);font-size:9px;text-transform:uppercase">Recent Events</label>' +
      events.map((e) => `<div class="hook-entry"><span class="ts">${formatTime(e.timestamp)}</span> <span class="tool-name">${e.tool || e.event}</span></div>`).join('')
    : '';
}

function updateStatusBar() {
  const c = { working: 0, thinking: 0, idle: 0, error: 0 };
  for (const cw of state.coworkers) c[cw.status] = (c[cw.status] || 0) + 1;
  document.getElementById('stat-working').textContent = c.working;
  document.getElementById('stat-thinking').textContent = c.thinking;
  document.getElementById('stat-idle').textContent = c.idle;
  document.getElementById('stat-error').textContent = c.error;
  document.getElementById('stat-time').textContent = new Date().toLocaleTimeString();
}

let needsResize = true;
function tick() {
  frame++;
  if (needsResize) {
    resizeCanvas();
    needsResize = false;
  }
  drawOffice();
  updateStatusBar();
  if (selectedCoworker) {
    const u = state.coworkers.find((c) => c.folder === selectedCoworker.folder);
    if (u) selectedCoworker = u;
  }
}
// Use both rAF (smooth in real browsers) and setInterval (works in headless)
function animate() {
  tick();
  requestAnimationFrame(animate);
}
setInterval(tick, 500);

// ===================================================================
// TAB 2: TIMELINE / AUDIT LOG (debug mode, event history)
// ===================================================================

function updateTimeline() {
  document.getElementById('obs-total-coworkers').textContent = state.coworkers.length;
  document.getElementById('obs-total-tasks').textContent = state.tasks.length;
  document.getElementById('obs-total-runs').textContent = state.taskRunLogs.length;

  const successes = state.taskRunLogs.filter((l) => l.status === 'success').length;
  const total = state.taskRunLogs.length;
  document.getElementById('obs-success-rate').textContent = total > 0 ? Math.round((successes / total) * 100) + '%' : '-';

  const durations = state.taskRunLogs.filter((l) => l.duration_ms).map((l) => l.duration_ms);
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  document.getElementById('obs-avg-duration').textContent = avg > 0 ? formatDuration(avg) : '-';

  // Merge events
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
    });
  }
  for (const ev of state.hookEvents) {
    timeline.push({
      time: ev.timestamp,
      type: 'hook',
      group: ev.group || '?',
      iconColor: 'var(--yellow)',
      title: ev.tool || ev.event || 'event',
      detail: ev.message || '',
      prompt: '',
    });
  }
  timeline.sort((a, b) => b.time - a.time);

  const container = document.getElementById('timeline-list');
  container.innerHTML = timeline.slice(0, 200).map((ev) => {
    const gc = getGroupColor(ev.group);
    return `<div class="tl-entry">
      <div class="tl-time">${formatTimeFull(ev.time)}</div>
      <div class="tl-line"><div class="tl-dot" style="background:${ev.iconColor}"></div><div class="tl-connector"></div></div>
      <div class="tl-content">
        <div class="tl-header">
          <span class="tl-group" style="color:${gc}">${esc(ev.group)}</span>
          <span class="tl-type tl-type-${ev.type}">${ev.type === 'task-run' ? 'TASK' : 'HOOK'}</span>
          <span class="tl-title">${esc(ev.title)}</span>
        </div>
        ${ev.prompt ? `<div class="tl-prompt">${esc(ev.prompt.slice(0, 120))}</div>` : ''}
        <div class="tl-detail">${esc(ev.detail)}</div>
      </div>
    </div>`;
  }).join('');

  if (timeline.length === 0) {
    container.innerHTML = '<div class="tl-empty">No events yet. Spawn a coworker or schedule a task.</div>';
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
  return new Date(typeof v === 'number' ? v : v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function formatTimeFull(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
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

// --- Init ---
window.addEventListener('resize', () => { needsResize = true; });
// Ensure canvas is sized after layout settles (fixes race in some browsers)
function scheduleResize() { needsResize = true; }
window.addEventListener('load', scheduleResize);
setTimeout(scheduleResize, 100);
setTimeout(scheduleResize, 500);
resizeCanvas();
connectWs();
animate();
