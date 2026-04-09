/* ================================================================
   Sublight WebUI — Frontend
   ================================================================ */

// ---------------------------------------------------------------------------
// Markdown renderer config
// ---------------------------------------------------------------------------

marked.setOptions({
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
});

function setMarkdownContent(el, text) {
  const raw = marked.parse(text);
  const fragment = DOMPurify.sanitize(raw, { RETURN_DOM_FRAGMENT: true });
  el.replaceChildren(fragment);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  sessions: new Map(),
  activeId: null,
  ws: null,
  defaultCwd: '',
  defaultPermissionMode: 'default',
  reconnectDelay: 1000,
  authToken: sessionStorage.getItem('sublight_token') || null,
  authRequired: false,
  notesVisible: false,
  artifactsVisible: false,
  /** Map<sessionId, artifact[]> */
  artifacts: new Map(),
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $sidebar       = document.getElementById('session-list');
const $emptyState    = document.getElementById('empty-state');
const $chatArea      = document.getElementById('chat-area');
const $chatTitle     = document.getElementById('chat-title');
const $chatStatus    = document.getElementById('chat-status');
const $chatRuntime   = document.getElementById('chat-runtime');
const $messages      = document.getElementById('messages');
const $inputBar      = document.getElementById('input-bar');
const $promptInput   = document.getElementById('prompt-input');
const $btnSend       = document.getElementById('btn-send');
const $btnAbort      = document.getElementById('btn-abort');
const $authScreen    = document.getElementById('auth-screen');
const $authForm      = document.getElementById('auth-form');
const $authToken     = document.getElementById('auth-token');
const $authError     = document.getElementById('auth-error');
const $appShell      = document.getElementById('app-shell');
const $notesPanel    = document.getElementById('notes-panel');
const $notesList     = document.getElementById('notes-list');
const $artifactsPanel = document.getElementById('artifacts-panel');
const $artifactsList  = document.getElementById('artifacts-list');
const $setupScreen    = document.getElementById('setup-screen');
const $setupToken     = document.getElementById('setup-token');
const $settingsDialog = document.getElementById('settings-dialog');

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

const $confirmDialog  = document.getElementById('confirm-dialog');
const $confirmMessage = document.getElementById('confirm-message');
const $confirmOk      = document.getElementById('confirm-ok');
const $confirmCancel  = document.getElementById('confirm-cancel');

function confirm(message) {
  return new Promise((resolve) => {
    $confirmMessage.textContent = message;
    $confirmDialog.showModal();

    function cleanup() {
      $confirmOk.removeEventListener('click', onOk);
      $confirmCancel.removeEventListener('click', onCancel);
      $confirmDialog.close();
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    $confirmOk.addEventListener('click', onOk);
    $confirmCancel.addEventListener('click', onCancel);
  });
}

// ---------------------------------------------------------------------------
// Auth & fetch helpers
// ---------------------------------------------------------------------------

/** Fetch with auth token in Authorization header. */
function authFetch(url, options = {}) {
  if (state.authToken) {
    options.headers = { ...options.headers, Authorization: `Bearer ${state.authToken}` };
  }
  return fetch(url, options);
}

/** Append auth token as query parameter (for img.src and other non-fetch URLs). */
function authUrl(base) {
  if (!state.authToken) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(state.authToken)}`;
}

function showAuthScreen() {
  $authScreen.classList.remove('hidden');
  $appShell.classList.add('hidden');
  $setupScreen.classList.add('hidden');
  $authToken.focus();
}

function hideAuthScreen() {
  $authScreen.classList.add('hidden');
  $appShell.classList.remove('hidden');
}

$authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const token = $authToken.value.trim();
  if (!token) return;
  state.authToken = token;
  sessionStorage.setItem('sublight_token', token);
  $authError.textContent = '';
  hideAuthScreen();
  connect();
});

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

function showSetupScreen(token, securityDefaults) {
  $setupScreen.classList.remove('hidden');
  $appShell.classList.add('hidden');
  $authScreen.classList.add('hidden');
  $setupToken.textContent = token || 'See server console — token is only shown on the machine running the server.';
  const copyBtn = document.getElementById('btn-copy-setup-token');
  if (copyBtn) copyBtn.style.display = token ? '' : 'none';

  document.getElementById('setup-scope-files').checked = securityDefaults.scopeFilesToSession;
  document.getElementById('setup-no-svg').checked = !securityDefaults.serveSvg;
  document.getElementById('setup-default-perms').checked = securityDefaults.defaultPermissionMode === 'default';
  document.getElementById('setup-max-sessions').value = securityDefaults.maxSessions;
}

document.getElementById('btn-copy-setup-token').addEventListener('click', () => {
  navigator.clipboard.writeText($setupToken.textContent);
  const btn = document.getElementById('btn-copy-setup-token');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
});

document.getElementById('btn-complete-setup').addEventListener('click', async () => {
  const security = {
    scopeFilesToSession: document.getElementById('setup-scope-files').checked,
    serveSvg: !document.getElementById('setup-no-svg').checked,
    maxSessions: parseInt(document.getElementById('setup-max-sessions').value) || 10,
    defaultPermissionMode: document.getElementById('setup-default-perms').checked ? 'default' : 'bypass',
  };

  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security }),
    });
    const data = await res.json();
    if (data.ok) {
      state.authToken = data.token;
      state.authRequired = true;
      sessionStorage.setItem('sublight_token', data.token);
      $setupScreen.classList.add('hidden');
      $appShell.classList.remove('hidden');
      connect();
    }
  } catch (err) {
    console.error('Setup failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

document.getElementById('btn-settings').addEventListener('click', async () => {
  try {
    const res = await authFetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('settings-token').textContent = data.token;
    document.getElementById('settings-bind').textContent =
      `${data.host}:${data.port}` +
      (data.envOverrides.host || data.envOverrides.port ? ' (from .env)' : '');
    document.getElementById('setting-scope-files').checked = data.security.scopeFilesToSession;
    document.getElementById('setting-no-svg').checked = !data.security.serveSvg;
    document.getElementById('setting-default-perms').checked = data.security.defaultPermissionMode === 'default';
    document.getElementById('setting-max-sessions').value = data.security.maxSessions;
    document.getElementById('setting-idle-timeout').value = data.security.idleTimeoutMinutes ?? 120;
    document.getElementById('setting-rate-limit').value = data.security.messageRateLimitPerMin ?? 30;
    document.getElementById('setting-max-log-age').value = data.security.maxLogAgeDays ?? 30;

    $settingsDialog.showModal();
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
});

document.getElementById('btn-copy-settings-token').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('settings-token').textContent);
  const btn = document.getElementById('btn-copy-settings-token');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
});

// ---------------------------------------------------------------------------
// Audit log viewer
// ---------------------------------------------------------------------------

const $auditDialog = document.getElementById('audit-dialog');
const $auditList = document.getElementById('audit-list');
const $auditCount = document.getElementById('audit-count');

document.getElementById('btn-view-audit').addEventListener('click', async () => {
  try {
    const res = await authFetch('/api/audit?limit=200');
    if (!res.ok) {
      showToast('Failed to load audit log');
      return;
    }
    const data = await res.json();
    $auditCount.textContent = `${data.entries.length} shown · ${data.totalLines} total`;

    $auditList.replaceChildren();
    if (data.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'logs-empty';
      empty.textContent = 'No audit entries yet.';
      $auditList.appendChild(empty);
    } else {
      // Newest first for easier scanning.
      for (const entry of [...data.entries].reverse()) {
        const row = document.createElement('div');
        row.className = 'audit-row';

        const ts = document.createElement('span');
        ts.className = 'audit-ts';
        ts.textContent = entry.ts ? new Date(entry.ts).toLocaleString() : '—';
        row.appendChild(ts);

        const ev = document.createElement('span');
        ev.className = 'audit-event audit-event-' + (entry.event?.type || 'unknown');
        ev.textContent = entry.event?.type || 'unknown';
        row.appendChild(ev);

        const meta = document.createElement('span');
        meta.className = 'audit-meta';
        const bits = [];
        if (entry.ip) bits.push(entry.ip);
        if (entry.event?.path) bits.push(entry.event.path);
        if (entry.event?.hadToken !== undefined) bits.push(entry.event.hadToken ? 'token:bad' : 'token:none');
        if (entry.event?.id) bits.push(entry.event.id.slice(0, 8));
        if (entry.event?.ageDays !== undefined) bits.push(`age:${entry.event.ageDays}d`);
        meta.textContent = bits.join(' · ');
        row.appendChild(meta);

        $auditList.appendChild(row);
      }
    }

    $auditDialog.showModal();
  } catch (err) {
    console.error('Failed to load audit log:', err);
  }
});

document.getElementById('audit-close').addEventListener('click', () => $auditDialog.close());

document.getElementById('btn-regen-token').addEventListener('click', async () => {
  const ok = await confirm(
    'Regenerate the access token?\n\n' +
    'The new token will be saved to settings.json but does NOT take effect until the server restarts. ' +
    'After restart, current browser tabs will be logged out and must use the new token.'
  );
  if (!ok) return;
  try {
    const res = await authFetch('/api/settings/regenerate-token', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to regenerate token');
      return;
    }
    document.getElementById('settings-token').textContent = data.token;
    showToast('Token regenerated — restart the server for it to take effect');
  } catch (err) {
    console.error('Failed to regenerate token:', err);
  }
});

document.getElementById('settings-cancel').addEventListener('click', () => {
  $settingsDialog.close();
});

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const idleTimeoutRaw = parseInt(document.getElementById('setting-idle-timeout').value, 10);
  const rateLimitRaw = parseInt(document.getElementById('setting-rate-limit').value, 10);
  const maxLogAgeRaw = parseInt(document.getElementById('setting-max-log-age').value, 10);
  const security = {
    scopeFilesToSession: document.getElementById('setting-scope-files').checked,
    serveSvg: !document.getElementById('setting-no-svg').checked,
    maxSessions: parseInt(document.getElementById('setting-max-sessions').value) || 10,
    defaultPermissionMode: document.getElementById('setting-default-perms').checked ? 'default' : 'bypass',
    idleTimeoutMinutes: Number.isFinite(idleTimeoutRaw) && idleTimeoutRaw >= 0 ? idleTimeoutRaw : 120,
    messageRateLimitPerMin: Number.isFinite(rateLimitRaw) && rateLimitRaw >= 0 ? rateLimitRaw : 30,
    maxLogAgeDays: Number.isFinite(maxLogAgeRaw) && maxLogAgeRaw >= 0 ? maxLogAgeRaw : 30,
  };

  try {
    const res = await authFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security }),
    });
    if (res.ok) {
      state.defaultPermissionMode = security.defaultPermissionMode;
      $settingsDialog.close();
      showToast('Settings saved');
    }
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
});

// ---------------------------------------------------------------------------
// Logs dialog
// ---------------------------------------------------------------------------

const $logsDialog  = document.getElementById('logs-dialog');
const $logsList    = document.getElementById('logs-list');
const $logsViewer  = document.getElementById('logs-viewer');
const $logsContent = document.getElementById('logs-viewer-content');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLogDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

document.getElementById('btn-logs').addEventListener('click', async () => {
  await loadLogsList();
  $logsViewer.classList.add('hidden');
  $logsList.classList.remove('hidden');
  $logsDialog.showModal();
});

document.getElementById('logs-filter').addEventListener('input', () => renderLogsList());

// Cached logs list for client-side filtering without refetching.
let cachedLogs = [];

async function loadLogsList() {
  try {
    const res = await authFetch('/api/logs');
    if (!res.ok) return;
    const data = await res.json();
    cachedLogs = data.logs;

    document.getElementById('logs-storage').textContent = `${data.logs.length} logs \u00b7 ${formatBytes(data.totalSize)}`;
    if (data.logDir) {
      document.getElementById('logs-dir-path').textContent = data.logDir;
    }

    renderLogsList();
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

document.getElementById('btn-copy-logs-dir').addEventListener('click', () => {
  const path = document.getElementById('logs-dir-path').textContent;
  if (!path) return;
  navigator.clipboard.writeText(path);
  const btn = document.getElementById('btn-copy-logs-dir');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});

document.getElementById('logs-show-stubs').addEventListener('change', () => renderLogsList());

function renderLogsList() {
  const filterEl = document.getElementById('logs-filter');
  const showStubs = document.getElementById('logs-show-stubs')?.checked;
  const q = (filterEl?.value || '').trim().toLowerCase();

  // A "stub" is a log for a session that never got a Claude session id —
  // usually a crash during spawn or an aborted first message. By default we
  // hide them to keep the list clean, but expose a toggle.
  const isStub = (log) => !log.claudeSessionId && !log.messageCount;

  let working = cachedLogs;
  if (!showStubs) working = working.filter((log) => !isStub(log));

  const filtered = q
    ? working.filter((log) => {
        const hay = [
          log.sessionName || '',
          log.cwd || '',
          log.id,
          log.startedAt || '',
          log.endedAt || '',
          log.permissionMode || '',
        ].join(' ').toLowerCase();
        return hay.includes(q);
      })
    : working;

  $logsList.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'logs-empty';
    empty.textContent = q ? `No logs match "${q}".` : 'No session logs yet.';
    $logsList.appendChild(empty);
    return;
  }

  for (const log of filtered) {
      const row = document.createElement('div');
      row.className = 'log-row';

      const info = document.createElement('div');
      info.className = 'log-info';

      const name = document.createElement('div');
      name.className = 'log-name';
      name.textContent = log.sessionName || shortPath(log.cwd) || log.id.slice(0, 8);
      info.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'log-meta';
      const parts = [formatLogDate(log.startedAt)];
      if (log.messageCount) parts.push(`${log.messageCount} msg${log.messageCount > 1 ? 's' : ''}`);
      parts.push(formatBytes(log.size));
      if (log.permissionMode === 'bypass') parts.push('bypass');
      meta.textContent = parts.join(' \u00b7 ');
      info.appendChild(meta);

      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'log-actions';

      if (log.resumable) {
        const resumeBtn = document.createElement('button');
        resumeBtn.textContent = 'Resume';
        resumeBtn.title = 'Reopen this session with Claude --resume';
        resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); resumeLog(log); });
        actions.appendChild(resumeBtn);
      } else if (log.live) {
        const liveTag = document.createElement('span');
        liveTag.className = 'log-tag';
        liveTag.textContent = 'live';
        actions.appendChild(liveTag);
      }

      const viewBtn = document.createElement('button');
      viewBtn.textContent = 'View';
      viewBtn.title = 'View log contents';
      viewBtn.addEventListener('click', (e) => { e.stopPropagation(); viewLog(log); });
      actions.appendChild(viewBtn);

      const dlBtn = document.createElement('button');
      dlBtn.textContent = 'Save';
      dlBtn.title = 'Download NDJSON';
      dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadLog(log); });
      actions.appendChild(dlBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'danger-btn';
      delBtn.textContent = '\u00d7';
      delBtn.title = 'Delete log';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirm('Delete this session log?');
        if (!ok) return;
        const r = await authFetch(`/api/logs/${log.id}`, { method: 'DELETE' });
        if (r.ok) loadLogsList();
      });
      actions.appendChild(delBtn);

    row.appendChild(actions);
    $logsList.appendChild(row);
  }
}

function shortPath(p) {
  if (!p) return null;
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || null;
}

async function viewLog(log) {
  try {
    const res = await authFetch(`/api/logs/${log.id}`);
    if (!res.ok) return;
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);

    document.getElementById('logs-viewer-title').textContent =
      log.sessionName || shortPath(log.cwd) || log.id.slice(0, 8);

    $logsContent.replaceChildren();

    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const el = document.createElement('div');
      el.className = 'log-entry';

      if (entry.type === 'user_message') {
        el.classList.add('log-user');
        el.textContent = entry.text;
      } else if (entry.type === 'claude_event' && entry.event?.type === 'assistant') {
        const blocks = entry.event.message?.content;
        if (!Array.isArray(blocks)) continue;
        const textParts = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        if (!textParts) continue;
        el.classList.add('log-assistant');
        el.textContent = textParts;
      } else if (entry.type === 'claude_event' && entry.event?.type === 'result' && entry.event.result) {
        el.classList.add('log-assistant');
        el.textContent = entry.event.result;
      } else if (entry.type === 'error') {
        el.classList.add('log-error');
        el.textContent = entry.message;
      } else if (entry.type === 'session_created') {
        el.classList.add('log-system');
        el.textContent = `Session started \u00b7 ${shortPath(entry.cwd)} \u00b7 ${entry.permissionMode}`;
      } else {
        // Skip internal events (turn_end, stderr, parse_error, etc.) for readability
        continue;
      }

      $logsContent.appendChild(el);
    }

    $logsList.classList.add('hidden');
    $logsViewer.classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load log:', err);
  }
}

async function resumeLog(log) {
  // Send the resume request. session_restored comes back on the WS.
  // The chat history is rehydrated there from /api/logs/:id.
  send({ type: 'resume_session', logId: log.id });
  $logsDialog.close();
}

/**
 * Walk the NDJSON log for a session and rebuild its in-memory messages +
 * artifacts. Mirrors the live handleClaudeEvent flow but writes directly to
 * session.messages so it works regardless of which session is currently active.
 */
async function rehydrateSessionFromLog(sessionId) {
  const res = await authFetch(`/api/logs/${sessionId}`);
  if (!res.ok) throw new Error(`log fetch failed: ${res.status}`);
  const text = await res.text();
  const session = state.sessions.get(sessionId);
  if (!session) return;

  // Track the parent for the assistant-text accumulator so flushed text
  // lands under the same parent as the text blocks that produced it.
  let pendingAssistant = '';
  let pendingAssistantParent = null;
  const flushAssistant = () => {
    if (pendingAssistant) {
      session.messages.push({
        role: 'assistant',
        text: pendingAssistant,
        parentToolUseId: pendingAssistantParent,
      });
      pendingAssistant = '';
      pendingAssistantParent = null;
    }
  };

  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'user_message') {
      flushAssistant();
      session.messages.push({ role: 'user', text: entry.text, attachments: null, parentToolUseId: null });
      session.lastUserTurn = { text: entry.text, attachments: null };
      continue;
    }

    if (entry.type === 'error' && entry.message) {
      flushAssistant();
      session.messages.push({ role: 'error', text: entry.message, parentToolUseId: null });
      continue;
    }

    if (entry.type === 'artifact' && entry.artifact) {
      const a = entry.artifact;
      // Skip transient/control artifacts that don't belong in the history panel.
      const transient = ['notification', 'open_url', 'progress', 'set_session_name', 'pin', 'permission_request'];
      if (transient.includes(a.type)) {
        if (a.type === 'set_session_name' && a.name) session.name = a.name;
        continue;
      }
      if (!state.artifacts.has(sessionId)) state.artifacts.set(sessionId, []);
      state.artifacts.get(sessionId).push(a);
      continue;
    }

    if (entry.type !== 'claude_event' || !entry.event) continue;
    const ev = entry.event;
    const parentId = ev.parent_tool_use_id || null;

    if (ev.type === 'assistant') {
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // If the parent changed mid-stream, flush what we have and start
          // a new accumulator under the new parent.
          if (pendingAssistant && pendingAssistantParent !== parentId) {
            flushAssistant();
          }
          pendingAssistant += block.text;
          pendingAssistantParent = parentId;
        } else if (block.type === 'thinking' && block.thinking) {
          flushAssistant();
          session.messages.push({ role: 'thinking', text: block.thinking, parentToolUseId: parentId });
        } else if (block.type === 'tool_use') {
          flushAssistant();
          session.messages.push({
            role: 'tool',
            name: block.name,
            input: block.input,
            result: null,
            id: block.id,
            parentToolUseId: parentId,
          });
        } else if (block.type === 'tool_result') {
          const existing = session.messages.find((m) => m.id === block.tool_use_id);
          if (existing) existing.result = extractToolResultText(block);
        }
      }
    } else if (ev.type === 'result') {
      if (pendingAssistant) {
        flushAssistant();
      } else if (ev.subtype === 'success' && ev.result) {
        session.messages.push({ role: 'assistant', text: ev.result, parentToolUseId: parentId });
      }
      if (ev.total_cost_usd != null) session.costUsd = ev.total_cost_usd;
    }
  }

  flushAssistant();

  if (state.activeId === sessionId) {
    renderChat();
    renderArtifacts();
    updateStatusUI();
    renderSidebar();
  }
}

async function downloadLog(log) {
  try {
    const res = await authFetch(`/api/logs/${log.id}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const name = (log.sessionName || log.id.slice(0, 8)) + '.ndjson';
    downloadBlob(blob, name);
  } catch (err) {
    console.error('Failed to download log:', err);
  }
}

