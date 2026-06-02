'use strict';
// task-tracker (UserPromptSubmit, throttled). FIRST turn -> FULL directive; within
// the 6h window -> SHORT line. State file: session_id 't' -> task-tracker-t.json.
// Self-heal (#7c fix): a FUTURE or garbage lastFull is treated as expired ->
// FULL again AND the state file is rewritten to ~now.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'task-tracker.js';
const STATE_FILE = 'task-tracker-t.json';
const FULL_MARKER = 'TASK-LIST DISCIPLINE:';
const SHORT_MARKER = 'TASK-LIST: capture every request';

function promptPayload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: process.cwd() };
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('FIRST turn (empty HOME) -> FULL directive', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).startsWith(FULL_MARKER), `expected FULL; got: ${ctx(r).slice(0, 60)}`);
  } finally {
    h.cleanup();
  }
});

test('Immediate second run (state present) -> SHORT line', () => {
  const h = makeHome();
  try {
    const r1 = testHook(HOOK, promptPayload(), { home: h.home });
    assert.ok(ctx(r1).startsWith(FULL_MARKER));
    const r2 = testHook(HOOK, promptPayload(), { home: h.home });
    assert.ok(ctx(r2).startsWith(SHORT_MARKER), `expected SHORT; got: ${ctx(r2).slice(0, 60)}`);
  } finally {
    h.cleanup();
  }
});

test('Self-heal: FUTURE lastFull -> FULL again and state rewritten to ~now', () => {
  const h = makeHome();
  try {
    const farFuture = Date.now() + 7 * 24 * 60 * 60 * 1000; // a week ahead
    h.writeState(STATE_FILE, { lastFull: farFuture });
    const before = Date.now();
    const r = testHook(HOOK, promptPayload(), { home: h.home });
    const after = Date.now();
    assert.ok(ctx(r).startsWith(FULL_MARKER), 'future timestamp must self-heal to FULL');
    const written = JSON.parse(fs.readFileSync(path.join(h.antiHall, STATE_FILE), 'utf8'));
    assert.ok(
      written.lastFull <= after + 5 * 60 * 1000 && written.lastFull >= before - 1000,
      `state must be rewritten to ~now (got ${written.lastFull}, window ${before}..${after})`
    );
  } finally {
    h.cleanup();
  }
});

test('Garbage lastFull -> FULL', () => {
  const h = makeHome();
  try {
    h.writeState(STATE_FILE, { lastFull: 'not-a-number' });
    const r = testHook(HOOK, promptPayload(), { home: h.home });
    assert.ok(ctx(r).startsWith(FULL_MARKER), 'garbage timestamp must yield FULL');
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON stdin -> FULL (never weaken discipline)', () => {
  const h = makeHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).startsWith(FULL_MARKER));
  } finally {
    h.cleanup();
  }
});
