import { spawn } from 'child_process';
import crypto from 'crypto';
import { config } from 'dotenv';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

config(); // load .env

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');
const ARTIFACT_MCP_PATH = path.join(__dirname, 'artifact-mcp.js');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Settings — persisted to settings.json, managed via UI
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  firstRun: true,
  token: null,
  host: '127.0.0.1',
  port: 3700,
  security: {
    scopeFilesToSession: true,
    serveSvg: false,
    maxSessions: 10,
    defaultPermissionMode: 'default',
  },
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      security: { ...DEFAULT_SETTINGS.security, ...(saved.security || {}) },
    };
  } catch {
    // First run — create settings with a fresh token
    const fresh = { ...DEFAULT_SETTINGS, token: crypto.randomUUID() };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveSettings(updates) {
  const current = loadSettings();
  const merged = {
    ...current,
    ...updates,
    security: { ...current.security, ...(updates.security || {}) },
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

let settings = loadSettings();

// .env overrides settings.json (backwards-compatible)
const PORT = process.env.PORT || settings.port;
const HOST = process.env.HOST || settings.host;
const AUTH_TOKEN = process.env.SUBLIGHT_TOKEN || settings.token;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Returns true if authorized. Sends 401 and returns false otherwise. */
function httpAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token || !timingSafeCompare(token, AUTH_TOKEN)) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

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
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Setup & settings API (no auth during first-run setup)
// ---------------------------------------------------------------------------

app.get('/api/setup-status', (_req, res) => {
  if (settings.firstRun) {
    res.json({ setupRequired: true, token: AUTH_TOKEN, settings: settings.security });
  } else {
    res.json({ setupRequired: false, authRequired: AUTH_TOKEN !== null });
  }
});

app.post('/api/setup', (req, res) => {
  if (!settings.firstRun) {
    return res.status(403).json({ error: 'Setup already completed' });
  }
  settings = saveSettings({
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
    security: settings.security,
  });
});

app.post('/api/settings', (req, res) => {
  if (!httpAuth(req, res)) return;
  if (req.body.security) {
    settings = saveSettings({ security: req.body.security });
  }
  res.json({ ok: true, security: settings.security });
});

app.get('/auth-status', (_req, res) => {
  res.json({ required: AUTH_TOKEN !== null });
});

// ---------------------------------------------------------------------------
// Log management API
// ---------------------------------------------------------------------------

/** Read first N lines of a log file and extract metadata. */
function extractLogMeta(logPath) {
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    let sessionName = null;
    let cwd = null;
    let permissionMode = null;
    let messageCount = 0;

    for (const line of lines.slice(0, 50)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_created') {
          cwd = entry.cwd;
          permissionMode = entry.permissionMode;
        }
        if (entry.type === 'artifact' && entry.artifact?.type === 'set_session_name') {
          sessionName = entry.artifact.name;
        }
        if (entry.type === 'user_message') messageCount++;
      } catch { continue; }
    }

    // Count remaining user messages if file is longer
    if (lines.length > 50) {
      for (const line of lines.slice(50)) {
        if (line.includes('"user_message"')) messageCount++;
      }
    }

    const firstLine = JSON.parse(lines[0]);
    const lastLine = JSON.parse(lines[lines.length - 1]);

    return {
      startedAt: firstLine.ts,
      endedAt: lastLine.ts,
      sessionName,
      cwd,
      permissionMode,
      messageCount,
      entryCount: lines.length,
    };
  } catch {
    return null;
  }
}

