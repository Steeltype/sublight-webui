// Shared session state.
//
// `sessions`             — Map<localId, Session>. The live registry.
// `sessionLogPaths`      — Map<localId, absolutePath> to the NDJSON log file.
// `connectionSessions`   — WeakMap<ws, Set<localId>> so a client can be
//                          attached to multiple sessions and we clean up on
//                          close without holding the ws alive.
// `connectionMessageTimestamps` — WeakMap<ws, number[]> for the sliding rate
//                          limit window.
//
// All of this is mutable process state; modules that need to read or write
// it import the same holder so the view is always consistent.

export const sessions = new Map();
export const sessionLogPaths = new Map();
export const connectionSessions = new WeakMap();
export const connectionMessageTimestamps = new WeakMap();

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
