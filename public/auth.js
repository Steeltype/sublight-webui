// Authenticated fetch + URL helpers. Reads the token from shared state so
// callers don't have to thread it through every call site.

import { state } from './state.js';

/** Fetch with auth token in Authorization header. */
export function authFetch(url, options = {}) {
  if (state.authToken) {
    options.headers = { ...options.headers, Authorization: `Bearer ${state.authToken}` };
  }
  return fetch(url, options);
}

/** Append auth token as query parameter (for img.src and other non-fetch URLs). */
export function authUrl(base) {
  if (!state.authToken) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(state.authToken)}`;
}

// ---------------------------------------------------------------------------
// Token persistence.
//
// Two storage tiers: localStorage for "remember me" (persists across browser
// close), sessionStorage for session-only (dies with the tab). Exactly one
// holds the current token — writing to one clears the other so toggling the
// checkbox doesn't leave a stale copy behind.
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'sublight_token';

export function loadAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || null;
}

export function saveAuthToken(token, remember) {
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

/** True when the current token lives in localStorage (i.e. user opted to remember). */
export function isTokenRemembered() {
  return localStorage.getItem(TOKEN_KEY) !== null;
}
