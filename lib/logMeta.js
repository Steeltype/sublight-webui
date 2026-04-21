/**
 * Parse a session NDJSON log and pull out everything the UI and the resume
 * flow need: name, cwd, permission mode, allowed tools, the latest Claude
 * session id, a closed marker, message counts, and timestamps.
 *
 * Kept separate from server.js so tests can exercise it directly against
 * fixture content without spinning up an HTTP server.
 */

/**
 * Parse NDJSON log content. Returns null on empty input; otherwise an object
 * describing the session. Malformed lines are skipped quietly.
 *
 * @param {string} content - Full NDJSON file content.
 * @returns {object|null}
 */
export function parseLogMeta(content) {
  if (typeof content !== 'string') return null;
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionName = null;
  let cwd = null;
  let permissionMode = null;
  let allowedTools = null;
  let model = null;
  let claudeSessionId = null;
  let messageCount = 0;
  let closed = false;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'session_created' || entry.type === 'session_imported' || entry.type === 'session_resumed') {
      if (entry.cwd) cwd = entry.cwd;
      if (entry.permissionMode) permissionMode = entry.permissionMode;
      if (Array.isArray(entry.allowedTools)) allowedTools = entry.allowedTools;
      if (typeof entry.model === 'string') model = entry.model;
    } else if (entry.type === 'user_message') {
      messageCount++;
    } else if (entry.type === 'artifact' && entry.artifact?.type === 'set_session_name') {
      sessionName = entry.artifact.name;
    } else if (entry.type === 'claude_event' && entry.event?.session_id) {
      claudeSessionId = entry.event.session_id;
    } else if (entry.type === 'session_closed_by_user') {
      closed = true;
    }
  }

  let startedAt = null;
  let endedAt = null;
  try { startedAt = JSON.parse(lines[0]).ts; } catch {}
  try { endedAt = JSON.parse(lines[lines.length - 1]).ts; } catch {}

  return {
    startedAt,
    endedAt,
    sessionName,
    cwd,
    permissionMode,
    allowedTools,
    model,
    claudeSessionId,
    closed,
    messageCount,
    entryCount: lines.length,
  };
}
