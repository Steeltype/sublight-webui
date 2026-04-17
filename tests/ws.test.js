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
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('session survives a WebSocket disconnect and can be re-attached', async () => {
  // First connection — create a session and run a turn.
  const first = openWs();
  await first.opened;

  send(first.ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'bypass' });
  const created = await first.waitFor((m) => m.type === 'session_created');
  const sessionId = created.sessionId;

  send(first.ws, { type: 'message', sessionId, text: 'first' });
  await first.waitFor((m) => m.type === 'stream_start');
  await first.waitFor((m) => m.type === 'claude_event' && m.event?.type === 'result');
  await first.waitFor((m) => m.type === 'stream_end');

  // Drop the first connection. The server should NOT kill the process.
  first.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  // Second connection — list_sessions should see the orphan; attach and run
  // another turn.
  const second = openWs();
  await second.opened;

  send(second.ws, { type: 'list_sessions' });
  const list = await second.waitFor((m) => m.type === 'session_list');
  const found = list.sessions.find((s) => s.sessionId === sessionId);
  assert.ok(found, 'expected the orphaned session to still be in the list');

  send(second.ws, { type: 'attach_session', sessionId });
  const attached = await second.waitFor((m) => m.type === 'session_attached');
  assert.equal(attached.sessionId, sessionId);

  // Now send a message on the reattached session. The stub Claude should
  // still be alive (persistent process) and reply on the new socket.
  send(second.ws, { type: 'message', sessionId, text: 'second' });
  await second.waitFor((m) => m.type === 'stream_start');
  const result = await second.waitFor(
    (m) => m.type === 'claude_event' && m.event?.type === 'result',
  );
  assert.ok(result.event.result.includes('ECHO: second'));
  await second.waitFor((m) => m.type === 'stream_end');

  second.ws.close();
});

test('new_session rejects a cwd that does not exist', async () => {
  const { ws, waitFor, opened } = openWs();
  await opened;

  send(ws, { type: 'new_session', cwd: '/nonexistent/path/for/sublight/test', permissionMode: 'bypass' });
  const err = await waitFor((m) => m.type === 'error');
  assert.match(err.message, /cwd does not exist/i);

  ws.close();
});

test('new_session rejects a cwd that is a file, not a directory', async () => {
  const { ws, waitFor, opened } = openWs();
  await opened;

  // package.json exists and is a file, not a directory — should be rejected.
  send(ws, { type: 'new_session', cwd: join(REPO_ROOT, 'package.json'), permissionMode: 'bypass' });
  const err = await waitFor((m) => m.type === 'error');
  assert.match(err.message, /not a directory/i);

  ws.close();
});

test('session recovers after Claude process crashes mid-turn', async () => {
  const { ws, waitFor, opened } = openWs();
  await opened;

  send(ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'bypass' });
  const created = await waitFor((m) => m.type === 'session_created');
  const sessionId = created.sessionId;

  // CRASH makes the fake claude exit(1) without emitting a result. The server
  // must still close out the stream so the UI clears its busy indicator.
  send(ws, { type: 'message', sessionId, text: 'CRASH' });
  await waitFor((m) => m.type === 'stream_start');
  const end = await waitFor((m) => m.type === 'stream_end' && m.sessionId === sessionId);
  assert.equal(end.exitCode, 1);

  // The next message must spawn a fresh process and round-trip normally —
  // not bounce with "Session is busy" or a stale stdin error.
  send(ws, { type: 'message', sessionId, text: 'after crash' });
  await waitFor((m) => m.type === 'stream_start');
  const result = await waitFor(
    (m) => m.type === 'claude_event' && m.event?.type === 'result',
  );
  assert.ok(result.event.result.includes('ECHO: after crash'));
  await waitFor((m) => m.type === 'stream_end');

  ws.close();
});

