'use strict';
// devswarm-child-gate (Stop hook). Forces a CHILD DevSwarm workspace to emit a
// heartbeat/self-report before stopping — a capped, self-resetting forced-ack.
// Primary sessions, non-DevSwarm sessions, and malformed stdin must all be silent
// no-ops (fail-open, exit 0). The cap must never hard-loop the child.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-child-gate.js';
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feat/x' };

function stopPayload(extra) {
  return Object.assign({ hook_event_name: 'Stop', session_id: 's1' }, extra || {});
}

function stateFile(home, session) {
  return path.join(home, '.anti-hall', 'devswarm', 'child-gate', session + '.json');
}

// A branch that is isSafeId-clean, so the heartbeat file key == the branch verbatim
// (heartbeats/main.json) — no sanitize+hash needed in the test.
const SAFE_CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' };

function heartbeatFile(home, key) {
  return path.join(home, '.anti-hall', 'devswarm', 'heartbeats', key + '.json');
}
function writeHeartbeat(home, key, ts) {
  const p = heartbeatFile(home, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, source: 'child-turn', branch: key }));
}

test('BLOCK: child workspace + supervisor active -> Stop is blocked with heartbeat forced-ack', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.decision, 'block');
    assert.ok(/message-parent/.test(r.json.reason), `reason must tell child to message-parent; got=${r.json.reason}`);
    // Distinct state file was created under devswarm/child-gate/.
    assert.ok(fs.existsSync(stateFile(h.home, 's1')), 'own distinct state file must exist');
  } finally {
    h.cleanup();
  }
});

test('UNREPORTED: no heartbeat emitted yet -> Stop is blocked (child has not reported current state)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: SAFE_CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'no heartbeat -> must force a report');
  } finally {
    h.cleanup();
  }
});

test('REGRESSION (v0.54.1): a FRESH turn-start heartbeat must NOT false-silence the gate — an unreported child still blocks', () => {
  const h = makeHome();
  try {
    // devswarm-child-turn writes this heartbeat at TURN START — it means "a turn
    // began", NOT "the child pinged its parent". The v0.54.0 gate wrongly treated it
    // as satisfaction and silenced a child that never ran message-parent. The gate
    // must now block regardless of a fresh heartbeat.
    writeHeartbeat(h.home, 'main', Date.now());
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: SAFE_CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'a fresh heartbeat must not silence an unreported child');
    assert.ok(/message-parent/.test(r.json.reason), 'must still demand a real message-parent report');
  } finally {
    h.cleanup();
  }
});

test('NO-OP: Primary (DEVSWARM_SOURCE_BRANCH empty) -> no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: no DevSwarm at all -> no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: child branch set but supervisor NOT active -> no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, env: { DEVSWARM_SOURCE_BRANCH: 'feat/x' } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('CAP: consecutive stops within the window block MAX_BLOCKS times then yield (no hard loop)', () => {
  const h = makeHome();
  try {
    // Two blocks, then the third consecutive Stop (same tight window) yields.
    const r1 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r1.json && r1.json.decision, 'block', 'first stop blocks');
    const r2 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r2.json && r2.json.decision, 'block', 'second stop blocks');
    const r3 = testHook(HOOK, stopPayload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', `third stop must yield (allow); got: ${r3.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('RESET: after the window elapses, the cap re-arms and forces a fresh heartbeat', () => {
  const h = makeHome();
  try {
    // Prime state as if the cap was already reached long ago (>5min).
    const p = stateFile(h.home, 's1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ blocks: 5, lastBlockAt: Date.now() - (6 * 60 * 1000) }));
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'stale cap must re-arm and block again');
  } finally {
    h.cleanup();
  }
});

test('SKIP: explicit user skip marker -> no block', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-child-gate': Date.now() + 60000 });
    const r = testHook(HOOK, stopPayload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout under skip; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: cap state unwritable -> exit 0, does NOT block (never fail-closed)', () => {
  const h = makeHome();
  try {
    // Make the cap-state directory unwritable by planting a FILE where the
    // child-gate needs a directory (cross-platform: mkdirSync recursive then
    // rename will throw ENOTDIR/EEXIST). The state write must fail -> the gate
    // must FAIL OPEN (allow the stop), never emit a block it can't cap.
    const dsw = path.join(h.home, '.anti-hall', 'devswarm');
    fs.mkdirSync(path.dirname(dsw), { recursive: true });
    fs.writeFileSync(dsw, 'not-a-directory'); // child-gate/<session>.json lives under here
    const r = testHook(HOOK, stopPayload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `unwritable cap state must NOT block; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `malformed stdin must not block; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});
