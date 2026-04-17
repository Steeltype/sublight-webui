// Per-session NDJSON log I/O.
//
// Each session writes turn-by-turn events to logs/<localId>.ndjson.
// Writes are async-append; errors go to stderr but never propagate so a
// logging failure can't take down a conversation.

import fs from 'fs';
import path from 'path';
import { parseLogMeta } from './logMeta.js';
import { LOG_DIR } from './paths.js';
import { sessionLogPaths } from './sessionState.js';

/**
 * Reserve a log file path for a session and stash it in sessionLogPaths.
 * The id is scrubbed to UUID chars only and the final path is confined to
 * LOG_DIR to prevent traversal.
 */
export function initSessionLog(localId) {
  const safe = localId.replace(/[^a-f0-9-]/g, '');
  const resolved = path.resolve(LOG_DIR, `${safe}.ndjson`);
  if (!resolved.startsWith(path.resolve(LOG_DIR))) return null;
  sessionLogPaths.set(localId, resolved);
  return resolved;
}

export function logToSession(session, entry) {
  const logPath = sessionLogPaths.get(session.localId);
  if (!logPath) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFile(logPath, line + '\n', (err) => {
    if (err) console.error(`[log] failed to write to ${logPath}: ${err.message}`);
  });
}

/** Read a log file and extract metadata used for the logs list + resume. */
export function extractLogMeta(logPath) {
  try {
    return parseLogMeta(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    return null;
  }
}
