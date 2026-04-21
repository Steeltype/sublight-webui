// Persistent Claude process management.
//
// Each session owns one long-running `claude` CLI process running with
// --input-format stream-json --output-format stream-json --verbose.
// User messages go to stdin as NDJSON; Claude streams back on stdout.
// The process stays alive across turns, so context doesn't reload.
//
// This module owns everything that touches the child: spawn, write,
// close, cleanup, plus the cwd validator and the per-session MCP
// config writer.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ARTIFACT_MCP_PATH, LOG_DIR } from './paths.js';
import { logToSession } from './sessionLog.js';
import { sendToSession, sessionLogPaths, sessions } from './sessionState.js';
import { PORT, settings } from './settings.js';

/** Check if a file path falls under any active session's cwd. */
export function isPathInSessionScope(filePath) {
  for (const session of sessions.values()) {
    const sessionRoot = path.resolve(session.cwd);
    if (filePath.startsWith(sessionRoot + path.sep) || filePath === sessionRoot) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a candidate session cwd before we hand it to spawn(). Resolves
 * symlinks so we can't be redirected outside an allowed root via a symlink
 * that points elsewhere. Returns { ok, resolved, error }.
 *
 * If settings.current.security.allowedCwdRoots is a non-empty array, the
 * resolved path must sit under one of those roots. Empty array = no
 * restriction (single-user default — the operator IS the user).
 */
export function validateCwd(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, error: 'cwd is required' };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, error: 'cwd must be an absolute path' };
  }
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    return { ok: false, error: `cwd does not exist: ${candidate}` };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `cwd is not accessible: ${candidate}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${candidate}` };
  }
  if (resolved === path.parse(resolved).root) {
    return { ok: false, error: 'cwd must not be the filesystem root' };
  }
  const roots = Array.isArray(settings.current.security.allowedCwdRoots)
    ? settings.current.security.allowedCwdRoots.filter((r) => typeof r === 'string' && r.trim())
    : [];
  if (roots.length) {
    const under = roots.some((root) => {
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch { return false; }
      return resolved === realRoot || resolved.startsWith(realRoot + path.sep);
    });
    if (!under) {
      return { ok: false, error: `cwd is outside allowed roots: ${candidate}` };
    }
  }
  return { ok: true, resolved };
}

