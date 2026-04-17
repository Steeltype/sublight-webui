// Filesystem paths used throughout the server. Everything resolves off the
// repo root so modules don't have to reason about their own location.

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..');
export const LOG_DIR = path.join(REPO_ROOT, 'logs');
export const ARTIFACT_MCP_PATH = path.join(REPO_ROOT, 'artifact-mcp.js');
// SUBLIGHT_SETTINGS_PATH lets tests point at a sandbox file without clobbering
// the developer's real settings.json. Unset in normal use.
export const SETTINGS_PATH = process.env.SUBLIGHT_SETTINGS_PATH
  || path.join(REPO_ROOT, 'settings.json');
export const AUDIT_LOG_PATH = path.join(LOG_DIR, 'audit.ndjson');
