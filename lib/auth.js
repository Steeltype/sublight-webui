// Auth + audit helpers. The authentication token is captured once at module
// init — token regeneration via the settings UI requires a server restart,
// which is why the audit event advises the user to do so.

import crypto from 'crypto';
import fs from 'fs';
import { AUDIT_LOG_PATH } from './paths.js';
import { settings } from './settings.js';

export const AUTH_TOKEN = process.env.SUBLIGHT_TOKEN || settings.current.token;

export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True if the request came from the loopback interface. */
export function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Append a line to logs/audit.ndjson. Records security-relevant events
 * (auth failures, setup, token regen, idle sweeps). Write errors go to
 * stderr but never propagate — audit logging must not break a request.
 */
export function audit(event, req) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ip: req?.socket?.remoteAddress || null,
    ua: req?.headers?.['user-agent']?.slice(0, 200) || null,
  };
  fs.appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error(`[audit] failed to write ${event.type || event}: ${err.message}`);
  });
}

/** Returns true if authorized. Sends 401 and returns false otherwise. */
export function httpAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token || !timingSafeCompare(token, AUTH_TOKEN)) {
    audit({ type: 'auth_failed', path: req.path, hadToken: !!token }, req);
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}