export function writeMcpConfig(session) {
  // nosemgrep — sessionId is server-generated UUID from crypto.randomUUID()
  const safe = session.localId.replace(/[^a-f0-9-]/g, '');
  const configPath = path.join(LOG_DIR, `mcp-${safe}.json`); // nosemgrep
  session.mcpConfigPath = configPath;
  const config = {
    mcpServers: {
      'sublight-artifacts': {
        command: 'node',
        args: [ARTIFACT_MCP_PATH],
        env: {
          SUBLIGHT_ARTIFACT_URL: `http://localhost:${PORT}/artifact`,
          SUBLIGHT_SESSION_ID: session.localId,
          SUBLIGHT_ARTIFACT_SECRET: session.artifactSecret,
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

export function killSession(session) {
  if (session.proc) {
    session.proc.kill('SIGTERM');
    session.proc = null;
  }
  if (session.mcpConfigPath) {
    fs.unlink(session.mcpConfigPath, () => {});
  }
  sessions.delete(session.localId);
  sessionLogPaths.delete(session.localId);
}

/**
 * Kill the session's current Claude process and immediately respawn it with
 * `--resume <claudeSessionId>` so the new process rehydrates the same
 * conversation. The in-memory session is preserved — only the child process
 * is cycled. Used to pick up newly-installed MCPs, permission changes, or
 * other config that's only read at process start.
 *
 * Returns { ok: true } on a successful restart, or { ok: false, error } if
 * the session is mid-turn, has no resumable Claude session id yet, or has
 * no live process to recycle.
 */
export function restartSession(session, ws) {
  if (session.status === 'busy') {
    return { ok: false, error: 'Session is busy — wait for the current response to finish' };
  }
  if (!session.claudeSession) {
    return { ok: false, error: 'No Claude session id captured yet — nothing to resume' };
  }
  session.resumeFromClaudeSession = session.claudeSession;
  const target = session.ws || ws;
  if (!session.proc) {
    ensureProcess(session, target);
    return { ok: true };
  }
  const oldProc = session.proc;
  // The existing 'close' handler attached in ensureProcess runs first and
  // nulls out session.proc, so our once handler can respawn cleanly.
  oldProc.once('close', () => {
    ensureProcess(session, target);
  });
  oldProc.kill('SIGTERM');
  return { ok: true };
}

export function ensureProcess(session, ws) {
  if (session.proc) return;

  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];

  // On resume we ask Claude to pick up its prior CLI session. The session_id
  // is stored in `session.resumeFromClaudeSession` by the resume handler and
  // cleared after the first spawn so reconnects don't keep re-resuming.
  if (session.resumeFromClaudeSession) {
    args.push('--resume', session.resumeFromClaudeSession);
    session.resumeFromClaudeSession = null;
  }

  if (session.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  } else if (Array.isArray(session.allowedTools) && session.allowedTools.length) {
    // Static allowlist for non-bypass mode: Claude runs listed tools without
    // prompting and denies everything else. Interactive prompts don't work
    // without a TTY, so this allowlist is the only supported non-bypass path.
    args.push('--allowedTools', ...session.allowedTools);
  }

  if (session.model) {
    args.push('--model', session.model);
  }

  const mcpConfigPath = writeMcpConfig(session);
  args.push('--mcp-config', mcpConfigPath);

  // Strip Sublight secrets from the subprocess environment — Claude doesn't need them.
  const childEnv = { ...process.env };
  delete childEnv.SUBLIGHT_TOKEN;

  // SUBLIGHT_CLAUDE_CMD overrides the spawn command for testing. It can be
  // either a plain command like "claude" or a JSON array for node + script
  // form: '["node","tests/fixtures/fake-claude.js"]'. Production ignores it.
  let cmd = 'claude';
  let cmdArgs = args;
  const override = process.env.SUBLIGHT_CLAUDE_CMD;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cmd = parsed[0];
        cmdArgs = [...parsed.slice(1), ...args];
      } else {
        cmd = override;
      }
    } catch {
      cmd = override;
    }
  }

  const proc = spawn(cmd, cmdArgs, {
    cwd: session.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.proc = proc;

  // Without this listener an EPIPE on stdin (Claude closed its end between
  // our write and the kernel flushing) becomes an uncaught stream error and
  // crashes the server. We log it and let the 'close' handler below run the
  // normal recovery path.
  proc.stdin.on('error', (err) => {
    logToSession(session, { type: 'stdin_error', message: err.message });
  });

  // NDJSON line buffer for stdout. A pathological Claude process (or
  // corrupted stream) could keep streaming without ever emitting \n — cap
  // the per-line buffer so we can't balloon memory. 8 MiB is well above
  // any real NDJSON event we emit.
  const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    if (stdoutBuf.length > MAX_STDOUT_LINE_BYTES) {
      logToSession(session, {
        type: 'parse_error',
        message: `stdout line exceeded ${MAX_STDOUT_LINE_BYTES} bytes — dropping buffer`,
        raw: stdoutBuf.slice(0, 200),
      });
      const nl = stdoutBuf.lastIndexOf('\n');
      stdoutBuf = nl >= 0 ? stdoutBuf.slice(nl + 1) : '';
      return;
    }
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        logToSession(session, { type: 'parse_error', message: err.message, raw: trimmed.slice(0, 200) });
        continue;
      }

      if (event.session_id && !session.claudeSession) {
        session.claudeSession = event.session_id;
      }

      // Detect turn completion: result event means Claude finished responding.
      if (event.type === 'result') {
        session.status = 'idle';
        session.unread = true;
        session.lastActiveAt = Date.now();
        logToSession(session, { type: 'turn_end', event });
        sendToSession(session, { type: 'claude_event', sessionId: session.localId, event });
        sendToSession(session, { type: 'stream_end', sessionId: session.localId });
        continue;
      }

      logToSession(session, { type: 'claude_event', event });
      sendToSession(session, { type: 'claude_event', sessionId: session.localId, event });
    }
  });

  // Keep a small ring of recent stderr so we can include it in stream_end
  // when Claude exits non-zero — users see *why* instead of just "exit 1".
  const MAX_STDERR_TAIL_BYTES = 4096;
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) logToSession(session, { type: 'stderr', text: text.trim() });
    stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
  });

  proc.on('close', (code) => {
    session.proc = null;
    const wasBusy = session.status === 'busy';
    session.status = 'idle';

    logToSession(session, { type: 'process_exit', code });

    if (wasBusy) {
      session.unread = true;
      const tail = stderrTail.trim();
      sendToSession(session, {
        type: 'stream_end',
        sessionId: session.localId,
        exitCode: code,
        stderr: code !== 0
          ? (tail ? `Claude exited with code ${code}: ${tail}` : `Claude process exited with code ${code}`)
          : undefined,
      });
    }
  });

  proc.on('error', (err) => {
    const wasBusy = session.status === 'busy';
    session.proc = null;
    // Reset to idle (not 'error') so the next user message can trigger a
    // fresh spawn attempt via ensureProcess.
    session.status = 'idle';
    logToSession(session, { type: 'error', message: err.message });
    session.unread = true;
    sendToSession(session, { type: 'error', sessionId: session.localId, message: err.message });
    if (wasBusy) {
      sendToSession(session, {
        type: 'stream_end',
        sessionId: session.localId,
        stderr: err.message,
      });
    }
  });
}

