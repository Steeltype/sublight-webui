import { spawn } from 'child_process';
import crypto from 'crypto';
import { config } from 'dotenv';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import { createServer } from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { AUTH_TOKEN, audit, httpAuth, isLoopback, timingSafeCompare } from './lib/auth.js';
import { ARTIFACT_MCP_PATH, AUDIT_LOG_PATH, LOG_DIR, REPO_ROOT } from './lib/paths.js';
import { extractLogMeta, initSessionLog, logToSession } from './lib/sessionLog.js';
import {
  connectionMessageTimestamps,
  connectionSessions,
  getConnectionSessions,
  sendJSON,
  sendToSession,
  sessionLogPaths,
  sessions,
} from './lib/sessionState.js';
import { saveSettings, settings } from './lib/settings.js';

config(); // load .env

fs.mkdirSync(LOG_DIR, { recursive: true });

// .env overrides settings.json (backwards-compatible)
const PORT = process.env.PORT || settings.current.port;
const HOST = process.env.HOST || settings.current.host;

/** Check if a file path falls under any active session's cwd. */
function isPathInSessionScope(filePath) {
  for (const session of sessions.values()) {
    const sessionRoot = path.resolve(session.cwd);
    if (filePath.startsWith(sessionRoot + path.sep) || filePath === sessionRoot) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a candidate session cwd before we hand it to spawn(). Resolves
 * symlinks so we can't be redirected outside an allowed root via a symlink
 * that points elsewhere. Returns { ok, resolved, error }.
 *
 * If settings.current.security.allowedCwdRoots is a non-empty array, the resolved
 * path must sit under one of those roots. Empty array = no restriction
 * (single-user default — the operator IS the user).
 */
function validateCwd(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, error: 'cwd is required' };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, error: 'cwd must be an absolute path' };
  }
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch (err) {
    return { ok: false, error: `cwd does not exist: ${candidate}` };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return { ok: false, error: `cwd is not accessible: ${candidate}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${candidate}` };
  }
  if (resolved === path.parse(resolved).root) {
    return { ok: false, error: 'cwd must not be the filesystem root' };
  }
  const roots = Array.isArray(settings.current.security.allowedCwdRoots)
    ? settings.current.security.allowedCwdRoots.filter((r) => typeof r === 'string' && r.trim())
    : [];
  if (roots.length) {
    const under = roots.some((root) => {
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch { return false; }
      return resolved === realRoot || resolved.startsWith(realRoot + path.sep);
    });
    if (!under) {
      return { ok: false, error: `cwd is outside allowed roots: ${candidate}` };
    }
  }
  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Express — security headers + static files + artifact endpoint
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(REPO_ROOT, 'public')));

// ---------------------------------------------------------------------------
// Setup & settings API (no auth during first-run setup)
// ---------------------------------------------------------------------------

app.get('/api/setup-status', (req, res) => {
  if (settings.current.firstRun) {
    // Only reveal the token to loopback callers. Remote callers (HOST=0.0.0.0
    // before first setup) get a flag and must read the token from the server
    // console, which prints it on first-run startup.
    if (isLoopback(req)) {
      res.json({ setupRequired: true, token: AUTH_TOKEN, settings: settings.current.security });
    } else {
      res.json({ setupRequired: true, tokenOnConsole: true, settings: settings.current.security });
    }
  } else {
    res.json({ setupRequired: false, authRequired: AUTH_TOKEN !== null });
  }
});

app.post('/api/setup', (req, res) => {
  if (!settings.current.firstRun) {
    return res.status(403).json({ error: 'Setup already completed' });
  }
  audit({ type: 'setup_completed' }, req);
  saveSettings({
    firstRun: false,
    security: req.body.security || {},
  });
  res.json({ ok: true, token: AUTH_TOKEN });
});

