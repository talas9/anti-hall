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

// SPAWN_CAP / WINDOW_MS are the hard contract from swarm-guard.js (lines 40-41).
// Mirror the real constants so the boundary tests pin the exact threshold.
const SPAWN_CAP = 20;
const WINDOW_MS = 60000;

// Seed swarm-spawns.log with `count` timestamps that are all fresh (within the
// 60s window: now-1000ms), one per line, exactly as readTimestamps() parses it.
function seedSpawnLog(antiHall, count) {
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(String(now - 1000));
  fs.writeFileSync(path.join(antiHall, 'swarm-spawns.log'), lines.join('\n') + '\n', 'utf8');
}

test('BLOCK: SPAWN_CAP fresh spawns in window -> exit 2, decision block, ceiling reason', () => {
  const h = makeHome();
  try {
    // Seed exactly SPAWN_CAP (20) fresh timestamps. The next spawn makes recent
    // count >= SPAWN_CAP, so the cap check at swarm-guard.js:285 must BLOCK.
    seedSpawnLog(h.antiHall, SPAWN_CAP);
    const r = testHook(HOOK, taskPayload(), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block exit 2; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', `expected decision block; json: ${JSON.stringify(r.json)}`);
    // Quote the ACTUAL reason prefix from swarm-guard.js:287.
    assert.match(r.json.reason, /agent spawn-rate ceiling reached/);
    assert.match(r.json.reason, new RegExp('cap is ' + SPAWN_CAP));
  } finally {
    h.cleanup();
  }
});

test('BOUNDARY ALLOW: SPAWN_CAP-1 fresh spawns -> exit 0 (threshold pinned)', () => {
  const h = makeHome();
  try {
    // One under the cap: recent count = 19 < 20, so the cap check must NOT fire.
    seedSpawnLog(h.antiHall, SPAWN_CAP - 1);
    const r = testHook(HOOK, taskPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `expected allow at cap-1; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `must not block at cap-1; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('SKIP-HATCH: skip.json {swarm-guard: future} -> ALLOW even over cap (exit 0)', () => {
  const h = makeHome();
  try {
    // Cap exceeded (would block per the BLOCK test above) ...
    seedSpawnLog(h.antiHall, SPAWN_CAP);
    // ... but an explicit, unexpired user skip for swarm-guard overrides it
    // (isSkipped('swarm-guard') at swarm-guard.js:232 -> exit 0 before any check).
    h.writeSkip({ 'swarm-guard': Date.now() + 600000 });
    const r = testHook(HOOK, taskPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `expected allow under skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `skip must suppress the block; json: ${JSON.stringify(r.json)}`);
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
