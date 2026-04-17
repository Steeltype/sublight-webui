// Periodic maintenance: idle-session sweep and old-log rotation.
//
// Runs every IDLE_SWEEP_INTERVAL_MS. Live sessions whose lastActiveAt has
// aged past settings.security.idleTimeoutMinutes are killed (process only;
// the NDJSON log stays on disk and can be resumed). Separately, NDJSON
// logs older than settings.security.maxLogAgeDays are deleted — never
// audit.ndjson and never logs for still-live sessions.

import fs from 'fs';
import path from 'path';
import { audit } from './auth.js';
import { killSession } from './claudeProcess.js';
import { LOG_DIR } from './paths.js';
import { logToSession } from './sessionLog.js';
import { connectionSessions, sendJSON, sessions } from './sessionState.js';
import { settings } from './settings.js';

const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startIdleSweeper(wss) {
  return setInterval(() => {
    idleSweep(wss);
    rotateOldLogs();
  }, IDLE_SWEEP_INTERVAL_MS).unref();
}

function idleSweep(wss) {
  const timeoutMinutes = settings.current.security.idleTimeoutMinutes || 0;
  if (timeoutMinutes <= 0) return;
  const cutoff = Date.now() - timeoutMinutes * 60 * 1000;
  for (const session of [...sessions.values()]) {
    if (session.status === 'busy') continue;
    if (!session.lastActiveAt || session.lastActiveAt > cutoff) continue;

    logToSession(session, {
      type: 'idle_sweep',
      idleForMs: Date.now() - session.lastActiveAt,
      timeoutMinutes,
    });

    const closeEvent = { type: 'session_closed', sessionId: session.localId, reason: 'idle_timeout' };
    for (const ws of wss.clients) {
      const connSet = connectionSessions.get(ws);
      if (connSet?.has(session.localId)) {
        sendJSON(ws, closeEvent);
        connSet.delete(session.localId);
      }
    }
    killSession(session);
  }
}

function rotateOldLogs() {
  const maxAgeDays = settings.current.security.maxLogAgeDays || 0;
  if (maxAgeDays <= 0) return;
  const ageCutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.ndjson') && f !== 'audit.ndjson');
    for (const f of files) {
      const id = f.replace('.ndjson', '');
      if (sessions.has(id)) continue; // skip live sessions
      // nosemgrep — f came from readdirSync of a server-controlled directory
      const full = path.join(LOG_DIR, f);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < ageCutoff) {
          fs.unlinkSync(full);
          audit({
            type: 'log_rotated',
            id,
            ageDays: Math.floor((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000)),
          });
        }
      } catch (err) {
        console.error(`[log_rotation] failed to stat/remove ${f}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[log_rotation] sweep failed: ${err.message}`);
  }
}

/**
 * Graceful shutdown. Sends SIGTERM to all Claude subprocesses, escalates
 * to SIGKILL at t+3s for anything that ignored SIGTERM, and force-exits at
 * t+5s if httpServer.close() hangs on a stuck connection.
 */
export function createShutdown(httpServer) {
  let shuttingDown = false;
  return function shutdown(signal) {
    if (shuttingDown) return; // ignore a second Ctrl-C
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down`);

    for (const session of sessions.values()) {
      if (session.proc) session.proc.kill('SIGTERM');
    }

    setTimeout(() => {
      for (const session of sessions.values()) {
        if (session.proc && session.proc.exitCode === null) {
          try { session.proc.kill('SIGKILL'); } catch {}
        }
      }
    }, 3000).unref();

    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
}
