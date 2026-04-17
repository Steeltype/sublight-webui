// Session export — Save (markdown transcript) and Bundle (zip of transcript,
// raw NDJSON, artifacts, and metadata).
//
// downloadBlob is exported so other modules (artifacts.js) can reuse the
// same object-URL dance without duplicating it.

import { state } from './state.js';
import { authFetch } from './auth.js';
import { showToast } from './toast.js';

/** Render the current session's in-memory messages to a markdown transcript. */
function buildMarkdownTranscript(session) {
  let md = `# Session: ${session.name}\n`;
  md += `> cwd: ${session.cwd}\n`;
  if (session.costUsd != null) md += `> cost: $${session.costUsd.toFixed(4)}\n`;
  md += `> exported: ${new Date().toISOString()}\n\n---\n\n`;

  for (const msg of session.messages) {
    // Tag subagent lines so the flat markdown still hints at the nesting.
    const tag = msg.parentToolUseId ? ' _(subagent)_' : '';
    switch (msg.role) {
      case 'user':
        md += `## User${tag}\n\n${msg.text}\n\n`;
        break;
      case 'assistant':
        md += `## Assistant${tag}\n\n${msg.text}\n\n`;
        break;
      case 'thinking':
        md += `<details><summary>Thinking${tag}</summary>\n\n${msg.text}\n\n</details>\n\n`;
        break;
      case 'tool':
        md += `### Tool: ${msg.name}${tag}\n\n\`\`\`json\n${typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input, null, 2)}\n\`\`\`\n\n`;
        if (msg.result != null) md += `**Result:**\n\`\`\`\n${msg.result}\n\`\`\`\n\n`;
        break;
      case 'error':
        md += `> **Error:**${tag} ${msg.text}\n\n`;
        break;
    }
  }
  return md;
}

/** Sanitize a session name for use as a filename. */
export function safeFilename(name) {
  return (name || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('btn-save').addEventListener('click', () => {
  const session = state.sessions.get(state.activeId);
  if (!session) return;
  const md = buildMarkdownTranscript(session);
  const blob = new Blob([md], { type: 'text/markdown' });
  downloadBlob(blob, `${safeFilename(session.name)}-${new Date().toISOString().slice(0, 10)}.md`);
});

document.getElementById('btn-bundle').addEventListener('click', async () => {
  const session = state.sessions.get(state.activeId);
  if (!session) return;
  const btn = document.getElementById('btn-bundle');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Bundling\u2026';

  try {
    const zip = new JSZip();

    // 1. Markdown transcript built from live session state.
    zip.file('transcript.md', buildMarkdownTranscript(session));

    // 2. Raw NDJSON log from the server — source of truth for the session.
    try {
      const logRes = await authFetch(`/api/logs/${session.id}`);
      if (logRes.ok) {
        zip.file('transcript.ndjson', await logRes.text());
      }
    } catch (err) {
      console.error('bundle: log fetch failed', err);
    }

    // 3. Bundled artifacts. For each image artifact we know about, fetch the
    // file from /local-file and drop it into artifacts/ with a sequential
    // filename so clashes are impossible. Non-image artifacts get inlined
    // into an artifacts.md index so nothing is lost.
    const artifactsList = state.artifacts.get(session.id) || [];
    const artifactIndexLines = ['# Artifacts\n'];
    let imageIndex = 0;
    for (const a of artifactsList) {
      if (a.type === 'image' && a.path) {
        try {
          const r = await authFetch(`/local-file?path=${encodeURIComponent(a.path)}`);
          if (r.ok) {
            const blob = await r.blob();
            const ext = (a.path.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
            const filename = `artifacts/image-${String(imageIndex++).padStart(3, '0')}.${ext}`;
            zip.file(filename, await blob.arrayBuffer());
            artifactIndexLines.push(`- ![${a.caption || a.path}](${filename})`);
            if (a.caption) artifactIndexLines.push(`  ${a.caption}`);
            artifactIndexLines.push('');
          }
        } catch (err) {
          console.error('bundle: image fetch failed for', a.path, err);
        }
      } else if (a.type === 'code') {
        artifactIndexLines.push(`## ${a.title || 'Code'}`);
        artifactIndexLines.push('```' + (a.language || '') + '\n' + (a.content || '') + '\n```\n');
      } else if (a.type === 'markdown') {
        artifactIndexLines.push(`## ${a.title || 'Document'}\n`);
        artifactIndexLines.push((a.markdown || '') + '\n');
      } else if (a.type === 'diff') {
        artifactIndexLines.push(`## ${a.title || 'Diff'}`);
        artifactIndexLines.push('```diff\n' + (a.diff || '') + '\n```\n');
      }
    }
    if (artifactsList.length > 0) {
      zip.file('artifacts.md', artifactIndexLines.join('\n'));
    }

    // 4. Sidecar metadata so the bundle is self-describing.
    const meta = {
      sessionId: session.id,
      name: session.name,
      cwd: session.cwd,
      costUsd: session.costUsd,
      exportedAt: new Date().toISOString(),
      runtime: session.runtime || null,
      messageCount: session.messages.length,
      artifactCount: artifactsList.length,
    };
    zip.file('metadata.json', JSON.stringify(meta, null, 2));

    const blob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `sublight-${safeFilename(session.name)}-${stamp}.zip`);
  } catch (err) {
    console.error('bundle export failed', err);
    showToast('Bundle export failed — see console');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});
