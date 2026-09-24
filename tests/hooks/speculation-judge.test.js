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

// SKIP-HATCH: speculation-judge calls isSkipped('speculation-judge') at
// speculation-judge.js:290, AFTER the ANTIHALL_SEMANTIC_JUDGE=1 env gate (line 64)
// but BEFORE the API-key check (line 306) and any network call. So to exercise the
// skip path we must ENABLE the judge (else it exits 0 at the env gate, never
// reaching the skip check). With the judge enabled AND an API key present, an
// unverified-inference transcript WOULD proceed toward the API; an explicit skip
// must short-circuit to exit 0 at line 290 before any of that. We assert exit 0 +
// no block. We never make a real API call: the skip fires before the network path.
test('SKIP-HATCH: skip.json {speculation-judge: future} -> exit 0, no block (judge enabled + key present)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'speculation-judge': Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-test-not-used' },
    });
    assert.strictEqual(r.status, 0, `expected allow under skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `skip must suppress any block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('SKIP-HATCH: broad "all" skip also covers speculation-judge (non-destructive)', () => {
  const h = makeHome();
  try {
    // speculation-judge is NOT in skip-guard's DESTRUCTIVE set, so a broad "all"
    // skip applies (skip-guard.js:50-53). Enabled judge + key, "all" skip -> exit 0.
    h.writeSkip({ all: Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-test-not-used' },
    });
    assert.strictEqual(r.status, 0, `expected allow under "all" skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `"all" skip must suppress any block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JUDGE_MODEL default: no override -> hook reaches API path, fails open (fake key)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-ant-fake-default' },
    });
    // Network will fail (fake key) -> fail-open -> exit 0, no block
    assert.strictEqual(r.status, 0, `expected fail-open exit 0; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `fail-open must not block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JUDGE_MODEL override: custom model env var -> hook accepts override, fails open (fake key)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: {
        ANTIHALL_SEMANTIC_JUDGE: '1',
        ANTHROPIC_API_KEY: 'sk-ant-fake-override',
        ANTIHALL_JUDGE_MODEL: 'claude-test-model-override',
      },
    });
    // Network will fail (fake key) -> fail-open -> exit 0, no block
    assert.strictEqual(r.status, 0, `expected fail-open exit 0 with model override; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `fail-open must not block; json: ${JSON.stringify(r.json)}`);
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