document.getElementById('logs-viewer-back').addEventListener('click', () => {
  $logsViewer.classList.add('hidden');
  $logsList.classList.remove('hidden');
});

document.getElementById('logs-clear-all').addEventListener('click', async () => {
  const ok = await confirm('Delete all logs from inactive sessions? Active session logs are kept.');
  if (!ok) return;
  const res = await authFetch('/api/logs', { method: 'DELETE' });
  if (res.ok) {
    const data = await res.json();
    showToast(`Deleted ${data.deleted} log${data.deleted !== 1 ? 's' : ''}`);
    loadLogsList();
  }
});

document.getElementById('logs-close').addEventListener('click', () => {
  $logsDialog.close();
});

// ---------------------------------------------------------------------------
// WebSocket connection with exponential backoff
// ---------------------------------------------------------------------------

const MAX_RECONNECT_DELAY = 30000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}`;
  if (state.authToken) {
    url += `?token=${encodeURIComponent(state.authToken)}`;
  }

  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    state.ws = ws;
    state.reconnectDelay = 1000;
    console.log('[ws] connected');
    send({ type: 'get_defaults' });
    // Ask the server what's still alive. Any sessions the client doesn't
    // already know about will be auto-rehydrated and reattached.
    send({ type: 'list_sessions' });
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', (evt) => {
    state.ws = null;
    if (evt.code === 1006 && state.authRequired) {
      state.authToken = null;
      sessionStorage.removeItem('sublight_token');
      $authError.textContent = 'Invalid token. Please try again.';
      showAuthScreen();
      return;
    }
    console.log(`[ws] disconnected — reconnecting in ${state.reconnectDelay / 1000}s`);
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });
}

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------
// Server message handler
// ---------------------------------------------------------------------------

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_created': {
      const session = {
        id: msg.sessionId,
        cwd: msg.cwd,
        name: shortCwd(msg.cwd),
        messages: [],
        status: 'idle',
        streamingEl: null,
        streamingText: '',
        pendingToolCards: new Map(),
        // Map of tool_use_id → container element. When an event carries
        // parent_tool_use_id, new child elements append into that parent's
        // container instead of the top-level #messages. Supports arbitrary
        // nesting depth (a Task subagent can spawn another Task).
        toolContainers: new Map(),
        costUsd: null,
      };
      state.sessions.set(msg.sessionId, session);
      switchSession(msg.sessionId);
      renderSidebar();
      break;
    }

    case 'session_restored': {
      const session = {
        id: msg.sessionId,
        cwd: msg.cwd,
        name: msg.name || shortCwd(msg.cwd),
        messages: [],
        status: 'idle',
        streamingEl: null,
        streamingText: '',
        pendingToolCards: new Map(),
        toolContainers: new Map(),
        costUsd: null,
      };
      state.sessions.set(msg.sessionId, session);
      switchSession(msg.sessionId);
      renderSidebar();
      // Pull the NDJSON log and replay it into the chat/artifact state. This
      // reuses the already-authenticated logs endpoint — no new protocol.
      rehydrateSessionFromLog(msg.sessionId).catch((err) => {
        console.error('Failed to rehydrate session', err);
        appendError(session, `Failed to rehydrate chat history: ${err.message}`);
      });
      break;
    }

    case 'session_list': {
      // Fires on (re)connect. Any server-side session we don't already have
      // in state is a reattach candidate — spin up a local shell, rehydrate
      // from the log, and send attach_session to start receiving live events.
      for (const s of msg.sessions || []) {
        if (state.sessions.has(s.sessionId)) continue;
        const session = {
          id: s.sessionId,
          cwd: s.cwd,
          name: s.name || shortCwd(s.cwd),
          messages: [],
          status: s.status || 'idle',
          streamingEl: null,
          streamingText: '',
          pendingToolCards: new Map(),
          toolContainers: new Map(),
          costUsd: null,
        };
        state.sessions.set(s.sessionId, session);
        rehydrateSessionFromLog(s.sessionId).catch((err) => {
          console.error('Failed to rehydrate session', err);
        });
        send({ type: 'attach_session', sessionId: s.sessionId });
      }
      renderSidebar();
      // If we had no active session before (e.g. page just reloaded) and
      // there's at least one session, switch to the first.
      if (!state.activeId && msg.sessions?.length) {
        switchSession(msg.sessions[0].sessionId);
      }
      break;
    }

    case 'session_attached': {
      // Server confirms we're now the owner of an existing session. No
      // visible state change — the rehydration fired alongside the
      // attach_session request and will populate the chat.
      break;
    }

    case 'stream_start': {
      const s = state.sessions.get(msg.sessionId);
      if (s) {
        s.status = 'busy';
        s.streamingText = '';
        s.streamingEl = null;
      }
      updateStatusUI();
      renderSidebar();
      break;
    }

    case 'claude_event': {
      const s = state.sessions.get(msg.sessionId);
      if (!s) break;
      handleClaudeEvent(s, msg.event);
      break;
    }

    case 'stream_end': {
      const s = state.sessions.get(msg.sessionId);
      if (s) {
        if (s.streamingEl) finalizeStreaming(s);
        s.status = 'idle';
        s.streamingEl = null;
        s.streamingText = '';
        s.pendingToolCards.clear();
        if (msg.stderr) appendError(s, msg.stderr);
      }
      updateStatusUI();
      renderSidebar();
      break;
    }

    case 'error': {
      const s = msg.sessionId ? state.sessions.get(msg.sessionId) : null;
      if (s) {
        appendError(s, msg.message);
        s.status = 'idle';
      } else {
        console.error('[server]', msg.message);
      }
      updateStatusUI();
      renderSidebar();
      break;
    }

    case 'session_closed': {
      state.sessions.delete(msg.sessionId);
      removeSessionNotes(msg.sessionId);
      if (state.activeId === msg.sessionId) state.activeId = null;
      renderSidebar();
      renderChat();
      break;
    }

    case 'defaults': {
      state.defaultCwd = msg.cwd || '';
      state.defaultPermissionMode = msg.defaultPermissionMode || 'default';
      break;
    }

    case 'dir_listing': {
      // Folder autocomplete for the new-session dialog. Helpers are defined
      // later in the file but exist by the time this runs (runtime-resolved).
      const input = $dialogCwd.value;
      const local = buildLocalSuggestions(input);
      const localPaths = new Set(local.map((i) => i.path));
      const fsEntries = (msg.entries || [])
        .filter((p) => !localPaths.has(p))
        .map((p) => ({ path: p, tag: null }));
      showSuggestions([...local, ...fsEntries].slice(0, 15));
      break;
    }

    case 'artifact': {
      const { sessionId, artifact } = msg;

      // Handle notification as toast (don't add to artifact list)
      if (artifact.type === 'notification') {
        showToast(artifact.message);
        break;
      }

      // Handle open_url with user confirmation
      if (artifact.type === 'open_url') {
        handleOpenUrl(artifact);
        break;
      }

      // Handle permission_request — Claude wants to run a tool in
      // non-bypass mode, and we need to ask the user to allow/deny.
      if (artifact.type === 'permission_request') {
        handlePermissionRequest(artifact);
        break;
      }

      // Handle set_session_name
      if (artifact.type === 'set_session_name') {
        const session = state.sessions.get(sessionId);
        if (session) {
          session.name = artifact.name;
          if (sessionId === state.activeId) $chatTitle.textContent = artifact.name;
          renderSidebar();
        }
        break;
      }

      // Handle progress updates (upsert by id)
      if (artifact.type === 'progress') {
        handleProgress(sessionId, artifact);
        break;
      }

      // Handle pin
      if (artifact.type === 'pin') {
        handlePin(sessionId, artifact.index);
        break;
      }

      // All other artifacts go into the list
      if (!state.artifacts.has(sessionId)) {
        state.artifacts.set(sessionId, []);
      }
      state.artifacts.get(sessionId).push(artifact);

      // Auto-open artifacts panel
      if (!state.artifactsVisible) {
        state.artifactsVisible = true;
        $artifactsPanel.classList.remove('hidden');
      }

      if (sessionId === state.activeId) {
        renderArtifacts();
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Claude NDJSON event interpreter
// ---------------------------------------------------------------------------

function handleClaudeEvent(session, event) {
  const isActive = session.id === state.activeId;

  // Track whether the current event came from a subagent (Task tool child)
  // so rendering helpers can mark it visually. Null/undefined means top-level.
  session.currentParentToolUseId = event.parent_tool_use_id || null;

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        // Only seed the name from the cwd if the session doesn't already have
        // one. session_created seeds a cwd-based name up front; session_restored
        // and set_session_name artifacts can replace it with a custom name. On
        // --resume the init event fires a second time for the same session, and
        // we must NOT clobber a custom name back to the cwd-derived default.
        if (!session.name) {
          session.name = shortCwd(event.cwd || session.cwd);
        }
        // Capture the Claude runtime state from the init event so we can
        // surface it in the chat header: model, MCP servers, tool/skill counts.
        session.runtime = {
          model: event.model || null,
          mcpServers: Array.isArray(event.mcp_servers) ? event.mcp_servers : [],
          toolCount: Array.isArray(event.tools) ? event.tools.length : 0,
          slashCommands: Array.isArray(event.slash_commands) ? event.slash_commands : [],
          slashCommandCount: Array.isArray(event.slash_commands) ? event.slash_commands.length : 0,
          skillCount: Array.isArray(event.skills) ? event.skills.length : 0,
          permissionMode: event.permissionMode || null,
        };
        if (isActive) {
          $chatTitle.textContent = session.name;
          updateRuntimeStrip(session);
        }
        renderSidebar();
      }
      break;

    case 'assistant': {
      const content = event.message?.content;
      if (!Array.isArray(content)) break;

      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) {
          if (session.streamingText && session.streamingEl) finalizeStreaming(session);
          if (isActive) {
            appendThinking(session, block.thinking);
          } else {
            session.messages.push({ role: 'thinking', text: block.thinking, parentToolUseId: session.currentParentToolUseId || null });
          }
        }

        if (block.type === 'text' && block.text) {
          session.streamingText += block.text;
          if (isActive) {
            ensureStreamingEl(session);
            renderStreamingText(session);
          }
        }

        if (block.type === 'tool_use') {
          if (session.streamingText && session.streamingEl) finalizeStreaming(session);
          if (isActive) {
            appendToolUse(session, block);
          } else {
            session.messages.push({ role: 'tool', name: block.name, input: block.input, result: null, id: block.id, parentToolUseId: session.currentParentToolUseId || null });
          }
        }

        if (block.type === 'tool_result') {
          if (isActive) {
            fillToolResult(session, block);
          } else {
            const existing = session.messages.find(m => m.id === block.tool_use_id);
            if (existing) existing.result = extractToolResultText(block);
          }
        }
      }
      break;
    }

    case 'result': {
      if (event.subtype === 'success' && event.result) {
        if (session.streamingText) {
          finalizeStreaming(session);
        } else {
          session.streamingText = event.result;
          if (isActive) {
            ensureStreamingEl(session);
            renderStreamingText(session);
            finalizeStreaming(session);
          } else {
            session.messages.push({ role: 'assistant', text: event.result, parentToolUseId: session.currentParentToolUseId || null });
          }
        }
      }
      if (event.subtype?.startsWith('error')) {
        appendError(session, event.result || `Error: ${event.subtype}`);
      }
      if (event.total_cost_usd != null) {
        session.costUsd = event.total_cost_usd;
        if (isActive) updateStatusUI();
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming text rendering
// ---------------------------------------------------------------------------

/**
 * Return the DOM element new chat elements should be appended to. Top-level
 * events go into #messages; events with a parent_tool_use_id drop into the
 * "children" container inside that parent Task card. Falls back to #messages
 * if the parent container is unknown (e.g. the Task card was created before
 * we started tracking children, or the parent id refers to a tool we never
 * rendered).
 */
function getRenderContainer(session) {
  const parentId = session.currentParentToolUseId;
  if (!parentId) return $messages;
  const container = session.toolContainers?.get(parentId);
  return container || $messages;
}

function ensureStreamingEl(session) {
  if (session.streamingEl) return;
  const el = document.createElement('div');
  el.className = 'msg msg-assistant streaming';
  if (session.currentParentToolUseId) el.classList.add('from-subagent');
  getRenderContainer(session).appendChild(el);
  session.streamingEl = el;
  scrollToBottom();
}

function renderStreamingText(session) {
  if (!session.streamingEl) return;
  setMarkdownContent(session.streamingEl, session.streamingText);
  scrollToBottom();
}

function finalizeStreaming(session) {
  if (!session.streamingEl) return;
  session.streamingEl.classList.remove('streaming');
  session.messages.push({
    role: 'assistant',
    text: session.streamingText,
    parentToolUseId: session.currentParentToolUseId || null,
  });
  session.streamingEl = null;
  session.streamingText = '';
}

// ---------------------------------------------------------------------------
// Thinking cards
// ---------------------------------------------------------------------------

function appendThinking(session, text) {
  const details = document.createElement('details');
  details.className = 'thinking-card';
  if (session.currentParentToolUseId) details.classList.add('from-subagent');
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'thinking-body';
  body.textContent = text;
  details.appendChild(body);
  getRenderContainer(session).appendChild(details);
  session.messages.push({ role: 'thinking', text, parentToolUseId: session.currentParentToolUseId || null });
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Tool-use cards
// ---------------------------------------------------------------------------

function appendToolUse(session, block) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  if (session.currentParentToolUseId) details.classList.add('from-subagent');
  // A Task tool launches a subagent. Mark the card so the user sees it's a
  // "parent" of any nested events that follow.
  const isTask = block.name === 'Task';
  if (isTask) {
    details.classList.add('task-parent');
    details.open = true; // auto-expand so the nested activity is visible
  }
  const summary = document.createElement('summary');
  summary.textContent = block.name;
  details.appendChild(summary);
  const inputBody = document.createElement('div');
  inputBody.className = 'tool-body';
  inputBody.textContent = typeof block.input === 'string'
    ? block.input
    : JSON.stringify(block.input, null, 2);
  details.appendChild(inputBody);

  // Every tool card gets a children container. For Task tools this is where
  // subagent events (thinking, tool_use, assistant text) will land. For
  // regular tools it stays empty — harmless and keeps the shape uniform.
  const children = document.createElement('div');
  children.className = 'tool-children';
  details.appendChild(children);
  session.toolContainers.set(block.id, children);

  const resultBody = document.createElement('div');
  resultBody.className = 'tool-body';
  resultBody.style.display = 'none';
  details.appendChild(resultBody);

  getRenderContainer(session).appendChild(details);
  session.pendingToolCards.set(block.id, { details, resultBody });
  session.messages.push({
    role: 'tool',
    name: block.name,
    input: block.input,
    result: null,
    id: block.id,
    parentToolUseId: session.currentParentToolUseId || null,
  });
  scrollToBottom();
}

function fillToolResult(session, block) {
  const text = extractToolResultText(block);
  const msg = session.messages.find(m => m.id === block.tool_use_id);
  if (msg) msg.result = text;
  const card = session.pendingToolCards.get(block.tool_use_id);
  if (card) {
    card.resultBody.textContent = text;
    card.resultBody.style.display = '';
    session.pendingToolCards.delete(block.tool_use_id);
  }
  scrollToBottom();
}

function extractToolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map(c => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(block.content, null, 2);
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function appendUserMessage(session, text, attachments) {
  session.messages.push({ role: 'user', text, attachments: attachments || null });
  // Track the most recent user turn so the Retry button can resend it.
  session.lastUserTurn = { text, attachments: attachments || null };
  if (session.id === state.activeId) {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    if (attachments?.length) {
      const thumbs = document.createElement('div');
      thumbs.className = 'msg-attachments';
      for (const att of attachments) {
        if (att.type === 'image') {
          const img = document.createElement('img');
          img.src = `data:${att.source.media_type};base64,${att.source.data}`;
          img.className = 'msg-attachment-img';
          thumbs.appendChild(img);
        }
      }
      if (thumbs.childElementCount) el.appendChild(thumbs);
    }
    const textNode = document.createElement('div');
    textNode.textContent = text;
    el.appendChild(textNode);
    $messages.appendChild(el);
    scrollToBottom();
  }
}

function appendError(session, text) {
  session.messages.push({ role: 'error', text });
  if (session.id === state.activeId) {
    const el = document.createElement('div');
    el.className = 'msg msg-error';
    el.textContent = text;
    getRenderContainer(session).appendChild(el);
    scrollToBottom();
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
}

function shortCwd(cwd) {
  if (!cwd) return 'Session';
  const parts = cwd.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || 'Session';
}

// ---------------------------------------------------------------------------
// Session switching
// ---------------------------------------------------------------------------

function switchSession(id) {
  if (state.activeId === id) return;
  state.activeId = id;
  renderSidebar();
  renderChat();
  renderNotes();
  if (state.artifactsVisible) renderArtifacts();
}

function renderChat() {
  const session = state.sessions.get(state.activeId);

  if (!session) {
    $chatArea.classList.add('hidden');
    $emptyState.classList.remove('hidden');
    return;
  }

  $emptyState.classList.add('hidden');
  $chatArea.classList.remove('hidden');
  $chatTitle.textContent = session.name || 'Session';
  updateStatusUI();
  updateRuntimeStrip(session);

  $messages.replaceChildren();
  // Rebuild toolContainers from scratch — we're about to re-append every
  // message, and nested children resolve parents via this map.
  session.toolContainers = new Map();

  // Resolve the container for a message: if it has a parent and we've
  // already rendered that parent's children container, use it; otherwise
  // fall back to the top-level messages area. The fallback handles
  // out-of-order or orphaned events gracefully.
  const containerFor = (parentId) => {
    if (parentId && session.toolContainers.has(parentId)) {
      return session.toolContainers.get(parentId);
    }
    return $messages;
  };

  for (const msg of session.messages) {
    const container = containerFor(msg.parentToolUseId);
    const isSubagent = !!msg.parentToolUseId;
    switch (msg.role) {
      case 'user': {
        const el = document.createElement('div');
        el.className = 'msg msg-user';
        if (isSubagent) el.classList.add('from-subagent');
        el.textContent = msg.text;
        container.appendChild(el);
        break;
      }
      case 'assistant': {
        const el = document.createElement('div');
        el.className = 'msg msg-assistant';
        if (isSubagent) el.classList.add('from-subagent');
        setMarkdownContent(el, msg.text);
        container.appendChild(el);
        break;
      }
      case 'thinking': {
        const details = document.createElement('details');
        details.className = 'thinking-card';
        if (isSubagent) details.classList.add('from-subagent');
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking';
        details.appendChild(summary);
        const body = document.createElement('div');
        body.className = 'thinking-body';
        body.textContent = msg.text;
        details.appendChild(body);
        container.appendChild(details);
        break;
      }
      case 'tool': {
        const details = document.createElement('details');
        details.className = 'tool-card';
        if (isSubagent) details.classList.add('from-subagent');
        const isTask = msg.name === 'Task';
        if (isTask) {
          details.classList.add('task-parent');
          details.open = true;
        }
        const summary = document.createElement('summary');
        summary.textContent = msg.name;
        details.appendChild(summary);
        const inputBody = document.createElement('div');
        inputBody.className = 'tool-body';
        inputBody.textContent = typeof msg.input === 'string'
          ? msg.input
          : JSON.stringify(msg.input, null, 2);
        details.appendChild(inputBody);
        // Register the children container before appending the card so any
        // later-arriving nested messages can find it.
        const children = document.createElement('div');
        children.className = 'tool-children';
        details.appendChild(children);
        if (msg.id) session.toolContainers.set(msg.id, children);
        if (msg.result != null) {
          const resultBody = document.createElement('div');
          resultBody.className = 'tool-body';
          resultBody.textContent = msg.result;
          details.appendChild(resultBody);
        }
        container.appendChild(details);
        break;
      }
      case 'error': {
        const el = document.createElement('div');
        el.className = 'msg msg-error';
        if (isSubagent) el.classList.add('from-subagent');
        el.textContent = msg.text;
        container.appendChild(el);
        break;
      }
    }
  }

  if (session.streamingText && session.status === 'busy') {
    ensureStreamingEl(session);
    renderStreamingText(session);
  }

  scrollToBottom();
  $promptInput.focus();
}

function updateRuntimeStrip(session) {
  if (!session?.runtime) {
    $chatRuntime.classList.add('hidden');
    $chatRuntime.textContent = '';
    $chatRuntime.title = '';
    return;
  }
  const { model, mcpServers, toolCount, slashCommandCount, skillCount } = session.runtime;
  const connected = mcpServers.filter((s) => s.status === 'connected').length;
  const failed = mcpServers.filter((s) => s.status === 'failed').length;
  const parts = [];
  if (model) parts.push(model);
  if (mcpServers.length) parts.push(`MCP ${connected}/${mcpServers.length}`);
  if (toolCount) parts.push(`${toolCount} tools`);
  $chatRuntime.textContent = parts.join(' · ');
  // Tooltip: full server list with status so users can audit on hover.
  const lines = [];
  if (model) lines.push(`Model: ${model}`);
  lines.push(`Tools: ${toolCount}  ·  Slash: ${slashCommandCount}  ·  Skills: ${skillCount}`);
  if (mcpServers.length) {
    lines.push('');
    lines.push('MCP servers:');
    for (const s of mcpServers) {
      lines.push(`  ${s.status === 'connected' ? '✓' : '✗'} ${s.name} (${s.status})`);
    }
  }
  if (failed > 0) $chatRuntime.classList.add('has-failed');
  else $chatRuntime.classList.remove('has-failed');
  $chatRuntime.title = lines.join('\n');
  $chatRuntime.classList.remove('hidden');
}

function updateStatusUI() {
  const session = state.sessions.get(state.activeId);
  if (!session) return;

  const busy = session.status === 'busy';
  $btnSend.classList.toggle('hidden', busy);
  $btnAbort.classList.toggle('hidden', !busy);
  $promptInput.disabled = busy;
  // Retry is available only when idle and a prior user turn exists to resend.
  const retryBtn = document.getElementById('btn-retry');
  if (retryBtn) {
    retryBtn.classList.toggle('hidden', busy || !session.lastUserTurn);
  }

  if (busy) {
    $chatStatus.textContent = 'thinking...';
  } else if (session.costUsd != null) {
    $chatStatus.textContent = `$${session.costUsd.toFixed(4)}`;
  } else {
    $chatStatus.textContent = 'idle';
  }
}

// ---------------------------------------------------------------------------
// Sidebar rendering with inline rename
// ---------------------------------------------------------------------------

function renderSidebar() {
  $sidebar.replaceChildren();
  for (const [id, session] of state.sessions) {
    const li = document.createElement('li');
    if (id === state.activeId) li.classList.add('active');
    li.addEventListener('click', () => switchSession(id));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'session-name';
    nameSpan.textContent = session.name || 'Session';
    if (session.status === 'busy') nameSpan.textContent += ' ...';

    // Double-click to rename
    nameSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(li, session);
    });

    li.appendChild(nameSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'session-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirm(`Close session "${session.name}"? This will terminate the Claude process.`);
      if (ok) send({ type: 'close_session', sessionId: id });
    });
    li.appendChild(closeBtn);

    $sidebar.appendChild(li);
  }
}

function startRename(li, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || '';

  // Replace the li content with the input
  const nameSpan = li.querySelector('.session-name');
  const closeBtn = li.querySelector('.session-close');
  nameSpan.classList.add('hidden');
  closeBtn.classList.add('hidden');
  li.insertBefore(input, nameSpan);
  input.focus();
  input.select();

  function finishRename() {
    const newName = input.value.trim();
    if (newName) session.name = newName;
    input.remove();
    nameSpan.classList.remove('hidden');
    closeBtn.classList.remove('hidden');
    nameSpan.textContent = session.name;
    if (session.id === state.activeId) {
      $chatTitle.textContent = session.name;
    }
  }

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = session.name; input.blur(); }
  });
  // Prevent the li click from firing
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// User input — Ctrl+Enter to send, Enter for newlines
// ---------------------------------------------------------------------------

$inputBar.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $promptInput.value.trim();
  if (!text || !state.activeId) return;

  const session = state.sessions.get(state.activeId);
  if (!session || session.status === 'busy') return;

  const attachments = consumeAttachments();
  appendUserMessage(session, text, attachments);
  send({ type: 'message', sessionId: state.activeId, text, attachments });
  $promptInput.value = '';
  autoResizeInput();
});

$promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $inputBar.requestSubmit();
  }
  // Plain Enter inserts a newline (default textarea behavior)
});

$promptInput.addEventListener('input', autoResizeInput);

function autoResizeInput() {
  $promptInput.style.height = 'auto';
  $promptInput.style.height = Math.min($promptInput.scrollHeight, 200) + 'px';
}

// ---------------------------------------------------------------------------
// Slash command autocomplete — appears when the composer starts with "/"
// and the active session has slash_commands captured from the init event.
// ---------------------------------------------------------------------------

const $slashSuggest = document.getElementById('slash-suggest');
let slashMatches = [];
let slashSelected = 0;

function updateSlashSuggest() {
  const session = state.sessions.get(state.activeId);
  const commands = session?.runtime?.slashCommands || [];
  const raw = $promptInput.value;
  // Only fire when the ENTIRE composer is a single line starting with /
  // and we have commands to suggest.
  if (!raw.startsWith('/') || raw.includes('\n') || commands.length === 0) {
    hideSlashSuggest();
    return;
  }
  const query = raw.slice(1).toLowerCase();
  slashMatches = commands
    .filter((cmd) => cmd.toLowerCase().includes(query))
    .slice(0, 10);
  if (slashMatches.length === 0) {
    hideSlashSuggest();
    return;
  }
  slashSelected = Math.min(slashSelected, slashMatches.length - 1);
  $slashSuggest.replaceChildren();
  slashMatches.forEach((cmd, i) => {
    const li = document.createElement('li');
    li.textContent = '/' + cmd;
    if (i === slashSelected) li.classList.add('active');
    // Use mousedown so it fires before the textarea blurs and hides the menu.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySlashMatch(i);
    });
    $slashSuggest.appendChild(li);
  });
  $slashSuggest.classList.remove('hidden');
}

function hideSlashSuggest() {
  slashMatches = [];
  slashSelected = 0;
  $slashSuggest.classList.add('hidden');
}

function applySlashMatch(index) {
  const cmd = slashMatches[index];
  if (!cmd) return;
  $promptInput.value = '/' + cmd + ' ';
  hideSlashSuggest();
  $promptInput.focus();
}

$promptInput.addEventListener('input', updateSlashSuggest);

// Keyboard navigation for the slash menu. Only intercept when it's open.
$promptInput.addEventListener('keydown', (e) => {
  if (slashMatches.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    slashSelected = (slashSelected + 1) % slashMatches.length;
    updateSlashSuggest();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    slashSelected = (slashSelected - 1 + slashMatches.length) % slashMatches.length;
    updateSlashSuggest();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    applySlashMatch(slashSelected);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashSuggest();
  }
});

$promptInput.addEventListener('blur', () => {
  // Small delay so mousedown on a suggestion can fire first.
  setTimeout(hideSlashSuggest, 100);
});

$btnAbort.addEventListener('click', () => {
  if (state.activeId) {
    send({ type: 'abort', sessionId: state.activeId });
  }
});

// ---------------------------------------------------------------------------
// Session export — markdown (Save) and full bundle (Bundle)
// ---------------------------------------------------------------------------

/** Render the current session's in-memory messages to a markdown transcript. */
function buildMarkdownTranscript(session) {
  let md = `# Session: ${session.name}\n`;
  md += `> cwd: ${session.cwd}\n`;
  if (session.costUsd != null) md += `> cost: $${session.costUsd.toFixed(4)}\n`;
  md += `> exported: ${new Date().toISOString()}\n\n---\n\n`;

  for (const msg of session.messages) {
    // Tag subagent lines so the flat markdown still hints at the nesting.
    const tag = msg.parentToolUseId ? ' _(subagent)_' : '';
    switch (msg.role) {
      case 'user':
        md += `## User${tag}\n\n${msg.text}\n\n`;
        break;
      case 'assistant':
        md += `## Assistant${tag}\n\n${msg.text}\n\n`;
        break;
      case 'thinking':
        md += `<details><summary>Thinking${tag}</summary>\n\n${msg.text}\n\n</details>\n\n`;
        break;
      case 'tool':
        md += `### Tool: ${msg.name}${tag}\n\n\`\`\`json\n${typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input, null, 2)}\n\`\`\`\n\n`;
        if (msg.result != null) md += `**Result:**\n\`\`\`\n${msg.result}\n\`\`\`\n\n`;
        break;
      case 'error':
        md += `> **Error:**${tag} ${msg.text}\n\n`;
        break;
    }
  }
  return md;
}

