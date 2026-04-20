/* ================================================================
   Sublight WebUI — Frontend
   ================================================================ */

import { handleOpenUrl, handlePin, handleProgress, renderArtifacts } from './artifacts.js';
import { consumeAttachments } from './attachments.js';
import { authFetch, isTokenRemembered, saveAuthToken } from './auth.js';
import {
  getNotificationPermission,
  isNotificationsSupported,
  loadNotificationPref,
  requestNotificationPermission,
  saveNotificationPref,
  showSessionNotification,
} from './notifications.js';
import { confirm } from './confirm.js';
import { downloadBlob } from './export.js';
import { setMarkdownContent } from './markdown.js';
import { renderNotes, removeSessionNotes } from './notes.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { connect, send } from './ws.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $sidebar       = document.getElementById('session-list');
const $emptyState    = document.getElementById('empty-state');
const $chatArea      = document.getElementById('chat-area');
const $chatTitle     = document.getElementById('chat-title');
const $chatStatus    = document.getElementById('chat-status');
const $btnCopyCwd    = document.getElementById('btn-copy-cwd');
const $chatRuntime   = document.getElementById('chat-runtime');
const $messages      = document.getElementById('messages');
const $inputBar      = document.getElementById('input-bar');
const $promptInput   = document.getElementById('prompt-input');
const $btnSend       = document.getElementById('btn-send');
const $btnAbort      = document.getElementById('btn-abort');
const $queueBar      = document.getElementById('queue-bar');
const $statusStrip   = document.getElementById('status-strip');
const $authScreen    = document.getElementById('auth-screen');
const $authForm      = document.getElementById('auth-form');
const $authToken     = document.getElementById('auth-token');
const $authError     = document.getElementById('auth-error');
const $appShell      = document.getElementById('app-shell');
const $artifactsPanel = document.getElementById('artifacts-panel');
const $setupScreen    = document.getElementById('setup-screen');
const $setupToken     = document.getElementById('setup-token');
const $settingsDialog = document.getElementById('settings-dialog');

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
  const remember = document.getElementById('auth-remember').checked;
  state.authToken = token;
  saveAuthToken(token, remember);
  $authError.textContent = '';
  hideAuthScreen();
  startWebSocket();
});

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

/** Generate a fresh random token in the browser. 32 hex chars (128 bits). */
function generateSetupToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function showSetupScreen(token, securityDefaults) {
  // Close any dialogs that may have been opened before boot() finished
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  $setupScreen.classList.remove('hidden');
  $appShell.classList.add('hidden');
  $authScreen.classList.add('hidden');

  const tokenHint = document.getElementById('setup-token-console-hint');
  if (token) {
    // Loopback setup: prefill so the user can just accept, or edit/paste their
    // own value (e.g. one their password manager generated).
    $setupToken.value = token;
    $setupToken.disabled = false;
    tokenHint.hidden = true;
  } else {
    // Remote setup: the server won't reveal the token over the network, so
    // the user must copy it from the server console.
    $setupToken.value = '';
    $setupToken.placeholder = 'Paste the token from the server console';
    $setupToken.disabled = false;
    tokenHint.hidden = false;
  }

  document.getElementById('setup-scope-files').checked = securityDefaults.scopeFilesToSession;
  document.getElementById('setup-no-svg').checked = !securityDefaults.serveSvg;
  document.getElementById('setup-default-perms').checked = securityDefaults.defaultPermissionMode === 'default';
  document.getElementById('setup-max-sessions').value = securityDefaults.maxSessions;
}

document.getElementById('btn-setup-token-reveal').addEventListener('click', () => {
  $setupToken.type = $setupToken.type === 'password' ? 'text' : 'password';
});

document.getElementById('btn-setup-token-regen').addEventListener('click', () => {
  $setupToken.value = generateSetupToken();
  $setupToken.type = 'text';
});

