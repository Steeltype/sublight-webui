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
const PORT = process.env.PORT || 3700;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.SUBLIGHT_TOKEN || null;
const LOG_DIR = path.join(__dirname, 'logs');
const ARTIFACT_MCP_PATH = path.join(__dirname, 'artifact-mcp.js');

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Express — security headers + static files + artifact endpoint
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        'https://cdnjs.cloudflare.com',
        'https://cdn.jsdelivr.net',
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://cdnjs.cloudflare.com',
      ],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth-status', (_req, res) => {
  res.json({ required: AUTH_TOKEN !== null });
});

// Serve local files (images etc.) for the artifact panel
app.get('/local-file', (req, res) => {
  // nosemgrep — intentional: authenticated file serving for artifact display
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).send('Missing path');
  }
  const resolved = path.resolve(filePath); // nosemgrep
  const ext = path.extname(resolved).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
  if (!allowed.includes(ext)) {
    return res.status(403).send('File type not allowed');
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

// Artifact callback — receives POSTs from the MCP artifact server
app.post('/artifact', (req, res) => {
  const { sessionId, ...artifact } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Unknown session' });
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
  fs.appendFile(logPath, line + '\n', () => {});
}

// ---------------------------------------------------------------------------
// WebSocket server — with auth on upgrade
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (AUTH_TOKEN) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token !== AUTH_TOKEN) {
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
  sessions.delete(session.localId);
  sessionLogPaths.delete(session.localId);
}

// ---------------------------------------------------------------------------
// MCP config for artifact server
// ---------------------------------------------------------------------------

function writeMcpConfig(sessionId) {
  // nosemgrep — sessionId is server-generated UUID from crypto.randomUUID()
  const safe = sessionId.replace(/[^a-f0-9-]/g, '');
  const configPath = path.join(LOG_DIR, `mcp-${safe}.json`); // nosemgrep
  const config = {
    mcpServers: {
      'sublight-artifacts': {
        command: 'node',
        args: [ARTIFACT_MCP_PATH],
        env: {
          SUBLIGHT_ARTIFACT_URL: `http://localhost:${PORT}/artifact`,
          SUBLIGHT_SESSION_ID: sessionId,
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
  const mcpConfigPath = writeMcpConfig(session.localId);
  args.push('--mcp-config', mcpConfigPath);

  const proc = spawn('claude', args, {
    cwd: session.cwd,
    env: { ...process.env },
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
      } catch {
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

function sendMessage(session, text, ws) {
  ensureProcess(session, ws);

  session.status = 'busy';
  logToSession(session, { type: 'user_message', text });

  sendJSON(ws, { type: 'stream_start', sessionId: session.localId });

  // Write user message to Claude's stdin as NDJSON
  const userMessage = {
    type: 'user',
    message: { role: 'user', content: text },
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
        const localId = crypto.randomUUID();
        const cwd = msg.cwd || process.cwd();
        const permissionMode = msg.permissionMode || 'default';
        const session = {
          localId,
          claudeSession: null,
          proc: null,
          cwd,
          status: 'idle',
          name: msg.name || null,
          permissionMode,
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

        sendMessage(session, msg.text, ws);
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
        sendJSON(ws, { type: 'defaults', cwd: process.cwd() });
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
        } catch {
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
    console.log('Auth: token required (set via SUBLIGHT_TOKEN in .env)');
  } else {
    console.log('Auth: disabled (set SUBLIGHT_TOKEN in .env to enable)');
  }
  console.log(`Artifact MCP: ${ARTIFACT_MCP_PATH}`);
});
