# CLAUDE.md — Sublight WebUI

## What This Is

Sublight is a web UI that wraps the Claude CLI via persistent stdin/stdout streaming. It is NOT an API client — it spawns `claude` processes and communicates over NDJSON.

## Architecture

### Server

- **server.js** (~100 lines) — Orchestration only: express + helmet, static mount, WebSocket server with auth-on-upgrade, interval/signal wiring, startup banner.
- **lib/settings.js** — `DEFAULT_SETTINGS`, `saveSettings`, and the live `settings.current` holder. Also loads `.env` and exports `PORT`/`HOST`.
- **lib/paths.js** — `REPO_ROOT`, `LOG_DIR`, `SETTINGS_PATH`, `AUDIT_LOG_PATH`, `ARTIFACT_MCP_PATH`.
- **lib/auth.js** — `timingSafeCompare`, `isLoopback`, `httpAuth`, `audit`. `AUTH_TOKEN` is frozen at module init (regeneration requires restart).
- **lib/sessionState.js** — The mutable process state: `sessions` Map, `sessionLogPaths`, `connectionSessions`, `connectionMessageTimestamps`, `pendingUrlRequests`. Plus `sendJSON`, `sendToSession`, `getConnectionSessions`, `checkRateLimit`.
- **lib/sessionLog.js** — Per-session NDJSON log I/O (`initSessionLog`, `logToSession`, `extractLogMeta`).
- **lib/claudeProcess.js** — `validateCwd`, `isPathInSessionScope`, `writeMcpConfig`, `killSession`, `ensureProcess`, `sendMessage`. Owns the child process lifecycle (spawn, stdin write, stdout parse, error/close handling).
- **lib/wsHandler.js** — `onWsConnection(ws)` — the big switch that routes incoming WS messages (new_session, message, resume_session, etc.) to the right state/process logic.
- **lib/routes.js** — `registerRoutes(app, { wss, shutdown })` wires every HTTP endpoint (setup, settings, audit, logs, notes, local-file, artifact).
- **lib/lifecycle.js** — `startIdleSweeper(wss)` (idle-session sweep + old-log rotation) and `createShutdown(httpServer)` (SIGTERM → SIGKILL escalation → hard exit).
- **lib/logMeta.js** — Pure NDJSON log parser. Kept separate so tests can exercise it without spinning up the server.
- **artifact-mcp.js** — MCP server injected into Claude sessions via `--mcp-config`. Provides 9 tools (show_image, show_artifact, show_markdown, show_diff, show_progress, notify, open_url, pin_artifact, set_session_name). Communicates back to the server via HTTP POST.

### Frontend

- **public/app.js** — Entry point. Imports the modules below, owns session switching, chat rendering, slash commands, WS message dispatch.
- **public/state.js** — Shared UI `state` singleton. Every module reads `state.sessions` / `state.activeId` / etc. from here.
- **public/ws.js** — `connect({ onMessage, onAuthFailed })` + `send(obj)`. Exponential reconnect.
- **public/auth.js** — `authFetch(url, opts)`, `authUrl(base)`.
- **public/artifacts.js** — Artifact panel rendering, progress bars, open_url confirmation, pin, per-card export.
- **public/attachments.js** — File upload/paste/drag buffer. Exposes `consumeAttachments()` for the composer.
- **public/notes.js** — Per-session notes panel. Server-persisted via `/api/notes/:id` with localStorage as offline fallback.
- **public/export.js** — Save-as-markdown and full-bundle-zip handlers. Exports `downloadBlob` and `safeFilename` for reuse.
- **public/markdown.js** — `setMarkdownContent(el, text)` — marked + DOMPurify.
- **public/confirm.js** — Modal `confirm()` dialog.
- **public/toast.js** — Transient toast notifications.
- **public/style.css** — Dark theme CSS. No build step, no preprocessor.
- **public/index.html** — Static HTML shell. CDN deps have SRI integrity hashes.

## Key Design Decisions

- **No framework / no build step** — vanilla ES modules loaded as `<script type="module">`. Frontend is ~2000 lines split across 10 modules; server is ~1600 lines split across 10 modules. Helmet CSP `scriptSrc: 'self'` allows same-origin module imports.
- **Persistent processes** — each session keeps one `claude` process alive via `--input-format stream-json`. This avoids context reload on every message (6x cheaper per turn).
- **MCP for UI control** — Claude pushes artifacts to the browser via custom MCP tools rather than parsing file paths from text. The MCP server is additive (`--mcp-config` spreads on top of existing configs).
- **Auth is token-based** — single shared secret in `.env` or `settings.json`. Not a multi-user system.

## How Messages Flow

1. User types in browser, hits Ctrl+Enter
2. Browser sends `{ type: "message", sessionId, text, attachments }` over WebSocket
3. Server writes NDJSON `{ type: "user", message: { role: "user", content } }` to Claude's stdin
4. Claude's stdout emits NDJSON events (assistant, tool_use, tool_result, result, etc.)
5. Server parses NDJSON line-by-line and forwards as `{ type: "claude_event", sessionId, event }` over WebSocket
6. Browser renders events in real-time (streaming text, tool cards, thinking blocks)
7. When `type: "result"` arrives, the turn is complete — server marks session idle

## Working On This Codebase

- Run `npm run dev` for auto-restart on changes
- Frontend changes are instant (just refresh browser)
- Server changes require restart (dev mode handles this)
- Test with `SUBLIGHT_TOKEN` set in `.env` to verify auth flow
- The `logs/` directory has NDJSON session logs for debugging

## Security Notes

- `--dangerously-skip-permissions` is passed when the session's `permissionMode` is `'bypass'`. The user picks this per-session from the new-session dialog; the default comes from `settings.security.defaultPermissionMode`.
- Non-bypass sessions must ship a non-empty `allowedTools` list (`--allowedTools Read Grep ...`). We used to support interactive permission prompts via a custom MCP tool, but Claude Code's `--permission-prompt-tool` validator does not see servers loaded via `--mcp-config`, and default-mode prompts require a TTY we don't have. The server rejects non-bypass sessions with no allowedTools so users don't create a session that hangs on the first tool call.
- `/local-file` endpoint serves images from any path on the filesystem (extension-allowlisted). Auth-gated but no path restriction beyond file type.
- `browse_dir` endpoint lists directories for the folder picker. Read-only, auth-gated.
- All HTML rendering goes through DOMPurify. No raw innerHTML with user/Claude content.
