'use strict';
// verify-first (UserPromptSubmit). Exit 0 with hookSpecificOutput.additionalContext
// starting 'VERIFY-FIRST:'. The nudge is DETERMINISTIC for a given raw stdin
// envelope (SHA-1 of the bytes), so the same payload yields the same text twice.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first.js';

function payload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'do a thing', cwd: '/tmp/x' };
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('returns additionalContext starting VERIFY-FIRST:', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).startsWith('VERIFY-FIRST:'), `got: ${ctx(r).slice(0, 40)}`);
  } finally {
    h.cleanup();
  }
});

test('deterministic: same full envelope -> same nudge', () => {
  const h = makeHome();
  try {
    // Identical raw stdin both times => identical SHA-1 => identical nudge index.
    const raw = JSON.stringify(payload());
    const r1 = testHookRaw(HOOK, raw, { home: h.home });
    const r2 = testHookRaw(HOOK, raw, { home: h.home });
    assert.strictEqual(ctx(r1), ctx(r2));
    assert.ok(ctx(r1).startsWith('VERIFY-FIRST:'));
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
