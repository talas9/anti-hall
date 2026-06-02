'use strict';
// verify-first-full (SessionStart). Exit 0; additionalContext is the FULL protocol
// containing the IRON LAW, the rule-K scannability line, and the USER OVERRIDE row.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first-full.js';

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('SessionStart startup -> full protocol with IRON LAW / rule K / USER OVERRIDE', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'SessionStart', source: 'startup' }, { home: h.home });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(c.includes('IRON LAW'), 'missing IRON LAW');
    assert.ok(c.includes('PRESENT FOR SCANNABILITY'), 'missing rule K scannability');
    assert.ok(c.includes('USER OVERRIDE'), 'missing USER OVERRIDE');
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0 (defaults to SessionStart)', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).includes('IRON LAW'));
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
