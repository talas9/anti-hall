'use strict';
// speculation-guard (Stop hook). Block => stdout {decision:'block'} + exit 0.
//
// State file derivation (from speculation-guard.js): session_id 't' -> safeSession
// 't' -> ~/.anti-hall/speculation-guard-state-t.json. Transcript is JSONL; the hook
// reads the LAST assistant message text. A hedge word (e.g. "should be") with no
// acknowledgment blocks; an acknowledgment ("verified", "haven't checked", etc.)
// suppresses it.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'speculation-guard.js';
const STATE_FILE = 'speculation-guard-state-t.json';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

test('BLOCK: hedge without acknowledgment', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('I made the change.'),
      assistantMessage('This should be fine now.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: hedge WITH acknowledgment', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('It should be fine, but I have not verified it yet — let me verify.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (acknowledged); stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: no hedge marker at all', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('I ran the test and it passed: 5/5.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (no hedge); stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('MAX_BLOCKS cap: blocks=3 already -> even a hedge ALLOWS', () => {
  const h = makeHome();
  try {
    // Pre-seed the state with a DIFFERENT hash so the dedupe path is not what
    // suppresses the block — only the cap should. blocks:3 == MAX_BLOCKS.
    h.writeState(STATE_FILE, { hash: 'differenthash', blocks: 3 });
    const tp = h.writeTranscript([assistantMessage('This should be fine.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `cap reached; expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ESCAPE HATCH: skip.json {speculation-guard: future} -> allow despite hedge', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'speculation-guard': Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('This should be fine.')]);
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
