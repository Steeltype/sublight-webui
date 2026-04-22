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

server.tool(
  'human_todo',
  'Post a checklist of actions the human operator needs to perform (run a local command, authenticate with a service, check an external dashboard, approve a deploy, etc.). The checklist appears in the artifact panel with checkboxes the user can tick off as they complete each step. The sidebar shows a distinct indicator for sessions that have unchecked items, so the human notices when you are waiting on them. Call again with the same id to update an existing checklist — replace the items array to add/remove items or mark items as already done. Use this instead of burying instructions in a prose reply whenever you need the human to take concrete steps outside the session.',
  {
    id: z.string().describe('Stable id for this checklist. Reuse to update an existing one.'),
    title: z.string().optional().describe('Optional heading (defaults to "For you to do").'),
    items: z.array(z.object({
      id: z.string().describe('Stable id for this item so the user\'s check marks survive updates.'),
      text: z.string().describe('What the human needs to do.'),
      done: z.boolean().optional().describe('Pre-check the item. Use when you know it is already complete. The user can still toggle it.'),
    })).min(1).describe('Ordered list of items.'),
  },
  async ({ id, title, items }) => {
    const result = await postArtifact({ type: 'human_todo', id, title: title || null, items });
    const pending = items.filter((i) => !i.done).length;
    return { content: [{ type: 'text', text: result.error || `human_todo posted (${pending}/${items.length} pending)` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
