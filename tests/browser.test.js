/**
 * Browser smoke test — boots the server with the fake-claude stub, opens
 * the UI in headless chromium, runs a full round-trip (new session + send
 * message + see echoed response), and tears everything down.
 *
 * The goal is to catch regressions that unit tests can't see: module graph
 * breakage, CSP violations, auth wiring, basic WebSocket flow, and DOM
 * rendering of the reply. One test covers ~80% of "is the whole thing
 * wired up" in ~100 lines.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

function randomPort() {
  return 36000 + Math.floor(Math.random() * 1000);
}

let child;
let sandbox;
let port;
let baseUrl;
const TOKEN = 'browser-smoke-token-abc123';

async function startServer() {
  sandbox = mkdtempSync(join(os.tmpdir(), 'sublight-browser-'));
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
      SUBLIGHT_TOKEN: TOKEN,
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
    child.stderr.on('data', (c) => process.stderr.write(`[browser-test server stderr] ${c}`));
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

test('full round-trip: boot, create session, send message, see reply', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Seed the auth token in sessionStorage before the first page load so
  // the app skips the auth screen and connects directly.
  await context.addInitScript((token) => {
    sessionStorage.setItem('sublight_token', token);
  }, TOKEN);

  const page = await context.newPage();

  // Capture console errors — failing the test on any uncaught error surfaces
  // module-graph breakage, CSP violations, etc.
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Sidebar-scoped New Session button (there's a duplicate in empty state).
    const sidebarNewBtn = page.getByRole('complementary').getByRole('button', { name: 'New session' });
    await sidebarNewBtn.click();

    // Dialog open — cwd is prefilled with process.cwd(). Bypass mode is
    // needed because the non-bypass path requires an allowedTools list.
    const bypass = page.locator('#session-bypass');
    if (!(await bypass.isChecked())) await bypass.check();

    await page.getByRole('button', { name: 'Create' }).click();

    // Session lands in the sidebar.
    const sessionItem = page.locator('#session-list li').first();
    await sessionItem.waitFor({ state: 'visible', timeout: 5000 });

    // Send a message and wait for the stub's echo to render.
    const composer = page.locator('#prompt-input');
    await composer.fill('hello sublight');
    await page.getByRole('button', { name: 'Send' }).click();

    // The fake-claude stub replies "ECHO: <text>" in an assistant message.
    await page.getByText('ECHO: hello sublight').first().waitFor({ state: 'visible', timeout: 5000 });

    // No console errors along the way — a single error here usually means
    // the module graph, CSP, or auth wiring regressed.
    assert.deepEqual(consoleErrors, [], `unexpected console errors:\n${consoleErrors.join('\n')}`);
  } finally {
    await browser.close();
  }
});
