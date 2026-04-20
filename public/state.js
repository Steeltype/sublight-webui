// Shared UI state singleton.
//
// Every module that needs the current session or UI toggles imports `state`
// from here. This is the canonical location — do not redeclare state in
// app.js or any extracted module.

import { loadAuthToken } from './auth.js';

export const state = {
  sessions: new Map(),
  activeId: null,
  ws: null,
  defaultCwd: '',
  defaultPermissionMode: 'default',
  reconnectDelay: 1000,
  authToken: loadAuthToken(),
  authRequired: false,
  notesVisible: false,
  artifactsVisible: false,
  /** Map<sessionId, artifact[]> */
  artifacts: new Map(),
};
