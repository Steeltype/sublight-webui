// Scans Claude Code's per-project session transcripts in
// ~/.claude/projects/<safe-cwd>/<session-id>.jsonl and extracts enough
// metadata to render a picker: cwd, timestamps, first user-visible message.
//
// The JSONL format isn't documented, so this is best-effort: we read at
// most the first 64KB of each file, looking for the first event that
// carries a `cwd` field and a user message that isn't a system caveat
// or slash-command echo. Unrecognized or malformed lines are skipped.
//
// Never trust the directory name's dash-mangled path — read cwd from the
// file contents instead. Different platforms encode paths differently
// (drive letter on Windows, UNC, etc.) and the mangling isn't reversible.

import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS_DIR } from './paths.js';

const HEAD_READ_BYTES = 64 * 1024;
const MAX_LINES_TO_SCAN = 80;

function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// True for the synthetic messages Claude CLI emits around slash commands.
// We skip these when picking a "first user message" preview so the picker
// shows something the user actually typed.
const SYSTEM_MESSAGE_PREFIX = /^<(local-command-caveat|command-name|command-message|command-args|local-command-stdout)/;

function extractMeta(filePath) {
  const head = readHead(filePath);
  if (!head) return {};
  const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, MAX_LINES_TO_SCAN);
  let cwd = null;
  let firstTurnAt = null;
  let firstUserMessage = null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
    if (!firstTurnAt && typeof obj.timestamp === 'string') firstTurnAt = obj.timestamp;
    if (!firstUserMessage && obj.type === 'user' && !obj.isMeta) {
      const c = obj.message?.content;
      if (typeof c === 'string' && !SYSTEM_MESSAGE_PREFIX.test(c)) {
        firstUserMessage = c.slice(0, 200);
      }
    }
    if (cwd && firstTurnAt && firstUserMessage) break;
  }
  return { cwd, firstTurnAt, firstUserMessage };
}

const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

export function listClaudeCodeSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  let topEntries;
  try {
    topEntries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const dir of topEntries) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, dir.name);
    let files;
    try {
      files = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const entry of files) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const filePath = path.join(projectDir, entry);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (stat.size === 0) continue;
      const meta = extractMeta(filePath);
      out.push({
        sessionId,
        cwd: meta.cwd,
        firstTurnAt: meta.firstTurnAt,
        lastTurnAt: stat.mtime.toISOString(),
        firstUserMessage: meta.firstUserMessage,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
