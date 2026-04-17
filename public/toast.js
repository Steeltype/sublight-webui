// Transient toast notifications.
//
// Creates a fresh DOM node per message so overlapping toasts stack naturally.
// The CSS handles the fade-in/out transition via the .visible class.

export function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
