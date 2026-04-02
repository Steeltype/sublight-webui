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

**This is a local development tool, not a production web application.** Understand these limitations before running it:

- **`--dangerously-skip-permissions` is enabled by default.** Every Claude session runs with full tool access (file read/write, shell execution, MCP tools) without interactive permission prompts. This is necessary for the headless streaming mode but means Claude can execute any command in the session's working directory. Only point sessions at directories you trust.

- **`/local-file` serves images from any filesystem path.** The endpoint is restricted to image file extensions (.png, .jpg, etc.) and requires auth, but there is no directory allowlist. Any authenticated user can request any image file on the server's filesystem.

- **`/browse_dir` lists directories on the server.** The folder picker's autocomplete can enumerate directories anywhere on the filesystem. Auth-gated but not path-restricted.

- **Single shared token for auth.** Authentication is a single bearer token in `.env`, not a multi-user system. Anyone with the token has full access to all sessions.

- **Sessions are in-memory.** If the server restarts, all active sessions and their conversation history are lost. Session logs persist in `logs/` but cannot be resumed.

- **No TLS.** The server runs plain HTTP/WS. If you expose it beyond localhost, use a reverse proxy with TLS (nginx, Caddy, etc.).

- **`open_url` requires user confirmation** but the other 8 MCP tools execute without prompting. Claude can push arbitrary images, code, and markdown to the artifact panel automatically.

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
