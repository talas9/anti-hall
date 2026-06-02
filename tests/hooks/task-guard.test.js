'use strict';
// task-guard (Stop hook). Block => stdout {decision:'block'} + exit 0.
//
// Task discovery: TodoWrite tool_use entries (input.todos[]) — last write wins,
// each TodoWrite REPLACES the list. Open = status pending|in_progress. State file:
// session_id 't' -> ~/.anti-hall/last-stop-taskset-t.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'task-guard.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

// An assistant message carrying a TodoWrite tool_use with the given todos array.
function todoWrite(todos) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw', input: { todos } }],
    },
  };
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

test('BLOCK: open (pending/in_progress) tasks remain at Stop', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'wire up the parser', status: 'in_progress' },
        { id: '2', content: 'write the docs', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: all tasks completed', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'wire up the parser', status: 'completed' },
        { id: '2', content: 'write the docs', status: 'completed' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: no tasks at all', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done.' }] } },
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ESCAPE HATCH: skip.json {task-guard: future} -> allow despite open tasks', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'task-guard': Date.now() + 600000 });
    const tp = h.writeTranscript([
      todoWrite([{ id: '1', content: 'open task', status: 'pending' }]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `skip active; expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});
