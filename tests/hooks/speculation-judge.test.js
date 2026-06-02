'use strict';
// speculation-judge (Stop hook, OPT-IN). Without ANTIHALL_SEMANTIC_JUDGE=1 it
// exits 0 immediately regardless of transcript. We never test the live API path.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'speculation-judge.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

test('OPT-OUT default: no ANTIHALL_SEMANTIC_JUDGE -> exit 0, no block', () => {
  const h = makeHome();
  try {
    // A confidently-stated unverified inference (would be a candidate to block if
    // the judge ran) — but the judge is disabled by default.
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(r.status, 0);
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