document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const token = $setupToken.value.trim();
  if (!token) {
    showToast('Pick a token before continuing');
    $setupToken.focus();
    return;
  }

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
      body: JSON.stringify({ token, security }),
    });
    const data = await res.json();
    if (data.ok) {
      const remember = document.getElementById('setup-remember').checked;
      state.authToken = data.token;
      state.authRequired = true;
      saveAuthToken(data.token, remember);
      $setupScreen.classList.add('hidden');
      $appShell.classList.remove('hidden');
      startWebSocket();
    } else {
      showToast(data.error || 'Setup failed');
    }
  } catch (err) {
    console.error('Setup failed:', err);
    showToast('Setup failed — see console');
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

    refreshNotificationsSetting();

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
// Desktop notifications toggle
// ---------------------------------------------------------------------------

const $settingNotifications = document.getElementById('setting-notifications');
const $settingNotificationsHint = document.getElementById('setting-notifications-hint');

function refreshNotificationsSetting() {
  const supported = isNotificationsSupported();
  const permission = getNotificationPermission();
  const enabled = supported && permission === 'granted' && loadNotificationPref();

  $settingNotifications.checked = enabled;
  $settingNotifications.disabled = !supported || permission === 'denied';

  if (!supported) {
    $settingNotificationsHint.textContent = 'This browser does not support desktop notifications.';
  } else if (permission === 'denied') {
    $settingNotificationsHint.textContent = 'Blocked by the browser — unblock notifications for this site, then try again.';
  } else if (permission === 'default') {
    $settingNotificationsHint.textContent = enabled ? '' : 'Enabling will ask for permission.';
  } else {
    $settingNotificationsHint.textContent = enabled ? 'Enabled — you will be notified when background sessions finish.' : '';
  }
}

$settingNotifications.addEventListener('change', async () => {
  if ($settingNotifications.checked) {
    const result = await requestNotificationPermission();
    if (result !== 'granted') {
      $settingNotifications.checked = false;
      saveNotificationPref(false);
      showToast(result === 'denied' ? 'Notifications blocked by browser' : 'Notifications not enabled');
      refreshNotificationsSetting();
      return;
    }
    saveNotificationPref(true);
  } else {
    saveNotificationPref(false);
  }
  refreshNotificationsSetting();
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
    'The new token takes effect immediately. Other browser tabs using the old ' +
    'token will need to reconnect with the new one.'
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
    state.authToken = data.token;
    // Preserve the user's existing choice of persistence — if they opted to
    // remember, the new token replaces the old in localStorage; otherwise it
    // stays session-only.
    saveAuthToken(data.token, isTokenRemembered());
    showToast('Token regenerated');
  } catch (err) {
    console.error('Failed to regenerate token:', err);
  }
});

document.getElementById('settings-cancel').addEventListener('click', () => {
  $settingsDialog.close();
});

