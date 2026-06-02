'use strict';
// swarm-guard (PreToolUse Task/Agent). A normal spawn under a fresh fake HOME is
// allowed (well under the 20/60s cap, memory healthy). We do NOT try to force the
// fork-bomb cap; just assert normal allow + fail-open on bad stdin.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('FIX: zero-byte STALE lock is stolen -> spawn still recorded (cap not disabled)', () => {
  const h = makeHome();
  try {
    // Pre-create a zero-byte (null-token) lock with an OLD mtime so it reads as
    // stale. A corrupt/empty lock made readLockToken() return null; before the
    // fix the stale-steal could never fire (token equality never held), so the
    // lock permanently wedged the rate limiter and spawns ran WITHOUT being
    // recorded — silently disabling the spawn cap. After the fix the stale lock
    // is stolen and the allowed spawn is recorded to swarm-spawns.log.
    const lockFile = path.join(h.antiHall, 'swarm-spawns.lock');
    const logFile = path.join(h.antiHall, 'swarm-spawns.log');
    fs.writeFileSync(lockFile, ''); // zero-byte -> null token
    const old = (Date.now() - 60_000) / 1000; // 60s old -> well past LOCK_STALE_MS
    fs.utimesSync(lockFile, old, old);

    const r = testHook(HOOK, taskPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `expected allow; stdout: ${r.stdout}`);

    // The spawn must have been RECORDED (proves the lock was stolen, not bypassed).
    const logged = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];
    assert.ok(logged.length >= 1, `spawn must be recorded after stealing a stale lock; log: ${JSON.stringify(logged)}`);
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
