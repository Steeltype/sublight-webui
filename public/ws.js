// WebSocket connection with exponential backoff.
//
// connect(onMessage) kicks off the socket, wiring state.ws on open and
// reconnecting on close with backoff capped at MAX_RECONNECT_DELAY. Callers
// pass a message handler so this module stays agnostic of the app-level
// switch statement.
//
// Distinguishing "server offline" from "token rejected" matters: the browser
// reports close code 1006 for any abnormal termination — bad auth on the
// upgrade, server crash, OS putting the tab to sleep, or the server being
// shut down. If we blindly treat every 1006 as an auth failure we wipe the
// user's stored token every time the server blinks. Instead we probe
// /auth-status (an unauthenticated endpoint) to tell the two apart.

import { clearAuthToken } from './auth.js';
import { state } from './state.js';

const MAX_RECONNECT_DELAY = 30000;

export function connect({ onMessage, onAuthFailed }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}`;
  if (state.authToken) {
    url += `?token=${encodeURIComponent(state.authToken)}`;
  }

  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    state.ws = ws;
    state.reconnectDelay = 1000;
    hideConnectionBanner();
    console.log('[ws] connected');
    send({ type: 'get_defaults' });
    // Ask the server what's still alive. Any sessions the client doesn't
    // already know about will be auto-rehydrated and reattached.
    send({ type: 'list_sessions' });
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    onMessage(msg);
  });

  ws.addEventListener('close', async (evt) => {
    state.ws = null;

    if (evt.code === 1006 && state.authRequired) {
      // Could be auth rejection OR server offline. /auth-status is a cheap
      // unauthenticated probe that resolves when the server is alive and
      // rejects when it's not.
      const reachable = await isServerReachable();
      if (reachable) {
        // Server is up — the WS upgrade rejected our token.
        state.authToken = null;
        clearAuthToken();
        hideConnectionBanner();
        onAuthFailed();
        return;
      }
      // Server is down — keep the token, keep retrying, surface it in the UI.
    }

    showConnectionBanner(state.reconnectDelay);
    console.log(`[ws] disconnected — reconnecting in ${state.reconnectDelay / 1000}s`);
    setTimeout(() => connect({ onMessage, onAuthFailed }), state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });
}

export function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

async function isServerReachable() {
  try {
    // cache: 'no-store' so a 401 from a previous session doesn't get served.
    const res = await fetch('/auth-status', { cache: 'no-store' });
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

let bannerTickHandle = null;

function showConnectionBanner(retryDelayMs) {
  const el = document.getElementById('connection-banner');
  const textEl = document.getElementById('connection-banner-text');
  if (!el || !textEl) return;
  el.classList.remove('hidden');
  const retryAt = Date.now() + retryDelayMs;
  clearInterval(bannerTickHandle);
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    textEl.textContent = remaining > 0
      ? `Server unreachable — retrying in ${remaining}s`
      : 'Server unreachable — retrying…';
  };
  tick();
  bannerTickHandle = setInterval(tick, 500);
}

function hideConnectionBanner() {
  const el = document.getElementById('connection-banner');
  if (el) el.classList.add('hidden');
  clearInterval(bannerTickHandle);
  bannerTickHandle = null;
}
