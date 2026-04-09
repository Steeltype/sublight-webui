# CLAUDE.md — Sublight WebUI

## What This Is

Sublight is a web UI that wraps the Claude CLI via persistent stdin/stdout streaming. It is NOT an API client — it spawns `claude` processes and communicates over NDJSON.

## Architecture

- **server.js** — Express + WebSocket server. Manages persistent Claude processes (one per session), routes NDJSON events to the browser, serves the artifact MCP callback endpoint, handles auth.
- **artifact-mcp.js** — MCP server injected into Claude sessions via `--mcp-config`. Provides 9 tools (show_image, show_artifact, show_markdown, show_diff, show_progress, notify, open_url, pin_artifact, set_session_name). Communicates back to server.js via HTTP POST.
- **public/app.js** — Vanilla JS frontend. Manages sessions, parses NDJSON stream events, renders chat/artifacts/notes, handles file attachments.
- **public/style.css** — Dark theme CSS. No build step, no preprocessor.
- **public/index.html** — Static HTML shell. CDN deps have SRI integrity hashes.

## Key Design Decisions

- **No framework** — vanilla JS, no build step, no bundler. The frontend is ~1500 lines and doesn't need React/Vue complexity.
- **Persistent processes** — each session keeps one `claude` process alive via `--input-format stream-json`. This avoids context reload on every message (6x cheaper per turn).
- **MCP for UI control** — Claude pushes artifacts to the browser via custom MCP tools rather than parsing file paths from text. The MCP server is additive (`--mcp-config` spreads on top of existing configs).
- **Auth is token-based** — single shared secret in `.env`. Not a multi-user system.

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
- Non-bypass mode is a known-broken leg: Claude Code's permission prompts expect a TTY we don't have, so tool calls that would prompt just hang. We tried wiring `--permission-prompt-tool` to an MCP tool on `sublight-artifacts`, but Claude's validator for that flag only sees servers from the user's global Claude config, not ones loaded via `--mcp-config`. See README "Known Limitations".
- `/local-file` endpoint serves images from any path on the filesystem (extension-allowlisted). Auth-gated but no path restriction beyond file type.
- `browse_dir` endpoint lists directories for the folder picker. Read-only, auth-gated.
- All HTML rendering goes through DOMPurify. No raw innerHTML with user/Claude content.
