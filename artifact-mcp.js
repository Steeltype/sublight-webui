/**
 * Sublight Artifact MCP Server
 *
 * Gives Claude tools to push artifacts (images, code, text, diffs,
 * progress updates, etc.) to the Sublight WebUI. Communicates back
 * to the main Sublight server via a local HTTP POST.
 *
 * Started automatically by Sublight when spawning a Claude session.
 * Receives SUBLIGHT_ARTIFACT_URL and SUBLIGHT_SESSION_ID as env vars.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ARTIFACT_URL = process.env.SUBLIGHT_ARTIFACT_URL;
const SESSION_ID = process.env.SUBLIGHT_SESSION_ID;
const ARTIFACT_SECRET = process.env.SUBLIGHT_ARTIFACT_SECRET;

async function postArtifact(artifact) {
  if (!ARTIFACT_URL) {
    return { error: 'SUBLIGHT_ARTIFACT_URL not set — artifact server misconfigured' };
  }
  try {
    const res = await fetch(ARTIFACT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Artifact-Secret': ARTIFACT_SECRET || '',
      },
      body: JSON.stringify({ sessionId: SESSION_ID, ...artifact }),
    });
    if (!res.ok) return { error: `Artifact POST failed: ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return data;
  } catch (err) {
    return { error: `Artifact POST failed: ${err.message}` };
  }
}

const server = new McpServer({
  name: 'sublight-artifacts',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Existing tools
// ---------------------------------------------------------------------------

server.tool(
  'show_image',
  'Display an image in the Sublight artifact panel. Use this after generating or finding an image file.',
  {
    path: z.string().describe('Absolute path to the image file on disk'),
    caption: z.string().optional().describe('Optional caption for the image'),
  },
  async ({ path, caption }) => {
    const result = await postArtifact({ type: 'image', path, caption: caption || null });
    return { content: [{ type: 'text', text: result.error || `Image displayed: ${path}` }] };
  },
);

server.tool(
  'show_artifact',
  'Display a text/code artifact in the Sublight artifact panel with syntax highlighting.',
  {
    title: z.string().describe('Title for the artifact'),
    content: z.string().describe('The artifact content (code or plain text)'),
    language: z.string().optional().describe('Language for syntax highlighting (e.g. "javascript", "python"). Omit for plain text.'),
  },
  async ({ title, content, language }) => {
    const result = await postArtifact({ type: 'code', title, content, language: language || null });
    return { content: [{ type: 'text', text: result.error || `Artifact displayed: ${title}` }] };
  },
);

server.tool(
  'notify',
  'Show a brief notification toast in the Sublight UI.',
  {
    message: z.string().describe('Notification message to display'),
  },
  async ({ message }) => {
    const result = await postArtifact({ type: 'notification', message });
    return { content: [{ type: 'text', text: result.error || 'Notification sent' }] };
  },
);

// ---------------------------------------------------------------------------
// New tools
// ---------------------------------------------------------------------------

server.tool(
  'show_progress',
  'Show or update a progress indicator in the artifact panel. Call repeatedly to update progress during long operations. Use the same id to update an existing progress bar.',
  {
    id: z.string().describe('Unique identifier for this progress bar (reuse to update)'),
    label: z.string().describe('Description of the operation (e.g. "Generating image...")'),
    percent: z.number().min(0).max(100).describe('Progress percentage (0-100)'),
    done: z.boolean().optional().describe('Set to true when the operation is complete'),
  },
  async ({ id, label, percent, done }) => {
    const result = await postArtifact({ type: 'progress', id, label, percent, done: done || false });
    return { content: [{ type: 'text', text: result.error || `Progress: ${label} ${percent}%` }] };
  },
);

server.tool(
  'show_diff',
  'Display a unified diff in the artifact panel for visual review of file changes.',
  {
    title: z.string().describe('Title for the diff (e.g. filename or description)'),
    diff: z.string().describe('Unified diff content (the output of git diff or similar)'),
  },
  async ({ title, diff }) => {
    const result = await postArtifact({ type: 'diff', title, diff });
    return { content: [{ type: 'text', text: result.error || `Diff displayed: ${title}` }] };
  },
);

server.tool(
  'open_url',
  'Request to open a URL in the user\'s browser. The user will see a confirmation dialog before the URL opens. Use for documentation links, PRs, dashboards, etc.',
  {
    url: z.string().describe('The URL to open'),
    label: z.string().optional().describe('Human-readable description of what this link is'),
  },
  async ({ url, label }) => {
    const result = await postArtifact({ type: 'open_url', url, label: label || null });
    if (result.opened) {
      return { content: [{ type: 'text', text: `URL opened: ${url}` }] };
    } else if (result.declined) {
      return { content: [{ type: 'text', text: `User declined to open: ${url}` }] };
    }
    return { content: [{ type: 'text', text: result.error || `URL open requested: ${url}` }] };
  },
);

server.tool(
  'pin_artifact',
  'Pin an artifact to keep it visible at the top of the artifact panel. Pinned artifacts do not scroll away when new ones arrive.',
  {
    index: z.number().describe('Index of the artifact to pin (0 = first/oldest, -1 = latest)'),
  },
  async ({ index }) => {
    const result = await postArtifact({ type: 'pin', index });
    return { content: [{ type: 'text', text: result.error || `Artifact pinned` }] };
  },
);

server.tool(
  'set_session_name',
  'Rename the current Sublight session. The new name appears in the sidebar and header.',
  {
    name: z.string().describe('New session name'),
  },
  async ({ name }) => {
    const result = await postArtifact({ type: 'set_session_name', name });
    return { content: [{ type: 'text', text: result.error || `Session renamed to: ${name}` }] };
  },
);

// ---------------------------------------------------------------------------
// Permission prompt — wired to Claude via --permission-prompt-tool
// ---------------------------------------------------------------------------
//
// When Claude needs to confirm a tool call, it invokes this tool with the
// requested tool_name + input. We bounce the request to the Sublight server,
// which forwards it to the browser, shows a modal, and waits for the user's
// decision. The tool must return a JSON text block with shape:
//   { behavior: "allow", updatedInput: <original or edited input> }
//   { behavior: "deny",  message: "<reason>" }

server.tool(
  'permission_prompt',
  'Internal: Sublight WebUI permission prompt handler. Not called directly by users.',
  {
    tool_name: z.string(),
    input: z.record(z.any()),
    tool_use_id: z.string().optional(),
  },
  async ({ tool_name, input, tool_use_id }) => {
    const result = await postArtifact({
      type: 'permission_request',
      toolName: tool_name,
      input,
      toolUseId: tool_use_id || null,
    });

    // Server returns { behavior, updatedInput?, message? } after the user decides.
    let decision;
    if (result && (result.behavior === 'allow' || result.behavior === 'deny')) {
      decision = {
        behavior: result.behavior,
        updatedInput: result.behavior === 'allow' ? (result.updatedInput || input) : undefined,
        message: result.behavior === 'deny' ? (result.message || 'User denied permission in Sublight UI') : undefined,
      };
    } else {
      // Error path (timeout, server down, transport failure) — fail closed.
      decision = {
        behavior: 'deny',
        message: result?.error || 'Sublight permission prompt failed — denying by default',
      };
    }
    // Strip undefined fields before serializing.
    const payload = Object.fromEntries(Object.entries(decision).filter(([, v]) => v !== undefined));
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  },
);

server.tool(
  'show_markdown',
  'Render a full markdown document in the artifact panel. Supports headings, lists, code blocks, tables, and other standard markdown. Use for generated documentation, READMEs, reports, etc.',
  {
    title: z.string().describe('Title for the document'),
    markdown: z.string().describe('Markdown content to render'),
  },
  async ({ title, markdown }) => {
    const result = await postArtifact({ type: 'markdown', title, markdown });
    return { content: [{ type: 'text', text: result.error || `Markdown displayed: ${title}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
