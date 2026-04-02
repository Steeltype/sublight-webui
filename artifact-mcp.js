/**
 * Sublight Artifact MCP Server
 *
 * Gives Claude tools to push artifacts (images, code, text) to the
 * Sublight WebUI's artifact panel. Communicates back to the main
 * Sublight server via a local HTTP POST.
 *
 * Started automatically by Sublight when spawning a Claude session.
 * Receives SUBLIGHT_ARTIFACT_URL as an env var pointing to the
 * callback endpoint (e.g. http://localhost:3700/artifact).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ARTIFACT_URL = process.env.SUBLIGHT_ARTIFACT_URL;
const SESSION_ID = process.env.SUBLIGHT_SESSION_ID;

async function postArtifact(artifact) {
  if (!ARTIFACT_URL) {
    return { error: 'SUBLIGHT_ARTIFACT_URL not set — artifact server misconfigured' };
  }
  try {
    const res = await fetch(ARTIFACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, ...artifact }),
    });
    if (!res.ok) return { error: `Artifact POST failed: ${res.status}` };
    return { success: true };
  } catch (err) {
    return { error: `Artifact POST failed: ${err.message}` };
  }
}

const server = new McpServer({
  name: 'sublight-artifacts',
  version: '1.0.0',
});

server.tool(
  'show_image',
  'Display an image in the Sublight artifact panel. Use this after generating or finding an image file.',
  {
    path: z.string().describe('Absolute path to the image file on disk'),
    caption: z.string().optional().describe('Optional caption for the image'),
  },
  async ({ path, caption }) => {
    const result = await postArtifact({
      type: 'image',
      path,
      caption: caption || null,
    });
    return {
      content: [{ type: 'text', text: result.error || `Image displayed: ${path}` }],
    };
  },
);

server.tool(
  'show_artifact',
  'Display a text/code/HTML artifact in the Sublight artifact panel. Use this to present structured output to the user.',
  {
    title: z.string().describe('Title for the artifact'),
    content: z.string().describe('The artifact content (text, code, or HTML)'),
    language: z.string().optional().describe('Language for syntax highlighting (e.g. "javascript", "python"). Omit for plain text.'),
  },
  async ({ title, content, language }) => {
    const result = await postArtifact({
      type: 'code',
      title,
      content,
      language: language || null,
    });
    return {
      content: [{ type: 'text', text: result.error || `Artifact displayed: ${title}` }],
    };
  },
);

server.tool(
  'notify',
  'Show a brief notification toast in the Sublight UI.',
  {
    message: z.string().describe('Notification message to display'),
  },
  async ({ message }) => {
    const result = await postArtifact({
      type: 'notification',
      message,
    });
    return {
      content: [{ type: 'text', text: result.error || 'Notification sent' }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
