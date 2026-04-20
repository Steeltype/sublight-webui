// Browser desktop notifications for background session completion.
//
// The preference is per-device (localStorage), not per-user, because the
// permission grant is a property of the browser origin. Firing goes through
// new Notification() from the page — no service worker involvement — which
// means notifications only show while the tab/PWA window is alive. That's
// acceptable for a localhost tool where the UI is usually kept open.

const PREF_KEY = 'sublight_notifications';

export function isNotificationsSupported() {
  return 'Notification' in window;
}

export function getNotificationPermission() {
  if (!isNotificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export function loadNotificationPref() {
  return localStorage.getItem(PREF_KEY) === '1';
}

export function saveNotificationPref(enabled) {
  if (enabled) localStorage.setItem(PREF_KEY, '1');
  else localStorage.removeItem(PREF_KEY);
}

/**
 * Ask the user for notification permission. Returns the final permission
 * state ('granted' | 'denied' | 'default' | 'unsupported'). Safe to call
 * even if permission was already granted.
 */
export async function requestNotificationPermission() {
  if (!isNotificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Show a notification for a finished session. Silently no-ops if
 * notifications are disabled or permission isn't granted. Uses `tag` keyed
 * on sessionId so rapid re-fires replace the previous notification instead
 * of stacking. `onClick` is invoked when the user clicks the notification —
 * typical callers will focus the window and switch to the session.
 */
export function showSessionNotification({ sessionId, sessionName, body, onClick }) {
  if (!loadNotificationPref()) return;
  if (getNotificationPermission() !== 'granted') return;

  const title = `Sublight — ${sessionName || 'Session'}`;
  const n = new Notification(title, {
    body: body || 'Ready',
    tag: `sublight-session-${sessionId}`,
    icon: '/icon-256.png',
    silent: false,
  });
  n.addEventListener('click', () => {
    window.focus();
    n.close();
    if (onClick) onClick();
  });
}
