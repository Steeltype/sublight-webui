// Artifacts panel — renders images, code, diffs, markdown, and progress bars
// that Claude pushes via MCP tools (show_image, show_artifact, show_diff,
// show_markdown, show_progress, pin_artifact, open_url).
//
// The panel's visibility toggle is a thin wrapper; the heavy lifting is in
// renderArtifacts() and renderArtifactCard().

import { state } from './state.js';
import { authFetch, authUrl } from './auth.js';
import { confirm } from './confirm.js';
import { downloadBlob } from './export.js';
import { setMarkdownContent } from './markdown.js';
import { send } from './ws.js';

const $artifactsList  = document.getElementById('artifacts-list');
const $artifactsPanel = document.getElementById('artifacts-panel');

/** Map<sessionId, Map<progressId, {label, percent, done}>> */
const progressBars = new Map();

export function getProgressBars(sessionId) {
  return progressBars.get(sessionId) || new Map();
}

export function renderArtifacts() {
  if (!state.activeId) return;
  const session = state.sessions.get(state.activeId);
  const artifacts = state.artifacts.get(state.activeId) || [];
  const humanTodos = session?.humanTodos || new Map();
  $artifactsList.replaceChildren();

  if (artifacts.length === 0 && !getProgressBars(state.activeId).size && humanTodos.size === 0) {
    const empty = document.createElement('p');
    empty.className = 'artifacts-empty';
    empty.textContent = 'No artifacts yet. Claude can use show_image, show_artifact, show_diff, and other tools to display content here.';
    $artifactsList.appendChild(empty);
    return;
  }

  // Human todos first — the user's attention is the scarcest resource, and
  // these are the only artifact type that asks them to do something.
  for (const [, todo] of humanTodos) {
    const card = renderHumanTodoCard(state.activeId, todo);
    if (card) $artifactsList.appendChild(card);
  }

  // Progress bars, then pinned artifacts, then the rest.
  for (const [, prog] of getProgressBars(state.activeId)) {
    const bar = document.createElement('div');
    bar.className = 'artifact-progress' + (prog.done ? ' done' : '');
    const label = document.createElement('div');
    label.className = 'progress-label';
    label.textContent = prog.label;
    bar.appendChild(label);
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${prog.percent}%`;
    track.appendChild(fill);
    bar.appendChild(track);
    const pct = document.createElement('div');
    pct.className = 'progress-pct';
    pct.textContent = prog.done ? 'Done' : `${prog.percent}%`;
    bar.appendChild(pct);
    $artifactsList.appendChild(bar);
  }

  const pinned = artifacts.filter((a) => a.pinned);
  const unpinned = artifacts.filter((a) => !a.pinned);
  for (const artifact of [...pinned, ...unpinned]) {
    const card = renderArtifactCard(artifact);
    if (card) $artifactsList.appendChild(card);
  }

  $artifactsList.scrollTop = $artifactsList.scrollHeight;
}

function renderArtifactCard(artifact) {
  const card = document.createElement('div');
  card.className = 'artifact-card' + (artifact.pinned ? ' pinned' : '');

  if (artifact.type === 'image') {
    const img = document.createElement('img');
    img.src = authUrl(`/local-file?path=${encodeURIComponent(artifact.path)}`);
    img.alt = artifact.caption || 'Image artifact';
    img.loading = 'lazy';
    card.appendChild(img);
    if (artifact.caption) {
      const cap = document.createElement('div');
      cap.className = 'artifact-caption';
      cap.textContent = artifact.caption;
      card.appendChild(cap);
    }
  } else if (artifact.type === 'code') {
    const title = document.createElement('div');
    title.className = 'artifact-title';
    title.textContent = artifact.title;
    card.appendChild(title);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = artifact.content;
    if (artifact.language) {
      code.className = `language-${artifact.language}`;
      hljs.highlightElement(code);
    }
    pre.appendChild(code);
    card.appendChild(pre);
  } else if (artifact.type === 'diff') {
    const title = document.createElement('div');
    title.className = 'artifact-title';
    title.textContent = artifact.title;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'diff-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy raw diff to clipboard';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(artifact.diff);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch (err) {
        console.error('Clipboard copy failed:', err);
      }
    });
    title.appendChild(copyBtn);
    card.appendChild(title);

    // Quick +added / -removed stat over the whole diff.
    let added = 0, removed = 0;
    const lines = artifact.diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    if (added || removed) {
      const stat = document.createElement('div');
      stat.className = 'diff-stat';
      const addSpan = document.createElement('span');
      addSpan.className = 'diff-add';
      addSpan.textContent = `+${added}`;
      const rmSpan = document.createElement('span');
      rmSpan.className = 'diff-remove';
      rmSpan.textContent = `\u2212${removed}`;
      stat.append(addSpan, ' ', rmSpan);
      card.appendChild(stat);
    }

    const pre = document.createElement('pre');
    pre.className = 'diff-content';
    for (const line of lines) {
      const span = document.createElement('span');
      span.textContent = line + '\n';
      if (line.startsWith('+++') || line.startsWith('---')) {
        span.className = 'diff-file';
      } else if (line.startsWith('+')) {
        span.className = 'diff-add';
      } else if (line.startsWith('-')) {
        span.className = 'diff-remove';
      } else if (line.startsWith('@@')) {
        span.className = 'diff-hunk';
      }
      pre.appendChild(span);
    }
    card.appendChild(pre);
  } else if (artifact.type === 'markdown') {
    const title = document.createElement('div');
    title.className = 'artifact-title';
    title.textContent = artifact.title;
    card.appendChild(title);
    const body = document.createElement('div');
    body.className = 'artifact-markdown';
    setMarkdownContent(body, artifact.markdown);
    card.appendChild(body);
  } else {
    return null;
  }

  // Export button on every card.
  const exportBtn = document.createElement('button');
  exportBtn.className = 'artifact-export';
  exportBtn.textContent = 'Save';
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportArtifact(artifact);
  });
  card.appendChild(exportBtn);

  return card;
}

function exportArtifact(artifact) {
  let blob, filename;

  if (artifact.type === 'image') {
    authFetch(`/local-file?path=${encodeURIComponent(artifact.path)}`)
      .then((r) => r.blob())
      .then((b) => {
        const ext = artifact.path.split('.').pop() || 'png';
        downloadBlob(b, `artifact.${ext}`);
      });
    return;
  } else if (artifact.type === 'code') {
    const ext = artifact.language
      ? { javascript: 'js', python: 'py', typescript: 'ts', html: 'html', css: 'css', json: 'json' }[artifact.language] || 'txt'
      : 'txt';
    blob = new Blob([artifact.content], { type: 'text/plain' });
    filename = `${artifact.title || 'artifact'}.${ext}`;
  } else if (artifact.type === 'diff') {
    blob = new Blob([artifact.diff], { type: 'text/plain' });
    filename = `${artifact.title || 'artifact'}.diff`;
  } else if (artifact.type === 'markdown') {
    blob = new Blob([artifact.markdown], { type: 'text/markdown' });
    filename = `${artifact.title || 'artifact'}.md`;
  } else {
    return;
  }

  downloadBlob(blob, filename);
}

export function handleProgress(sessionId, artifact) {
  if (!progressBars.has(sessionId)) progressBars.set(sessionId, new Map());
  const bars = progressBars.get(sessionId);

  if (artifact.done) {
    bars.set(artifact.id, { ...artifact });
    if (sessionId === state.activeId) renderArtifacts();
    setTimeout(() => {
      bars.delete(artifact.id);
      if (sessionId === state.activeId) renderArtifacts();
    }, 3000);
  } else {
    bars.set(artifact.id, artifact);
    if (sessionId === state.activeId) renderArtifacts();
  }

  if (!state.artifactsVisible) {
    state.artifactsVisible = true;
    $artifactsPanel.classList.remove('hidden');
  }
}

export function handlePin(sessionId, index) {
  const artifacts = state.artifacts.get(sessionId);
  if (!artifacts) return;
  const idx = index < 0 ? artifacts.length + index : index;
  if (idx >= 0 && idx < artifacts.length) {
    artifacts[idx].pinned = true;
    if (sessionId === state.activeId) renderArtifacts();
  }
}

// ---------------------------------------------------------------------------
// Human todos — checklists Claude pushes for the operator to act on.
// Item state is stored in localStorage so it survives refresh. Claude's
// `done` flag is the initial state; the user's toggle overrides from there.
// ---------------------------------------------------------------------------

function todoKey(sessionId, todoId, itemId) {
  return `sublight-human-todo:${sessionId}:${todoId}:${itemId}`;
}

function getItemChecked(sessionId, todoId, itemId, fromClaude) {
  const val = localStorage.getItem(todoKey(sessionId, todoId, itemId));
  if (val === null) return !!fromClaude;
  return val === '1';
}

function setItemChecked(sessionId, todoId, itemId, checked) {
  localStorage.setItem(todoKey(sessionId, todoId, itemId), checked ? '1' : '0');
}

/** Delete every checkbox-state key for a specific session. Called when the
 *  session's log is deleted so we don't leave orphan entries behind. */
export function clearHumanTodoStorage(sessionId) {
  if (!sessionId) return;
  const prefix = `sublight-human-todo:${sessionId}:`;
  // Collect first, then delete — removing during iteration would shift
  // indices and we'd skip keys.
  const victims = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) victims.push(key);
  }
  for (const key of victims) localStorage.removeItem(key);
}

/** Sweep every checkbox-state key whose sessionId is not in the provided set.
 *  Used after the "delete all inactive logs" bulk action. */
export function clearHumanTodoStorageExcept(keepSessionIds) {
  const keep = keepSessionIds instanceof Set ? keepSessionIds : new Set(keepSessionIds || []);
  const prefix = 'sublight-human-todo:';
  const victims = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    // Key shape: sublight-human-todo:<sessionId>:<todoId>:<itemId>
    const sessionId = key.slice(prefix.length).split(':', 1)[0];
    if (!keep.has(sessionId)) victims.push(key);
  }
  for (const key of victims) localStorage.removeItem(key);
}

export function hasPendingHumanTodos(session) {
  if (!session?.humanTodos || session.humanTodos.size === 0) return false;
  for (const [todoId, todo] of session.humanTodos) {
    for (const item of todo.items || []) {
      if (!getItemChecked(session.id, todoId, item.id, item.done)) return true;
    }
  }
  return false;
}

function countChecked(sessionId, todo) {
  let n = 0;
  for (const item of todo.items || []) {
    if (getItemChecked(sessionId, todo.id, item.id, item.done)) n++;
  }
  return n;
}

function renderHumanTodoCard(sessionId, todo) {
  const card = document.createElement('div');
  card.className = 'artifact-card human-todo-card';
  const total = (todo.items || []).length;
  let checked = countChecked(sessionId, todo);
  if (total > 0 && checked === total) card.classList.add('all-done');

  const header = document.createElement('div');
  header.className = 'artifact-title human-todo-title';

  const label = document.createElement('span');
  label.textContent = todo.title || 'For you to do';
  header.appendChild(label);

  const progress = document.createElement('span');
  progress.className = 'human-todo-progress';
  progress.textContent = `${checked}/${total}`;
  header.appendChild(progress);

  card.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'human-todo-items';

  for (const item of todo.items || []) {
    const li = document.createElement('li');
    li.className = 'human-todo-item';

    const labelEl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const isChecked = getItemChecked(sessionId, todo.id, item.id, item.done);
    cb.checked = isChecked;
    if (isChecked) li.classList.add('checked');

    cb.addEventListener('change', () => {
      setItemChecked(sessionId, todo.id, item.id, cb.checked);
      li.classList.toggle('checked', cb.checked);
      checked = countChecked(sessionId, todo);
      progress.textContent = `${checked}/${total}`;
      card.classList.toggle('all-done', total > 0 && checked === total);
      document.dispatchEvent(new CustomEvent('human-todo-changed', {
        detail: { sessionId },
      }));
    });

    const text = document.createElement('span');
    text.className = 'human-todo-text';
    text.textContent = item.text;

    labelEl.appendChild(cb);
    labelEl.appendChild(text);
    li.appendChild(labelEl);
    list.appendChild(li);
  }

  card.appendChild(list);
  return card;
}

export async function handleOpenUrl(artifact) {
  const label = artifact.label || artifact.url;
  const ok = await confirm(`Claude wants to open a URL:\n\n${label}\n\n${artifact.url}`);
  send({ type: 'url_response', requestId: artifact.requestId, opened: ok });
  if (ok) {
    window.open(artifact.url, '_blank', 'noopener,noreferrer');
  }
}

document.getElementById('btn-artifacts').addEventListener('click', () => {
  state.artifactsVisible = !state.artifactsVisible;
  $artifactsPanel.classList.toggle('hidden', !state.artifactsVisible);
  if (state.artifactsVisible) renderArtifacts();
});
