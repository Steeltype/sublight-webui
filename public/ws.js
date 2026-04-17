// WebSocket connection with exponential backoff.
//
// connect(onMessage) kicks off the socket, wiring state.ws on open and
// reconnecting on close with backoff capped at MAX_RECONNECT_DELAY. Callers
// pass a message handler so this module stays agnostic of the app-level
// switch statement.

import { state } from './state.js';

const MAX_RECONNECT_DELAY = 30000;

/**
 * Open a WebSocket and attach the caller's message handler. On unexpected
 * close we reconnect, doubling the delay each time up to MAX_RECONNECT_DELAY.
 * A 1006 close while authRequired means the token is bad — the caller's
 * onAuthFailed fires instead of reconnecting.
 */
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

  ws.addEventListener('close', (evt) => {
    state.ws = null;
    if (evt.code === 1006 && state.authRequired) {
      state.authToken = null;
      sessionStorage.removeItem('sublight_token');
      onAuthFailed();
      return;
    }
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
