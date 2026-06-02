'use strict';
// swarm-guard (PreToolUse Task/Agent). A normal spawn under a fresh fake HOME is
// allowed (well under the 20/60s cap, memory healthy). We do NOT try to force the
// fork-bomb cap; just assert normal allow + fail-open on bad stdin.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'swarm-guard.js';

function taskPayload() {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, session_id: 't' };
}

test('normal spawn -> allow (exit 0)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, taskPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `expected allow; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});
