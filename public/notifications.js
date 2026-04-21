// Browser desktop notifications for background session completion.
//
// The preference is per-device (localStorage), not per-user, because the
// permission grant is a property of the browser origin. Firing goes through
// new Notification() from the page — no service worker involvement — which
// means notifications only show while the tab/PWA window is alive. That's
// acceptable for a localhost tool where the UI is usually kept open.

const PREF_KEY = 'sublight_notifications';
const SOUND_PREF_KEY = 'sublight_completion_sound';

export function isNotificationsSupported() {
  return 'Notification' in window;
}

export function loadCompletionSoundPref() {
  return localStorage.getItem(SOUND_PREF_KEY) === '1';
}

export function saveCompletionSoundPref(enabled) {
  if (enabled) localStorage.setItem(SOUND_PREF_KEY, '1');
  else localStorage.removeItem(SOUND_PREF_KEY);
}

/**
 * Play a short two-note chirp via WebAudio. No asset file — the tone is
 * synthesized on demand so it works even when the service worker / cache is
 * uninitialized. Silently no-ops if AudioContext is unavailable (e.g. the
 * user hasn't interacted with the page yet, which gates audio on some
 * browsers).
 */
export function playCompletionSound() {
  if (!loadCompletionSoundPref()) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.12;
    master.connect(ctx.destination);
    // Two quick rising notes — pleasant, unmistakable, under half a second.
    const notes = [
      { freq: 880, start: 0.0, dur: 0.12 },
      { freq: 1320, start: 0.11, dur: 0.18 },
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now + n.start);
      gain.gain.linearRampToValueAtTime(1, now + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);
      osc.connect(gain).connect(master);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
    // Close the context once playback is done so we don't leak audio nodes.
    setTimeout(() => ctx.close?.().catch(() => {}), 600);
  } catch {
    // WebAudio failed — nothing to do, sound is best-effort.
  }
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
