// File attachments — upload, paste, drag-and-drop
//
// Owns the pending-attachment buffer that builds up as the user pastes
// screenshots, drops files on the messages pane, or clicks the attach button.
// app.js calls consumeAttachments() when submitting a message to hand over
// the buffered payloads and reset the UI.

const $attachBar = document.getElementById('attachments-bar');
const $fileInput = document.getElementById('file-input');
const $btnAttach = document.getElementById('btn-attach');
const $promptInput = document.getElementById('prompt-input');
const $messages = document.getElementById('messages');

/** Array of { file: File, dataUrl: string, base64: string, mediaType: string } */
const pendingAttachments = [];

$btnAttach.addEventListener('click', () => $fileInput.click());

$fileInput.addEventListener('change', () => {
  for (const file of $fileInput.files) {
    addAttachment(file);
  }
  $fileInput.value = '';
});

// Paste handler (screenshots from clipboard)
$promptInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addAttachment(file);
    }
  }
});

// Drag and drop on messages area
$messages.addEventListener('dragover', (e) => {
  e.preventDefault();
  $messages.classList.add('drag-over');
});

$messages.addEventListener('dragleave', () => {
  $messages.classList.remove('drag-over');
});

$messages.addEventListener('drop', (e) => {
  e.preventDefault();
  $messages.classList.remove('drag-over');
  for (const file of e.dataTransfer.files) {
    addAttachment(file);
  }
});

function addAttachment(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return;
    const [, mediaType, base64] = match;

    pendingAttachments.push({ file, dataUrl, base64, mediaType });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function removeAttachment(index) {
  pendingAttachments.splice(index, 1);
  renderAttachments();
}

function renderAttachments() {
  $attachBar.replaceChildren();
  if (pendingAttachments.length === 0) {
    $attachBar.classList.add('hidden');
    return;
  }
  $attachBar.classList.remove('hidden');

  pendingAttachments.forEach((att, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';

    if (att.mediaType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      thumb.appendChild(img);
    } else {
      const label = document.createElement('div');
      label.className = 'file-label';
      label.textContent = att.file.name;
      thumb.appendChild(label);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => removeAttachment(i));
    thumb.appendChild(removeBtn);

    $attachBar.appendChild(thumb);
  });
}

/**
 * Drain the pending buffer into an Anthropic-API-shaped content array and
 * reset the UI. Returns null if nothing was queued.
 */
export function consumeAttachments() {
  if (pendingAttachments.length === 0) return null;
  const content = pendingAttachments.map((att) => {
    if (att.mediaType.startsWith('image/')) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: att.mediaType, data: att.base64 },
      };
    }
    try {
      const text = atob(att.base64);
      return { type: 'text', text: `[File: ${att.file.name}]\n${text}` };
    } catch {
      return { type: 'text', text: `[File: ${att.file.name}] (binary, ${att.file.size} bytes)` };
    }
  });
  pendingAttachments.length = 0;
  renderAttachments();
  return content;
}
