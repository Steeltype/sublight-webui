// HTTP routes.
//
// Call registerRoutes(app, { wss, shutdown }) once after express() is set
// up. wss is needed for the /artifact callback to broadcast to connected
// clients; shutdown is the callback that tears down the server on a POST
// to /api/shutdown.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { audit, getAuthToken, httpAuth, isLoopback, timingSafeCompare } from './auth.js';
import { listClaudeCodeSessions } from './claudeCodeSessions.js';
import { isPathInSessionScope } from './claudeProcess.js';
import { AUDIT_LOG_PATH, LOG_DIR } from './paths.js';
import { extractLogMeta, logToSession } from './sessionLog.js';
import {
  connectionSessions,
  pendingUrlRequests,
  sendJSON,
  sessionLogPaths,
  sessions,
} from './sessionState.js';
import { HOST, PORT, saveSettings, settings } from './settings.js';

export function registerRoutes(app, { wss, shutdown }) {
  // -------------------------------------------------------------------------
  // Setup & settings (no auth during first-run setup)
  // -------------------------------------------------------------------------

  app.get('/api/setup-status', (req, res) => {
    if (settings.current.firstRun) {
      // Only reveal the token to loopback callers. Remote callers (HOST=0.0.0.0
      // before first setup) get a flag and must read the token from the server
      // console, which prints it on first-run startup.
      if (isLoopback(req)) {
        res.json({ setupRequired: true, token: getAuthToken(), settings: settings.current.security });
      } else {
        res.json({ setupRequired: true, tokenOnConsole: true, settings: settings.current.security });
      }
    } else {
      res.json({ setupRequired: false, authRequired: getAuthToken() !== null });
    }
  });

  app.post('/api/setup', (req, res) => {
    if (!settings.current.firstRun) {
      return res.status(403).json({ error: 'Setup already completed' });
    }
    // SUBLIGHT_TOKEN env pins the token — the UI still sends one but we ignore
    // it to keep getAuthToken()'s env-wins rule obvious.
    const envPinned = !!process.env.SUBLIGHT_TOKEN;
    const chosenToken = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const update = {
      firstRun: false,
      security: req.body.security || {},
    };
    if (!envPinned && chosenToken) {
      update.token = chosenToken;
    }
    saveSettings(update);
    audit({ type: 'setup_completed', envPinned, tokenCustomized: !envPinned && !!chosenToken }, req);
    res.json({ ok: true, token: getAuthToken() });
  });

  app.get('/api/settings', (req, res) => {
    if (!httpAuth(req, res)) return;
    res.json({
      token: getAuthToken(),
      host: HOST,
      port: PORT,
      envOverrides: {
        token: !!process.env.SUBLIGHT_TOKEN,
        host: !!process.env.HOST,
        port: !!process.env.PORT,
      },
      security: settings.current.security,
    });
  });

  app.post('/api/settings', (req, res) => {
    if (!httpAuth(req, res)) return;
    if (req.body.security) {
      saveSettings({ security: req.body.security });
    }
    res.json({ ok: true, security: settings.current.security });
  });

  /**
   * Regenerate the auth token. Persists to settings.json and takes effect
   * immediately — existing WebSocket connections stay open (they were
   * authorized at upgrade time), but any new request must use the new token.
   */
  app.post('/api/settings/regenerate-token', (req, res) => {
    if (!httpAuth(req, res)) return;
    if (process.env.SUBLIGHT_TOKEN) {
      return res.status(409).json({
        error: 'Token is pinned by the SUBLIGHT_TOKEN environment variable. Remove it from .env to regenerate here.',
      });
    }
    const newToken = crypto.randomUUID();
    saveSettings({ token: newToken });
    audit({ type: 'token_regenerated' }, req);
    res.json({ ok: true, token: newToken });
  });

  app.post('/api/shutdown', (req, res) => {
    if (!httpAuth(req, res)) return;
    res.json({ ok: true });
    shutdown('API');
  });

  app.get('/auth-status', (_req, res) => {
    res.json({ required: getAuthToken() !== null });
  });

  /** Read the last N audit entries. Newest last. */
  app.get('/api/audit', (req, res) => {
    if (!httpAuth(req, res)) return;
    try {
      if (!fs.existsSync(AUDIT_LOG_PATH)) return res.json({ entries: [] });
      const content = fs.readFileSync(AUDIT_LOG_PATH, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const sliced = lines.slice(-limit);
      const entries = [];
      for (const line of sliced) {
        try { entries.push(JSON.parse(line)); } catch { continue; }
      }
      res.json({ entries, totalLines: lines.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Log management
  // -------------------------------------------------------------------------

  app.get('/api/logs', (req, res) => {
    if (!httpAuth(req, res)) return;
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter((f) => f.endsWith('.ndjson') && f !== 'audit.ndjson')
        .map((f) => {
          // nosemgrep — f comes from readdirSync (server-controlled directory listing), not user input
          const full = path.join(LOG_DIR, f);
          const stat = fs.statSync(full);
          const id = f.replace('.ndjson', '');
          const meta = extractLogMeta(full);
          const live = sessions.has(id);
          const resumable = !!(meta && meta.claudeSessionId && !meta.closed && !live);
          return {
            id,
            filename: f,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            live,
            resumable,
            ...meta,
          };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      res.json({ logs: files, totalSize, logDir: path.resolve(LOG_DIR) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/claude-code-sessions', (req, res) => {
    if (!httpAuth(req, res)) return;
    try {
      const list = listClaudeCodeSessions();
      // Mark sessions already live in Sublight so the UI can grey them out.
      const liveClaudeIds = new Set(
        [...sessions.values()]
          .map((s) => s.claudeSession)
          .filter(Boolean),
      );
      const decorated = list.map((s) => ({ ...s, live: liveClaudeIds.has(s.sessionId) }));
      res.json({ sessions: decorated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/:id', (req, res) => {
    if (!httpAuth(req, res)) return;
    // nosemgrep — input sanitized to [a-f0-9-] (UUID chars only) + startsWith guard
    const safe = req.params.id.replace(/[^a-f0-9-]/g, '');
    const logPath = path.resolve(LOG_DIR, `${safe}.ndjson`); // nosemgrep
    if (!logPath.startsWith(path.resolve(LOG_DIR))) {
      return res.status(403).send('Invalid log ID');
    }
    if (!fs.existsSync(logPath)) { // nosemgrep
      return res.status(404).json({ error: 'Log not found' });
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    fs.createReadStream(logPath).pipe(res); // nosemgrep
  });

  app.delete('/api/logs/:id', (req, res) => {
    if (!httpAuth(req, res)) return;
    // nosemgrep — input sanitized to [a-f0-9-] (UUID chars only) + startsWith guard
    const safe = req.params.id.replace(/[^a-f0-9-]/g, '');
    const logPath = path.resolve(LOG_DIR, `${safe}.ndjson`); // nosemgrep
    if (!logPath.startsWith(path.resolve(LOG_DIR))) {
      return res.status(403).send('Invalid log ID');
    }
    if (sessionLogPaths.has(safe)) {
      return res.status(409).json({ error: 'Cannot delete log for an active session' });
    }
    try {
      fs.unlinkSync(logPath); // nosemgrep
      // Also clean up the session's notes sidecar if it exists. Failure here
      // is non-fatal — the log is the primary artifact.
      const notesPath = path.resolve(LOG_DIR, `notes-${safe}.json`);
      if (notesPath.startsWith(path.resolve(LOG_DIR))) {
        try { fs.unlinkSync(notesPath); } catch {} // nosemgrep
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/logs', (req, res) => {
    if (!httpAuth(req, res)) return;
    try {
      const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.ndjson'));
      let deleted = 0;
      for (const f of files) {
        const id = f.replace('.ndjson', '');
        if (sessionLogPaths.has(id)) continue;
        fs.unlinkSync(path.join(LOG_DIR, f));
        deleted++;
      }
      res.json({ ok: true, deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Notes sidecar — per-session scratch pad. Frontend GETs on panel open and
  // PUTs on edit (debounced). Small JSON blob replaced in full on every
  // write — no append semantics.
  // -------------------------------------------------------------------------

  app.get('/api/notes/:id', (req, res) => {
    if (!httpAuth(req, res)) return;
    const safe = req.params.id.replace(/[^a-f0-9-]/g, '');
    const notesPath = path.resolve(LOG_DIR, `notes-${safe}.json`); // nosemgrep
    if (!notesPath.startsWith(path.resolve(LOG_DIR))) {
      return res.status(403).send('Invalid session id');
    }
    try {
      // nosemgrep — auth-gated, id is [a-f0-9-] scoped to LOG_DIR
      const raw = fs.readFileSync(notesPath, 'utf-8');
      res.json(JSON.parse(raw));
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ notes: [] });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/notes/:id', (req, res) => {
    if (!httpAuth(req, res)) return;
    const safe = req.params.id.replace(/[^a-f0-9-]/g, '');
    const notesPath = path.resolve(LOG_DIR, `notes-${safe}.json`); // nosemgrep
    if (!notesPath.startsWith(path.resolve(LOG_DIR))) {
      return res.status(403).send('Invalid session id');
    }
    const notes = Array.isArray(req.body?.notes) ? req.body.notes : null;
    if (!notes) return res.status(400).json({ error: 'Expected { notes: [...] }' });
    const trimmed = notes
      .filter((n) => n && typeof n.text === 'string')
      .slice(0, 500)
      .map((n) => ({
        text: n.text.slice(0, 20000),
        createdAt: typeof n.createdAt === 'string' ? n.createdAt : new Date().toISOString(),
      }));
    try {
      fs.writeFileSync(notesPath, JSON.stringify({ notes: trimmed })); // nosemgrep
      res.json({ ok: true, count: trimmed.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // File serving for the artifact panel — auth-gated, image-only, scoped.
  // -------------------------------------------------------------------------

  app.get('/local-file', (req, res) => {
    if (!httpAuth(req, res)) return;
    // nosemgrep — intentional: authenticated file serving for artifact display
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).send('Missing path');
    }
    const resolved = path.resolve(filePath); // nosemgrep
    // Block path traversal: the resolved path must match the raw input once
    // normalized. Catches ../ sequences, null bytes, and canonicalization tricks.
    if (resolved !== path.normalize(filePath)) {
      return res.status(403).send('Path traversal denied');
    }
    const ext = path.extname(resolved).toLowerCase();
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    if (settings.current.security.serveSvg) allowed.push('.svg');
    if (!allowed.includes(ext)) {
      return res.status(403).send('File type not allowed');
    }
    // Follow symlinks before the scope check — otherwise a link under a
    // session cwd could be used to read files outside of it. realpath
    // doubles as an existence check so fs.existsSync isn't needed.
    let realPath;
    try {
      realPath = fs.realpathSync(resolved); // nosemgrep
    } catch {
      return res.status(404).send('File not found');
    }
    // Scope check against the real (symlink-resolved) path so links can't escape.
    if (settings.current.security.scopeFilesToSession && !isPathInSessionScope(realPath)) {
      return res.status(403).send('Path outside session scope');
    }
    // Stream file directly — res.sendFile has Windows quirks in Express 5.
    // nosemgrep — intentional: auth-gated file serving for artifact display.
    // Only serves image extensions. Users already have full shell access via Claude.
    const mimeTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    fs.createReadStream(realPath).pipe(res); // nosemgrep
  });

  // -------------------------------------------------------------------------
  // Artifact callback — receives POSTs from the MCP artifact server per-session.
  // -------------------------------------------------------------------------

  app.post('/artifact', (req, res) => {
    const { sessionId, ...artifact } = req.body;
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Unknown session' });
    }
    // Verify per-session artifact secret — only the MCP server spawned for
    // this session knows it.
    const secret = req.headers['x-artifact-secret'];
    if (!secret || !timingSafeCompare(secret, session.artifactSecret)) {
      return res.status(401).json({ error: 'Invalid artifact secret' });
    }

    if (artifact.type === 'set_session_name' && artifact.name) {
      session.name = artifact.name;
    }

    // open_url: forward to browser, wait for the user's accept/decline via
    // the pendingUrlRequests map (resolved by the WS url_response case).
    if (artifact.type === 'open_url') {
      const requestId = crypto.randomUUID();
      artifact.requestId = requestId;

      const timeout = setTimeout(() => {
        pendingUrlRequests.delete(requestId);
        res.json({ declined: true });
      }, 60000);

      pendingUrlRequests.set(requestId, {
        resolve: (opened) => {
          clearTimeout(timeout);
          pendingUrlRequests.delete(requestId);
          res.json({ opened, declined: !opened });
        },
      });

      const event = { type: 'artifact', sessionId, artifact };
      for (const ws of wss.clients) {
        const connSessions = connectionSessions.get(ws);
        if (connSessions?.has(sessionId)) {
          sendJSON(ws, event);
        }
      }
      logToSession(session, { type: 'artifact', artifact });
      return;
    }

    // Forward artifact to all WebSocket clients that own this session.
    const event = { type: 'artifact', sessionId, artifact };
    for (const ws of wss.clients) {
      const connSessions = connectionSessions.get(ws);
      if (connSessions?.has(sessionId)) {
        sendJSON(ws, event);
      }
    }

    logToSession(session, { type: 'artifact', artifact });
    res.json({ ok: true });
  });
}
