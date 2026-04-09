/**
 * WebSocket integration tests — boots the server with a stub Claude CLI,
 * opens a real WebSocket to it, and runs full message round-trips.
 *
 * The stub claude lives at tests/fixtures/fake-claude.js and is selected via
 * the SUBLIGHT_CLAUDE_CMD env override (see ensureProcess in server.js).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

function randomPort() {
  return 35000 + Math.floor(Math.random() * 1000);
}

let child;
let sandbox;
let baseUrl;
let port;
const token = 'ws-test-token-9876';

/**
 * Open a WS to the server, auto-bail the test after `timeoutMs` if no
 * expected events arrive. Returns the socket and a message queue helper.
 */
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  const queue = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    queue.push(msg);
    // Wake up anyone waiting for this or a later message.
    while (waiters.length && queue.length) {
      const w = waiters.shift();
      w.resolve(queue.shift());
    }
  });

  /** Wait for the next server message, or throw after timeoutMs. */
  const next = (timeoutMs = 3000) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(`WS message timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const w = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject,
    };
    waiters.push(w);
  });

  /** Wait until a message matching the predicate shows up (drops non-matches). */
  const waitFor = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await next(Math.max(50, deadline - Date.now()));
      if (predicate(msg)) return msg;
    }
    throw new Error(`Timed out waiting for predicate after ${timeoutMs}ms`);
  };

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return { ws, next, waitFor, opened };
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function startServer() {
  sandbox = mkdtempSync(join(os.tmpdir(), 'sublight-ws-'));
  port = randomPort();
  baseUrl = `http://127.0.0.1:${port}`;

  const settingsPath = join(sandbox, 'sublight-test-settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      firstRun: false,
      token: null,
      host: '127.0.0.1',
      port,
      security: {
        scopeFilesToSession: true,
        serveSvg: false,
        maxSessions: 10,
        defaultPermissionMode: 'bypass',
        idleTimeoutMinutes: 0,
        messageRateLimitPerMin: 0,
        maxLogAgeDays: 0,
      },
    }, null, 2),
  );

  const realSettings = join(REPO_ROOT, 'settings.json');
  const backupSettings = join(sandbox, 'settings.json.bak');
  try { cpSync(realSettings, backupSettings); } catch {}
  cpSync(settingsPath, realSettings);

  const fakeClaude = join(REPO_ROOT, 'tests', 'fixtures', 'fake-claude.js');

  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SUBLIGHT_TOKEN: token,
      // Route spawn('claude', ...) to `node tests/fixtures/fake-claude.js`.
      SUBLIGHT_CLAUDE_CMD: JSON.stringify([process.execPath, fakeClaude]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { cpSync(backupSettings, realSettings); } catch {}
      reject(new Error('Server did not start within 8s'));
    }, 8000);
    const onData = (chunk) => {
      if (chunk.toString().includes('Sublight WebUI running at')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        try { cpSync(backupSettings, realSettings); } catch {}
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => process.stderr.write(`[ws-test server stderr] ${c}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        try { cpSync(backupSettings, realSettings); } catch {}
        reject(new Error(`Server exited early with code ${code}`));
      }
    });
  });
}

async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  if (!child.killed) child.kill('SIGKILL');
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
}

before(async () => { await startServer(); });
after(async () => { await stopServer(); });

test('WebSocket auth rejects missing token', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 401);
      resolve();
    });
    ws.once('error', () => resolve()); // Some Node versions surface as error
    ws.once('open', () => reject(new Error('Should not have connected without a token')));
    setTimeout(() => reject(new Error('No rejection within 2s')), 2000);
  });
});

test('full message round-trip through stub claude', async () => {
  const { ws, next, waitFor, opened } = openWs();
  await opened;

  // Create a session and expect session_created + defaults.
  send(ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'bypass' });
  const created = await waitFor((m) => m.type === 'session_created');
  assert.ok(created.sessionId);
  const sessionId = created.sessionId;

  // Send a user message and expect stream_start, claude_event(s), stream_end.
  send(ws, { type: 'message', sessionId, text: 'hello stub' });
  await waitFor((m) => m.type === 'stream_start' && m.sessionId === sessionId);

  // The fake claude emits an init event on startup, so the first claude_event
  // should be the init. We might also see additional assistant events before
  // stream_end arrives.
  const init = await waitFor(
    (m) => m.type === 'claude_event' && m.event?.subtype === 'init',
  );
  assert.equal(init.event.model, 'fake-claude-test');
  assert.ok(Array.isArray(init.event.mcp_servers));

  // Wait for the result event and then stream_end.
  const result = await waitFor(
    (m) => m.type === 'claude_event' && m.event?.type === 'result',
  );
  assert.equal(result.event.subtype, 'success');
  assert.ok(result.event.result.includes('ECHO: hello stub'));
  assert.equal(typeof result.event.total_cost_usd, 'number');

  await waitFor((m) => m.type === 'stream_end' && m.sessionId === sessionId);

  // Second turn on the same session to verify the stub is still alive and
  // the process is persistent (Sublight's headline feature).
  send(ws, { type: 'message', sessionId, text: 'second turn' });
  await waitFor((m) => m.type === 'stream_start');
  const result2 = await waitFor(
    (m) => m.type === 'claude_event' && m.event?.type === 'result',
  );
  assert.ok(result2.event.result.includes('ECHO: second turn'));

  ws.close();
});

test('tool_use round-trip surfaces both the call and the result', async () => {
  const { ws, waitFor, opened } = openWs();
  await opened;

  send(ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'bypass' });
  const created = await waitFor((m) => m.type === 'session_created');
  const sessionId = created.sessionId;

  send(ws, { type: 'message', sessionId, text: 'TOOL' });
  await waitFor((m) => m.type === 'stream_start');

  // Look for the tool_use block in any assistant event.
  const toolUseEvent = await waitFor(
    (m) =>
      m.type === 'claude_event' &&
      m.event?.type === 'assistant' &&
      Array.isArray(m.event.message?.content) &&
      m.event.message.content.some((b) => b.type === 'tool_use'),
  );
  const toolBlock = toolUseEvent.event.message.content.find((b) => b.type === 'tool_use');
  assert.equal(toolBlock.name, 'Read');

  // And its matching tool_result. It arrives as a "user" typed claude_event.
  const toolResultEvent = await waitFor(
    (m) =>
      m.type === 'claude_event' &&
      m.event?.type === 'user' &&
      Array.isArray(m.event.message?.content) &&
      m.event.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === toolBlock.id),
  );
  assert.ok(toolResultEvent);

  await waitFor((m) => m.type === 'stream_end');
  ws.close();
});

test('rate limit trips when messageRateLimitPerMin is exceeded', async () => {
  // We need a fresh server for this — we set rate limit via the settings
  // endpoint on the existing one.
  const { ws, waitFor, opened } = openWs();
  await opened;

  // Tighten the rate limit to 2/min for this test.
  const tighten = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ security: { messageRateLimitPerMin: 2 } }),
  });
  assert.equal(tighten.status, 200);

  send(ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'bypass' });
  const created = await waitFor((m) => m.type === 'session_created');
  const sessionId = created.sessionId;

  // Send messages until we see an error. The session pipeline will echo
  // stream_start / events / stream_end for each successful one; the third
  // message in quick succession should be rejected with a rate-limit error.
  const errors = [];
  const collectUntilError = async () => {
    for (let i = 0; i < 5; i++) {
      send(ws, { type: 'message', sessionId, text: `msg-${i}` });
      // Drain until we see either stream_end or an error for this session.
      const msg = await waitFor(
        (m) =>
          (m.type === 'stream_end' && m.sessionId === sessionId) ||
          (m.type === 'error' && (m.sessionId === sessionId || !m.sessionId)),
      );
      if (msg.type === 'error') {
        errors.push(msg);
        break;
      }
    }
  };
  await collectUntilError();

  assert.ok(errors.length > 0, 'expected a rate-limit error but none arrived');
  assert.match(errors[0].message, /rate limit/i);

  // Reset the rate limit so other tests aren't affected.
  await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ security: { messageRateLimitPerMin: 0 } }),
  });

  ws.close();
});
