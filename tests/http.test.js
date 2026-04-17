/**
 * HTTP integration tests — boot server.js as a subprocess in a temporary
 * sandbox (fresh settings.json, empty logs/, random port) and exercise the
 * auth-gated and unauth-gated endpoints. No Claude CLI involvement.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

/** Pick a TCP port in a safe high range. Collisions are possible but rare. */
function randomPort() {
  return 34000 + Math.floor(Math.random() * 1000);
}

let child;
let sandbox;
let baseUrl;
const token = 'integ-test-token-12345';

/** Spawn a Sublight server in a clean sandbox and wait for its startup banner. */
function startServer() {
  sandbox = mkdtempSync(join(os.tmpdir(), 'sublight-test-'));
  mkdirSync(join(sandbox, 'public'), { recursive: true });
  // We need server.js to find public/index.html from its resolved dir.
  // Easiest path: copy server + deps into the sandbox and run from there.
  // Instead we run server.js in place but override LOG_DIR via a custom
  // settings file — LOG_DIR is hardcoded to `logs/` next to server.js, so
  // running in place is fine and we clean up the test log after.
  const port = randomPort();
  baseUrl = `http://127.0.0.1:${port}`;

  // Sandboxed settings file — SUBLIGHT_SETTINGS_PATH tells the server to read
  // and write this instead of the repo's real settings.json.
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
        defaultPermissionMode: 'default',
        idleTimeoutMinutes: 0,
        messageRateLimitPerMin: 0,
        maxLogAgeDays: 0,
      },
    }, null, 2),
  );

  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SUBLIGHT_TOKEN: token,
      SUBLIGHT_SETTINGS_PATH: settingsPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start within 8s')), 8000);
    const onData = (chunk) => {
      if (chunk.toString().includes('Sublight WebUI running at')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => process.stderr.write(`[server stderr] ${c}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
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

test('GET /auth-status returns required=true when token is set', async () => {
  const res = await fetch(`${baseUrl}/auth-status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.required, true);
});

test('GET /api/setup-status on completed setup returns authRequired', async () => {
  const res = await fetch(`${baseUrl}/api/setup-status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.setupRequired, false);
  assert.equal(data.authRequired, true);
});

test('auth-gated endpoint rejects missing token', async () => {
  const res = await fetch(`${baseUrl}/api/logs`);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Authentication required');
});

test('auth-gated endpoint rejects wrong token', async () => {
  const res = await fetch(`${baseUrl}/api/logs`, {
    headers: { Authorization: 'Bearer completely-wrong-token' },
  });
  assert.equal(res.status, 401);
});

test('GET /api/logs with valid token returns logs + dir', async () => {
  const res = await fetch(`${baseUrl}/api/logs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.logs));
  assert.equal(typeof data.totalSize, 'number');
  assert.equal(typeof data.logDir, 'string');
  assert.ok(data.logDir.length > 0);
});

test('GET /api/settings returns security shape', async () => {
  const res = await fetch(`${baseUrl}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.security, 'object');
  assert.ok('idleTimeoutMinutes' in data.security);
  assert.ok('messageRateLimitPerMin' in data.security);
  assert.ok('maxLogAgeDays' in data.security);
});

test('GET /api/audit returns entries array', async () => {
  const res = await fetch(`${baseUrl}/api/audit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.entries));
  // The unauth-fetch in the test above should have triggered an auth_failed
  // entry, so the audit log should have at least one entry by now.
  assert.ok(data.entries.length >= 1);
  const authFailed = data.entries.find((e) => e.event?.type === 'auth_failed');
  assert.ok(authFailed, 'expected at least one auth_failed audit entry');
});

test('POST /api/settings/regenerate-token refuses when env pins the token', async () => {
  const res = await fetch(`${baseUrl}/api/settings/regenerate-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.ok(data.error.toLowerCase().includes('environment'));
});

test('unknown /api path returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/definitely-not-a-thing`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
});

test('/local-file rejects path traversal outside session scope', async () => {
  const res = await fetch(`${baseUrl}/local-file?path=../../etc/passwd`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Either 403 (scope rejection) or 400 (extension rejection) — both acceptable.
  assert.ok([400, 403, 404].includes(res.status), `unexpected status ${res.status}`);
});
