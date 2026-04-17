// Shared session state.
//
// `sessions`             — Map<localId, Session>. The live registry.
// `sessionLogPaths`      — Map<localId, absolutePath> to the NDJSON log file.
// `connectionSessions`   — WeakMap<ws, Set<localId>> so a client can be
//                          attached to multiple sessions and we clean up on
//                          close without holding the ws alive.
// `connectionMessageTimestamps` — WeakMap<ws, number[]> for the sliding rate
//                          limit window.
// `pendingUrlRequests`   — Map<requestId, {resolve}> for open_url callbacks.
//                          Populated by the artifact POST handler, resolved
//                          by the WS url_response case.
//
// All of this is mutable process state; modules that need to read or write
// it import the same holder so the view is always consistent.

import { settings } from './settings.js';

export const sessions = new Map();
export const sessionLogPaths = new Map();
export const connectionSessions = new WeakMap();
export const connectionMessageTimestamps = new WeakMap();
export const pendingUrlRequests = new Map();

export function getConnectionSessions(ws) {
  let set = connectionSessions.get(ws);
  if (!set) {
    set = new Set();
    connectionSessions.set(ws, set);
  }
  return set;
}

export function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Route a message to whichever WebSocket is currently attached to this
 * session. If nothing is attached (e.g. the browser is mid-reload), the
 * message is silently dropped — the NDJSON log is the source of truth and
 * a reconnecting client will rehydrate from there.
 */
export function sendToSession(session, obj) {
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    sendJSON(session.ws, obj);
  }
}

/**
 * Sliding-window rate limiter, per WebSocket connection. Records the current
 * timestamp on success so successive calls deplete the allowance. Returns
 * { ok: true } if the call is allowed, or { ok: false, retryMs } if the
 * connection has already sent `limit` messages in the last 60s.
 *
 * settings.current.security.messageRateLimitPerMin set to 0 disables the check.
 */
export function checkRateLimit(ws) {
  const limit = settings.current.security.messageRateLimitPerMin || 0;
  if (limit <= 0) return { ok: true };
  const now = Date.now();
  const windowStart = now - 60_000;
  let stamps = connectionMessageTimestamps.get(ws);
  if (!stamps) {
    stamps = [];
    connectionMessageTimestamps.set(ws, stamps);
  }
  while (stamps.length && stamps[0] < windowStart) stamps.shift();
  if (stamps.length >= limit) {
    return { ok: false, retryMs: stamps[0] + 60_000 - now, limit };
  }
  stamps.push(now);
  return { ok: true };
}