app.get('/api/settings', (req, res) => {
  if (!httpAuth(req, res)) return;
  res.json({
    token: AUTH_TOKEN,
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
 * Regenerate the auth token. Persists to settings.json and takes effect on
 * next server restart — we deliberately do not mutate AUTH_TOKEN at runtime
 * because existing connections would be orphaned mid-conversation.
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
  res.json({ ok: true, token: newToken, restartRequired: true });
});

app.post('/api/shutdown', (req, res) => {
  if (!httpAuth(req, res)) return;
  res.json({ ok: true });
  shutdown('API');
});

app.get('/auth-status', (_req, res) => {
  res.json({ required: AUTH_TOKEN !== null });
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

// ---------------------------------------------------------------------------
// Log management API
// ---------------------------------------------------------------------------

app.get('/api/logs', (req, res) => {
  if (!httpAuth(req, res)) return;
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.ndjson') && f !== 'audit.ndjson')
      .map(f => {
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
  // Don't delete logs for active sessions
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

// Notes sidecar — per-session scratch pad. The frontend GETs on panel open
// and PUTs on edit (debounced). File is a small JSON blob that's replaced
// in full on every write — no append semantics, no history.
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
  // Bound the payload so a runaway client can't eat disk.
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

app.delete('/api/logs', (req, res) => {
  if (!httpAuth(req, res)) return;
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.ndjson'));
    let deleted = 0;
    for (const f of files) {
      const id = f.replace('.ndjson', '');
      // Skip active session logs
      if (sessionLogPaths.has(id)) continue;
      fs.unlinkSync(path.join(LOG_DIR, f));
      deleted++;
    }
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve local files (images etc.) for the artifact panel — auth-gated, scoped
app.get('/local-file', (req, res) => {
  if (!httpAuth(req, res)) return;
  // nosemgrep — intentional: authenticated file serving for artifact display
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).send('Missing path');
  }
  const resolved = path.resolve(filePath); // nosemgrep
  // Block path traversal: the resolved path must match the raw input once normalized.
  // This catches ../ sequences, null bytes, and other canonicalization tricks.
  if (resolved !== path.normalize(filePath)) {
    return res.status(403).send('Path traversal denied');
  }
  const ext = path.extname(resolved).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  if (settings.current.security.serveSvg) allowed.push('.svg');
  if (!allowed.includes(ext)) {
    return res.status(403).send('File type not allowed');
  }
  // Follow symlinks before the scope check — otherwise a link under a session
  // cwd could be used to read arbitrary files outside of it. realpath also
  // doubles as an existence check so we no longer need fs.existsSync below.
  let realPath;
  try {
    realPath = fs.realpathSync(resolved); // nosemgrep
  } catch {
    return res.status(404).send('File not found');
  }
  // Scope check: when enabled, only serve files under active session directories.
  // We check the real (symlink-resolved) path so links can't escape scope.
  if (settings.current.security.scopeFilesToSession && !isPathInSessionScope(realPath)) {
    return res.status(403).send('Path outside session scope');
  }
  // Stream file directly — res.sendFile has issues with some Windows paths in Express 5.
  // nosemgrep — intentional: auth-gated file serving for artifact display.
  // Only serves image extensions. Users already have full shell access via Claude sessions.
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  fs.createReadStream(realPath).pipe(res); // nosemgrep
});

// Artifact callback — receives POSTs from the MCP artifact server (per-session secret)
app.post('/artifact', (req, res) => {
  const { sessionId, ...artifact } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Unknown session' });
  }
  // Verify per-session artifact secret — only the MCP server spawned for this session knows it
  const secret = req.headers['x-artifact-secret'];
  if (!secret || !timingSafeCompare(secret, session.artifactSecret)) {
    return res.status(401).json({ error: 'Invalid artifact secret' });
  }

  // Handle set_session_name server-side (updates session state)
  if (artifact.type === 'set_session_name' && artifact.name) {
    session.name = artifact.name;
  }

  // For open_url, we forward to browser and wait for the user's response
  // via a pending promise. The browser sends back { opened: true/false }.
  if (artifact.type === 'open_url') {
    const requestId = crypto.randomUUID();
    artifact.requestId = requestId;

    // Store a resolver so the browser can respond
    const timeout = setTimeout(() => {
      pendingUrlRequests.delete(requestId);
      res.json({ declined: true });
    }, 60000);

    pendingUrlRequests.set(requestId, { resolve: (opened) => {
      clearTimeout(timeout);
      pendingUrlRequests.delete(requestId);
      res.json({ opened, declined: !opened });
    }});

    // Forward to browser (don't respond yet — wait for user decision)
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

  // Forward artifact to all WebSocket clients that own this session
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

/** Pending open_url requests awaiting user confirmation */
const pendingUrlRequests = new Map();

const httpServer = createServer(app);

// ---------------------------------------------------------------------------
// Session logging
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebSocket server — with auth on upgrade
// ---------------------------------------------------------------------------

// 100 MiB: big enough for attached screenshots and reasonable files without
// being an unbounded memory hazard. The auth gate on WS upgrade is the real
// control against abuse — this is just a sanity ceiling on a single frame.
const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });

httpServer.on('upgrade', (req, socket, head) => {
  if (AUTH_TOKEN) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token || !timingSafeCompare(token, AUTH_TOKEN)) {
      audit({ type: 'ws_auth_failed', hadToken: !!token }, req);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

/**
 * Sliding-window rate limiter, per WebSocket connection. Records the current
 * timestamp on success so successive calls deplete the allowance. Returns
 * { ok: true } if the call is allowed, or { ok: false, retryMs } if the
 * connection has already sent `limit` messages in the last 60s.
 *
 * settings.current.security.messageRateLimitPerMin set to 0 disables the check.
 */
function checkRateLimit(ws) {
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

function killSession(session) {
  if (session.proc) {
    session.proc.kill('SIGTERM');
    session.proc = null;
  }
  // Clean up MCP config file
  if (session.mcpConfigPath) {
    fs.unlink(session.mcpConfigPath, () => {});
  }
  sessions.delete(session.localId);
  sessionLogPaths.delete(session.localId);
}

// ---------------------------------------------------------------------------
// MCP config for artifact server
// ---------------------------------------------------------------------------

function writeMcpConfig(session) {
  // nosemgrep — sessionId is server-generated UUID from crypto.randomUUID()
  const safe = session.localId.replace(/[^a-f0-9-]/g, '');
  const configPath = path.join(LOG_DIR, `mcp-${safe}.json`); // nosemgrep
  session.mcpConfigPath = configPath;
  const config = {
    mcpServers: {
      'sublight-artifacts': {
        command: 'node',
        args: [ARTIFACT_MCP_PATH],
        env: {
          SUBLIGHT_ARTIFACT_URL: `http://localhost:${PORT}/artifact`,
          SUBLIGHT_SESSION_ID: session.localId,
          SUBLIGHT_ARTIFACT_SECRET: session.artifactSecret,
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// ---------------------------------------------------------------------------
// Persistent Claude process management
//
// Each session gets ONE long-running `claude` process using:
//   --input-format stream-json --output-format stream-json --verbose
//
// Messages are written to stdin as NDJSON. Responses stream back on stdout.
// The process stays alive across turns — no context reload, no re-spawn.
// ---------------------------------------------------------------------------

function ensureProcess(session, ws) {
  if (session.proc) return; // already running

  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];

  // On resume we ask Claude to pick up its prior CLI session. The session_id
  // is stored in `session.resumeFromClaudeSession` by the resume handler and
  // cleared after the first spawn so reconnects don't keep re-resuming.
  if (session.resumeFromClaudeSession) {
    args.push('--resume', session.resumeFromClaudeSession);
    session.resumeFromClaudeSession = null;
  }

  if (session.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  } else if (Array.isArray(session.allowedTools) && session.allowedTools.length) {
    // Static allowlist for non-bypass mode: Claude runs listed tools without
    // prompting and denies everything else. Interactive prompts don't work
    // without a TTY, so this allowlist is the only supported non-bypass path.
    args.push('--allowedTools', ...session.allowedTools);
  }

  // Inject our artifact MCP server alongside existing MCP configs
  const mcpConfigPath = writeMcpConfig(session);
  args.push('--mcp-config', mcpConfigPath);

  // Strip Sublight secrets from the subprocess environment — Claude doesn't need them
  const childEnv = { ...process.env };
  delete childEnv.SUBLIGHT_TOKEN;

  // SUBLIGHT_CLAUDE_CMD overrides the spawn command for testing. It can be
  // either a plain command like "claude" or a JSON array for node + script
  // form: '["node","tests/fixtures/fake-claude.js"]'. Production ignores it.
  let cmd = 'claude';
  let cmdArgs = args;
  const override = process.env.SUBLIGHT_CLAUDE_CMD;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cmd = parsed[0];
        cmdArgs = [...parsed.slice(1), ...args];
      } else {
        cmd = override;
      }
    } catch {
      cmd = override;
    }
  }

  const proc = spawn(cmd, cmdArgs, {
    cwd: session.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.proc = proc;

  // Without this listener an EPIPE on stdin (Claude closed its end between
  // our write and the kernel flushing) becomes an uncaught stream error and
  // crashes the server. We log it and let the 'close' handler below run the
  // normal recovery path.
  proc.stdin.on('error', (err) => {
    logToSession(session, { type: 'stdin_error', message: err.message });
  });

  // NDJSON line buffer for stdout. `stdoutBuf` holds bytes since the last
  // newline. A pathological Claude process (or corrupted stream) could keep
  // streaming without ever emitting \n — cap the per-line buffer so we can't
  // balloon memory. 8 MiB is well above any real NDJSON event we emit.
  const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    if (stdoutBuf.length > MAX_STDOUT_LINE_BYTES) {
      logToSession(session, {
        type: 'parse_error',
        message: `stdout line exceeded ${MAX_STDOUT_LINE_BYTES} bytes — dropping buffer`,
        raw: stdoutBuf.slice(0, 200),
      });
      // Drop the partial line but keep whatever comes after the next newline.
      const nl = stdoutBuf.lastIndexOf('\n');
      stdoutBuf = nl >= 0 ? stdoutBuf.slice(nl + 1) : '';
      return;
    }
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        logToSession(session, { type: 'parse_error', message: err.message, raw: trimmed.slice(0, 200) });
        continue;
      }

      if (event.session_id && !session.claudeSession) {
        session.claudeSession = event.session_id;
      }

      // Detect turn completion: result event means Claude finished responding
      if (event.type === 'result') {
        session.status = 'idle';
        session.lastActiveAt = Date.now();
        logToSession(session, { type: 'turn_end', event });
        sendToSession(session, { type: 'claude_event', sessionId: session.localId, event });
        sendToSession(session, { type: 'stream_end', sessionId: session.localId });
        continue;
      }

      logToSession(session, { type: 'claude_event', event });
      sendToSession(session, { type: 'claude_event', sessionId: session.localId, event });
    }
  });

  // Keep a small ring of the most recent stderr bytes so we can include it
  // in the stream_end payload if Claude exits with an error. Bounded so a
  // chatty child doesn't balloon memory.
  const MAX_STDERR_TAIL_BYTES = 4096;
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) logToSession(session, { type: 'stderr', text: text.trim() });
    stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
  });

  proc.on('close', (code) => {
    session.proc = null;
    const wasBusy = session.status === 'busy';
    session.status = 'idle';

    logToSession(session, { type: 'process_exit', code });

    // If process died while busy, notify the currently-attached client.
    // Include the stderr tail on non-zero exit so the user sees why Claude
    // bailed instead of just "exit 1".
    if (wasBusy) {
      const tail = stderrTail.trim();
      sendToSession(session, {
        type: 'stream_end',
        sessionId: session.localId,
        exitCode: code,
        stderr: code !== 0
          ? (tail ? `Claude exited with code ${code}: ${tail}` : `Claude process exited with code ${code}`)
          : undefined,
      });
    }
  });

  proc.on('error', (err) => {
    const wasBusy = session.status === 'busy';
    session.proc = null;
    // Reset to idle (not 'error') so the next user message can trigger a
    // fresh spawn attempt via ensureProcess. Staying in a sticky 'error'
    // state buys nothing — the next spawn will either succeed or hit the
    // same failure and notify the client again.
    session.status = 'idle';
    logToSession(session, { type: 'error', message: err.message });
    sendToSession(session, { type: 'error', sessionId: session.localId, message: err.message });
    // Close out the in-flight stream so the UI's busy indicator clears.
    if (wasBusy) {
      sendToSession(session, {
        type: 'stream_end',
        sessionId: session.localId,
        stderr: err.message,
      });
    }
  });
}

function sendMessage(session, text, ws, attachments) {
  // Make sure the session points at the connection that's sending us work.
  // This matters when a reattached client sends a message immediately after
  // reconnecting — the stdout handler will route responses here.
  session.ws = ws;
  ensureProcess(session, ws);

  // If spawn failed (e.g., `claude` not on PATH) the error handler already
  // nulled out session.proc and notified the client. Bail rather than crashing
  // on a null stdin. Also guard against a stdin that's been closed out from
  // under us — write() on a non-writable stream would emit an 'error' event
  // asynchronously instead of returning, and the user would get no feedback.
  if (!session.proc?.stdin?.writable) {
    sendToSession(session, {
      type: 'error',
      sessionId: session.localId,
      message: 'Claude process is not running. Is the `claude` CLI installed and on PATH?',
    });
    return;
  }

  session.status = 'busy';
  session.lastActiveAt = Date.now();
  logToSession(session, { type: 'user_message', text, hasAttachments: !!attachments?.length });

  sendToSession(session, { type: 'stream_start', sessionId: session.localId });

  // Build content array — text + any image/file attachments
  let content;
  if (attachments?.length) {
    content = [];
    for (const att of attachments) {
      if (att.type === 'image' && att.source) {
        content.push(att); // Already in Anthropic API format
      } else if (att.type === 'text') {
        content.push(att);
      }
    }
    content.push({ type: 'text', text });
  } else {
    content = text;
  }

  const userMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
  // Callback form so a write error (EPIPE, process died between the writable
  // check above and the kernel write) surfaces instead of being swallowed.
  // Node still buffers even when write() returns false, so we don't need to
  // honor backpressure explicitly — just propagate errors.
  session.proc.stdin.write(JSON.stringify(userMessage) + '\n', (err) => {
    if (!err) return;
    logToSession(session, { type: 'stdin_error', message: err.message });
    const wasBusy = session.status === 'busy';
    session.status = 'idle';
    sendToSession(session, {
      type: 'error',
      sessionId: session.localId,
      message: `Failed to deliver message to Claude: ${err.message}`,
    });
    if (wasBusy) {
      sendToSession(session, { type: 'stream_end', sessionId: session.localId, stderr: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Handle incoming WebSocket messages
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
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
          name: msg.name || null,
          permissionMode,
          allowedTools,
          artifactSecret: crypto.randomUUID(),
          mcpConfigPath: null,
          lastActiveAt: Date.now(),
          ws, // currently attached connection
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
          // Kill the process — it will be re-spawned on next message
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
        // Re-open the log path so new events append to the existing file.
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
          // Evict the old connection's ownership marker so its ws.close
          // handler doesn't null out session.ws for this new attachment.
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
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .filter(e => !prefix || e.name.toLowerCase().startsWith(prefix))
            .slice(0, 20)
            .map(e => {
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
});

// ---------------------------------------------------------------------------
// Idle session sweeper — reclaims Claude subprocesses that have gone quiet.
// A swept session is killed (process only) and removed from memory. Its log
// stays on disk and the Resume flow can bring it back.
// ---------------------------------------------------------------------------

const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  // Idle sweep: kill Claude subprocesses that have gone quiet.
  const timeoutMinutes = settings.current.security.idleTimeoutMinutes || 0;
  if (timeoutMinutes > 0) {
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

  // Log rotation: delete session NDJSON logs older than maxLogAgeDays.
  // Never touches audit.ndjson or logs for currently-live sessions.
  const maxAgeDays = settings.current.security.maxLogAgeDays || 0;
  if (maxAgeDays > 0) {
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
            audit({ type: 'log_rotated', id, ageDays: Math.floor((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000)) });
          }
        } catch (err) {
          console.error(`[log_rotation] failed to stat/remove ${f}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[log_rotation] sweep failed: ${err.message}`);
    }
  }
}, IDLE_SWEEP_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Graceful shutdown — kill all child processes
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; // ignore a second Ctrl-C
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down`);

  // First pass: polite SIGTERM so Claude can flush its log and exit cleanly.
  for (const session of sessions.values()) {
    if (session.proc) session.proc.kill('SIGTERM');
  }

  // Second pass at t+3s: SIGKILL anything that ignored SIGTERM. Without this,
  // a stuck child can survive our hard-exit timer and become an orphan.
  setTimeout(() => {
    for (const session of sessions.values()) {
      if (session.proc && session.proc.exitCode === null) {
        try { session.proc.kill('SIGKILL'); } catch {}
      }
    }
  }, 3000).unref();

  httpServer.close(() => process.exit(0));
  // Last-resort exit if httpServer.close() never calls back (hung connections).
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, HOST, () => {
  console.log(`Sublight WebUI running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (AUTH_TOKEN) {
    console.log('Auth: token required');
  } else {
    console.log('\x1b[33m⚠ Auth: DISABLED — anyone with network access can use this instance\x1b[0m');
  }
  if (HOST === '0.0.0.0') {
    console.log('\x1b[33m⚠ Listening on all interfaces — accessible from your network\x1b[0m');
  }
  if (settings.current.firstRun) {
    console.log('\x1b[36m→ First run — open the UI to complete setup\x1b[0m');
    if (AUTH_TOKEN) {
      console.log(`\x1b[36m→ Setup token: ${AUTH_TOKEN}\x1b[0m`);
    }
  }
  console.log(`Artifact MCP: ${ARTIFACT_MCP_PATH}`);
});
