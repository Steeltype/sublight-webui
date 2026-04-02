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

// Ensure logs directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Express — security headers + static files
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
      imgSrc: ["'self'", 'data:'],
    },
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// Auth status endpoint — lets the frontend know if a token is required
app.get('/auth-status', (_req, res) => {
  res.json({ required: AUTH_TOKEN !== null });
});

const httpServer = createServer(app);

// ---------------------------------------------------------------------------
// Session logging
// ---------------------------------------------------------------------------

/** Pre-computed safe log paths, keyed by localId. Set once at session creation. */
const sessionLogPaths = new Map();

function initSessionLog(localId) {
  // localId is always from crypto.randomUUID(), but belt-and-suspenders:
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
  // Auth check: if SUBLIGHT_TOKEN is set, require it as a query param
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

/** Global session store — keyed by localId */
const sessions = new Map();

/** Track which sessions belong to which WS connection */
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
// Spawn `claude` in print + stream-json mode
// ---------------------------------------------------------------------------

function spawnClaude(session, text, ws) {
  const args = [
    '-p', text,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (session.claudeSession) {
    args.push('--resume', session.claudeSession);
  }

  if (session.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  }

  const proc = spawn('claude', args, {
    cwd: session.cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  session.proc = proc;
  session.status = 'busy';

  logToSession(session, { type: 'user_message', text });

  sendJSON(ws, {
    type: 'stream_start',
    sessionId: session.localId,
  });

  // NDJSON line buffer — data arrives in arbitrary chunks
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

      logToSession(session, { type: 'claude_event', event });

      sendJSON(ws, {
        type: 'claude_event',
        sessionId: session.localId,
        event,
      });
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  proc.on('close', (code) => {
    // Flush trailing line
    if (stdoutBuf.trim()) {
      try {
        const event = JSON.parse(stdoutBuf.trim());
        if (event.session_id && !session.claudeSession) {
          session.claudeSession = event.session_id;
        }
        logToSession(session, { type: 'claude_event', event });
        sendJSON(ws, {
          type: 'claude_event',
          sessionId: session.localId,
          event,
        });
      } catch { /* ignore */ }
    }

    session.proc = null;
    session.status = 'idle';

    logToSession(session, { type: 'stream_end', exitCode: code });

    sendJSON(ws, {
      type: 'stream_end',
      sessionId: session.localId,
      exitCode: code,
      stderr: stderrBuf.trim() || undefined,
    });
  });

  proc.on('error', (err) => {
    session.proc = null;
    session.status = 'error';

    logToSession(session, { type: 'error', message: err.message });

    sendJSON(ws, {
      type: 'error',
      sessionId: session.localId,
      message: err.message,
    });
  });
}

// ---------------------------------------------------------------------------
// Handle incoming WebSocket messages
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  const connSessions = getConnectionSessions(ws);

  // Clean up all sessions owned by this connection when it closes
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

        spawnClaude(session, msg.text, ws);
        break;
      }

      case 'abort': {
        const session = sessions.get(msg.sessionId);
        if (session?.proc && connSessions.has(msg.sessionId)) {
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

      // ---- Browse directories for autocomplete ----
      case 'browse_dir': {
        const input = (msg.path || '').trim();
        if (!input) {
          sendJSON(ws, { type: 'dir_listing', entries: [] });
          break;
        }

        // Determine the directory to list and optional prefix filter
        let dirToList = input;
        let prefix = '';
        try {
          const stat = fs.statSync(input);
          if (!stat.isDirectory()) {
            sendJSON(ws, { type: 'dir_listing', entries: [] });
            break;
          }
        } catch {
          // Input isn't a valid dir — try its parent and filter by the basename
          dirToList = path.dirname(input);
          prefix = path.basename(input).toLowerCase();
        }

        try {
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal
          // Intentional: directory browsing is the purpose of this endpoint.
          // Auth-gated, read-only listing. Users already have full shell via Claude sessions.
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
  // Force exit after 5s if connections don't close
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
});
