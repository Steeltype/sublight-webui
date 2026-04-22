#!/usr/bin/env node
/**
 * Fake Claude CLI for integration tests.
 *
 * Mimics the subset of `claude --input-format stream-json --output-format stream-json`
 * that Sublight uses. Reads user messages from stdin as NDJSON and emits a
 * canned init → assistant-text → result sequence to stdout for each one.
 *
 * Knows how to respond to:
 * - Any user turn: echoes back "ECHO: <text>" in an assistant message,
 *   then a result event with a matching text and a fake cost.
 * - The special text "CRASH": exits with code 1 to exercise the error path.
 * - The special text "TOOL": emits a tool_use block for "Read" then a
 *   tool_result for it, then the assistant summary.
 * - The special text "SLOW": emits an assistant intro line but no result,
 *   so the turn stays open until aborted.
 * - A control_request with subtype "interrupt": emits a control_response
 *   and then a result event for the (otherwise open) turn, mirroring how
 *   the real Claude CLI responds to the SDK's interrupt() call.
 *
 * Intentionally minimal — just enough for the Sublight pipeline to process.
 */

import readline from 'node:readline';
import crypto from 'node:crypto';

// One persistent session id for this process run. Matches how the real
// claude CLI keeps an id per session (which Sublight captures for --resume).
const SESSION_ID = crypto.randomUUID();
let turnIndex = 0;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitInit() {
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: SESSION_ID,
    model: 'fake-claude-test',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [
      { name: 'sublight-artifacts', status: 'connected' },
    ],
    slash_commands: ['help', 'clear'],
    skills: [],
    permissionMode: 'bypass',
    plugins: [],
    agents: [],
    output_style: null,
    apiKeySource: 'test',
    claude_code_version: '0.0.0-fake',
    fast_mode_state: null,
    uuid: crypto.randomUUID(),
  });
}

function emitAssistantText(text) {
  emit({
    type: 'assistant',
    message: {
      id: 'msg_' + crypto.randomUUID(),
      model: 'fake-claude-test',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: text.length,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: crypto.randomUUID(),
  });
}

function emitToolUse(name, input, id) {
  emit({
    type: 'assistant',
    message: {
      id: 'msg_' + crypto.randomUUID(),
      model: 'fake-claude-test',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: crypto.randomUUID(),
  });
}

function emitToolResult(id, content) {
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: content }] }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: crypto.randomUUID(),
  });
}

function emitResult(text) {
  turnIndex++;
  emit({
    type: 'result',
    subtype: 'success',
    result: text,
    total_cost_usd: 0.0001 * turnIndex,
    session_id: SESSION_ID,
    uuid: crypto.randomUUID(),
    duration_ms: 10,
    num_turns: turnIndex,
  });
}

// Emit the init event once at startup so Sublight's runtime strip populates.
emitInit();

const rl = readline.createInterface({ input: process.stdin });

let openTurnActive = false;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // An interrupt control_request from Sublight — ack with control_response
  // and close out the current turn with a result event. Matches the real
  // CLI's behavior when the SDK calls client.interrupt().
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id },
    });
    if (openTurnActive) {
      openTurnActive = false;
      emitResult('(interrupted)');
    }
    return;
  }

  // We only react to user messages — Sublight writes these in response to
  // composer submits.
  if (msg.type !== 'user' || !msg.message) return;

  // Extract the user text from whatever shape Sublight sent.
  let userText = '';
  const content = msg.message.content;
  if (typeof content === 'string') {
    userText = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        userText += block.text;
      }
    }
  }

  if (userText === 'CRASH') {
    process.exit(1);
  }

  if (userText === 'SLOW') {
    // Open turn — emit an assistant chunk but do not emit result. The
    // turn stays busy until an interrupt arrives (or the test times out).
    openTurnActive = true;
    emitAssistantText('working on it...');
    return;
  }

  if (userText === 'TOOL') {
    const toolId = 'toolu_' + crypto.randomUUID();
    emitToolUse('Read', { file_path: '/fake/path.txt' }, toolId);
    emitToolResult(toolId, 'fake file contents');
    emitAssistantText('Read the file. It said: fake file contents');
    emitResult('Read the file. It said: fake file contents');
    return;
  }

  emitAssistantText(`ECHO: ${userText}`);
  emitResult(`ECHO: ${userText}`);
});

rl.on('close', () => {
  process.exit(0);
});