export function sendMessage(session, text, ws, attachments) {
  // Make sure the session points at the connection that's sending us work.
  // This matters when a reattached client sends a message immediately after
  // reconnecting — the stdout handler will route responses here.
  session.ws = ws;
  ensureProcess(session, ws);

  // If spawn failed (e.g., `claude` not on PATH) the error handler already
  // nulled out session.proc and notified the client. Bail rather than crashing
  // on a null stdin. Also guard against a stdin that's been closed out from
  // under us — write() on a non-writable stream would emit 'error'
  // asynchronously instead of returning, and the user would get no feedback.
  if (!session.proc?.stdin?.writable) {
    sendToSession(session, {
      type: 'error',
      sessionId: session.localId,
      message: 'Claude process is not running. Is the `claude` CLI installed and on PATH?',
    });
    return;
  }

  session.status = 'busy';
  session.lastActiveAt = Date.now();
  logToSession(session, { type: 'user_message', text, hasAttachments: !!attachments?.length });

  sendToSession(session, { type: 'stream_start', sessionId: session.localId });

  // Build content array — text + any image/file attachments.
  let content;
  if (attachments?.length) {
    content = [];
    for (const att of attachments) {
      if (att.type === 'image' && att.source) {
        content.push(att); // Already in Anthropic API format
      } else if (att.type === 'text') {
        content.push(att);
      }
    }
    content.push({ type: 'text', text });
  } else {
    content = text;
  }

  const userMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
  // Callback form so a write error (EPIPE, process died between the writable
  // check above and the kernel write) surfaces instead of being swallowed.
  // Node still buffers even when write() returns false, so we don't need to
  // honor backpressure explicitly — just propagate errors.
  session.proc.stdin.write(JSON.stringify(userMessage) + '\n', (err) => {
    if (!err) return;
    logToSession(session, { type: 'stdin_error', message: err.message });
    const wasBusy = session.status === 'busy';
    session.status = 'idle';
    sendToSession(session, {
      type: 'error',
      sessionId: session.localId,
      message: `Failed to deliver message to Claude: ${err.message}`,
    });
    if (wasBusy) {
      sendToSession(session, { type: 'stream_end', sessionId: session.localId, stderr: err.message });
    }
  });
}
