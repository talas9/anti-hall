'use strict';
// devswarm-reply-state — per-session reply tracking used by the parent
// Stop-gate to distinguish "read" from "decided and replied" (§4.3 of
// 2026-08-02-devswarm-parent-decide-gate.md). Covers fail-open reads,
// atomic+monotonic writes, and the unansweredQuestions fail-open-toward-
// unanswered filter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { makeHome } = require('../helpers/fixtures.js');

const MODULE_PATH = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-reply-state.js',
);
const M = require(MODULE_PATH);

const SESSION = 'sess-1';

test('readReplyState: missing file returns {}', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.deepEqual(M.readReplyState(SESSION, home), {});
  } finally { cleanup(); }
});

test('readReplyState: malformed/corrupt file returns {} (fail-open), never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.replyStatePathFor(SESSION, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    assert.doesNotThrow(() => M.readReplyState(SESSION, home));
    assert.deepEqual(M.readReplyState(SESSION, home), {});

    // wrong shape (array instead of object) also fails open to {}
    fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
    assert.deepEqual(M.readReplyState(SESSION, home), {});
  } finally { cleanup(); }
});

// P2 FIX (Round 3 review): a null/unresolvable repoKey must NEVER sanitize
// into a shared literal fallback bucket (e.g. 'norepo') — that would let two
// UNRELATED projects that both hit an unresolvable-key condition read/write
// the SAME file, a cross-project state bleed. Instead: "no persisted state
// available" — a read fails open toward {} and a write is a safe no-op, no
// file or directory is ever created.
test('replyStatePathFor: a null/falsy repoKey returns null, never a shared fallback path', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.strictEqual(M.replyStatePathFor(null, home), null);
    assert.strictEqual(M.replyStatePathFor(undefined, home), null);
    assert.strictEqual(M.replyStatePathFor('', home), null);
  } finally { cleanup(); }
});

test('readReplyState(null, home) returns {} without creating any file', () => {
  const { home, cleanup } = makeHome();
  try {
    const state = M.readReplyState(null, home);
    assert.deepEqual(state, {});
    const parentGateDir = path.join(home, '.anti-hall', 'devswarm', 'parent-gate');
    assert.strictEqual(fs.existsSync(parentGateDir), false, 'no parent-gate dir/file should be created for a null key');
  } finally { cleanup(); }
});

test('recordReply(null, home, ...) is a safe no-op: creates no file, never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.doesNotThrow(() => M.recordReply(null, home, 'child-a', 1000));
    const parentGateDir = path.join(home, '.anti-hall', 'devswarm', 'parent-gate');
    assert.strictEqual(fs.existsSync(parentGateDir), false, 'no parent-gate dir/file should be created for a null key');
    // Confirms this never falls back to a shared 'norepo' bucket either.
    assert.strictEqual(fs.existsSync(path.join(parentGateDir, 'norepo-replies.json')), false);
  } finally { cleanup(); }
});

test('recordReply then readReplyState round-trips the value', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 1000);
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 1000);
  } finally { cleanup(); }
});

test('recordReply: an earlier ts on a later call does not regress lastReplyTs (monotonic)', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 5000);
    M.recordReply(SESSION, home, 'child-a', 1000); // racing/late write, earlier ts
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 5000, 'must never regress on an earlier/late write');
  } finally { cleanup(); }
});

test('recordReply: a later ts on a later call advances lastReplyTs', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 1000);
    M.recordReply(SESSION, home, 'child-a', 5000);
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 5000);
  } finally { cleanup(); }
});

test('recordReply: merges into existing state, does not clobber other senders', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 1000);
    M.recordReply(SESSION, home, 'child-b', 2000);
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 1000);
    assert.equal(state['child-b'].lastReplyTs, 2000);
  } finally { cleanup(); }
});

