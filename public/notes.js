// Notes panel — per-session scratch space. Persisted on the server via
// /api/notes/:sessionId so notes survive browser changes and server
// migrations. localStorage keeps a staged copy for offline edits and a
// one-time migration source for notes created before server persistence.

import { state } from './state.js';
import { confirm } from './confirm.js';
import { authFetch } from './auth.js';
import { showToast } from './toast.js';

const $notesList  = document.getElementById('notes-list');
const $notesPanel = document.getElementById('notes-panel');

function notesKey(sessionId) {
  return `sublight_notes_${sessionId}`;
}

function loadLocalNotes(sessionId) {
  try {
    return JSON.parse(localStorage.getItem(notesKey(sessionId))) || [];
  } catch {
    return [];
  }
}

function saveLocalNotes(sessionId, notes) {
  localStorage.setItem(notesKey(sessionId), JSON.stringify(notes));
}

function clearLocalNotes(sessionId) {
  localStorage.removeItem(notesKey(sessionId));
}

export function removeSessionNotes(sessionId) {
  // Server-side notes are cleaned up when the session log is deleted; we
  // only clear the local staging copy here.
  clearLocalNotes(sessionId);
}

/** Per-session in-memory cache so edits don't round-trip to the server on
 *  every keystroke — we debounce writes through syncNotes(). */
const notesCache = new Map();

async function fetchNotesForSession(sessionId) {
  if (notesCache.has(sessionId)) return notesCache.get(sessionId);
  try {
    const res = await authFetch(`/api/notes/${sessionId}`);
    if (res.ok) {
      const body = await res.json();
      let notes = Array.isArray(body.notes) ? body.notes : [];
      // One-time migration: if the server has nothing but there are local
      // notes from before server persistence, push them up.
      if (notes.length === 0) {
        const local = loadLocalNotes(sessionId);
        if (local.length > 0) {
          notes = local;
          await putNotes(sessionId, notes);
          clearLocalNotes(sessionId);
        }
      } else {
        // Server state wins — forget any stale local copy.
        clearLocalNotes(sessionId);
      }
      notesCache.set(sessionId, notes);
      return notes;
    }
  } catch (err) {
    console.error('notes fetch failed', err);
  }
  // Fallback to local copy so the panel still works offline.
  const local = loadLocalNotes(sessionId);
  notesCache.set(sessionId, local);
  return local;
}

async function putNotes(sessionId, notes) {
  try {
    const res = await authFetch(`/api/notes/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    if (!res.ok) throw new Error(`PUT /api/notes returned ${res.status}`);
  } catch (err) {
    console.error('notes PUT failed — falling back to localStorage', err);
    saveLocalNotes(sessionId, notes);
    showToast('Notes save failed — cached locally, will retry on next edit');
  }
}

/** Debounced write. Accumulates rapid edits into a single PUT. */
let syncTimer = null;
let syncSessionId = null;
function scheduleSync(sessionId) {
  if (syncTimer && syncSessionId !== sessionId) {
    // Flush the pending write for the previous session synchronously (well,
    // as synchronously as we can) before accepting edits for a new one.
    clearTimeout(syncTimer);
    const pending = notesCache.get(syncSessionId);
    if (pending) putNotes(syncSessionId, pending);
  }
  syncSessionId = sessionId;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const notes = notesCache.get(sessionId);
    if (notes) putNotes(sessionId, notes);
    syncTimer = null;
  }, 600);
}

export async function renderNotes() {
  if (!state.activeId) return;
  const sessionId = state.activeId;
  const notes = await fetchNotesForSession(sessionId);
  // Guard against the user switching sessions while we were fetching.
  if (state.activeId !== sessionId) return;

  $notesList.replaceChildren();

  if (notes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'notes-empty';
    empty.textContent = 'No notes yet. Click + to add one.';
    $notesList.appendChild(empty);
    return;
  }

  for (let i = 0; i < notes.length; i++) {
    const card = document.createElement('div');
    card.className = 'note-card';

    const textarea = document.createElement('textarea');
    textarea.className = 'note-textarea';
    textarea.value = notes[i].text;
    textarea.placeholder = 'Write a note...';
    textarea.rows = 3;

    const idx = i;
    textarea.addEventListener('input', () => {
      const current = notesCache.get(sessionId);
      if (current && current[idx]) {
        current[idx].text = textarea.value;
        scheduleSync(sessionId);
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-delete';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete note';
    deleteBtn.setAttribute('aria-label', 'Delete note');
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirm('Delete this note?');
      if (!ok) return;
      const current = notesCache.get(sessionId);
      if (current) {
        current.splice(idx, 1);
        scheduleSync(sessionId);
      }
      renderNotes();
    });

    card.appendChild(deleteBtn);
    card.appendChild(textarea);
    $notesList.appendChild(card);
  }
}

document.getElementById('btn-add-note').addEventListener('click', async () => {
  if (!state.activeId) return;
  const sessionId = state.activeId;
  const notes = await fetchNotesForSession(sessionId);
  if (state.activeId !== sessionId) return;
  notes.push({ text: '', createdAt: new Date().toISOString() });
  scheduleSync(sessionId);
  await renderNotes();
  const last = $notesList.querySelector('.note-card:last-child .note-textarea');
  if (last) last.focus();
});

document.getElementById('btn-notes').addEventListener('click', () => {
  state.notesVisible = !state.notesVisible;
  $notesPanel.classList.toggle('hidden', !state.notesVisible);
  if (state.notesVisible) renderNotes();
});

// Flush any pending write if the user navigates away / closes the tab.
window.addEventListener('beforeunload', () => {
  if (syncTimer && syncSessionId) {
    clearTimeout(syncTimer);
    const notes = notesCache.get(syncSessionId);
    if (notes) {
      // sendBeacon is the right primitive for shutdown writes but it doesn't
      // support auth headers; fall back to a sync XHR-equivalent via fetch
      // with keepalive so the request survives teardown.
      try {
        fetch(`/api/notes/${syncSessionId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: state.authToken ? `Bearer ${state.authToken}` : '',
          },
          body: JSON.stringify({ notes }),
          keepalive: true,
        });
      } catch {}
    }
  }
});
