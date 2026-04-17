// Notes panel — per-session scratch space, stored in localStorage.
//
// Notes are not sent to Claude. They're a private working pad for the user
// that survives reload but not server migration (localStorage scope).

import { state } from './state.js';
import { confirm } from './confirm.js';

const $notesList  = document.getElementById('notes-list');
const $notesPanel = document.getElementById('notes-panel');

function notesKey(sessionId) {
  return `sublight_notes_${sessionId}`;
}

function loadNotes(sessionId) {
  try {
    return JSON.parse(localStorage.getItem(notesKey(sessionId))) || [];
  } catch {
    return [];
  }
}

function saveNotes(sessionId, notes) {
  localStorage.setItem(notesKey(sessionId), JSON.stringify(notes));
}

export function removeSessionNotes(sessionId) {
  localStorage.removeItem(notesKey(sessionId));
}

export function renderNotes() {
  if (!state.activeId) return;
  const notes = loadNotes(state.activeId);
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
      const current = loadNotes(state.activeId);
      if (current[idx]) {
        current[idx].text = textarea.value;
        saveNotes(state.activeId, current);
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-delete';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete note';
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirm('Delete this note?');
      if (!ok) return;
      const current = loadNotes(state.activeId);
      current.splice(idx, 1);
      saveNotes(state.activeId, current);
      renderNotes();
    });

    card.appendChild(deleteBtn);
    card.appendChild(textarea);
    $notesList.appendChild(card);
  }
}

document.getElementById('btn-add-note').addEventListener('click', () => {
  if (!state.activeId) return;
  const notes = loadNotes(state.activeId);
  notes.push({ text: '', createdAt: new Date().toISOString() });
  saveNotes(state.activeId, notes);
  renderNotes();
  const last = $notesList.querySelector('.note-card:last-child .note-textarea');
  if (last) last.focus();
});

document.getElementById('btn-notes').addEventListener('click', () => {
  state.notesVisible = !state.notesVisible;
  $notesPanel.classList.toggle('hidden', !state.notesVisible);
  if (state.notesVisible) renderNotes();
});