document.getElementById('btn-shutdown').addEventListener('click', async () => {
  $settingsDialog.close();
  if (!await confirm('Shut down the Sublight server? All sessions will be terminated.')) return;
  try {
    await authFetch('/api/shutdown', { method: 'POST' });
  } catch { /* connection will drop */ }
  document.body.textContent = 'Server shut down.';
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

    if (entry.type === 'session_imported') {
      session.imported = true;
      continue;
    }

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
      const transient = ['notification', 'open_url', 'progress', 'set_session_name', 'pin'];
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
// Claude Code session import picker
// ---------------------------------------------------------------------------

const $claudeImportDialog = document.getElementById('claude-import-dialog');
const $claudeImportList   = document.getElementById('claude-import-list');
const $claudeImportFilter = document.getElementById('claude-import-filter');
const $claudeImportBypass = document.getElementById('claude-import-bypass');
const $claudeImportCount  = document.getElementById('claude-import-count');

let cachedClaudeSessions = [];

document.getElementById('btn-open-claude-import').addEventListener('click', () => {
  // Close the logs dialog first so the import picker doesn't stack on top of it.
  if ($logsDialog.open) $logsDialog.close();
  openClaudeImportDialog();
});
document.getElementById('claude-import-close').addEventListener('click', () => $claudeImportDialog.close());
$claudeImportFilter.addEventListener('input', renderClaudeImportList);

async function openClaudeImportDialog() {
  cachedClaudeSessions = [];
  $claudeImportCount.textContent = 'loading…';
  $claudeImportList.replaceChildren();
  $claudeImportDialog.showModal();
  try {
    const res = await authFetch('/api/claude-code-sessions');
    if (!res.ok) {
      $claudeImportCount.textContent = 'failed to load';
      const err = document.createElement('p');
      err.className = 'logs-empty';
      err.textContent = `Failed to list sessions (HTTP ${res.status}).`;
      $claudeImportList.appendChild(err);
      return;
    }
    const data = await res.json();
    cachedClaudeSessions = data.sessions || [];
    $claudeImportCount.textContent = `${cachedClaudeSessions.length} session${cachedClaudeSessions.length === 1 ? '' : 's'}`;
    renderClaudeImportList();
  } catch (err) {
    console.error('Failed to load Claude Code sessions', err);
    $claudeImportCount.textContent = 'failed to load';
  }
}

function renderClaudeImportList() {
  const q = ($claudeImportFilter.value || '').trim().toLowerCase();
  const filtered = q
    ? cachedClaudeSessions.filter((s) => {
        const hay = [s.cwd || '', s.sessionId, s.lastTurnAt || '', s.firstUserMessage || ''].join(' ').toLowerCase();
        return hay.includes(q);
      })
    : cachedClaudeSessions;

  $claudeImportList.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'logs-empty';
    empty.textContent = q ? `No sessions match "${q}".` : 'No Claude Code sessions found.';
    $claudeImportList.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const row = document.createElement('div');
    row.className = 'log-row';

    const info = document.createElement('div');
    info.className = 'log-info';

    const name = document.createElement('div');
    name.className = 'log-name';
    name.textContent = shortPath(s.cwd) || s.sessionId.slice(0, 8);
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    const parts = [formatLogDate(s.lastTurnAt)];
    parts.push(formatBytes(s.sizeBytes));
    parts.push(s.sessionId.slice(0, 8));
    meta.textContent = parts.join(' \u00b7 ');
    info.appendChild(meta);

    if (s.firstUserMessage) {
      const snippet = document.createElement('div');
      snippet.className = 'log-meta';
      snippet.textContent = s.firstUserMessage.length > 120
        ? s.firstUserMessage.slice(0, 119) + '\u2026'
        : s.firstUserMessage;
      info.appendChild(snippet);
    }

    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'log-actions';

    if (s.live) {
      const liveTag = document.createElement('span');
      liveTag.className = 'log-tag';
      liveTag.textContent = 'live';
      actions.appendChild(liveTag);
    } else if (!s.cwd) {
      const tag = document.createElement('span');
      tag.className = 'log-tag';
      tag.textContent = 'no cwd';
      tag.title = 'No working directory found in the transcript — cannot import';
      actions.appendChild(tag);
    } else {
      const resumeBtn = document.createElement('button');
      resumeBtn.textContent = 'Resume';
      resumeBtn.title = 'Spawn claude --resume with the current Sublight settings';
      resumeBtn.addEventListener('click', () => resumeClaudeSession(s));
      actions.appendChild(resumeBtn);
    }

    row.appendChild(actions);
    $claudeImportList.appendChild(row);
  }
}

function resumeClaudeSession(s) {
  if (!s.cwd) {
    showToast('No cwd recorded for this session');
    return;
  }
  const bypass = $claudeImportBypass.checked;
  send({
    type: 'import_claude_session',
    claudeSessionId: s.sessionId,
    cwd: s.cwd,
    permissionMode: bypass ? 'bypass' : state.defaultPermissionMode,
    // Non-bypass mode requires an allowedTools list to avoid hanging. For
    // simplicity we always go bypass here since the user is resuming an
    // interactive CLI session that was using full permissions anyway.
    allowedTools: bypass ? null : ['Read', 'Glob', 'Grep'],
  });
  $claudeImportDialog.close();
}

// ---------------------------------------------------------------------------
// WebSocket connection with exponential backoff
// ---------------------------------------------------------------------------

function startWebSocket() {
  connect({
    onMessage: handleServerMessage,
    onAuthFailed: () => {
      $authError.textContent = 'Invalid token. Please try again.';
      showAuthScreen();
    },
  });
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
        hasUnread: false,
        imported: false,
        streamingEl: null,
        streamingText: '',
        pendingToolCards: new Map(),
        // Map of tool_use_id → container element. When an event carries
        // parent_tool_use_id, new child elements append into that parent's
        // container instead of the top-level #messages. Supports arbitrary
        // nesting depth (a Task subagent can spawn another Task).
        toolContainers: new Map(),
        costUsd: null,
        queue: [],
        // Status-strip tracking: turnStartedAt is when stream_start arrived,
        // lastStreamAt is when the most recent text chunk landed, and
        // outstandingTools maps tool_use_id → { name, startedAt } until the
        // matching tool_result fills it.
        turnStartedAt: 0,
        lastStreamAt: 0,
        outstandingTools: new Map(),
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
        hasUnread: false,
        // imported sessions come from the Claude CLI transcript store, so there's
        // no Sublight NDJSON to replay — only the new notice is rendered.
        imported: !!msg.imported,
        streamingEl: null,
        streamingText: '',
        pendingToolCards: new Map(),
        toolContainers: new Map(),
        costUsd: null,
        queue: [],
        turnStartedAt: 0,
        lastStreamAt: 0,
        outstandingTools: new Map(),
      };
      state.sessions.set(msg.sessionId, session);
      switchSession(msg.sessionId);
      renderSidebar();
      if (!session.imported) {
        // Pull the NDJSON log and replay it into the chat/artifact state. This
        // reuses the already-authenticated logs endpoint — no new protocol.
        rehydrateSessionFromLog(msg.sessionId).catch((err) => {
          console.error('Failed to rehydrate session', err);
          appendError(session, `Failed to rehydrate chat history: ${err.message}`);
        });
      }
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
          hasUnread: !!s.unread,
          // rehydrateSessionFromLog flips this to true when it sees the
          // session_imported marker at the head of the log.
          imported: false,
          streamingEl: null,
          streamingText: '',
          pendingToolCards: new Map(),
          toolContainers: new Map(),
          costUsd: null,
          queue: [],
          turnStartedAt: 0,
          lastStreamAt: 0,
          outstandingTools: new Map(),
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
      // A reattached session may already be busy — spin up the ticker if so.
      if ([...state.sessions.values()].some((s) => s.status === 'busy')) {
        startStatusTicker();
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
        s.turnStartedAt = Date.now();
        s.lastStreamAt = 0;
        s.outstandingTools.clear();
      }
      updateStatusUI();
      renderSidebar();
      startStatusTicker();
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
        s.outstandingTools.clear();
        if (msg.stderr) appendError(s, msg.stderr);
        if (state.activeId !== s.id) {
          s.hasUnread = true;
        } else {
          // Currently viewing — keep server's unread flag in sync so a
          // reconnect after this turn doesn't resurrect a stale dot.
          send({ type: 'mark_read', sessionId: s.id });
        }
        maybeNotifyIdle(s, msg.stderr);
      }
      updateStatusUI();
      renderSidebar();
      maybeStopStatusTicker();
      if (s) drainQueue(s);
      break;
    }

    case 'error': {
      const s = msg.sessionId ? state.sessions.get(msg.sessionId) : null;
      if (s) {
        appendError(s, msg.message);
        s.status = 'idle';
        s.outstandingTools.clear();
        if (state.activeId !== s.id) {
          s.hasUnread = true;
        } else {
          send({ type: 'mark_read', sessionId: s.id });
        }
        maybeNotifyIdle(s, msg.message);
      } else {
        console.error('[server]', msg.message);
      }
      updateStatusUI();
      renderSidebar();
      maybeStopStatusTicker();
      if (s) drainQueue(s);
      break;
    }

    case 'session_closed': {
      state.sessions.delete(msg.sessionId);
      removeSessionNotes(msg.sessionId);
      if (state.activeId === msg.sessionId) {
        state.activeId = null;
        renderQueue(null);
      }
      renderSidebar();
      renderChat();
      break;
    }

    case 'session_restarted': {
      showToast('Claude process restarted — MCPs and settings reloaded');
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
          if (session.streamingText) finalizeStreaming(session);
          if (isActive) {
            appendThinking(session, block.thinking);
          } else {
            session.messages.push({ role: 'thinking', text: block.thinking, parentToolUseId: session.currentParentToolUseId || null });
          }
        }

        if (block.type === 'text' && block.text) {
          session.streamingText += block.text;
          session.lastStreamAt = Date.now();
          if (isActive) {
            ensureStreamingEl(session);
            renderStreamingText(session);
          }
        }

        if (block.type === 'tool_use') {
          if (session.streamingText) finalizeStreaming(session);
          session.outstandingTools.set(block.id, { name: block.name, startedAt: Date.now() });
          if (isActive) {
            appendToolUse(session, block);
          } else {
            session.messages.push({ role: 'tool', name: block.name, input: block.input, result: null, id: block.id, parentToolUseId: session.currentParentToolUseId || null });
          }
        }

        if (block.type === 'tool_result') {
          session.outstandingTools.delete(block.tool_use_id);
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

  // Keep the status strip snappy — the ticker updates it every 500ms for
  // elapsed counters, but state transitions (tool_use, tool_result) feel
  // laggy at that cadence. Re-render per event for the active session.
  if (isActive) renderStatusStrip(session);
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
  // The DOM bubble only exists when the session was active during streaming.
  // The accumulated text, however, must be flushed to session.messages
  // regardless — otherwise background turns finishing on an inactive tab
  // silently lose their assistant text (the text never makes it into the
  // array that renderChat replays from on switch-back).
  if (session.streamingEl) {
    session.streamingEl.classList.remove('streaming');
  }
  if (session.streamingText) {
    session.messages.push({
      role: 'assistant',
      text: session.streamingText,
      parentToolUseId: session.currentParentToolUseId || null,
    });
  }
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

// ---------------------------------------------------------------------------
// Message queue — lets the user type the next prompt while Claude is still
// working on the current one. Each queued item fires automatically as soon
// as the session goes idle (normal completion OR abort — we don't clear the
// queue on Stop, so the user can interrupt one bad turn without losing the
// next three). Click × on a chip to cancel one before it fires.
// ---------------------------------------------------------------------------

let queueIdCounter = 0;

function enqueueMessage(session, text, attachments) {
  const id = ++queueIdCounter;
  session.queue.push({ id, text, attachments: attachments || null });
  if (session.id === state.activeId) {
    renderQueue(session);
    renderStatusStrip(session);
  }
}

function removeQueuedItem(session, id) {
  session.queue = session.queue.filter((item) => item.id !== id);
  if (session.id === state.activeId) {
    renderQueue(session);
    renderStatusStrip(session);
  }
}

function renderQueue(session) {
  $queueBar.replaceChildren();
  if (!session || session.queue.length === 0) {
    $queueBar.classList.add('hidden');
    return;
  }
  $queueBar.classList.remove('hidden');
  for (const item of session.queue) {
    const chip = document.createElement('div');
    chip.className = 'queued-item';
    chip.title = item.text;

    const textEl = document.createElement('span');
    textEl.className = 'queued-text';
    textEl.textContent = item.text;
    chip.appendChild(textEl);

    if (item.attachments?.length) {
      const attachEl = document.createElement('span');
      attachEl.className = 'queued-attach';
      attachEl.textContent = `+${item.attachments.length}📎`;
      chip.appendChild(attachEl);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'queued-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove from queue';
    removeBtn.addEventListener('click', () => removeQueuedItem(session, item.id));
    chip.appendChild(removeBtn);

    $queueBar.appendChild(chip);
  }
}

// Called when a session flips from busy to idle. Pops the next queued item
// (if any) and sends it as if the user had just hit Ctrl+Enter. Fires
// regardless of whether the session is the active one — the user queued it
// expecting it to run.
function drainQueue(session) {
  if (!session || session.queue.length === 0) return;
  if (session.status !== 'idle') return;
  const next = session.queue.shift();
  if (session.id === state.activeId) {
    renderQueue(session);
    renderStatusStrip(session);
  }
  appendUserMessage(session, next.text, next.attachments);
  send({ type: 'message', sessionId: session.id, text: next.text, attachments: next.attachments });
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
  const session = state.sessions.get(id);
  if (session) {
    session.hasUnread = false;
    // Clear the server-side flag too so other tabs and future reconnects
    // don't see a stale unread. Idempotent server-side.
    send({ type: 'mark_read', sessionId: id });
  }
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
  $btnCopyCwd.title = session.cwd ? `Copy: ${session.cwd}` : 'No working directory';
  updateStatusUI();
  updateRuntimeStrip(session);
  renderQueue(session);

  $messages.replaceChildren();
  if (session.imported) {
    const notice = document.createElement('div');
    notice.className = 'imported-notice';
    notice.textContent = 'Imported from Claude Code. Prior conversation is loaded in Claude\u2019s memory but not shown here — send a message to continue.';
    $messages.appendChild(notice);
  }
  // Rebuild toolContainers from scratch — we're about to re-append every
  // message, and nested children resolve parents via this map.
  session.toolContainers = new Map();
  // Drop any stale streamingEl reference pointing at a detached DOM node
  // from a previous active period. The block further down will recreate a
  // fresh bubble if streaming is still in progress.
  session.streamingEl = null;

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
  // Send button stays visible even when busy — it queues the message for
  // delivery as soon as the current turn completes. The Stop button sits
  // alongside it so the user can still interrupt the in-flight turn.
  $btnSend.textContent = busy ? 'Queue' : 'Send';
  $btnSend.title = busy
    ? 'Queue for after current turn (Ctrl+Enter)'
    : 'Send (Ctrl+Enter)';
  $btnAbort.classList.toggle('hidden', !busy);
  $promptInput.disabled = false;
  // Retry is available only when idle and a prior user turn exists to resend.
  const retryBtn = document.getElementById('btn-retry');
  if (retryBtn) {
    retryBtn.classList.toggle('hidden', busy || !session.lastUserTurn);
  }
  renderStatusStrip(session);

  if (busy) {
    $chatStatus.textContent = '';
    const indicator = document.createElement('span');
    indicator.className = 'working-indicator';
    indicator.textContent = 'Working';
    const dots = document.createElement('span');
    dots.className = 'working-dots';
    for (let i = 0; i < 3; i++) { const d = document.createElement('span'); d.textContent = '.'; dots.appendChild(d); }
    indicator.appendChild(dots);
    $chatStatus.appendChild(indicator);
  } else if (session.costUsd != null) {
    $chatStatus.textContent = `$${session.costUsd.toFixed(4)}`;
  } else {
    $chatStatus.textContent = 'idle';
  }
}

// ---------------------------------------------------------------------------
// Status strip — the always-visible activity line above the composer
// ---------------------------------------------------------------------------

// Streaming is "fresh" if a text chunk landed within this many ms. Past that
// we consider the tokens stale and switch to the generic "Working" state,
// which usually means we're waiting on a tool call or subagent.
const STREAM_FRESH_MS = 1500;

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

function renderStatusStrip(session) {
  $statusStrip.replaceChildren();
  if (!session) {
    const dot = document.createElement('span');
    dot.className = 'status-dot idle';
    const label = document.createElement('span');
    label.className = 'status-label';
    label.textContent = 'No active session';
    $statusStrip.append(dot, label);
    return;
  }

  const now = Date.now();
  const busy = session.status === 'busy';

  const dot = document.createElement('span');
  dot.className = 'status-dot';
  $statusStrip.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'status-label';
  $statusStrip.appendChild(label);

  if (!busy) {
    dot.classList.add('idle');
    if (session.costUsd != null) {
      label.textContent = 'Ready';
      const meta = document.createElement('span');
      meta.className = 'status-meta';
      meta.textContent = `$${session.costUsd.toFixed(4)} last turn`;
      $statusStrip.appendChild(meta);
    } else {
      label.textContent = 'Ready';
    }
    if (session.queue?.length) {
      const meta = document.createElement('span');
      meta.className = 'status-meta';
      meta.textContent = `${session.queue.length} queued`;
      $statusStrip.appendChild(meta);
    }
    return;
  }

  // Busy. Decide the sub-state.
  const outstanding = session.outstandingTools;
  const latestTool = outstanding.size > 0
    ? [...outstanding.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
    : null;
  const streamingFresh = session.lastStreamAt
    && (now - session.lastStreamAt) < STREAM_FRESH_MS;

  if (latestTool) {
    dot.classList.add('tool');
    label.textContent = 'Running ';
    const toolEl = document.createElement('span');
    toolEl.className = 'status-tool';
    toolEl.textContent = latestTool.name;
    label.appendChild(toolEl);
    if (outstanding.size > 1) {
      const extra = document.createElement('span');
      extra.textContent = ` +${outstanding.size - 1} more`;
      extra.style.color = 'var(--text-dim)';
      label.appendChild(extra);
    }
    const elapsed = document.createElement('span');
    elapsed.className = 'status-elapsed';
    elapsed.textContent = formatElapsed(now - latestTool.startedAt);
    $statusStrip.appendChild(elapsed);
  } else if (streamingFresh) {
    dot.classList.add('streaming');
    label.textContent = 'Streaming response';
    const elapsed = document.createElement('span');
    elapsed.className = 'status-elapsed';
    elapsed.textContent = formatElapsed(now - session.turnStartedAt);
    $statusStrip.appendChild(elapsed);
  } else {
    dot.classList.add('waiting');
    label.textContent = 'Working';
    const elapsed = document.createElement('span');
    elapsed.className = 'status-elapsed';
    elapsed.textContent = formatElapsed(now - session.turnStartedAt);
    $statusStrip.appendChild(elapsed);
  }

  if (session.queue?.length) {
    const meta = document.createElement('span');
    meta.className = 'status-meta';
    meta.textContent = `${session.queue.length} queued`;
    $statusStrip.appendChild(meta);
  }
}

// Tick the status strip every 500ms while anything is busy so elapsed
// counters stay live. Started on stream_start; stopped when nothing is
// busy to avoid a permanent background timer.
let statusTickerId = null;

function startStatusTicker() {
  if (statusTickerId != null) return;
  statusTickerId = setInterval(() => {
    const session = state.sessions.get(state.activeId);
    if (session) renderStatusStrip(session);
  }, 500);
}

function maybeStopStatusTicker() {
  const anyBusy = [...state.sessions.values()].some((s) => s.status === 'busy');
  if (anyBusy) return;
  if (statusTickerId != null) {
    clearInterval(statusTickerId);
    statusTickerId = null;
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
    if (session.status === 'busy') {
      const dots = document.createElement('span');
      dots.className = 'sidebar-working-dots';
      for (let i = 0; i < 3; i++) { const d = document.createElement('span'); d.textContent = '.'; dots.appendChild(d); }
      nameSpan.appendChild(dots);
    } else if (session.hasUnread) {
      const dot = document.createElement('span');
      dot.className = 'sidebar-unread-dot';
      dot.title = 'New output — not yet reviewed';
      dot.setAttribute('aria-label', 'Unread output');
      nameSpan.appendChild(dot);
    }

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
  updateUnreadTitle();
}

// Prefix the document/tab title with a bullet when any background session
// has output waiting. Lets the OS badge/taskbar grab attention when Sublight
// is installed as a PWA or running in a minimized window.
function updateUnreadTitle() {
  const anyUnread = [...state.sessions.values()].some((s) => s.hasUnread);
  const base = 'Sublight';
  const want = anyUnread ? `\u25CF ${base}` : base;
  if (document.title !== want) document.title = want;
}

// Fire a desktop notification when a background session finishes. "Background"
// means the user is either looking at another session or has the tab hidden.
function maybeNotifyIdle(session, errorText) {
  const away = state.activeId !== session.id || document.visibilityState === 'hidden';
  if (!away) return;
  showSessionNotification({
    sessionId: session.id,
    sessionName: session.name || 'Session',
    body: errorText ? `Error: ${truncate(errorText, 140)}` : lastAssistantSnippet(session),
    onClick: () => switchSession(session.id),
  });
}

function lastAssistantSnippet(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'assistant' && typeof m.text === 'string' && m.text.trim()) {
      return truncate(m.text.trim().replace(/\s+/g, ' '), 140);
    }
  }
  return 'Ready';
}

function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '\u2026';
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
  if (!session) return;

  const attachments = consumeAttachments();

  if (session.status === 'busy') {
    // Queue for after the current turn completes. drainQueue() will fire it.
    enqueueMessage(session, text, attachments);
  } else {
    appendUserMessage(session, text, attachments);
    send({ type: 'message', sessionId: state.activeId, text, attachments });
  }
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
// Chat header — copy cwd to clipboard. Export handlers live in export.js.
// ---------------------------------------------------------------------------

$btnCopyCwd.addEventListener('click', () => {
  const session = state.sessions.get(state.activeId);
  if (!session?.cwd) return;
  navigator.clipboard.writeText(session.cwd).then(() => {
    $btnCopyCwd.title = 'Copied!';
    setTimeout(() => { $btnCopyCwd.title = 'Copy working directory path'; }, 1500);
  });
});

// ---------------------------------------------------------------------------
// Artifacts panel lives in artifacts.js; only chat-adjacent handlers stay here.
// ---------------------------------------------------------------------------


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

document.getElementById('btn-restart').addEventListener('click', async () => {
  if (!state.activeId) return;
  const session = state.sessions.get(state.activeId);
  if (!session) return;
  if (session.status === 'busy') {
    showToast('Wait for the current response to finish before restarting');
    return;
  }
  const ok = await confirm('Restart the Claude process? The conversation is kept via --resume, but any in-flight streaming is lost.');
  if (!ok) return;
  send({ type: 'restart_session', sessionId: state.activeId });
});


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
// Boot — check for first-run setup, then auth
// ---------------------------------------------------------------------------

// Close any dialogs the browser may have restored via bfcache / form state.
document.querySelectorAll('dialog[open]').forEach(d => d.close());

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
    startWebSocket();
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
