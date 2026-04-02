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
  $setupToken.textContent = token;

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

document.getElementById('settings-cancel').addEventListener('click', () => {
  $settingsDialog.close();
});

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const security = {
    scopeFilesToSession: document.getElementById('setting-scope-files').checked,
    serveSvg: !document.getElementById('setting-no-svg').checked,
    maxSessions: parseInt(document.getElementById('setting-max-sessions').value) || 10,
    defaultPermissionMode: document.getElementById('setting-default-perms').checked ? 'default' : 'bypass',
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

async function loadLogsList() {
  try {
    const res = await authFetch('/api/logs');
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('logs-storage').textContent = `${data.logs.length} logs \u00b7 ${formatBytes(data.totalSize)}`;

    $logsList.replaceChildren();
    if (data.logs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'logs-empty';
      empty.textContent = 'No session logs yet.';
      $logsList.appendChild(empty);
      return;
    }

    for (const log of data.logs) {
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
  } catch (err) {
    console.error('Failed to load logs:', err);
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
        costUsd: null,
      };
      state.sessions.set(msg.sessionId, session);
      switchSession(msg.sessionId);
      renderSidebar();
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

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        session.name = shortCwd(event.cwd || session.cwd);
        if (isActive) $chatTitle.textContent = session.name;
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
            session.messages.push({ role: 'thinking', text: block.thinking });
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
            session.messages.push({ role: 'tool', name: block.name, input: block.input, result: null, id: block.id });
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
            session.messages.push({ role: 'assistant', text: event.result });
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

function ensureStreamingEl(session) {
  if (session.streamingEl) return;
  const el = document.createElement('div');
  el.className = 'msg msg-assistant streaming';
  $messages.appendChild(el);
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
  session.messages.push({ role: 'assistant', text: session.streamingText });
  session.streamingEl = null;
  session.streamingText = '';
}

// ---------------------------------------------------------------------------
// Thinking cards
// ---------------------------------------------------------------------------

function appendThinking(session, text) {
  const details = document.createElement('details');
  details.className = 'thinking-card';
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'thinking-body';
  body.textContent = text;
  details.appendChild(body);
  $messages.appendChild(details);
  session.messages.push({ role: 'thinking', text });
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Tool-use cards
// ---------------------------------------------------------------------------

function appendToolUse(session, block) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  const summary = document.createElement('summary');
  summary.textContent = block.name;
  details.appendChild(summary);
  const inputBody = document.createElement('div');
  inputBody.className = 'tool-body';
  inputBody.textContent = typeof block.input === 'string'
    ? block.input
    : JSON.stringify(block.input, null, 2);
  details.appendChild(inputBody);
  const resultBody = document.createElement('div');
  resultBody.className = 'tool-body';
  resultBody.style.display = 'none';
  details.appendChild(resultBody);
  $messages.appendChild(details);
  session.pendingToolCards.set(block.id, { details, resultBody });
  session.messages.push({ role: 'tool', name: block.name, input: block.input, result: null, id: block.id });
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
    $messages.appendChild(el);
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

  $messages.replaceChildren();
  for (const msg of session.messages) {
    switch (msg.role) {
      case 'user': {
        const el = document.createElement('div');
        el.className = 'msg msg-user';
        el.textContent = msg.text;
        $messages.appendChild(el);
        break;
      }
      case 'assistant': {
        const el = document.createElement('div');
        el.className = 'msg msg-assistant';
        setMarkdownContent(el, msg.text);
        $messages.appendChild(el);
        break;
      }
      case 'thinking': {
        const details = document.createElement('details');
        details.className = 'thinking-card';
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking';
        details.appendChild(summary);
        const body = document.createElement('div');
        body.className = 'thinking-body';
        body.textContent = msg.text;
        details.appendChild(body);
        $messages.appendChild(details);
        break;
      }
      case 'tool': {
        const details = document.createElement('details');
        details.className = 'tool-card';
        const summary = document.createElement('summary');
        summary.textContent = msg.name;
        details.appendChild(summary);
        const inputBody = document.createElement('div');
        inputBody.className = 'tool-body';
        inputBody.textContent = typeof msg.input === 'string'
          ? msg.input
          : JSON.stringify(msg.input, null, 2);
        details.appendChild(inputBody);
        if (msg.result != null) {
          const resultBody = document.createElement('div');
          resultBody.className = 'tool-body';
          resultBody.textContent = msg.result;
          details.appendChild(resultBody);
        }
        $messages.appendChild(details);
        break;
      }
      case 'error': {
        const el = document.createElement('div');
        el.className = 'msg msg-error';
        el.textContent = msg.text;
        $messages.appendChild(el);
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

function updateStatusUI() {
  const session = state.sessions.get(state.activeId);
  if (!session) return;

  const busy = session.status === 'busy';
  $btnSend.classList.toggle('hidden', busy);
  $btnAbort.classList.toggle('hidden', !busy);
  $promptInput.disabled = busy;

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

$btnAbort.addEventListener('click', () => {
  if (state.activeId) {
    send({ type: 'abort', sessionId: state.activeId });
  }
});

// ---------------------------------------------------------------------------
// Save session as markdown
// ---------------------------------------------------------------------------

document.getElementById('btn-save').addEventListener('click', () => {
  const session = state.sessions.get(state.activeId);
  if (!session) return;

  let md = `# Session: ${session.name}\n`;
  md += `> cwd: ${session.cwd}\n`;
  if (session.costUsd != null) md += `> cost: $${session.costUsd.toFixed(4)}\n`;
  md += `> exported: ${new Date().toISOString()}\n\n---\n\n`;

  for (const msg of session.messages) {
    switch (msg.role) {
      case 'user':
        md += `## User\n\n${msg.text}\n\n`;
        break;
      case 'assistant':
        md += `## Assistant\n\n${msg.text}\n\n`;
        break;
      case 'thinking':
        md += `<details><summary>Thinking</summary>\n\n${msg.text}\n\n</details>\n\n`;
        break;
      case 'tool':
        md += `### Tool: ${msg.name}\n\n\`\`\`json\n${typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input, null, 2)}\n\`\`\`\n\n`;
        if (msg.result != null) md += `**Result:**\n\`\`\`\n${msg.result}\n\`\`\`\n\n`;
        break;
      case 'error':
        md += `> **Error:** ${msg.text}\n\n`;
        break;
    }
  }

  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${session.name || 'session'}-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
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
    card.appendChild(title);
    const pre = document.createElement('pre');
    pre.className = 'diff-content';
    // Color diff lines
    for (const line of artifact.diff.split('\n')) {
      const span = document.createElement('span');
      span.textContent = line + '\n';
      if (line.startsWith('+') && !line.startsWith('+++')) {
        span.className = 'diff-add';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
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

// Handle dir_listing responses from server
const originalHandler = handleServerMessage;
handleServerMessage = function(msg) {
  if (msg.type === 'dir_listing') {
    const input = $dialogCwd.value;
    const local = buildLocalSuggestions(input);
    const localPaths = new Set(local.map(i => i.path));
    const fs = (msg.entries || [])
      .filter(p => !localPaths.has(p))
      .map(p => ({ path: p, tag: null }));
    showSuggestions([...local, ...fs].slice(0, 15));
    return;
  }
  originalHandler(msg);
};

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
  send({ type: 'new_session', cwd, permissionMode: bypass ? 'bypass' : 'default' });
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

boot();
