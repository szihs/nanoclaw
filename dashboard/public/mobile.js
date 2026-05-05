
// NanoClaw Mobile Dashboard

let state = { coworkers: [], tasks: [], taskRunLogs: [], registeredGroups: [], hookEvents: [], timestamp: 0 };
const nativeFetch = window.fetch.bind(window);

// --- Auth ---
const dashboardAuth = { checked: false, required: false, authenticated: false, prompting: null };

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
  } catch { return { required: false, authenticated: true }; }
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
    if (!res.ok) { alert('Invalid dashboard secret'); return false; }
    dashboardAuth.authenticated = true;
    return true;
  })();
  const result = await dashboardAuth.prompting;
  dashboardAuth.prompting = null;
  return result;
}

window.fetch = async function(input, init) {
  if (!isApiRequest(input) || isAuthRequest(input)) return nativeFetch(input, init);
  if (!dashboardAuth.checked) await refreshDashboardAuthStatus();
  if (dashboardAuth.required && !dashboardAuth.authenticated) {
    const ok = await promptForDashboardSecret();
    if (!ok) throw new Error('Authentication required');
  }
  const res = await nativeFetch(input, init);
  if (res.status === 401 && dashboardAuth.required) {
    dashboardAuth.authenticated = false;
    const ok = await promptForDashboardSecret();
    if (!ok) throw new Error('Authentication required');
    return nativeFetch(input, init);
  }
  return res;
};

// --- Unread tracking ---
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

// --- Coworker state ---
let cwState = {
  selected: null,
  messages: [],
  polling: null,
  types: null,
  pendingApprovals: [],
  pendingCredentials: [],
  approvalCountByFolder: {},
  _inflightApprovals: new Set(),
};

// --- Live updates ---
let liveSource = null;
let pollTimer = null;

function setLiveStatus(text, color) {
  const dot = document.getElementById('m-live-dot');
  const label = document.getElementById('m-live-label');
  if (dot) dot.style.background = color;
  if (label) label.textContent = text;
}

function applyState(data) {
  state = { ...state, ...data };
  renderCwList();
  if (cwState.selected) {
    updateChatHeader();
    renderDetail();
  }
  updateTabBadges();
}

async function pollState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return false;
    applyState(await res.json());
    return true;
  } catch { return false; }
}

