// Settings — persisted to settings.json, loaded once at startup, mutated
// via saveSettings(). Exported as a holder object so other modules see the
// latest value without needing a getter: read `settings.current.security.X`.

import crypto from 'crypto';
import fs from 'fs';
import { SETTINGS_PATH } from './paths.js';

export const DEFAULT_SETTINGS = {
  firstRun: true,
  token: null,
  host: '127.0.0.1',
  port: 3700,
  security: {
    scopeFilesToSession: true,
    serveSvg: false,
    maxSessions: 10,
    defaultPermissionMode: 'default',
    // Kill Claude subprocesses that haven't had activity in this many minutes.
    // 0 disables. Resuming the session via the UI re-spawns on next message.
    idleTimeoutMinutes: 120,
    // Max user messages per minute per WebSocket connection. 0 disables.
    messageRateLimitPerMin: 30,
    // Delete session NDJSON logs whose last-modified time is older than this
    // many days. 0 disables. audit.ndjson and logs for currently-live sessions
    // are never touched.
    maxLogAgeDays: 30,
    // If non-empty, new/resumed session cwds must resolve to a path under one
    // of these roots. Empty = no restriction (the operator picks any folder).
    // Symlinks are resolved before the check so links can't escape.
    allowedCwdRoots: [],
  },
};

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      security: { ...DEFAULT_SETTINGS.security, ...(saved.security || {}) },
    };
  } catch {
    // First run — create settings with a fresh token.
    const fresh = { ...DEFAULT_SETTINGS, token: crypto.randomUUID() };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

/** Live holder so modules reading `settings.current.X` always see the
 *  latest value after saveSettings() has run. */
export const settings = { current: loadFromDisk() };

export function saveSettings(updates) {
  const current = loadFromDisk();
  const merged = {
    ...current,
    ...updates,
    security: { ...current.security, ...(updates.security || {}) },
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  settings.current = merged;
  return merged;
}
