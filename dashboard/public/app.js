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
let pollTimer = null;
let hoveredDesk = -1;
let timelineFilter = null; // group folder filter for timeline
let cachedMessages = []; // messages fetched from /api/messages

const Z = PixelSprites.ZOOM;
const OFFICE_TILE = PixelSprites.TILE;

// --- WebSocket ---
function updateDetailHooks(cw) {
  const hooksEl = document.getElementById('detail-hooks');
  if (!hooksEl) return;
  const events = state.hookEvents.filter((e) => e.group === cw.folder).slice(-10);
  hooksEl.innerHTML = events.length > 0
    ? '<label style="color:var(--text-dim);font-size:9px;text-transform:uppercase">Recent Events</label>' +
      events.map((e) => `<div class="hook-entry"><span class="ts">${formatTime(e.timestamp)}</span> <span class="tool-name">${e.tool || e.event}</span></div>`).join('')
    : '';
}

function applyState(nextState) {
  state = nextState;
  updateTimeline();
  // Live-update detail panel if open
  if (selectedCoworker) {
    const updated = state.coworkers.find((c) => c.folder === selectedCoworker.folder);
    if (updated) {
      updateDetailHooks(updated);
      document.getElementById('detail-tool').textContent = updated.lastToolUse || '-';
      const sc = { idle: ['#6B7280', 'IDLE'], working: ['#10B981', 'WORKING'], thinking: ['#F59E0B', 'THINKING'], error: ['#EF4444', 'ERROR'] };
      const [sColor, sLabel] = sc[updated.status] || sc.idle;
      const statusEl = document.getElementById('detail-status');
      if (statusEl) statusEl.innerHTML = `<span class="status-badge" style="background:${sColor}20;color:${sColor}">${sLabel}</span>`;
      document.getElementById('detail-task').textContent = updated.currentTask || 'None';
      document.getElementById('detail-activity').textContent = updated.lastActivity ? timeAgo(updated.lastActivity) : 'Never';
      document.getElementById('detail-task-count').textContent = updated.taskCount;
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
  document.getElementById('ws-status').textContent = 'Polling...';
  document.querySelector('.status-dot').style.background = 'var(--yellow)';
  pollState();
  pollTimer = setInterval(async () => {
    const ok = await pollState();
    if (!ok) {
      document.getElementById('ws-status').textContent = 'Reconnecting...';
      document.querySelector('.status-dot').style.background = 'var(--yellow)';
    }
  }, 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => {
    stopPolling();
    document.getElementById('ws-status').textContent = 'Connected';
    document.querySelector('.status-dot').style.background = 'var(--green)';
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        applyState(msg.data);
      }
    } catch {}
  };
  ws.onclose = () => {
    startPolling();
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => {
    startPolling();
    ws.close();
  };
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

function isDrawable(sprite) {
  if (!sprite) return false;
  if (typeof sprite.naturalWidth === 'number') {
    return sprite.naturalWidth > 0 && sprite.naturalHeight > 0;
  }
  if (typeof sprite.width === 'number') {
    return sprite.width > 0 && sprite.height > 0;
  }
  return false;
}

function roundedRectPath(context, x, y, width, height, radius) {
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius);
    return;
  }

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

// Layout constants
const OFFICE_COLS = 4;
const CELL_W = 5 * OFFICE_TILE * Z;   // 5 tiles wide per desk cell
const CELL_H = 4 * OFFICE_TILE * Z;   // 4 tiles tall per desk cell
const WALL_ROWS = 2;            // wall is 2 tiles tall
const PADDING_X = OFFICE_TILE * Z;
const PADDING_Y = (WALL_ROWS * OFFICE_TILE + OFFICE_TILE) * Z; // below wall + gap

// Animation state per coworker
const charAnims = new Map();
function getCharAnim(folder) {
  if (!charAnims.has(folder)) {
    charAnims.set(folder, { x: 0, y: 0, targetX: 0, targetY: 0, init: false });
  }
  return charAnims.get(folder);
}

function resizeCanvas() {
  const parent = canvas.parentElement;
  if (!parent) return false;

  const parentRect = parent.getBoundingClientRect();
  const officeBar = parent.querySelector('.office-bar');
  const barHeight = officeBar?.getBoundingClientRect().height || 28;
  const nextWidth = Math.floor(parentRect.width || parent.clientWidth || 0);
  const nextHeight = Math.floor((parentRect.height || parent.clientHeight || 0) - barHeight);

  // Flex layout can report zero during initial script execution in headless browsers.
  if (nextWidth < 64 || nextHeight < 64) {
    return false;
  }

  if (canvas.width !== nextWidth) canvas.width = nextWidth;
  if (canvas.height !== nextHeight) canvas.height = nextHeight;
  canvas.style.width = `${nextWidth}px`;
  canvas.style.height = `${nextHeight}px`;
  return true;
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
  // Solid dark floor for readability
  ctx.fillStyle = '#1a1f2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Subtle grid lines
  ctx.strokeStyle = '#252b3a';
  ctx.lineWidth = 1;
  const tw = OFFICE_TILE * Z;
  for (let x = 0; x < canvas.width; x += tw) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += tw) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}

function drawWalls() {
  const tw = OFFICE_TILE * Z;
  const wallImg = PixelSprites.getWallImage();

  if (isDrawable(wallImg)) {
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
    ctx.fillRect(0, 0, canvas.width, WALL_ROWS * OFFICE_TILE * Z);
    ctx.fillStyle = '#4A5A6A';
    ctx.fillRect(0, WALL_ROWS * OFFICE_TILE * Z - 4, canvas.width, 4);
  }

  // Shadow under wall
  ctx.fillStyle = '#00000018';
  ctx.fillRect(0, WALL_ROWS * OFFICE_TILE * Z, canvas.width, 6 * Z);
}

function drawWallDecorations() {
  const tw = OFFICE_TILE * Z;
  const wallH = WALL_ROWS * OFFICE_TILE * Z;

  // Wall paintings
  const painting = PixelSprites.getFurniture('largePainting');
  if (isDrawable(painting)) {
    ctx.drawImage(painting, PADDING_X + 2 * tw, 2, 32 * Z, 32 * Z);
  }
  const sp1 = PixelSprites.getFurniture('smallPainting');
  if (isDrawable(sp1)) {
    ctx.drawImage(sp1, PADDING_X + 8 * tw, tw * 0.5, tw, tw);
  }
  const sp2 = PixelSprites.getFurniture('smallPainting2');
  if (isDrawable(sp2)) {
    ctx.drawImage(sp2, PADDING_X + 14 * tw, tw * 0.5, tw, tw);
  }

  // Clock
  const clock = PixelSprites.getFurniture('clock');
  if (isDrawable(clock)) {
    ctx.drawImage(clock, canvas.width - PADDING_X - 2 * tw, tw * 0.3, tw, tw);
  }

  // Whiteboard
  const wb = PixelSprites.getFurniture('whiteboard');
  if (isDrawable(wb)) {
    ctx.drawImage(wb, PADDING_X + 5 * tw, 0, 48 * Z, 48 * Z);
  }

  // Title text on wall
  ctx.fillStyle = '#94A3B880';
  ctx.font = `${10}px "Courier New", monospace`;
  ctx.fillText('NANOCLAW OFFICE', PADDING_X + 12 * tw, wallH - 8);
}

function drawFloorDecorations() {
  const tw = OFFICE_TILE * Z;
  const wallH = WALL_ROWS * OFFICE_TILE * Z;

  // Plants along edges
  const plant = PixelSprites.getFurniture('largePlant') || PixelSprites.getFurniture('plant');
  if (isDrawable(plant)) {
    const ph = PixelSprites.getFurnitureInfo('largePlant')?.h || 32;
    ctx.drawImage(plant, PADDING_X - tw * 0.5, wallH + tw * 0.5, tw, ph * Z);
    ctx.drawImage(plant, canvas.width - PADDING_X - tw * 0.5, wallH + tw * 0.5, tw, ph * Z);
  }

  // Bookshelf against wall
  const bookshelf = PixelSprites.getFurniture('bookshelf');
  if (isDrawable(bookshelf)) {
    ctx.drawImage(bookshelf, canvas.width - PADDING_X - 3 * tw, wallH - 16 * Z, tw, 48 * Z);
  }

  // Cactus
  const cactus = PixelSprites.getFurniture('cactus');
  if (isDrawable(cactus)) {
    ctx.drawImage(cactus, PADDING_X + 18 * tw, wallH + tw * 0.5, tw, 32 * Z);
  }

  // Bin near entrance
  const bin = PixelSprites.getFurniture('bin');
  if (isDrawable(bin)) {
    ctx.drawImage(bin, PADDING_X + tw * 0.2, canvas.height - 50, tw, tw);
  }
}

function drawDeskSetup(x, y, cw, index) {
  ctx.imageSmoothingEnabled = false;
  const tw = OFFICE_TILE * Z;

  // Chair (behind desk — drawn first for z-order)
  const chair = PixelSprites.getFurniture('chair');
  if (isDrawable(chair)) {
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
    if (isDrawable(pc)) {
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
    if (isDrawable(pcOff)) {
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
  if (isDrawable(coffee) && index % 2 === 0) {
    ctx.drawImage(coffee, x + 2.5 * tw, y + tw + 2, tw * 0.7, tw * 0.7);
  }

  // Pot/plant on some desks
  const pot = PixelSprites.getFurniture('pot');
  if (isDrawable(pot) && index % 3 === 1) {
    ctx.drawImage(pot, x + 2.4 * tw, y + tw - 4, tw * 0.7, tw * 0.7);
  }
}

function drawCharacter(cw, deskX, deskY) {
  const anim = getCharAnim(cw.folder);
  const tw = OFFICE_TILE * Z;

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
  const tw = OFFICE_TILE * Z;
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
  roundedRectPath(ctx, bx, by, w, h, 3);
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

  // Memory panel — full content with lightweight markdown rendering
  const memEl = document.getElementById('detail-memory');
  memEl.innerHTML = '<span style="color:var(--text-muted)">Loading...</span>';
  try {
    const res = await fetch(`/api/memory/${cw.folder}`);
    if (res.ok) {
      const raw = await res.text();
      memEl.innerHTML = renderMarkdown(raw);
    } else {
      memEl.textContent = '(no CLAUDE.md)';
    }
  } catch { memEl.textContent = '(error)'; }

  // Memory expand/collapse toggle
  const memToggle = document.getElementById('memory-toggle');
  if (memToggle) {
    memToggle.textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
    memToggle.onclick = () => {
      memEl.classList.toggle('expanded');
      memToggle.textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
    };
  }

  // View Timeline button
  const timelineBtn = document.getElementById('detail-view-timeline');
  if (timelineBtn) {
    timelineBtn.onclick = () => {
      setTimelineFilter(cw.folder);
      // Switch to timeline tab
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      document.querySelector('[data-tab="observability"]').classList.add('active');
      document.getElementById('observability').classList.add('active');
    };
  }

  const hooksEl = document.getElementById('detail-hooks');
  const events = state.hookEvents.filter((e) => e.group === cw.folder).slice(-10);
  hooksEl.innerHTML = events.length > 0
    ? '<label style="color:var(--text-dim);font-size:9px;text-transform:uppercase">Recent Events</label>' +
      events.map((e) => `<div class="hook-entry"><span class="ts">${formatTime(e.timestamp)}</span> <span class="tool-name">${e.tool || e.event}</span></div>`).join('')
    : '';
}

// Lightweight markdown renderer (headers, bold, code, bullets)
function renderMarkdown(text) {
  return esc(text)
    .split('\n')
    .map((line) => {
      // Headers
      if (line.startsWith('### ')) return `<div class="md-h3">${line.slice(4)}</div>`;
      if (line.startsWith('## ')) return `<div class="md-h2">${line.slice(3)}</div>`;
      if (line.startsWith('# ')) return `<div class="md-h1">${line.slice(2)}</div>`;
      // Bullets
      if (/^[-*] /.test(line)) return `<div class="md-li">${line.replace(/^[-*] /, '&bull; ')}</div>`;
      // Inline code
      line = line.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
      // Bold
      line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return `<div>${line || '&nbsp;'}</div>`;
    })
    .join('');
}

// Timeline filter management
function setTimelineFilter(group) {
  timelineFilter = group || null;
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
    needsResize = !resizeCanvas();
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
  needsResize = true;
  tick();
  requestAnimationFrame(animate);
}
setInterval(() => {
  needsResize = true;
  tick();
}, 500);

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
  for (const ev of state.hookEvents) {
    // Color-code by event type
    let iconColor = 'var(--yellow)';
    let badge = 'HOOK';
    let badgeClass = 'tl-type-hook';
    if (ev.event === 'PostToolUseFailure') {
      iconColor = 'var(--red)';
      badge = 'ERROR';
      badgeClass = 'tl-type-error';
    } else if (ev.event === 'SubagentStart' || ev.event === 'SubagentStop') {
      iconColor = 'var(--purple)';
      badge = 'AGENT';
      badgeClass = 'tl-type-subagent';
    } else if (ev.event === 'SessionStart') {
      iconColor = 'var(--green)';
      badge = 'SESSION';
      badgeClass = 'tl-type-session';
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
    });
  }

  // Add messages from SQLite
  for (const msg of cachedMessages) {
    timeline.push({
      time: new Date(msg.created_at).getTime(),
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

  container.innerHTML = filtered.slice(0, 200).map((ev, idx) => {
    const gc = getGroupColor(ev.group);
    const hasExpand = ev.toolInput || ev.toolResponse;
    const expandId = `tl-expand-${idx}`;
    return `<div class="tl-entry">
      <div class="tl-time">${formatTimeFull(ev.time)}</div>
      <div class="tl-line"><div class="tl-dot" style="background:${ev.iconColor}"></div><div class="tl-connector"></div></div>
      <div class="tl-content">
        <div class="tl-header">
          <span class="tl-group tl-group-link" style="color:${gc}" data-group="${esc(ev.group)}">${esc(ev.group)}</span>
          <span class="tl-type ${ev.badgeClass || 'tl-type-hook'}">${ev.badge || 'HOOK'}</span>
          <span class="tl-title">${esc(ev.title)}</span>
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
};

// --- Admin pill navigation ---
document.querySelectorAll('.admin-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
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
      url += '&before=' + encodeURIComponent(last.created_at);
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
    <tr><th>Time</th><th>Group</th><th>Direction</th><th>Sender</th><th>Content</th></tr>`;
  for (const m of adminState.messages) {
    const dir = m.direction === 'incoming' ? 'IN' : 'OUT';
    const dirClass = m.direction === 'incoming' ? 'color:var(--accent)' : 'color:var(--green)';
    html += `<tr>
      <td style="white-space:nowrap">${esc(formatTime(m.created_at))}</td>
      <td>${esc(m.group_folder || '-')}</td>
      <td style="${dirClass};font-weight:600">${dir}</td>
      <td>${esc(m.sender_name || m.sender || '-')}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((m.body || m.content || '').slice(0, 200))}</td>
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
    const actionBtn = t.status === 'active'
      ? `<button class="admin-action-btn" data-action="pause-task" data-id="${t.id}">Pause</button>`
      : `<button class="admin-action-btn success" data-action="resume-task" data-id="${t.id}">Resume</button>`;
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
  if (adminState.skills.length === 0) {
    el.innerHTML = '<div class="admin-empty">No skills found in container/skills/</div>';
    return;
  }
  let html = `<table class="admin-table">
    <tr><th>Skill</th><th>Description</th><th>Files</th><th>Status</th><th>Actions</th></tr>`;
  for (const s of adminState.skills) {
    const chipClass = s.enabled ? 'enabled' : 'disabled';
    const chipText = s.enabled ? 'Enabled' : 'Disabled';
    const btnClass = s.enabled ? 'danger' : 'success';
    const btnText = s.enabled ? 'Disable' : 'Enable';
    html += `<tr>
      <td><strong>${esc(s.title || s.name)}</strong><br><span style="color:var(--text-muted)">${esc(s.name)}</span></td>
      <td style="max-width:250px">${esc(s.description || '-')}</td>
      <td style="font-size:9px;color:var(--text-muted)">${(s.files || []).join(', ')}</td>
      <td><span class="admin-chip ${chipClass}">${chipText}</span></td>
      <td><button class="admin-action-btn ${btnClass}" data-action="toggle-skill" data-name="${esc(s.name)}">${btnText}</button></td>
    </tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
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
    html += `<div class="admin-group-card">
      <h4>${esc(g.name || g.folder)}${mainBadge} ${containerChip}</h4>
      <div class="admin-group-meta">
        <span>Folder: <strong>${esc(g.folder)}</strong></span>
        <span>Sessions: ${g.sessionCount || 0}</span>
        <span>Trigger: ${esc(g.trigger_pattern || 'default')}</span>
        <span>Added: ${g.added_at ? formatTime(g.added_at) : '-'}</span>
      </div>
      <details>
        <summary style="cursor:pointer;font-size:10px;color:var(--text-dim)">CLAUDE.md Editor</summary>
        <textarea class="admin-editor" data-folder="${esc(g.folder)}">${esc(g.memory || '(no CLAUDE.md)')}</textarea>
        <button class="admin-save-btn" data-action="save-memory" data-folder="${esc(g.folder)}">Save</button>
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
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await fetch(`/api/memory/${encodeURIComponent(folder)}`, {
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
});

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
connectWs();
animate();