app.get('/api/logs', (req, res) => {
  if (!httpAuth(req, res)) return;
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.ndjson'))
      .map(f => {
        // nosemgrep — f comes from readdirSync (server-controlled directory listing), not user input
        const full = path.join(LOG_DIR, f);
        const stat = fs.statSync(full);
        const id = f.replace('.ndjson', '');
        const meta = extractLogMeta(full);
        return {
          id,
          filename: f,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          ...meta,
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    res.json({ logs: files, totalSize });
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
    res.json({ ok: true });
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
  const ext = path.extname(resolved).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  if (settings.security.serveSvg) allowed.push('.svg');
  if (!allowed.includes(ext)) {
    return res.status(403).send('File type not allowed');
  }
  // Scope check: when enabled, only serve files under active session directories
  if (settings.security.scopeFilesToSession && !isPathInSessionScope(resolved)) {
    return res.status(403).send('Path outside session scope');
  }
  // nosemgrep — intentional: auth-gated local file serving for artifact display.
  // Only serves image extensions. Users already have full shell access via Claude sessions.
  if (!fs.existsSync(resolved)) { // nosemgrep
    return res.status(404).send('File not found');
  }
  // Stream file directly — res.sendFile has issues with some Windows paths in Express 5
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  fs.createReadStream(resolved).pipe(res); // nosemgrep
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

const sessionLogPaths = new Map();

function initSessionLog(localId) {
  const safe = localId.replace(/[^a-f0-9-]/g, '');
  const resolved = path.resolve(LOG_DIR, `${safe}.ndjson`);
  if (!resolved.startsWith(path.resolve(LOG_DIR))) return null;
  sessionLogPaths.set(localId, resolved);
  return resolved;
}

function logToSession(session, entry) {
  const logPath = sessionLogPaths.get(session.localId);
  if (!logPath) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFile(logPath, line + '\n', (err) => {
    if (err) console.error(`[log] failed to write to ${logPath}: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// WebSocket server — with auth on upgrade
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

httpServer.on('upgrade', (req, socket, head) => {
  if (AUTH_TOKEN) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token || !timingSafeCompare(token, AUTH_TOKEN)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const sessions = new Map();
const connectionSessions = new WeakMap();

function getConnectionSessions(ws) {
  let set = connectionSessions.get(ws);
  if (!set) {
    set = new Set();
    connectionSessions.set(ws, set);
  }
  return set;
}

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
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

  if (session.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  }

  // Inject our artifact MCP server alongside existing MCP configs
  const mcpConfigPath = writeMcpConfig(session);
  args.push('--mcp-config', mcpConfigPath);

  // Strip Sublight secrets from the subprocess environment — Claude doesn't need them
  const childEnv = { ...process.env };
  delete childEnv.SUBLIGHT_TOKEN;

  const proc = spawn('claude', args, {
    cwd: session.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.proc = proc;

  // NDJSON line buffer for stdout
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
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
        logToSession(session, { type: 'turn_end', event });
        sendJSON(ws, { type: 'claude_event', sessionId: session.localId, event });
        sendJSON(ws, { type: 'stream_end', sessionId: session.localId });
        continue;
      }

      logToSession(session, { type: 'claude_event', event });
      sendJSON(ws, { type: 'claude_event', sessionId: session.localId, event });
    }
  });

  proc.stderr.on('data', (chunk) => {
    // Log stderr but don't surface to user unless process crashes
    const text = chunk.toString().trim();
    if (text) logToSession(session, { type: 'stderr', text });
  });

  proc.on('close', (code) => {
    session.proc = null;
    const wasBusy = session.status === 'busy';
    session.status = 'idle';

    logToSession(session, { type: 'process_exit', code });

    // If process died while busy, notify the client
    if (wasBusy) {
      sendJSON(ws, {
        type: 'stream_end',
        sessionId: session.localId,
        exitCode: code,
        stderr: code !== 0 ? `Claude process exited with code ${code}` : undefined,
      });
    }
  });

  proc.on('error', (err) => {
    session.proc = null;
    session.status = 'error';
    logToSession(session, { type: 'error', message: err.message });
    sendJSON(ws, { type: 'error', sessionId: session.localId, message: err.message });
  });
}

function sendMessage(session, text, ws, attachments) {
  ensureProcess(session, ws);

  session.status = 'busy';
  logToSession(session, { type: 'user_message', text, hasAttachments: !!attachments?.length });

  sendJSON(ws, { type: 'stream_start', sessionId: session.localId });

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
  session.proc.stdin.write(JSON.stringify(userMessage) + '\n');
}

// ---------------------------------------------------------------------------
// Handle incoming WebSocket messages
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  const connSessions = getConnectionSessions(ws);

  ws.on('close', () => {
    for (const localId of connSessions) {
      const session = sessions.get(localId);
      if (session) {
        logToSession(session, { type: 'connection_closed' });
        killSession(session);
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
        if (sessions.size >= settings.security.maxSessions) {
          sendJSON(ws, { type: 'error', message: `Session limit reached (max ${settings.security.maxSessions}). Close a session first.` });
          break;
        }
        const localId = crypto.randomUUID();
        const cwd = msg.cwd || process.cwd();
        const permissionMode = msg.permissionMode || settings.security.defaultPermissionMode;
        const session = {
          localId,
          claudeSession: null,
          proc: null,
          cwd,
          status: 'idle',
          name: msg.name || null,
          permissionMode,
          artifactSecret: crypto.randomUUID(),
          mcpConfigPath: null,
        };
        sessions.set(localId, session);
        connSessions.add(localId);
        initSessionLog(localId);

        logToSession(session, { type: 'session_created', cwd, permissionMode });
        sendJSON(ws, { type: 'session_created', sessionId: localId, cwd });
        break;
      }

      case 'message': {
        const session = sessions.get(msg.sessionId);
        if (!session || !connSessions.has(msg.sessionId)) {
          sendJSON(ws, { type: 'error', sessionId: msg.sessionId, message: 'Unknown session' });
          return;
        }
        if (session.status === 'busy') {
          sendJSON(ws, { type: 'error', sessionId: msg.sessionId, message: 'Session is busy — wait for the current response to finish' });
          return;
        }
        if (!msg.text?.trim()) return;

        sendMessage(session, msg.text, ws, msg.attachments);
        break;
      }

      case 'abort': {
        const session = sessions.get(msg.sessionId);
        if (session?.proc && connSessions.has(msg.sessionId)) {
          // Kill the process — it will be re-spawned on next message
          session.proc.kill('SIGTERM');
        }
        break;
      }

      case 'close_session': {
        const session = sessions.get(msg.sessionId);
        if (session && connSessions.has(msg.sessionId)) {
          logToSession(session, { type: 'session_closed_by_user' });
          killSession(session);
          connSessions.delete(msg.sessionId);
        }
        sendJSON(ws, { type: 'session_closed', sessionId: msg.sessionId });
        break;
      }

      case 'list_sessions': {
        const list = [...connSessions]
          .map(id => sessions.get(id))
          .filter(Boolean)
          .map(s => ({
            sessionId: s.localId,
            status: s.status,
            cwd: s.cwd,
            name: s.name,
          }));
        sendJSON(ws, { type: 'session_list', sessions: list });
        break;
      }

      case 'get_defaults': {
        sendJSON(ws, {
          type: 'defaults',
          cwd: process.cwd(),
          defaultPermissionMode: settings.security.defaultPermissionMode,
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
// Graceful shutdown — kill all child processes
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  for (const session of sessions.values()) {
    if (session.proc) {
      session.proc.kill('SIGTERM');
    }
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
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
  if (settings.firstRun) {
    console.log('\x1b[36m→ First run — open the UI to complete setup\x1b[0m');
  }
  console.log(`Artifact MCP: ${ARTIFACT_MCP_PATH}`);
});
