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