/** Sanitize a session name for use as a filename. */
function safeFilename(name) {
  return (name || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}

document.getElementById('btn-save').addEventListener('click', () => {
  const session = state.sessions.get(state.activeId);
  if (!session) return;
  const md = buildMarkdownTranscript(session);
  const blob = new Blob([md], { type: 'text/markdown' });
  downloadBlob(blob, `${safeFilename(session.name)}-${new Date().toISOString().slice(0, 10)}.md`);
});

document.getElementById('btn-bundle').addEventListener('click', async () => {
  const session = state.sessions.get(state.activeId);
  if (!session) return;
  const btn = document.getElementById('btn-bundle');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Bundling…';

  try {
    const zip = new JSZip();

    // 1. Markdown transcript built from live session state.
    zip.file('transcript.md', buildMarkdownTranscript(session));

    // 2. Raw NDJSON log from the server — source of truth for the session.
    try {
      const logRes = await authFetch(`/api/logs/${session.id}`);
      if (logRes.ok) {
        zip.file('transcript.ndjson', await logRes.text());
      }
    } catch (err) {
      console.error('bundle: log fetch failed', err);
    }

    // 3. Bundled artifacts. For each image artifact we know about, fetch the
    // file from /local-file and drop it into artifacts/ with a sequential
    // filename so clashes are impossible. Non-image artifacts get inlined
    // into an artifacts.md index so nothing is lost.
    const artifactsList = state.artifacts.get(session.id) || [];
    const artifactIndexLines = ['# Artifacts\n'];
    let imageIndex = 0;
    for (const a of artifactsList) {
      if (a.type === 'image' && a.path) {
        try {
          const r = await authFetch(`/local-file?path=${encodeURIComponent(a.path)}`);
          if (r.ok) {
            const blob = await r.blob();
            const ext = (a.path.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
            const filename = `artifacts/image-${String(imageIndex++).padStart(3, '0')}.${ext}`;
            zip.file(filename, await blob.arrayBuffer());
            artifactIndexLines.push(`- ![${a.caption || a.path}](${filename})`);
            if (a.caption) artifactIndexLines.push(`  ${a.caption}`);
            artifactIndexLines.push('');
          }
        } catch (err) {
          console.error('bundle: image fetch failed for', a.path, err);
        }
      } else if (a.type === 'code') {
        artifactIndexLines.push(`## ${a.title || 'Code'}`);
        artifactIndexLines.push('```' + (a.language || '') + '\n' + (a.content || '') + '\n```\n');
      } else if (a.type === 'markdown') {
        artifactIndexLines.push(`## ${a.title || 'Document'}\n`);
        artifactIndexLines.push((a.markdown || '') + '\n');
      } else if (a.type === 'diff') {
        artifactIndexLines.push(`## ${a.title || 'Diff'}`);
        artifactIndexLines.push('```diff\n' + (a.diff || '') + '\n```\n');
      }
    }
    if (artifactsList.length > 0) {
      zip.file('artifacts.md', artifactIndexLines.join('\n'));
    }

    // 4. Sidecar metadata so the bundle is self-describing.
    const meta = {
      sessionId: session.id,
      name: session.name,
      cwd: session.cwd,
      costUsd: session.costUsd,
      exportedAt: new Date().toISOString(),
      runtime: session.runtime || null,
      messageCount: session.messages.length,
      artifactCount: artifactsList.length,
    };
    zip.file('metadata.json', JSON.stringify(meta, null, 2));

    const blob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `sublight-${safeFilename(session.name)}-${stamp}.zip`);
  } catch (err) {
    console.error('bundle export failed', err);
    showToast('Bundle export failed — see console');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// ---------------------------------------------------------------------------
// Notes panel — per-session scratch space, stored in localStorage
// ---------------------------------------------------------------------------

function notesKey(sessionId) {
  return `sublight_notes_${sessionId}`;
}

function loadNotes(sessionId) {
  try {
    return JSON.parse(localStorage.getItem(notesKey(sessionId))) || [];
  } catch {
    return [];
  }
}

function saveNotes(sessionId, notes) {
  localStorage.setItem(notesKey(sessionId), JSON.stringify(notes));
}

function removeSessionNotes(sessionId) {
  localStorage.removeItem(notesKey(sessionId));
}

function renderNotes() {
  if (!state.activeId) return;
  const notes = loadNotes(state.activeId);
  $notesList.replaceChildren();

  if (notes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'notes-empty';
    empty.textContent = 'No notes yet. Click + to add one.';
    $notesList.appendChild(empty);
    return;
  }

  for (let i = 0; i < notes.length; i++) {
    const card = document.createElement('div');
    card.className = 'note-card';

    const textarea = document.createElement('textarea');
    textarea.className = 'note-textarea';
    textarea.value = notes[i].text;
    textarea.placeholder = 'Write a note...';
    textarea.rows = 3;

    // Auto-save on input
    const idx = i;
    textarea.addEventListener('input', () => {
      const current = loadNotes(state.activeId);
      if (current[idx]) {
        current[idx].text = textarea.value;
        saveNotes(state.activeId, current);
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-delete';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete note';
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirm('Delete this note?');
      if (!ok) return;
      const current = loadNotes(state.activeId);
      current.splice(idx, 1);
      saveNotes(state.activeId, current);
      renderNotes();
    });

    card.appendChild(deleteBtn);
    card.appendChild(textarea);
    $notesList.appendChild(card);
  }
}

document.getElementById('btn-add-note').addEventListener('click', () => {
  if (!state.activeId) return;
  const notes = loadNotes(state.activeId);
  notes.push({ text: '', createdAt: new Date().toISOString() });
  saveNotes(state.activeId, notes);
  renderNotes();
  // Focus the new note
  const last = $notesList.querySelector('.note-card:last-child .note-textarea');
  if (last) last.focus();
});

document.getElementById('btn-notes').addEventListener('click', () => {
  state.notesVisible = !state.notesVisible;
  $notesPanel.classList.toggle('hidden', !state.notesVisible);
  if (state.notesVisible) renderNotes();
});

// ---------------------------------------------------------------------------
// Artifacts panel
// ---------------------------------------------------------------------------

function renderArtifacts() {
  if (!state.activeId) return;
  const artifacts = state.artifacts.get(state.activeId) || [];
  $artifactsList.replaceChildren();

  if (artifacts.length === 0 && !getProgressBars(state.activeId).size) {
    const empty = document.createElement('p');
    empty.className = 'artifacts-empty';
    empty.textContent = 'No artifacts yet. Claude can use show_image, show_artifact, show_diff, and other tools to display content here.';
    $artifactsList.appendChild(empty);
    return;
  }

  // Render progress bars at top
  for (const [id, prog] of getProgressBars(state.activeId)) {
    const bar = document.createElement('div');
    bar.className = 'artifact-progress' + (prog.done ? ' done' : '');
    const label = document.createElement('div');
    label.className = 'progress-label';
    label.textContent = prog.label;
    bar.appendChild(label);
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${prog.percent}%`;
    track.appendChild(fill);
    bar.appendChild(track);
    const pct = document.createElement('div');
    pct.className = 'progress-pct';
    pct.textContent = prog.done ? 'Done' : `${prog.percent}%`;
    bar.appendChild(pct);
    $artifactsList.appendChild(bar);
  }

  // Render pinned artifacts first
  const pinned = artifacts.filter(a => a.pinned);
  const unpinned = artifacts.filter(a => !a.pinned);

  for (const artifact of [...pinned, ...unpinned]) {
    const card = renderArtifactCard(artifact);
    if (card) $artifactsList.appendChild(card);
  }

  $artifactsList.scrollTop = $artifactsList.scrollHeight;
}

function renderArtifactCard(artifact) {
  const card = document.createElement('div');
  card.className = 'artifact-card' + (artifact.pinned ? ' pinned' : '');

  if (artifact.type === 'image') {
    const img = document.createElement('img');
    img.src = authUrl(`/local-file?path=${encodeURIComponent(artifact.path)}`);
    img.alt = artifact.caption || 'Image artifact';
    img.loading = 'lazy';
    card.appendChild(img);
    if (artifact.caption) {
      const cap = document.createElement('div');
      cap.className = 'artifact-caption';
      cap.textContent = artifact.caption;
      card.appendChild(cap);
    }
  } else if (artifact.type === 'code') {
    const title = document.createElement('div');
    title.className = 'artifact-title';
    title.textContent = artifact.title;
    card.appendChild(title);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = artifact.content;
    if (artifact.language) {
      code.className = `language-${artifact.language}`;
      hljs.highlightElement(code);
    }
    pre.appendChild(code);
    card.appendChild(pre);
  } else if (artifact.type === 'diff') {
    const title = document.createElement('div');
    title.className = 'artifact-title';
    title.textContent = artifact.title;
    // Copy-to-clipboard button inline in the title row for quick grab.
    const copyBtn = document.createElement('button');
    copyBtn.className = 'diff-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy raw diff to clipboard';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(artifact.diff);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch (err) {
        console.error('Clipboard copy failed:', err);
      }
    });
    title.appendChild(copyBtn);
    card.appendChild(title);

    // Quick stat summary: +added / -removed across the whole diff.
    let added = 0, removed = 0;
    const lines = artifact.diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    if (added || removed) {
      const stat = document.createElement('div');
      stat.className = 'diff-stat';
      const addSpan = document.createElement('span');
      addSpan.className = 'diff-add';
      addSpan.textContent = `+${added}`;
      const rmSpan = document.createElement('span');
      rmSpan.className = 'diff-remove';
      rmSpan.textContent = `−${removed}`;
      stat.append(addSpan, ' ', rmSpan);
      card.appendChild(stat);
    }

    const pre = document.createElement('pre');
    pre.className = 'diff-content';
    for (const line of lines) {
      const span = document.createElement('span');
      span.textContent = line + '\n';
      if (line.startsWith('+++') || line.startsWith('---')) {
        span.className = 'diff-file';
      } else if (line.startsWith('+')) {
        span.className = 'diff-add';
      } else if (line.startsWith('-')) {
        span.className = 'diff-remove';
      } else if (line.startsWith('@@')) {
        span.className = 'diff-hunk';
      }
      pre.appendChild(span);
    }
    card.appendChild(pre);
  } else if (artifact.type === 'markdown') {
    const title = document.createElement('div');
    title.className = 'artifact-title';
    title.textContent = artifact.title;
    card.appendChild(title);
    const body = document.createElement('div');
    body.className = 'artifact-markdown';
    setMarkdownContent(body, artifact.markdown);
    card.appendChild(body);
  } else {
    return null;
  }

  // Export button on every card
  const exportBtn = document.createElement('button');
  exportBtn.className = 'artifact-export';
  exportBtn.textContent = 'Save';
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportArtifact(artifact);
  });
  card.appendChild(exportBtn);

  return card;
}

function exportArtifact(artifact) {
  let blob, filename;

  if (artifact.type === 'image') {
    // Download image via fetch
    authFetch(`/local-file?path=${encodeURIComponent(artifact.path)}`)
      .then(r => r.blob())
      .then(b => {
        const ext = artifact.path.split('.').pop() || 'png';
        downloadBlob(b, `artifact.${ext}`);
      });
    return;
  } else if (artifact.type === 'code') {
    const ext = artifact.language ? { javascript: 'js', python: 'py', typescript: 'ts', html: 'html', css: 'css', json: 'json' }[artifact.language] || 'txt' : 'txt';
    blob = new Blob([artifact.content], { type: 'text/plain' });
    filename = `${artifact.title || 'artifact'}.${ext}`;
  } else if (artifact.type === 'diff') {
    blob = new Blob([artifact.diff], { type: 'text/plain' });
    filename = `${artifact.title || 'artifact'}.diff`;
  } else if (artifact.type === 'markdown') {
    blob = new Blob([artifact.markdown], { type: 'text/markdown' });
    filename = `${artifact.title || 'artifact'}.md`;
  } else {
    return;
  }

  downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Progress bars — stored separately (upserted by id, not appended)
/** Map<sessionId, Map<progressId, {label, percent, done}>> */
const progressBars = new Map();

function getProgressBars(sessionId) {
  return progressBars.get(sessionId) || new Map();
}

function handleProgress(sessionId, artifact) {
  if (!progressBars.has(sessionId)) progressBars.set(sessionId, new Map());
  const bars = progressBars.get(sessionId);

  if (artifact.done) {
    // Mark as done, remove after a short delay
    bars.set(artifact.id, { ...artifact });
    if (sessionId === state.activeId) renderArtifacts();
    setTimeout(() => {
      bars.delete(artifact.id);
      if (sessionId === state.activeId) renderArtifacts();
    }, 3000);
  } else {
    bars.set(artifact.id, artifact);
    if (sessionId === state.activeId) renderArtifacts();
  }

  if (!state.artifactsVisible) {
    state.artifactsVisible = true;
    $artifactsPanel.classList.remove('hidden');
  }
}

// Pin artifact
function handlePin(sessionId, index) {
  const artifacts = state.artifacts.get(sessionId);
  if (!artifacts) return;

  const idx = index < 0 ? artifacts.length + index : index;
  if (idx >= 0 && idx < artifacts.length) {
    artifacts[idx].pinned = true;
    if (sessionId === state.activeId) renderArtifacts();
  }
}

// Open URL with confirmation
async function handleOpenUrl(artifact) {
  const label = artifact.label || artifact.url;
  const ok = await confirm(`Claude wants to open a URL:\n\n${label}\n\n${artifact.url}`);
  send({ type: 'url_response', requestId: artifact.requestId, opened: ok });
  if (ok) {
    window.open(artifact.url, '_blank', 'noopener,noreferrer');
  }
}

async function handlePermissionRequest(artifact) {
  const { toolName, input, requestId } = artifact;
  let inputPreview;
  try {
    inputPreview = JSON.stringify(input, null, 2);
  } catch {
    inputPreview = String(input);
  }
  // Cap the preview so a giant tool input doesn't blow up the modal.
  if (inputPreview.length > 2000) {
    inputPreview = inputPreview.slice(0, 2000) + '\n… (truncated)';
  }

  const allow = await confirm(
    `Claude wants to use a tool:\n\n${toolName}\n\n${inputPreview}\n\nAllow this tool call?`
  );

  send({
    type: 'permission_response',
    requestId,
    allow,
    message: allow ? undefined : 'User denied via Sublight UI',
  });
}

document.getElementById('btn-retry').addEventListener('click', () => {
  const session = state.sessions.get(state.activeId);
  if (!session || session.status === 'busy' || !session.lastUserTurn) return;
  const { text, attachments } = session.lastUserTurn;
  // Append as a fresh user turn and dispatch — Claude will produce a new
  // response from its current context rather than rewinding.
  appendUserMessage(session, text, attachments);
  send({ type: 'message', sessionId: state.activeId, text, attachments });
  session.status = 'busy';
  updateStatusUI();
});

document.getElementById('btn-artifacts').addEventListener('click', () => {
  state.artifactsVisible = !state.artifactsVisible;
  $artifactsPanel.classList.toggle('hidden', !state.artifactsVisible);
  if (state.artifactsVisible) renderArtifacts();
});

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ---------------------------------------------------------------------------
// New Session dialog with folder autocomplete
// ---------------------------------------------------------------------------

const $dialog       = document.getElementById('new-session-dialog');
const $dialogCwd    = document.getElementById('session-cwd');
const $cwdSuggest   = document.getElementById('cwd-suggestions');
const RECENT_KEY    = 'sublight_recent_dirs';
const MAX_RECENTS   = 10;

function getRecentDirs() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch { return []; }
}

function addRecentDir(dir) {
  let recents = getRecentDirs().filter(d => d !== dir);
  recents.unshift(dir);
  if (recents.length > MAX_RECENTS) recents.length = MAX_RECENTS;
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
}

function getSessionDirs() {
  const dirs = new Set();
  for (const s of state.sessions.values()) {
    if (s.cwd) dirs.add(s.cwd);
  }
  return [...dirs];
}

let cwdDebounce = null;
let cwdHighlight = -1;

function showSuggestions(items) {
  $cwdSuggest.replaceChildren();
  cwdHighlight = -1;
  if (items.length === 0) {
    $cwdSuggest.classList.add('hidden');
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item.path;
    if (item.tag) {
      const tag = document.createElement('span');
      tag.className = 'suggest-tag';
      tag.textContent = item.tag;
      li.appendChild(tag);
    }
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur
      $dialogCwd.value = item.path;
      $cwdSuggest.classList.add('hidden');
      // If selected a dir, trigger another browse to show children
      requestBrowse(item.path + '/');
    });
    $cwdSuggest.appendChild(li);
  }
  $cwdSuggest.classList.remove('hidden');
}

function buildLocalSuggestions(input) {
  const lower = input.toLowerCase();
  const items = [];

  // Open session dirs
  for (const dir of getSessionDirs()) {
    if (dir.toLowerCase().includes(lower)) {
      items.push({ path: dir, tag: 'open' });
    }
  }

  // Recent dirs (skip duplicates with open sessions)
  const openSet = new Set(getSessionDirs());
  for (const dir of getRecentDirs()) {
    if (!openSet.has(dir) && dir.toLowerCase().includes(lower)) {
      items.push({ path: dir, tag: 'recent' });
    }
  }

  return items;
}

function requestBrowse(input) {
  if (!input.trim()) {
    showSuggestions(buildLocalSuggestions(''));
    return;
  }
  // Show local matches immediately, then augment with filesystem results
  send({ type: 'browse_dir', path: input });
}

// dir_listing responses from the server are handled in handleServerMessage's
// main switch. No interception needed here.

$dialogCwd.addEventListener('input', () => {
  clearTimeout(cwdDebounce);
  cwdDebounce = setTimeout(() => requestBrowse($dialogCwd.value), 150);
});

$dialogCwd.addEventListener('focus', () => {
  if (!$dialogCwd.value.trim()) {
    showSuggestions(buildLocalSuggestions(''));
  }
});

$dialogCwd.addEventListener('blur', () => {
  // Delay to allow mousedown on suggestions to fire
  setTimeout(() => $cwdSuggest.classList.add('hidden'), 200);
});

$dialogCwd.addEventListener('keydown', (e) => {
  const items = $cwdSuggest.querySelectorAll('li');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cwdHighlight = Math.min(cwdHighlight + 1, items.length - 1);
    items.forEach((li, i) => li.classList.toggle('highlighted', i === cwdHighlight));
    items[cwdHighlight]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cwdHighlight = Math.max(cwdHighlight - 1, 0);
    items.forEach((li, i) => li.classList.toggle('highlighted', i === cwdHighlight));
    items[cwdHighlight]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Tab' || (e.key === 'Enter' && cwdHighlight >= 0)) {
    if (cwdHighlight >= 0 && items[cwdHighlight]) {
      e.preventDefault();
      const text = items[cwdHighlight].childNodes[0].textContent;
      $dialogCwd.value = text;
      $cwdSuggest.classList.add('hidden');
      requestBrowse(text + '/');
    }
  }
});

function openNewSessionDialog() {
  $dialogCwd.value = state.defaultCwd || '';
  document.getElementById('session-bypass').checked = state.defaultPermissionMode === 'bypass';
  $cwdSuggest.classList.add('hidden');
  $dialog.showModal();
  $dialogCwd.focus();
  $dialogCwd.select();
}

document.getElementById('new-session-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cwd = $dialogCwd.value.trim();
  if (!cwd) return;
  addRecentDir(cwd);
  const bypass = document.getElementById('session-bypass').checked;
  // Parse the Allowed tools field into an array, respecting quoted segments
  // like `"Bash(git log *)"` so Claude gets the full pattern as one entry.
  const allowedRaw = document.getElementById('session-allowed-tools').value.trim();
  const allowedTools = allowedRaw
    ? (allowedRaw.match(/"[^"]+"|\S+/g) || []).map((s) => s.replace(/^"|"$/g, ''))
    : null;
  send({
    type: 'new_session',
    cwd,
    permissionMode: bypass ? 'bypass' : 'default',
    allowedTools: allowedTools && allowedTools.length ? allowedTools : undefined,
  });
  $dialog.close();
});

document.getElementById('dialog-cancel').addEventListener('click', () => {
  $dialog.close();
});

document.getElementById('btn-new-session').addEventListener('click', openNewSessionDialog);
document.getElementById('btn-new-session-empty').addEventListener('click', openNewSessionDialog);

// ---------------------------------------------------------------------------
// File attachments — upload, paste, drag-and-drop
// ---------------------------------------------------------------------------

const $attachBar = document.getElementById('attachments-bar');
const $fileInput = document.getElementById('file-input');
const $btnAttach = document.getElementById('btn-attach');

/** Array of { file: File, dataUrl: string, base64: string, mediaType: string } */
const pendingAttachments = [];

$btnAttach.addEventListener('click', () => $fileInput.click());

$fileInput.addEventListener('change', () => {
  for (const file of $fileInput.files) {
    addAttachment(file);
  }
  $fileInput.value = '';
});

// Paste handler (screenshots from clipboard)
$promptInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addAttachment(file);
    }
  }
});

// Drag and drop on messages area
$messages.addEventListener('dragover', (e) => {
  e.preventDefault();
  $messages.classList.add('drag-over');
});

$messages.addEventListener('dragleave', () => {
  $messages.classList.remove('drag-over');
});

$messages.addEventListener('drop', (e) => {
  e.preventDefault();
  $messages.classList.remove('drag-over');
  for (const file of e.dataTransfer.files) {
    addAttachment(file);
  }
});

function addAttachment(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    // Extract base64 and media type
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return;
    const [, mediaType, base64] = match;

    const attachment = { file, dataUrl, base64, mediaType };
    pendingAttachments.push(attachment);
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function removeAttachment(index) {
  pendingAttachments.splice(index, 1);
  renderAttachments();
}

function renderAttachments() {
  $attachBar.replaceChildren();
  if (pendingAttachments.length === 0) {
    $attachBar.classList.add('hidden');
    return;
  }
  $attachBar.classList.remove('hidden');

  pendingAttachments.forEach((att, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';

    if (att.mediaType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      thumb.appendChild(img);
    } else {
      const label = document.createElement('div');
      label.className = 'file-label';
      label.textContent = att.file.name;
      thumb.appendChild(label);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => removeAttachment(i));
    thumb.appendChild(removeBtn);

    $attachBar.appendChild(thumb);
  });
}

function consumeAttachments() {
  if (pendingAttachments.length === 0) return null;
  const content = pendingAttachments.map(att => {
    if (att.mediaType.startsWith('image/')) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: att.mediaType, data: att.base64 },
      };
    }
    // For text files, decode and include as text
    try {
      const text = atob(att.base64);
      return { type: 'text', text: `[File: ${att.file.name}]\n${text}` };
    } catch {
      return { type: 'text', text: `[File: ${att.file.name}] (binary, ${att.file.size} bytes)` };
    }
  });
  pendingAttachments.length = 0;
  renderAttachments();
  return content;
}

// ---------------------------------------------------------------------------
// Boot — check for first-run setup, then auth
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const res = await fetch('/api/setup-status');
    const data = await res.json();

    if (data.setupRequired) {
      showSetupScreen(data.token, data.settings);
      return;
    }

    state.authRequired = data.authRequired;
  } catch {
    // Fallback: server may not support setup-status yet
    try {
      const res = await fetch('/auth-status');
      const data = await res.json();
      state.authRequired = data.required;
    } catch {
      state.authRequired = false;
    }
  }

  if (state.authRequired && !state.authToken) {
    showAuthScreen();
  } else {
    hideAuthScreen();
    connect();
  }
}

// ---------------------------------------------------------------------------
// Command palette — Ctrl+K quick switcher over live sessions + resumable logs
// ---------------------------------------------------------------------------

const $paletteDialog = document.getElementById('palette-dialog');
const $paletteInput = document.getElementById('palette-input');
const $paletteList = document.getElementById('palette-list');
let paletteItems = [];
let paletteSelected = 0;

async function openCommandPalette() {
  // Build an item list: open sessions first, then the resumable logs fetch.
  const items = [];
  for (const session of state.sessions.values()) {
    items.push({
      kind: 'session',
      id: session.id,
      label: session.name || shortCwd(session.cwd) || 'Session',
      detail: session.cwd,
      busy: session.status === 'busy',
    });
  }
  items.push({ kind: 'action', id: 'new', label: 'New session…', detail: 'Ctrl+N' });

  // Kick off the logs fetch in the background so the palette opens immediately.
  // The resumable rows get appended when it lands.
  paletteItems = items;
  paletteSelected = 0;
  $paletteInput.value = '';
  renderPaletteList();
  $paletteDialog.showModal();
  $paletteInput.focus();

  try {
    const res = await authFetch('/api/logs');
    if (!res.ok) return;
    const data = await res.json();
    const resumables = data.logs
      .filter((l) => l.resumable)
      .slice(0, 20)
      .map((l) => ({
        kind: 'resume',
        id: l.id,
        label: l.sessionName || shortPath(l.cwd) || l.id.slice(0, 8),
        detail: `resume · ${l.cwd}`,
        log: l,
      }));
    paletteItems = [...items, ...resumables];
    renderPaletteList();
  } catch (err) {
    console.error('palette log fetch failed', err);
  }
}

function renderPaletteList() {
  const q = $paletteInput.value.trim().toLowerCase();
  const filtered = q
    ? paletteItems.filter((i) =>
        (i.label + ' ' + (i.detail || '')).toLowerCase().includes(q),
      )
    : paletteItems;
  paletteSelected = Math.min(paletteSelected, Math.max(0, filtered.length - 1));

  $paletteList.replaceChildren();
  filtered.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'palette-item';
    if (i === paletteSelected) li.classList.add('active');
    const tag = document.createElement('span');
    tag.className = 'palette-tag palette-tag-' + item.kind;
    tag.textContent = item.kind;
    li.appendChild(tag);
    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = item.label;
    li.appendChild(label);
    if (item.detail) {
      const detail = document.createElement('span');
      detail.className = 'palette-detail';
      detail.textContent = item.detail;
      li.appendChild(detail);
    }
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      activatePaletteItem(item);
    });
    $paletteList.appendChild(li);
  });
  $paletteList.dataset.filtered = JSON.stringify(filtered.map((_, i) => i));
}

function activatePaletteItem(item) {
  $paletteDialog.close();
  if (item.kind === 'session') {
    switchSession(item.id);
  } else if (item.kind === 'resume') {
    resumeLog(item.log);
  } else if (item.kind === 'action' && item.id === 'new') {
    openNewSessionDialog();
  }
}

$paletteInput.addEventListener('input', () => {
  paletteSelected = 0;
  renderPaletteList();
});

$paletteInput.addEventListener('keydown', (e) => {
  const q = $paletteInput.value.trim().toLowerCase();
  const filtered = q
    ? paletteItems.filter((i) => (i.label + ' ' + (i.detail || '')).toLowerCase().includes(q))
    : paletteItems;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteSelected = (paletteSelected + 1) % Math.max(1, filtered.length);
    renderPaletteList();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSelected = (paletteSelected - 1 + filtered.length) % Math.max(1, filtered.length);
    renderPaletteList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (filtered[paletteSelected]) activatePaletteItem(filtered[paletteSelected]);
  }
});

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------
//
// - Ctrl/Cmd+N        new session dialog
// - Ctrl/Cmd+/        show shortcut hint toast
// - Escape            close the top open <dialog>, or focus the composer
//
// We do NOT hijack shortcuts when the user is typing into the composer or
// into a dialog input, unless it's a modifier combo we explicitly own.

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const target = e.target;
  const typingInField =
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  if (mod && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    openNewSessionDialog();
    return;
  }

  if (mod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  if (mod && e.key === '/') {
    e.preventDefault();
    showToast('Shortcuts: Ctrl+K switch · Ctrl+N new · Ctrl+Enter send · Esc focus composer');
    return;
  }

  if (e.key === 'Escape') {
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog) {
      openDialog.close();
      return;
    }
    if (!typingInField && $promptInput && !$promptInput.disabled) {
      e.preventDefault();
      $promptInput.focus();
    }
  }
});

// ---------------------------------------------------------------------------
// Mobile sidebar drawer
// ---------------------------------------------------------------------------
// On narrow screens the sidebar is hidden by default and opens as a slide-in
// drawer over the chat area. The scrim is a tappable backdrop that closes it.

const $mobileNavBtn = document.getElementById('btn-mobile-nav');
const $mobileScrim = document.getElementById('mobile-scrim');
const $sidebarEl = document.getElementById('sidebar');

function openMobileSidebar() {
  $sidebarEl.classList.add('mobile-open');
  $mobileScrim.classList.add('visible');
}

function closeMobileSidebar() {
  $sidebarEl.classList.remove('mobile-open');
  $mobileScrim.classList.remove('visible');
}

$mobileNavBtn.addEventListener('click', openMobileSidebar);
$mobileScrim.addEventListener('click', closeMobileSidebar);

// Tapping a session in the sidebar on mobile should also close the drawer —
// we delegate via event bubbling since the list items are rendered dynamically.
$sidebarEl.addEventListener('click', (e) => {
  if (window.matchMedia('(max-width: 768px)').matches && e.target.closest('#session-list li')) {
    closeMobileSidebar();
  }
});

boot();
