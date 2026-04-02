# Sublight WebUI

A lightweight web interface for Claude CLI that wraps persistent Claude Code sessions with a multi-session chat UI, artifact panel, and custom MCP tools.

## Quick Start

```bash
npm install
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

### Security
- Token-based auth via `.env` (WebSocket upgrade validation)
- Helmet.js security headers with CSP
- DOMPurify sanitization on all rendered HTML
- SRI integrity hashes on all CDN resources
- Per-connection session ownership (no UUID guessing)
- Graceful shutdown with child process cleanup
- Confirmation dialogs for destructive actions

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
├── logs/               # Per-session NDJSON logs (gitignored)
├── .env.example        # Configuration reference
└── package.json
```
