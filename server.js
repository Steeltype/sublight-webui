import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import { createServer } from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { audit, getAuthToken, timingSafeCompare } from './lib/auth.js';
import { createShutdown, startIdleSweeper } from './lib/lifecycle.js';
import { ARTIFACT_MCP_PATH, LOG_DIR, REPO_ROOT } from './lib/paths.js';
import { registerRoutes } from './lib/routes.js';
import { HOST, PORT, settings } from './lib/settings.js';
import { onWsConnection } from './lib/wsHandler.js';

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Express — security headers + static files
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

const httpServer = createServer(app);
const shutdown = createShutdown(httpServer);

// ---------------------------------------------------------------------------
// WebSocket server — with auth on upgrade
// ---------------------------------------------------------------------------

// 100 MiB: big enough for attached screenshots and reasonable files without
// being an unbounded memory hazard. The auth gate on WS upgrade is the real
// control against abuse — this is just a sanity ceiling on a single frame.
const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });

// Routes need both wss (/artifact broadcast loop) and shutdown (POST
// /api/shutdown). Wire them after both are in scope.
registerRoutes(app, { wss, shutdown });

httpServer.on('upgrade', (req, socket, head) => {
  const authToken = getAuthToken();
  if (authToken) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token || !timingSafeCompare(token, authToken)) {
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

wss.on('connection', onWsConnection);

startIdleSweeper(wss);

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, HOST, () => {
  const authToken = getAuthToken();
  console.log(`Sublight WebUI running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (authToken) {
    console.log('Auth: token required');
  } else {
    console.log('\x1b[33m⚠ Auth: DISABLED — anyone with network access can use this instance\x1b[0m');
  }
  if (HOST === '0.0.0.0') {
    console.log('\x1b[33m⚠ Listening on all interfaces — accessible from your network\x1b[0m');
  }
  if (settings.current.firstRun) {
    console.log('\x1b[36m→ First run — open the UI to complete setup\x1b[0m');
    if (authToken) {
      console.log(`\x1b[36m→ Setup token: ${authToken}\x1b[0m`);
    }
  }
  console.log(`Artifact MCP: ${ARTIFACT_MCP_PATH}`);
});
