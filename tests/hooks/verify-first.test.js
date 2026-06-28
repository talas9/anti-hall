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

test('the new "Intent over letter" nudge is reachable across inputs', () => {
  const h = makeHome();
  try {
    // The nudge is a deterministic SHA-1(stdin) % NUDGES.length pick, so sweep
    // distinct envelopes until the emitted additionalContext carries the new
    // scope-fidelity facet. If the string were dropped from NUDGES this never hits.
    let found = false;
    for (let i = 0; i < 5000 && !found; i++) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 't' + i, prompt: 'x' });
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.strictEqual(r.status, 0);
      if (ctx(r).includes('Intent over letter')) found = true;
    }
    assert.ok(found, 'expected some input to emit the "Intent over letter" nudge');
  } finally {
    h.cleanup();
  }
});

test('the new "VERIFY DELEGATED WORK" nudge is reachable across inputs', () => {
  const h = makeHome();
  try {
    // Same deterministic SHA-1(stdin) % NUDGES.length pick: sweep distinct
    // envelopes until the emitted additionalContext carries the new
    // verify-delegated-work facet (coordinator re-checks a subagent's report).
    // If the string were dropped from NUDGES this never hits.
    let found = false;
    for (let i = 0; i < 5000 && !found; i++) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 't' + i, prompt: 'x' });
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.strictEqual(r.status, 0);
      const c = ctx(r);
      if (c.includes('VERIFY DELEGATED WORK') && c.includes('reconcile multiple workers')) found = true;
    }
    assert.ok(found, 'expected some input to emit the "VERIFY DELEGATED WORK" nudge');
  } finally {
    h.cleanup();
  }
});

test('the new "Default delegated ... BACKGROUND" nudge is reachable across inputs', () => {
  const h = makeHome();
  try {
    // Same deterministic SHA-1(stdin) % NUDGES.length pick: sweep distinct
    // envelopes until the emitted additionalContext carries the new
    // background-default facet (coordinator passes run_in_background itself).
    // If the string were dropped from NUDGES this never hits.
    let found = false;
    for (let i = 0; i < 5000 && !found; i++) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 't' + i, prompt: 'x' });
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.strictEqual(r.status, 0);
      const c = ctx(r);
      if (c.includes('Default delegated') && c.includes('run_in_background')) found = true;
    }
    assert.ok(found, 'expected some input to emit the "Default delegated ... BACKGROUND" nudge');
  } finally {
    h.cleanup();
  }
});

test('the new "SYNTHESIZE, NEVER RELAY" nudge is reachable across inputs', () => {
  const h = makeHome();
  try {
    // Same deterministic SHA-1(stdin) % NUDGES.length pick: sweep distinct
    // envelopes until the emitted additionalContext carries the new
    // no-raw-relay / output-budget facet (message-bloat prevention, #45).
    // If the string were dropped from NUDGES this never hits.
    let found = false;
    for (let i = 0; i < 5000 && !found; i++) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 't' + i, prompt: 'x' });
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.strictEqual(r.status, 0);
      const c = ctx(r);
      if (c.includes('SYNTHESIZE, NEVER RELAY') && c.includes('output budget')) found = true;
    }
    assert.ok(found, 'expected some input to emit the "SYNTHESIZE, NEVER RELAY" nudge');
  } finally {
    h.cleanup();
  }
});

test('the new "DONE = verified against the AGREED acceptance" nudge is reachable across inputs', () => {
  const h = makeHome();
  try {
    // Same deterministic SHA-1(stdin) % NUDGES.length pick: sweep distinct
    // envelopes until the emitted additionalContext carries the new
    // done-bar / acceptance-criteria facet ("false done" P0 fix, #79).
    // If the string were dropped from NUDGES this never hits.
    let found = false;
    for (let i = 0; i < 5000 && !found; i++) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 't' + i, prompt: 'x' });
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.strictEqual(r.status, 0);
      const c = ctx(r);
      if (c.includes('AGREED acceptance criteria') && c.includes('PENDING OWNER REVIEW')) found = true;
    }
    assert.ok(found, 'expected some input to emit the "DONE = verified against the AGREED acceptance" nudge');
  } finally {
    h.cleanup();
  }
});

test('NUDGES array has exactly 20 entries (count asserted via the source)', () => {
  // Lock the rotation size: the per-turn pick is SHA-1(stdin) % NUDGES.length,
  // so the count is load-bearing. 0.30.0 added the done-bar/acceptance nudge -> 18;
  // 0.36.0 added the distribute-models + shallow+wide nudges -> 20.
  const path = require('node:path');
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'verify-first.js'),
    'utf8',
  );
  const arr = src.match(/const NUDGES = \[([\s\S]*?)\n\];/);
  assert.ok(arr, 'NUDGES array literal not found in verify-first.js');
  // Count the quoted string entries (each nudge is a "..." line ending in a comma).
  const entries = arr[1].split('\n').filter((l) => /^\s*"/.test(l.trim()) || /^\s*"/.test(l));
  assert.strictEqual(entries.length, 20, `expected 20 nudges, found ${entries.length}`);
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