// P0 FIX regression (Round 5 review): recordReply's read-modify-write used to
// be UNLOCKED — two processes racing recordReply on the SAME repoKey could
// both read the pre-write state, each merge in their own sender's entry, then
// each write back; the SECOND write clobbers the FIRST, silently losing a
// reply entry. Reproduced empirically pre-fix: 40 concurrent writers to the
// same file retained only ~30/31/30 of 40 entries across three runs. This
// spawns N=40 REAL concurrent OS-thread writers (worker_threads, mirroring
// anti-hall-log.test.js's concurrent-rotation regression test — a same-thread
// Promise.all over synchronous fs calls would never reproduce genuine
// interleaving) against the SAME repoKey, each recording a DIFFERENT sender,
// then asserts ALL 40 entries survived — proving the race is closed, not just
// that the code compiles.
test('recordReply: N concurrent OS-thread writers to the SAME repoKey all survive (lost-update race regression)', async () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'concurrent-repo';
    const WORKER_PATH = path.join(__dirname, '..', 'helpers', 'reply-state-race-worker.js');
    const N = 40;
    // Shared Int32Array barrier: every worker blocks on Atomics.wait until the
    // main thread flips it, so all N recordReply() calls fire as close to
    // simultaneously as real OS threads allow.
    const sab = new Int32Array(new SharedArrayBuffer(4));
    const runs = [];
    for (let i = 0; i < N; i++) {
      const w = new Worker(WORKER_PATH, { workerData: { i, home, repoKey, sabBuffer: sab.buffer, modulePath: MODULE_PATH } });
      runs.push(new Promise((resolve, reject) => {
        w.on('error', reject);
        w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker ' + i + ' exited ' + code))));
      }));
    }
    // Give every worker time to spin up and reach Atomics.wait before releasing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    Atomics.store(sab, 0, 1);
    Atomics.notify(sab, 0);
    await Promise.all(runs);

    const state = M.readReplyState(repoKey, home);
    const keys = Object.keys(state);
    assert.equal(keys.length, N, 'all ' + N + ' concurrent writers must survive the lost-update race (got ' + keys.length + ')');
    for (let i = 0; i < N; i++) {
      assert.ok(state['child-' + i], 'entry from concurrent worker ' + i + ' must not be lost');
      assert.equal(state['child-' + i].lastReplyTs, 1000 + i);
    }
  } finally { cleanup(); }
});

test('unansweredQuestions: separates answered (ts <= lastReplyTs) from unanswered (ts > lastReplyTs, or no entry)', () => {
  const pendingQuestions = [
    { from: 'child-a', ts: 500, seq: 1 },  // answered: lastReplyTs 1000 >= 500
    { from: 'child-a', ts: 1500, seq: 2 }, // unanswered: newer than the reply
    { from: 'child-b', ts: 100, seq: 3 },  // unanswered: no reply-state entry at all
  ];
  const replyState = { 'child-a': { lastReplyTs: 1000 } };
  const result = M.unansweredQuestions(pendingQuestions, replyState);
  assert.deepEqual(result.map((q) => q.seq), [2, 3]);
});

test('unansweredQuestions: ts exactly equal to lastReplyTs counts as answered (strictly greater required)', () => {
  const pendingQuestions = [{ from: 'child-a', ts: 1000, seq: 1 }];
  const replyState = { 'child-a': { lastReplyTs: 1000 } };
  assert.deepEqual(M.unansweredQuestions(pendingQuestions, replyState), []);
});

test('unansweredQuestions: fails open toward unanswered on malformed input, never throws', () => {
  // non-array pendingQuestions -> [] (no crash, no fabricated unanswered list either;
  // just never throws and never silently drops a genuine array of questions since
  // there wasn't one to begin with)
  assert.doesNotThrow(() => M.unansweredQuestions(null, {}));
  assert.deepEqual(M.unansweredQuestions(null, {}), []);
  assert.deepEqual(M.unansweredQuestions('not-an-array', {}), []);

  // a question missing `from` -> kept as unanswered (fail-open, never silently dropped)
  const malformedEntry = [{ ts: 100, seq: 1 }]; // no `from`
  assert.doesNotThrow(() => M.unansweredQuestions(malformedEntry, {}));
  const r1 = M.unansweredQuestions(malformedEntry, {});
  assert.equal(r1.length, 1, 'a question missing `from` must be kept as unanswered, not dropped');

  // replyState that isn't an object -> every question treated as unanswered
  const questions = [{ from: 'child-a', ts: 100, seq: 1 }];
  assert.doesNotThrow(() => M.unansweredQuestions(questions, 'not-an-object'));
  const r2 = M.unansweredQuestions(questions, 'not-an-object');
  assert.equal(r2.length, 1, 'a malformed replyState must not silently clear a real question');

  assert.doesNotThrow(() => M.unansweredQuestions(questions, null));
  const r3 = M.unansweredQuestions(questions, null);
  assert.equal(r3.length, 1);

  // a totally malformed individual entry (not an object at all) -> kept, never throws
  const weirdEntries = [null, undefined, 42, 'str', { from: 'child-a', ts: 5, seq: 9 }];
  assert.doesNotThrow(() => M.unansweredQuestions(weirdEntries, {}));
  const r4 = M.unansweredQuestions(weirdEntries, {});
  assert.equal(r4.length, weirdEntries.length, 'every malformed entry must be kept as unanswered too');
});