function startPolling() {
  if (pollTimer) return;
  setLiveStatus('Polling', 'var(--yellow)');
  pollState();
  pollTimer = setInterval(async () => {
    const ok = await pollState();
    if (!ok) setLiveStatus('Reconnecting...', 'var(--yellow)');
  }, 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function connectLiveUpdates() {
  if (!('EventSource' in window)) { startPolling(); return; }
  if (liveSource) liveSource.close();
  liveSource = new EventSource('/api/events');
  liveSource.onopen = () => { stopPolling(); setLiveStatus('Connected', 'var(--green)'); };
  liveSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') applyState(msg.data);
    } catch {}
  };
  liveSource.onerror = () => { startPolling(); setLiveStatus('Reconnecting...', 'var(--yellow)'); };
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
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function md(s) {
  let h = esc(s);
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/^#{1,4}\s+(.+)$/gm, (_m, t) => `<strong>${t}</strong>`);
  h = h.replace(/^[-*]{3,}\s*$/gm, '<hr>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/(?<!")(?<!=)(https?:\/\/[^\s<)"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/((?:^\|.+\|[ \t]*\n)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    const dataRows = rows.filter(r => !/^\|[\s\-:|]+\|$/.test(r));
    if (dataRows.length === 0) return block;
    const parseRow = (r) => r.split('|').slice(1, -1).map(c => c.trim());
    let t = '<table>';
    dataRows.forEach((r, i) => { const cells = parseRow(r); const tag = i === 0 ? 'th' : 'td'; t += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>'; });
    return t + '</table>';
  });
  h = h.replace(/^(\s*)[•\-]\s+(.+)$/gm, '$1<li>$2</li>');
  h = h.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');
  h = h.replace(/\n{2,}/g, '</p><p>');
  h = h.replace(/(?<!<\/pre>)\n/g, '<br>');
  return `<p>${h}</p>`;
}

const STATUS_CONFIG = {
  idle: ['#6B7280', 'IDLE'],
  active: ['#3B82F6', 'ACTIVE'],
  working: ['#10B981', 'WORKING'],
  thinking: ['#F59E0B', 'THINKING'],
  error: ['#EF4444', 'ERROR'],
};
function getStatusConfig(status) { return STATUS_CONFIG[status] || STATUS_CONFIG.idle; }

// --- Tab switching ---
let currentView = 'list';

function switchView(viewId) {
  currentView = viewId;
  document.querySelectorAll('.m-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`m-view-${viewId}`)?.classList.add('active');
  document.querySelectorAll('.m-tab').forEach(t => t.classList.toggle('active', t.dataset.view === viewId));
}

document.querySelectorAll('.m-tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

// --- Coworker list ---
function getCwCoworkers() {
  const live = state.coworkers || [];
  const reg = state.registeredGroups || [];
  const folders = new Set(live.map(c => c.folder));
  const coworkers = live.map(c => ({ ...c, isMain: c.folder === 'main' }));
  reg.forEach(g => {
    if (!folders.has(g.folder)) {
      coworkers.push({ folder: g.folder, name: g.name || g.folder, type: g.type || '', status: 'idle', isMain: g.folder === 'main', lastActivity: null });
    }
  });
  return coworkers;
}

function renderCwList() {
  const list = document.getElementById('m-cw-list');
  if (!list) return;
  if (!cwState.types) {
    cwState.types = 'loading';
    fetch('/api/types').then(r => r.ok ? r.json() : {}).then(t => { cwState.types = t; renderCwList(); }).catch(() => { cwState.types = {}; });
  }
  const coworkers = getCwCoworkers();
  if (coworkers.length === 0) {
    list.innerHTML = '<div class="m-cw-empty">No coworkers yet.</div>';
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
  list.innerHTML = coworkers.map(cw => {
    const selected = cwState.selected === cw.folder ? ' selected' : '';
    const label = cw.isMain ? `${esc(cw.name)} (main)` : esc(cw.name);
    const meta = cw.lastActivity ? timeAgo(cw.lastActivity) : (cw.type || 'idle');
    const approvalCount = cwState.approvalCountByFolder[cw.folder] || 0;
    const unread = hasUnread(cw.folder);
    return `<div class="m-cw-item${selected}" data-folder="${escAttr(cw.folder)}">
      <div class="m-cw-dot ${cw.status}"></div>
      <div class="m-cw-info">
        <div class="m-cw-name">${label}</div>
        <div class="m-cw-meta">${esc(meta)}</div>
      </div>
      <div class="m-cw-badges">
        ${approvalCount > 0 ? '<div class="m-cw-approval-dot"></div>' : ''}
        ${unread ? '<div class="m-cw-unread"></div>' : ''}
      </div>
      <div class="m-cw-chevron">&rsaquo;</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.m-cw-item').forEach(el => {
    el.addEventListener('click', () => {
      selectCoworker(el.dataset.folder);
      switchView('chat');
    });
  });
}

function selectCoworker(folder) {
  cwState.selected = folder;
  cwState.messages = [];
  cwState.pendingApprovals = [];
  cwState.pendingCredentials = [];
  if (cwState.polling) { clearInterval(cwState.polling); cwState.polling = null; }
  renderCwList();
  if (folder) {
    updateChatHeader();
    fetchCwMessages();
    cwState.polling = setInterval(fetchCwMessages, 3000);
    renderDetail();
  } else {
    document.getElementById('m-chat-messages').innerHTML = '<div class="m-chat-empty">Select a coworker to start chatting.</div>';
    document.getElementById('m-detail').innerHTML = '<div class="m-detail-empty">Select a coworker to view details.</div>';
  }
}

function updateChatHeader() {
  const cw = getCwCoworkers().find(c => c.folder === cwState.selected);
  if (!cw) return;
  document.getElementById('m-chat-name').textContent = cw.name;
  const badge = document.getElementById('m-chat-status');
  const [color] = getStatusConfig(cw.status);
  badge.textContent = cw.status;
  badge.style.background = color;
}

// --- Chat messages ---
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
    } catch { cwState.pendingApprovals = []; }
    try {
      const cr = await fetch(`/api/credentials?group=${encodeURIComponent(cwState.selected)}`);
      cwState.pendingCredentials = cr.ok ? await cr.json() : [];
    } catch { cwState.pendingCredentials = []; }
    cwState.approvalCountByFolder[cwState.selected] = (cwState.pendingApprovals || []).length + (cwState.pendingCredentials || []).length;
    renderCwMessages();
    if (cwState.messages.length > 0 && cwState.selected) {
      const latest = cwState.messages[cwState.messages.length - 1];
      if (latest.timestamp) {
        readCursors.markRead(cwState.selected, latest.timestamp);
        renderCwList();
      }
    }
  } catch {}
}

function renderAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const items = attachments.map(att => {
    if (!att || !att.url || !att.name) return '';
    if (att.isImage) {
      return `<a href="${escAttr(att.url)}" target="_blank" rel="noopener" style="display:block;margin-top:6px">
        <img src="${escAttr(att.url)}" alt="${escAttr(att.name)}" style="max-width:100%;max-height:200px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);object-fit:cover" />
      </a>`;
    }
    return `<a href="${escAttr(att.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;text-decoration:none;color:inherit;margin-top:6px;font-size:11px">📎 ${esc(att.name)}</a>`;
  }).filter(Boolean);
  return items.length > 0 ? `<div style="margin-top:4px">${items.join('')}</div>` : '';
}

function renderApprovalCard(item) {
  const safeReason = item.reason ? `\n\n*Reason:* ${esc(item.reason)}` : '';
  const desc = item.action === 'install_packages'
    ? `**Install packages:** ${(item.packages || []).map(p => esc(p)).join(', ')}${safeReason}`
    : item.action === 'request_rebuild'
    ? `**Rebuild container**${safeReason}`
    : item.action === 'add_mcp_server'
    ? `**Add MCP server**`
    : `**${esc(item.action)}**`;
  return `<div class="m-card m-card-approval">
    <div class="m-card-body">${md(desc)}</div>
    <div class="m-card-actions">
      <button class="m-btn m-btn-approve approval-btn" data-qid="${escAttr(item.approvalId)}" data-decision="Approve">Approve</button>
      <button class="m-btn m-btn-reject approval-btn" data-qid="${escAttr(item.approvalId)}" data-decision="Reject">Reject</button>
    </div>
    <div class="m-card-label">${formatTime(item.createdAt)} — approval</div>
  </div>`;
}

function renderCredentialCard(item) {
  const desc = `**Credential request:** ${esc(item.name)}\n\nHost: \`${esc(item.hostPattern)}\`${item.headerName ? `\nHeader: \`${esc(item.headerName)}\`` : ''}${item.valueFormat ? `\nFormat: \`${esc(item.valueFormat)}\`` : ''}${item.description ? `\n\n${esc(item.description)}` : ''}`;
  return `<div class="m-card m-card-credential">
    <div class="m-card-body">${md(desc)}</div>
    <div class="m-card-actions">
      <button class="m-btn m-btn-approve cred-enter-btn" data-cid="${escAttr(item.credentialId)}" data-name="${escAttr(item.name)}" data-desc="${escAttr(item.description || item.name)}">Enter credential</button>
      <button class="m-btn m-btn-reject cred-reject-btn" data-cid="${escAttr(item.credentialId)}">Reject</button>
    </div>
    <div class="m-card-label">${formatTime(item.createdAt)} — credential</div>
  </div>`;
}

function renderCwMessages() {
  const el = document.getElementById('m-chat-messages');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;

  const approvalHtml = (cwState.pendingApprovals || []).map(renderApprovalCard).join('');
  const credentialHtml = (cwState.pendingCredentials || []).map(renderCredentialCard).join('');

  const messageHtml = cwState.messages.map(m => {
    const isOutgoing = m.direction === 'outgoing';
    const cls = isOutgoing ? 'assistant' : 'user';
    const time = m.timestamp ? formatTime(m.timestamp) : '';
    const text = m.displayContent || m.content || '';
    const attachHtml = renderAttachments(m.attachments);
    const isSystem = m.kind === 'task' || m.kind === 'system';
    const kindLabel = m.kind && m.kind !== 'chat' ? ` <span style="font-size:7px;color:#999;font-style:italic">${esc(m.kind)}</span>` : '';
    const systemCls = isSystem ? ' m-msg-system' : '';

    if (m.cardType === 'ask_question' && m.questionId && m.options && m.options.length > 0) {
      if (m.isPending) {
        const btns = m.options.map(opt =>
          `<button class="m-btn m-btn-primary question-btn" data-qid="${escAttr(m.questionId)}" data-option="${escAttr(opt)}">${esc(opt)}</button>`
        ).join('');
        return `<div class="m-card m-card-question">
          <div class="m-card-body">${md(text)}</div>
          <div class="m-card-actions">${btns}</div>
          <div class="m-card-label">${time} — question</div>
        </div>`;
      }
      return `<div class="m-card" style="opacity:0.6">
        <div class="m-card-body">${md(text)}</div>
        <div class="m-card-label">${time} — question (answered)</div>
      </div>`;
    }

    const bubbleBody = `${text ? (isOutgoing ? md(text) : esc(text)) : '<span style="color:#9ca3af">(empty)</span>'}${attachHtml}`;
    return `<div class="m-msg ${cls}${systemCls}">
      <div class="m-msg-bubble">${bubbleBody}</div>
      <div class="m-msg-time">${time}${kindLabel}</div>
    </div>`;
  }).join('');

  if (!approvalHtml && !credentialHtml && !messageHtml) {
    el.innerHTML = '<div class="m-chat-empty">No messages yet. Send a message to start.</div>';
    return;
  }

  const totalPending = (cwState.pendingApprovals || []).length + (cwState.pendingCredentials || []).length;
  const bannerHtml = totalPending > 0
    ? `<div class="m-approval-banner"><div class="m-approval-banner-label">Pending Actions (${totalPending})</div>${approvalHtml}${credentialHtml}</div>`
    : '';
  el.innerHTML = messageHtml + bannerHtml;
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

// --- Event delegation for cards ---
document.getElementById('m-chat-messages').addEventListener('click', async (e) => {
  const approvalBtn = e.target.closest('.approval-btn');
  if (approvalBtn) {
    const qid = approvalBtn.dataset.qid;
    const decision = approvalBtn.dataset.decision;
    if (cwState._inflightApprovals.has(qid)) return;
    cwState._inflightApprovals.add(qid);
    approvalBtn.disabled = true;
    try {
      await fetch('/api/approvals/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: qid, action: decision.toLowerCase() }),
      });
      setTimeout(fetchCwMessages, 500);
    } catch (err) { alert('Failed: ' + err.message); }
    cwState._inflightApprovals.delete(qid);
    return;
  }

  const credEnterBtn = e.target.closest('.cred-enter-btn');
  if (credEnterBtn) {
    showCredentialModal(credEnterBtn.dataset.cid, credEnterBtn.dataset.name, credEnterBtn.dataset.desc);
    return;
  }

  const credRejectBtn = e.target.closest('.cred-reject-btn');
  if (credRejectBtn) {
    try {
      await fetch('/api/credentials/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: credRejectBtn.dataset.cid }),
      });
      setTimeout(fetchCwMessages, 500);
    } catch (err) { alert('Failed: ' + err.message); }
    return;
  }

  const questionBtn = e.target.closest('.question-btn');
  if (questionBtn) {
    questionBtn.disabled = true;
    try {
      await fetch('/api/questions/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: questionBtn.dataset.qid, response: questionBtn.dataset.option }),
      });
      setTimeout(fetchCwMessages, 500);
    } catch (err) { alert('Failed: ' + err.message); }
    return;
  }
});

function showCredentialModal(credentialId, name, desc) {
  const overlay = document.createElement('div');
  overlay.className = 'm-modal-overlay';
  overlay.innerHTML = `<div class="m-modal">
    <h3>Enter Credential</h3>
    <p>${esc(desc)}</p>
    <input type="password" id="m-cred-input" placeholder="${escAttr(name)}" autocomplete="off">
    <div class="m-modal-actions">
      <button class="m-btn m-btn-reject" id="m-cred-cancel">Cancel</button>
      <button class="m-btn m-btn-approve" id="m-cred-submit">Submit</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const input = document.getElementById('m-cred-input');
  input.focus();
  document.getElementById('m-cred-cancel').onclick = () => overlay.remove();
  document.getElementById('m-cred-submit').onclick = async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await fetch('/api/credentials/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId, value }),
      });
      overlay.remove();
      setTimeout(fetchCwMessages, 500);
    } catch (err) { alert('Failed: ' + err.message); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('m-cred-submit').click();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// --- Send message ---
async function sendCwMessage() {
  const input = document.getElementById('m-chat-input');
  const content = input.value.trim();
  if (!cwState.selected || !content) return;
  input.value = '';
  autoResizeInput();
  const optimistic = {
    content, sender: 'web@dashboard', sender_name: 'Dashboard',
    is_from_me: 0, is_bot_message: 0, timestamp: new Date().toISOString(),
  };
  cwState.messages.push(optimistic);
  renderCwMessages();
  const el = document.getElementById('m-chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: cwState.selected, content }),
    });
    if (!res.ok) {
      cwState.messages = cwState.messages.filter(m => m !== optimistic);
      renderCwMessages();
      let err = 'Failed to send';
      try { const d = await res.json(); err = d.error || err; } catch {}
      alert(err);
      return;
    }
    fetchCwMessages();
  } catch (e) {
    cwState.messages = cwState.messages.filter(m => m !== optimistic);
    renderCwMessages();
    alert('Failed: ' + e.message);
  }
}

document.getElementById('m-send-btn').addEventListener('click', sendCwMessage);
document.getElementById('m-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCwMessage(); }
});

// Auto-resize textarea
function autoResizeInput() {
  const input = document.getElementById('m-chat-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
}
document.getElementById('m-chat-input').addEventListener('input', autoResizeInput);

// --- Back button ---
document.getElementById('m-chat-back').addEventListener('click', () => switchView('list'));

// --- Detail view ---
async function renderDetail() {
  const el = document.getElementById('m-detail');
  if (!el) return;
  const folder = cwState.selected;
  if (!folder) {
    el.innerHTML = '<div class="m-detail-empty">Select a coworker to view details.</div>';
    return;
  }
  const cw = getCwCoworkers().find(c => c.folder === folder);
  if (!cw) {
    el.innerHTML = '<div class="m-detail-empty">Coworker not found.</div>';
    return;
  }
  const [statusColor, statusLabel] = getStatusConfig(cw.status);

  let lastAct = cw.lastActivity ? new Date(cw.lastActivity).getTime() : 0;
  const liveCw = (state.coworkers || []).find(c => c.folder === folder);
  if (liveCw?.hookTimestamp && liveCw.hookTimestamp > lastAct) lastAct = liveCw.hookTimestamp;

  const subagents = liveCw?.subagents || [];
  const subagentHtml = subagents.length > 0
    ? subagents.map(s => {
        const type = s.agentType && s.agentType !== 'default' ? s.agentType : 'child';
        const [sc] = getStatusConfig(s.status);
        return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0">
          <div style="width:8px;height:8px;border-radius:50%;background:${sc}"></div>
          <span style="font-size:11px">${esc(type)} <span style="color:var(--text-muted)">${esc(s.status || 'unknown')}</span></span>
        </div>`;
      }).join('')
    : '<span style="color:var(--text-muted);font-size:11px">None</span>';

  const shortName = (t) => t.replace(/^mcp__\w+__/, '');
  const allowedMcp = (cw.allowedMcpTools || []).map(t => `<span class="m-mcp-tag allowed">${esc(shortName(t))}</span>`).join('');
  const blockedMcp = (cw.disallowedMcpTools || []).map(t => `<span class="m-mcp-tag blocked">${esc(shortName(t))}</span>`).join('');
  const mcpHtml = allowedMcp + blockedMcp || '<span style="color:var(--text-muted);font-size:11px">none</span>';

  el.innerHTML = `
    <div class="m-detail-header">
      <div class="m-cw-dot ${cw.status}" style="width:14px;height:14px"></div>
      <div class="m-detail-name">${esc(cw.name)}</div>
      <span style="font-size:9px;padding:2px 8px;border-radius:999px;background:${statusColor};color:#fff">${statusLabel}</span>
    </div>

    <div class="m-detail-section">
      <div class="m-detail-section-title">Info</div>
      <div class="m-detail-card">
        <div class="m-detail-row"><span class="m-detail-label">Type</span><span class="m-detail-value">${esc(cw.type || '-')}</span></div>
        <div class="m-detail-row"><span class="m-detail-label">Trigger</span><span class="m-detail-value">${esc(cw.trigger || '-')}</span></div>
        <div class="m-detail-row"><span class="m-detail-label">Tasks</span><span class="m-detail-value">${cw.taskCount || 0}</span></div>
        <div class="m-detail-row"><span class="m-detail-label">Current</span><span class="m-detail-value">${esc(cw.currentTask || '-')}</span></div>
        <div class="m-detail-row" style="border:none"><span class="m-detail-label">Last Activity</span><span class="m-detail-value">${lastAct > 0 ? timeAgo(lastAct) : '-'}</span></div>
      </div>
    </div>

    <div class="m-detail-section">
      <div class="m-detail-section-title">Subagents</div>
      <div class="m-detail-card">${subagentHtml}</div>
    </div>

    <div class="m-detail-section">
      <div class="m-detail-section-title">MCP Tools</div>
      <div class="m-detail-card">${mcpHtml}</div>
    </div>

    <div class="m-detail-section">
      <div class="m-detail-section-title">Memory</div>
      <div class="m-detail-card">
        <div class="m-memory-preview" id="m-memory-content">Loading...</div>
        <button class="m-memory-toggle" id="m-memory-toggle">Expand</button>
      </div>
    </div>
  `;

  // Load memory
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(folder)}`);
    const memEl = document.getElementById('m-memory-content');
    if (res.ok) {
      const text = await res.text();
      memEl.innerHTML = md(text || '');
    } else {
      memEl.innerHTML = '<span style="color:var(--text-muted)">(no CLAUDE.md)</span>';
    }
    document.getElementById('m-memory-toggle').onclick = () => {
      memEl.classList.toggle('expanded');
      document.getElementById('m-memory-toggle').textContent = memEl.classList.contains('expanded') ? 'Collapse' : 'Expand';
    };
  } catch {
    const memEl = document.getElementById('m-memory-content');
    if (memEl) memEl.innerHTML = '<span style="color:var(--text-muted)">(failed to load)</span>';
  }
}

// --- Tab badges ---
function updateTabBadges() {
  const listBadge = document.getElementById('m-tab-badge-list');
  const chatBadge = document.getElementById('m-tab-badge-chat');
  const coworkers = getCwCoworkers();
  const anyUnread = coworkers.some(cw => hasUnread(cw.folder));
  const totalApprovals = Object.values(cwState.approvalCountByFolder).reduce((a, b) => a + b, 0);
  if (listBadge) listBadge.style.display = anyUnread ? 'block' : 'none';
  if (chatBadge) chatBadge.style.display = totalApprovals > 0 ? 'block' : 'none';
}

// --- Init ---
(async function init() {
  await pollState();
  connectLiveUpdates();
})();
