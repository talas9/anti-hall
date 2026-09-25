'use strict';
// stop-ack.js — the ONE shared signature-ack mechanism for nudge-class Stop
// hooks (peer complaint #1, 2026-09-26). Unit tests for the lib itself;
// integration coverage lives in silent-agent-nudge.test.js and
// tasklist-guard.test.js (wired call sites).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stopAck = require('../../plugins/anti-hall/hooks/lib/stop-ack.js');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-stop-ack-'));
}

test('signatureFor: same subject -> same signature, different subject -> different signature', () => {
  const a = stopAck.signatureFor('agent-1,agent-2');
  const b = stopAck.signatureFor('agent-1,agent-2');
  const c = stopAck.signatureFor('agent-1,agent-3');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('isAcked: false before any ack; true after recordAck for the exact (hook, signature, session)', () => {
  const home = makeHome();
  try {
    const sig = stopAck.signatureFor('cond-1');
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sig), false);
    assert.ok(stopAck.recordAck(home, 's1', 'hook-a', sig));
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sig), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isAcked: scoped to hook — an ack for one hook does not silence another', () => {
  const home = makeHome();
  try {
    const sig = stopAck.signatureFor('cond-1');
    stopAck.recordAck(home, 's1', 'hook-a', sig);
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-b', sig), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isAcked: scoped to session — an ack in one session does not silence another', () => {
  const home = makeHome();
  try {
    const sig = stopAck.signatureFor('cond-1');
    stopAck.recordAck(home, 's1', 'hook-a', sig);
    assert.strictEqual(stopAck.isAcked(home, 's2', 'hook-a', sig), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isAcked: a DIFFERENT signature under the same hook+session is not acked', () => {
  const home = makeHome();
  try {
    const sig1 = stopAck.signatureFor('cond-1');
    const sig2 = stopAck.signatureFor('cond-2');
    stopAck.recordAck(home, 's1', 'hook-a', sig1);
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sig2), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('FAIL-OPEN: missing home/session/hook/signature -> isAcked is always false, never throws', () => {
  assert.strictEqual(stopAck.isAcked(null, 's1', 'hook-a', 'sig'), false);
  assert.strictEqual(stopAck.isAcked(os.tmpdir(), '', 'hook-a', 'sig'), false);
  assert.strictEqual(stopAck.isAcked(os.tmpdir(), 's1', '', 'sig'), false);
  assert.strictEqual(stopAck.isAcked(os.tmpdir(), 's1', 'hook-a', ''), false);
});

test('FAIL-OPEN: a corrupt state file -> isAcked returns false, never throws', () => {
  const home = makeHome();
  try {
    const p = stopAck.statePath(home, 's1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    const sig = stopAck.signatureFor('cond-1');
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sig), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('kill switch: guards.stopAck=false / ANTIHALL_STOP_ACK=off makes isAcked always false', () => {
  const home = makeHome();
  try {
    const sig = stopAck.signatureFor('cond-1');
    stopAck.recordAck(home, 's1', 'hook-a', sig);
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sig), true);
    const prevEnv = process.env.ANTIHALL_STOP_ACK;
    process.env.ANTIHALL_STOP_ACK = 'off';
    try {
      assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sig), false);
    } finally {
      if (prevEnv === undefined) delete process.env.ANTIHALL_STOP_ACK;
      else process.env.ANTIHALL_STOP_ACK = prevEnv;
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('ackHint: names the exact merge key the agent must write', () => {
  const home = makeHome();
  try {
    const sig = stopAck.signatureFor('cond-1');
    const hint = stopAck.ackHint('hook-a', sig, home, 's1');
    assert.match(hint, new RegExp('"hook-a:' + sig + '"'));
    assert.match(hint, /stop-ack-s1\.json/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordAck: multiple acks under the same session merge (do not clobber each other)', () => {
  const home = makeHome();
  try {
    const sigA = stopAck.signatureFor('cond-a');
    const sigB = stopAck.signatureFor('cond-b');
    stopAck.recordAck(home, 's1', 'hook-a', sigA);
    stopAck.recordAck(home, 's1', 'hook-b', sigB);
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-a', sigA), true);
    assert.strictEqual(stopAck.isAcked(home, 's1', 'hook-b', sigB), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
