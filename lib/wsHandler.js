// WebSocket connection handler.
//
// Exports onWsConnection(ws) — server.js wires this into wss.on('connection').
// The big switch routes incoming client messages (new_session, message,
// resume_session, etc.) to the right piece of state/process logic.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { killSession, restartSession, sendMessage, validateCwd } from './claudeProcess.js';
import { LOG_DIR } from './paths.js';
import { extractLogMeta, initSessionLog, logToSession } from './sessionLog.js';
import {
  checkRateLimit,
  connectionSessions,
  getConnectionSessions,
  pendingUrlRequests,
  sendJSON,
  sessions,
} from './sessionState.js';
import { settings } from './settings.js';

export function onWsConnection(ws) {
  const connSessions = getConnectionSessions(ws);

  ws.on('close', () => {
    // Detach instead of killing — the process keeps running, the browser can
    // reconnect and reattach. The NDJSON log is the source of truth for
    // anything that happened while detached; on reattach the client fetches
    // /api/logs/:id to catch up.
    for (const localId of connSessions) {
      const session = sessions.get(localId);
      if (session) {
        logToSession(session, { type: 'connection_closed' });
        if (session.ws === ws) session.ws = null;
      }
    }
    connSessions.clear();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJSON(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'new_session': {
        if (sessions.size >= settings.current.security.maxSessions) {
          sendJSON(ws, { type: 'error', message: `Session limit reached (max ${settings.current.security.maxSessions}). Close a session first.` });
          break;
        }
        const localId = crypto.randomUUID();
        const cwdCheck = validateCwd(msg.cwd || process.cwd());
        if (!cwdCheck.ok) {
          sendJSON(ws, { type: 'error', message: cwdCheck.error });
          break;
        }
        const cwd = cwdCheck.resolved;
        const permissionMode = msg.permissionMode || settings.current.security.defaultPermissionMode;
        // allowedTools is an array of Claude tool-name patterns (e.g. "Read",
        // "Bash(git log *)"). Only honored in non-bypass mode — bypass already
        // disables all permission checks.
        const allowedTools = Array.isArray(msg.allowedTools)
          ? msg.allowedTools.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
          : null;
        // Non-bypass mode without a static allowlist will hang on the first tool
        // call: Claude Code expects a TTY for its permission prompts and we have
        // none. Fail fast at creation time instead of letting the user discover
        // this mid-turn.
        if (permissionMode !== 'bypass' && (!allowedTools || !allowedTools.length)) {
          sendJSON(ws, {
            type: 'error',
            message: 'Non-bypass sessions require a non-empty allowedTools list. Tool prompts without a TTY will hang.',
          });
          break;
        }
        const session = {
          localId,
          claudeSession: null,
          proc: null,
          cwd,
          status: 'idle',
          unread: false,
          name: msg.name || null,
          permissionMode,
          allowedTools,
          artifactSecret: crypto.randomUUID(),
          mcpConfigPath: null,
          lastActiveAt: Date.now(),
          ws,
        };
        sessions.set(localId, session);
        connSessions.add(localId);
        initSessionLog(localId);

        logToSession(session, { type: 'session_created', cwd, permissionMode, allowedTools: allowedTools || null });
        sendJSON(ws, { type: 'session_created', sessionId: localId, cwd });
        break;
      }

      case 'message': {
        const session = sessions.get(msg.sessionId);
        if (!session) {
          sendJSON(ws, { type: 'error', sessionId: msg.sessionId, message: 'Unknown session' });
          return;
        }
        // Auto-attach on first message after a reconnect so callers don't
        // have to send attach_session first for the simple case.
        if (!connSessions.has(msg.sessionId)) {
          connSessions.add(msg.sessionId);
          session.ws = ws;
        }
        if (session.status === 'busy') {
          sendJSON(ws, { type: 'error', sessionId: msg.sessionId, message: 'Session is busy — wait for the current response to finish' });
          return;
        }
        if (!msg.text?.trim()) return;

        const rate = checkRateLimit(ws);
        if (!rate.ok) {
          sendJSON(ws, {
            type: 'error',
            sessionId: msg.sessionId,
            message: `Rate limit: ${rate.limit} messages/min. Retry in ${Math.ceil(rate.retryMs / 1000)}s.`,
          });
          return;
        }

        sendMessage(session, msg.text, ws, msg.attachments);
        break;
      }

      case 'abort': {
        const session = sessions.get(msg.sessionId);
        if (session?.proc) {
          // Kill the process — it will be re-spawned on next message.
          session.proc.kill('SIGTERM');
        }
        break;
      }

      case 'resume_session': {
        const rawId = String(msg.logId || '');
        const safe = rawId.replace(/[^a-f0-9-]/g, '');
        if (!safe || safe !== rawId) {
          sendJSON(ws, { type: 'error', message: 'Invalid log id' });
          break;
        }
        if (sessions.has(safe)) {
          sendJSON(ws, { type: 'error', message: 'Session is already live — cannot resume' });
          break;
        }
        if (sessions.size >= settings.current.security.maxSessions) {
          sendJSON(ws, { type: 'error', message: `Session limit reached (max ${settings.current.security.maxSessions})` });
          break;
        }
        const logPath = path.resolve(LOG_DIR, `${safe}.ndjson`);
        if (!logPath.startsWith(path.resolve(LOG_DIR)) || !fs.existsSync(logPath)) {
          sendJSON(ws, { type: 'error', message: 'Log not found' });
          break;
        }
        const meta = extractLogMeta(logPath);
        if (!meta || !meta.claudeSessionId) {
          sendJSON(ws, { type: 'error', message: 'Log has no resumable Claude session id' });
          break;
        }
        if (meta.closed) {
          sendJSON(ws, { type: 'error', message: 'Log is marked closed — cannot resume' });
          break;
        }
        const resumeCwdCheck = validateCwd(meta.cwd || '');
        if (!resumeCwdCheck.ok) {
          sendJSON(ws, { type: 'error', message: `Cannot resume — ${resumeCwdCheck.error}` });
          break;
        }
        const resumedCwd = resumeCwdCheck.resolved;

        const session = {
          localId: safe,
          claudeSession: meta.claudeSessionId,
          resumeFromClaudeSession: meta.claudeSessionId,
          proc: null,
          cwd: resumedCwd,
          status: 'idle',
          unread: false,
          name: meta.sessionName || null,
          permissionMode: meta.permissionMode || settings.current.security.defaultPermissionMode,
          allowedTools: meta.allowedTools || null,
          artifactSecret: crypto.randomUUID(),
          mcpConfigPath: null,
          lastActiveAt: Date.now(),
          ws,
        };
        sessions.set(safe, session);
        connSessions.add(safe);
        initSessionLog(safe);
        logToSession(session, { type: 'session_resumed', cwd: resumedCwd, permissionMode: session.permissionMode });

        sendJSON(ws, {
          type: 'session_restored',
          sessionId: safe,
          cwd: resumedCwd,
          name: session.name,
          permissionMode: session.permissionMode,
        });
        break;
      }

      case 'import_claude_session': {
        // Continue a Claude CLI session that was created outside Sublight.
        // Claude's own transcript stays in ~/.claude/projects/ — we just
        // spawn `claude --resume <id>` and stream events into a fresh
        // Sublight log from this point forward.
        const rawId = String(msg.claudeSessionId || '');
        const safeClaudeId = rawId.replace(/[^a-f0-9-]/gi, '');
        if (!safeClaudeId || safeClaudeId !== rawId || safeClaudeId.length !== 36) {
          sendJSON(ws, { type: 'error', message: 'Invalid Claude session id' });
          break;
        }
        if (sessions.size >= settings.current.security.maxSessions) {
          sendJSON(ws, { type: 'error', message: `Session limit reached (max ${settings.current.security.maxSessions}). Close a session first.` });
          break;
        }
        const importCwdCheck = validateCwd(msg.cwd || '');
        if (!importCwdCheck.ok) {
          sendJSON(ws, { type: 'error', message: importCwdCheck.error });
          break;
        }
        const importedCwd = importCwdCheck.resolved;
        // If an in-memory session is already live against this Claude id, don't
        // double-spawn — two processes writing to the same Claude transcript
        // would corrupt it.
        for (const s of sessions.values()) {
          if (s.claudeSession === safeClaudeId) {
            sendJSON(ws, { type: 'error', message: 'That Claude session is already live in Sublight' });
            return;
          }
        }
        const importPermissionMode = msg.permissionMode || settings.current.security.defaultPermissionMode;
        const importAllowedTools = Array.isArray(msg.allowedTools)
          ? msg.allowedTools.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
          : null;
        if (importPermissionMode !== 'bypass' && (!importAllowedTools || !importAllowedTools.length)) {
          sendJSON(ws, {
            type: 'error',
            message: 'Non-bypass sessions require a non-empty allowedTools list. Tool prompts without a TTY will hang.',
          });
          break;
        }
        const importLocalId = crypto.randomUUID();
        const importSession = {
          localId: importLocalId,
          claudeSession: safeClaudeId,
          resumeFromClaudeSession: safeClaudeId,
          proc: null,
          cwd: importedCwd,
          status: 'idle',
          unread: false,
          name: msg.name || null,
          permissionMode: importPermissionMode,
          allowedTools: importAllowedTools,
          artifactSecret: crypto.randomUUID(),
          mcpConfigPath: null,
          lastActiveAt: Date.now(),
          ws,
        };
        sessions.set(importLocalId, importSession);
        connSessions.add(importLocalId);
        initSessionLog(importLocalId);
        logToSession(importSession, {
          type: 'session_imported',
          cwd: importedCwd,
          permissionMode: importPermissionMode,
          allowedTools: importAllowedTools || null,
          claudeSessionId: safeClaudeId,
        });
        sendJSON(ws, {
          type: 'session_restored',
          sessionId: importLocalId,
          cwd: importedCwd,
          name: importSession.name,
          permissionMode: importPermissionMode,
          imported: true,
        });
        break;
      }

      case 'restart_session': {
        const session = sessions.get(msg.sessionId);
        if (!session) {
          sendJSON(ws, { type: 'error', sessionId: msg.sessionId, message: 'Unknown session' });
          break;
        }
        if (!connSessions.has(msg.sessionId)) {
          connSessions.add(msg.sessionId);
          session.ws = ws;
        }
        const result = restartSession(session, ws);
        if (!result.ok) {
          sendJSON(ws, { type: 'error', sessionId: msg.sessionId, message: result.error });
          break;
        }
        logToSession(session, { type: 'session_restarted', cwd: session.cwd, permissionMode: session.permissionMode });
        sendJSON(ws, { type: 'session_restarted', sessionId: session.localId });
        break;
      }

      case 'close_session': {
        const session = sessions.get(msg.sessionId);
        if (session) {
          logToSession(session, { type: 'session_closed_by_user' });
          killSession(session);
          connSessions.delete(msg.sessionId);
        }
        sendJSON(ws, { type: 'session_closed', sessionId: msg.sessionId });
        break;
      }

      case 'list_sessions': {
        // Return every in-memory session so a reconnecting client can see
        // what's available to re-attach. Each entry includes an `attached`
        // flag that's true when this connection already owns it.
        const list = [...sessions.values()].map((s) => ({
          sessionId: s.localId,
          status: s.status,
          cwd: s.cwd,
          name: s.name,
          unread: !!s.unread,
          attached: connSessions.has(s.localId),
          hasClient: !!s.ws,
        }));
        sendJSON(ws, { type: 'session_list', sessions: list });
        break;
      }

      case 'attach_session': {
        // Re-link an existing in-memory session to this connection. Used
        // after a browser reload or reconnect so the same Claude process
        // continues streaming to the new socket.
        const rawId = String(msg.sessionId || '');
        const safe = rawId.replace(/[^a-f0-9-]/g, '');
        if (!safe || safe !== rawId) {
          sendJSON(ws, { type: 'error', message: 'Invalid session id' });
          break;
        }
        const session = sessions.get(safe);
        if (!session) {
          sendJSON(ws, { type: 'error', message: 'Session not found' });
          break;
        }
        // If another connection currently owns it, steal — there's only one
        // user in this tool's trust model. The old socket will find its
        // sends dropped (sendToSession checks readyState).
        if (session.ws && session.ws !== ws && session.ws.readyState === session.ws.OPEN) {
          const oldConn = connectionSessions.get(session.ws);
          oldConn?.delete(safe);
        }
        session.ws = ws;
        connSessions.add(safe);
        sendJSON(ws, {
          type: 'session_attached',
          sessionId: safe,
          cwd: session.cwd,
          name: session.name,
          status: session.status,
          permissionMode: session.permissionMode,
        });
        break;
      }

      case 'get_defaults': {
        sendJSON(ws, {
          type: 'defaults',
          cwd: process.cwd(),
          defaultPermissionMode: settings.current.security.defaultPermissionMode,
        });
        break;
      }

      case 'mark_read': {
        // Client is actively viewing this session — clear the server-side
        // unread flag so the next session_list (e.g. after reconnect) doesn't
        // show a stale dot.
        const session = sessions.get(msg.sessionId);
        if (session) session.unread = false;
        break;
      }

      // ---- User response to open_url confirmation ----
      case 'url_response': {
        const pending = pendingUrlRequests.get(msg.requestId);
        if (pending) {
          pending.resolve(msg.opened);
        }
        break;
      }

      case 'browse_dir': {
        const input = (msg.path || '').trim();
        if (!input) {
          sendJSON(ws, { type: 'dir_listing', entries: [] });
          break;
        }

        let dirToList = input;
        let prefix = '';
        try {
          const stat = fs.statSync(input);
          if (!stat.isDirectory()) {
            sendJSON(ws, { type: 'dir_listing', entries: [] });
            break;
          }
        } catch {
          dirToList = path.dirname(input);
          prefix = path.basename(input).toLowerCase();
        }

        try {
          // nosemgrep — intentional: directory browsing for folder picker
          const resolvedParent = path.resolve(dirToList); // nosemgrep
          const entries = fs.readdirSync(resolvedParent, { withFileTypes: true });
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix))
            .slice(0, 20)
            .map((e) => {
              const full = path.resolve(resolvedParent, e.name); // nosemgrep
              return full.startsWith(resolvedParent) ? full : null;
            })
            .filter(Boolean);
          sendJSON(ws, { type: 'dir_listing', entries: dirs });
        } catch (err) {
          console.error(`[browse_dir] ${err.message}`);
          sendJSON(ws, { type: 'dir_listing', entries: [] });
        }
        break;
      }

      default:
        sendJSON(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });
}