test('/local-file rejects a symlink that escapes session scope', async () => {
  // Stand up a session rooted in a temp dir, then plant a .png symlink
  // inside that dir pointing to a file outside of it. The pre-fix code
  // checked the scope using the link's own path (which was in scope);
  // the fixed code resolves the real path and rejects.
  const scopeDir = mkdtempSync(join(os.tmpdir(), 'sublight-scope-'));
  const outsideDir = mkdtempSync(join(os.tmpdir(), 'sublight-outside-'));
  const target = join(outsideDir, 'secret.png');
  writeFileSync(target, 'PNGDATA');
  const linkPath = join(scopeDir, 'leak.png');
  symlinkSync(target, linkPath);

  const { ws, waitFor, opened } = openWs();
  await opened;

  send(ws, { type: 'new_session', cwd: scopeDir, permissionMode: 'bypass' });
  await waitFor((m) => m.type === 'session_created');

  const res = await fetch(
    `${baseUrl}/local-file?path=${encodeURIComponent(linkPath)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /outside session scope/i);

  ws.close();
  rmSync(scopeDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test('new_session rejects non-bypass mode without an allowedTools list', async () => {
  const { ws, waitFor, opened } = openWs();
  await opened;

  send(ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'default' });
  const err = await waitFor((m) => m.type === 'error');
  assert.match(err.message, /allowedTools/i);

  ws.close();
});

test('browse_dir returns entries for a real directory and empty for unmatched prefix', async () => {
  const { ws, waitFor, opened } = openWs();
  await opened;

  send(ws, { type: 'browse_dir', path: REPO_ROOT });
  const real = await waitFor((m) => m.type === 'dir_listing');
  assert.ok(Array.isArray(real.entries));
  assert.ok(real.entries.length > 0, 'expected at least one subdir of the repo root');
  for (const entry of real.entries) {
    assert.ok(entry.startsWith(REPO_ROOT), `entry ${entry} should be under REPO_ROOT`);
  }

  // Prefix match path: a child that doesn't exist should return the parent's
  // directories filtered by prefix. A deliberately-weird prefix returns [].
  send(ws, { type: 'browse_dir', path: join(REPO_ROOT, 'zzz_nonexistent_prefix') });
  const empty = await waitFor((m) => m.type === 'dir_listing');
  assert.deepEqual(empty.entries, []);

  ws.close();
});

test('resume_session rebuilds a session from an orphaned NDJSON log', async () => {
  // Simulate the "server restarted mid-session" scenario: a log file exists
  // in logs/ with session_created + a captured claude_session_id but no
  // session_closed_by_user marker. resume_session should read it back and
  // spin up a fresh live session with the same id.
  const { randomUUID } = await import('node:crypto');
  const logId = randomUUID();
  const fakeClaudeSid = randomUUID();
  const logLines = [
    { ts: '2024-01-01T00:00:00.000Z', type: 'session_created', cwd: REPO_ROOT, permissionMode: 'bypass', allowedTools: null },
    { ts: '2024-01-01T00:00:01.000Z', type: 'user_message', text: 'hi', hasAttachments: false },
    { ts: '2024-01-01T00:00:02.000Z', type: 'claude_event', event: { type: 'system', subtype: 'init', session_id: fakeClaudeSid } },
  ];
  const logPath = join(REPO_ROOT, 'logs', `${logId}.ndjson`);
  writeFileSync(logPath, logLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  try {
    const { ws, waitFor, opened } = openWs();
    await opened;

    send(ws, { type: 'resume_session', logId });
    const restored = await waitFor((m) => m.type === 'session_restored');
    assert.equal(restored.sessionId, logId);
    assert.equal(restored.cwd, REPO_ROOT);

    // Run a message on the resumed session — a fresh fake-claude spawns and
    // round-trips, proving the session is fully live.
    send(ws, { type: 'message', sessionId: logId, text: 'after resume' });
    await waitFor((m) => m.type === 'stream_start');
    const result = await waitFor(
      (m) => m.type === 'claude_event' && m.event?.type === 'result',
    );
    assert.ok(result.event.result.includes('ECHO: after resume'));
    await waitFor((m) => m.type === 'stream_end');

    // Clean up the resumed session so later tests don't trip maxSessions.
    send(ws, { type: 'close_session', sessionId: logId });
    await waitFor((m) => m.type === 'session_closed' && m.sessionId === logId);
    ws.close();
  } finally {
    try { rmSync(logPath, { force: true }); } catch {}
  }
});

test('GET /api/logs lists sessions and /api/logs/:id streams the NDJSON body', async () => {
  // Stand up a session so there's definitely a log to find.
  const { ws, waitFor, opened } = openWs();
  await opened;
  send(ws, { type: 'new_session', cwd: REPO_ROOT, permissionMode: 'bypass' });
  const created = await waitFor((m) => m.type === 'session_created');
  const sessionId = created.sessionId;
  send(ws, { type: 'message', sessionId, text: 'for log test' });
  await waitFor((m) => m.type === 'stream_end');

  // Unauthenticated → 401.
  const unauth = await fetch(`${baseUrl}/api/logs`);
  assert.equal(unauth.status, 401);

  // Auth → list with our id present.
  const listRes = await fetch(`${baseUrl}/api/logs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.ok(Array.isArray(listBody.logs));
  const entry = listBody.logs.find((l) => l.id === sessionId);
  assert.ok(entry, 'expected the newly-created session in the logs list');
  assert.equal(entry.live, true);

  // Stream the body of /api/logs/:id — should be NDJSON we can parse.
  const bodyRes = await fetch(`${baseUrl}/api/logs/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(bodyRes.status, 200);
  assert.match(bodyRes.headers.get('content-type') || '', /ndjson/);
  const text = await bodyRes.text();
  const lines = text.split('\n').filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    JSON.parse(line); // throws on malformed NDJSON
  }

  // Nonexistent id → 404.
  const missing = await fetch(
    `${baseUrl}/api/logs/00000000-0000-0000-0000-000000000000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(missing.status, 404);

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
