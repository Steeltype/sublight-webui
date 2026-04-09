import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogMeta } from '../lib/logMeta.js';

/** Small helper to build an NDJSON string from a list of entries. */
const ndjson = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('returns null for empty input', () => {
  assert.equal(parseLogMeta(''), null);
  assert.equal(parseLogMeta(null), null);
  assert.equal(parseLogMeta(undefined), null);
});

test('extracts cwd, permissionMode, and allowedTools from session_created', () => {
  const content = ndjson([
    { ts: '2026-04-09T00:00:00Z', type: 'session_created', cwd: 'U:/project', permissionMode: 'default', allowedTools: ['Read', 'Glob'] },
  ]);
  const meta = parseLogMeta(content);
  assert.equal(meta.cwd, 'U:/project');
  assert.equal(meta.permissionMode, 'default');
  assert.deepEqual(meta.allowedTools, ['Read', 'Glob']);
  assert.equal(meta.claudeSessionId, null);
  assert.equal(meta.messageCount, 0);
  assert.equal(meta.closed, false);
  assert.equal(meta.entryCount, 1);
});

test('counts user messages', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'user_message', text: 'hello' },
    { ts: 't3', type: 'user_message', text: 'again' },
    { ts: 't4', type: 'user_message', text: 'third' },
  ]);
  const meta = parseLogMeta(content);
  assert.equal(meta.messageCount, 3);
});

test('picks the latest claudeSessionId from claude_event entries', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'claude_event', event: { type: 'system', subtype: 'init', session_id: 'first-id' } },
    { ts: 't3', type: 'claude_event', event: { type: 'assistant', session_id: 'first-id' } },
    { ts: 't4', type: 'claude_event', event: { type: 'system', subtype: 'init', session_id: 'second-id' } },
  ]);
  const meta = parseLogMeta(content);
  assert.equal(meta.claudeSessionId, 'second-id');
});

test('marks closed when session_closed_by_user appears', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'user_message', text: 'hi' },
    { ts: 't3', type: 'session_closed_by_user' },
  ]);
  assert.equal(parseLogMeta(content).closed, true);
});

test('does not mark closed on a normal session', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'claude_event', event: { type: 'system', subtype: 'init', session_id: 'x' } },
  ]);
  assert.equal(parseLogMeta(content).closed, false);
});

test('reads sessionName from set_session_name artifact', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'artifact', artifact: { type: 'set_session_name', name: 'Cool Session' } },
  ]);
  assert.equal(parseLogMeta(content).sessionName, 'Cool Session');
});

test('later set_session_name wins', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'artifact', artifact: { type: 'set_session_name', name: 'First' } },
    { ts: 't3', type: 'artifact', artifact: { type: 'set_session_name', name: 'Second' } },
  ]);
  assert.equal(parseLogMeta(content).sessionName, 'Second');
});

test('stub session has no claudeSessionId and zero messages', () => {
  const content = ndjson([
    { ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: 't2', type: 'error', message: 'claude not found' },
  ]);
  const meta = parseLogMeta(content);
  assert.equal(meta.claudeSessionId, null);
  assert.equal(meta.messageCount, 0);
});

test('malformed JSON lines are skipped', () => {
  const content = [
    JSON.stringify({ ts: 't1', type: 'session_created', cwd: '/p', permissionMode: 'bypass' }),
    '{not valid json',
    JSON.stringify({ ts: 't2', type: 'user_message', text: 'hi' }),
    'also garbage',
    JSON.stringify({ ts: 't3', type: 'user_message', text: 'ok' }),
    '',
  ].join('\n');
  const meta = parseLogMeta(content);
  assert.equal(meta.cwd, '/p');
  assert.equal(meta.messageCount, 2);
});

test('startedAt and endedAt come from first and last valid lines', () => {
  const content = ndjson([
    { ts: '2026-04-01T10:00:00Z', type: 'session_created', cwd: '/p', permissionMode: 'bypass' },
    { ts: '2026-04-01T10:05:00Z', type: 'user_message', text: 'x' },
    { ts: '2026-04-01T11:30:00Z', type: 'claude_event', event: { type: 'result' } },
  ]);
  const meta = parseLogMeta(content);
  assert.equal(meta.startedAt, '2026-04-01T10:00:00Z');
  assert.equal(meta.endedAt, '2026-04-01T11:30:00Z');
});

test('entryCount excludes blank lines', () => {
  const content = 'line1\n\nline2\n\n\n';
  // All non-blank lines are invalid JSON and skipped, but still counted.
  const meta = parseLogMeta(content);
  assert.equal(meta.entryCount, 2);
});
