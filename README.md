# Sublight WebUI

A lightweight web interface for Claude CLI that wraps persistent Claude Code sessions with a multi-session chat UI, artifact panel, and custom MCP tools.

![Sublight WebUI — artifact panel with markdown, diff, and tool cards](assets/screenshot.jpeg)

![Image generation via SwarmUI displayed in artifact panel](assets/screenshot-image-gen.jpeg)

## Quick Start

```bash
npm install
cp .env.example .env      # edit with your token
npm start
```

Open `http://localhost:3700` in your browser.

## Configuration

Copy `.env.example` to `.env` and edit:

```bash
# Required for network access — set a secret token
SUBLIGHT_TOKEN=your-secret-here

# Bind address (default: 0.0.0.0 for LAN access)
HOST=0.0.0.0

# Port (default: 3700)
PORT=3700
```

## Architecture

```
Browser <--WebSocket--> Sublight Server <--stdin/stdout--> Claude CLI (persistent)
                              |                                  |
                              +<-- POST /artifact --<-- MCP artifact server
```

Each session spawns **one persistent Claude process** using `--input-format stream-json --output-format stream-json`. Messages are written to stdin, responses stream from stdout. The process stays alive across turns — no context reload, no re-spawn, significantly lower token cost per turn.

A custom MCP server (`artifact-mcp.js`) is injected via `--mcp-config` alongside existing project/global MCP servers. It gives Claude tools to push artifacts, images, diffs, and notifications to the browser.

## Features

### Sessions
- Create multiple concurrent sessions, each with its own Claude process
- Set working directory per session (with autocomplete from recent/open/filesystem)
- Rename sessions (double-click in sidebar)
- Export conversations to markdown
- Session logs saved as NDJSON in `logs/`

### Chat
- Multi-line input (Enter = newline, Ctrl+Enter = send)
- Streaming responses with markdown rendering and syntax highlighting
- Collapsible thinking blocks (purple) and tool use cards (blue)
- File attachments: click +, Ctrl+V paste screenshots, or drag-and-drop images
- Multimodal — attached images sent to Claude as base64 for vision analysis

### Artifact Panel
Claude has 9 MCP tools to push content to a side panel:

| Tool | Purpose |
|---|---|
| `show_image` | Display local image files |
| `show_artifact` | Code/text with syntax highlighting |
| `show_markdown` | Full markdown documents |
| `show_diff` | Color-coded unified diffs |
| `show_progress` | Animated progress bar |
| `notify` | Toast notification |
| `open_url` | Open URL in new tab (with user confirmation) |
| `pin_artifact` | Pin artifacts to top of panel |
| `set_session_name` | Rename the session |

Artifacts are individually exportable (hover to reveal Save button).

### Notes
- Per-session scratch space (Notes panel)
- Multiple note cards per session, auto-saved to localStorage
- Not sent to Claude — private working memory for the user

## Security Warnings

**This is a local development tool, not a production web application.** Understand these caveats before running it:

- **Sessions inherit your global Claude config.** Sublight spawns the `claude` CLI as a child process, so whatever MCP servers, plugins, hooks, allowed-tools rules, and permissions live in your `~/.claude.json` come along for the ride. Sublight's own MCP server (`sublight-artifacts`) is added on top via `--mcp-config`. If Claude is authorized to do something in your terminal, it is authorized to do it from a Sublight session.

- **Per-session permission mode is your call.** The new-session dialog lets you pick between "skip permission prompts" (passes `--dangerously-skip-permissions`) and the default mode. Skip-permissions runs Claude unrestricted on the session's working directory. Only point it at directories you trust.

- **`/local-file` serves images from any filesystem path.** The endpoint is restricted to image file extensions (.png, .jpg, etc.) and requires auth, but there is no directory allowlist. Any authenticated user can request any image file on the server's filesystem.

- **`/browse_dir` lists directories on the server.** The folder picker's autocomplete can enumerate directories anywhere on the filesystem. Auth-gated but not path-restricted.

- **Single shared token for auth.** Authentication is a single bearer token, stored in `settings.json` or pinned via `.env`. Not a multi-user system. Anyone with the token has full access to all sessions.

- **No TLS.** The server runs plain HTTP/WS. If you expose it beyond localhost, use a reverse proxy with TLS (nginx, Caddy, etc.).

- **`open_url` requires user confirmation** but other sublight-artifacts MCP tools (show_image, show_markdown, show_diff, notify, etc.) execute without prompting. Claude can push arbitrary images, code, and markdown to the artifact panel automatically.

### Known Limitations

- **Non-bypass sessions hang on tools that require a permission prompt.** Claude Code's interactive permission flow expects a terminal that Sublight doesn't give it. We attempted to route prompts through a `--permission-prompt-tool` MCP tool, but Claude Code's validator for that flag only inspects servers from the user's global Claude config — not servers loaded via `--mcp-config`, which is how Sublight provides its own tools. Until upstream lifts that restriction (or we register `sublight-artifacts` in the global config), non-bypass sessions silently block on any tool call that would normally ask for permission. If you need unattended tool execution, use "skip permission prompts" when creating a session.

- **Sessions are in-memory but logs persist.** If the server restarts, active WebSocket sessions drop. The NDJSON transcripts in `logs/` remain, and the Sessions Logs → Resume button will reopen them via `claude --resume`, lazily re-spawning the child process on the next message.

### Recommended Deployment

For local-only use (single machine):
```bash
HOST=127.0.0.1
SUBLIGHT_TOKEN=  # optional when localhost-only
```

For LAN access (trusted network):
```bash
HOST=0.0.0.0
SUBLIGHT_TOKEN=a-strong-random-token
```

Do not expose to the public internet without a reverse proxy, TLS, and additional access controls.

## Requirements

- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude CLI must be in PATH

## Development

```bash
npm run dev    # auto-restart on file changes
```

## File Structure

```
sublight-webui/
├── server.js           # Express + WebSocket server, persistent process management
├── artifact-mcp.js     # MCP server with 9 tools for browser artifact display
├── public/
│   ├── index.html      # SPA shell
│   ├── app.js          # Frontend logic (sessions, streaming, artifacts, attachments)
│   └── style.css       # Dark theme
├── assets/             # Screenshots for README
├── logs/               # Per-session NDJSON logs (gitignored)
├── .env.example        # Configuration reference
└── package.json
```
