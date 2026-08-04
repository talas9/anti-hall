'use strict';
// devswarm-reply-state — per-project reply tracking used by the parent
// Stop-gate to distinguish "read" from "decided and replied" (§4.3 of
// 2026-08-02-devswarm-parent-decide-gate.md). Covers fail-open reads, the
// APPEND-ONLY write path (Task #4 redesign), fold/dedup correctness, the
// concurrent-writer no-loss guarantee, the legacy->append-only forward
// migration, and the unansweredQuestions fail-open-toward-unanswered filter.

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

// --- fail-open reads --------------------------------------------------------
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

    // wrong shape (array line instead of object) also fails open to {}
    fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
    assert.deepEqual(M.readReplyState(SESSION, home), {});
  } finally { cleanup(); }
});

// A single corrupt line among valid append records must NOT poison the rest:
// the fold skips the bad line and keeps every good sender (per-line fail-open).
test('readReplyState: a corrupt line among valid records is skipped, the others survive', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.replyStatePathFor(SESSION, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p,
      JSON.stringify({ m: 'child-a', t: 1000 }) + '\n' +
      '{ this is not json\n' +
      JSON.stringify({ m: 'child-b', t: 2000 }) + '\n');
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 1000);
    assert.equal(state['child-b'].lastReplyTs, 2000);
    assert.equal(Object.keys(state).length, 2);
  } finally { cleanup(); }
});

// --- null / unresolvable repoKey -------------------------------------------
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
    assert.strictEqual(fs.existsSync(path.join(parentGateDir, 'norepo-replies.json')), false);
  } finally { cleanup(); }
});

// --- write path round-trip + monotonic fold --------------------------------
test('recordReply then readReplyState round-trips the value', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 1000);
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 1000);
  } finally { cleanup(); }
});

test('recordReply: an earlier ts on a later call does not regress lastReplyTs (fold takes max)', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 5000);
    M.recordReply(SESSION, home, 'child-a', 1000); // racing/late write, earlier ts
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 5000, 'the fold must take the max ts, never regress');
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

test('recordReply: multiple senders each keep their own max, none clobbered', () => {
  const { home, cleanup } = makeHome();
  try {
    M.recordReply(SESSION, home, 'child-a', 1000);
    M.recordReply(SESSION, home, 'child-b', 2000);
    M.recordReply(SESSION, home, 'child-a', 1500);
    const state = M.readReplyState(SESSION, home);
    assert.equal(state['child-a'].lastReplyTs, 1500);
    assert.equal(state['child-b'].lastReplyTs, 2000);
  } finally { cleanup(); }
});

// --- APPEND-ONLY on-disk shape ---------------------------------------------
// The core structural property: recordReply appends a newline-delimited record
// and takes NO lock and stages NO tmp file. The absence of a .lock / .tmp.*
// sibling is what proves the read-modify-write apparatus is truly gone.
test('recordReply: writes an append-only JSONL log — one record per call, no lock/tmp siblings', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'append-shape-repo';
    const p = M.replyStatePathFor(repoKey, home);
    M.recordReply(repoKey, home, 'child-a', 1000);
    M.recordReply(repoKey, home, 'child-b', 2000);
    M.recordReply(repoKey, home, 'child-a', 3000);

    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'three recordReply calls -> three appended records');
    for (const line of lines) {
      const o = JSON.parse(line);
      assert.equal(typeof o.m, 'string');
      assert.equal(typeof o.t, 'number');
      assert.ok(M.isAppendRecord(o), 'every line is a well-formed append record');
    }

    const siblings = fs.readdirSync(path.dirname(p));
    const base = path.basename(p);
    assert.ok(!siblings.includes(base + '.lock'), 'append-only must take NO lock file');
    assert.deepEqual(siblings.filter((f) => f.startsWith(base + '.tmp.')), [], 'append-only stages NO tmp file');
    assert.deepEqual(siblings.filter((f) => f.startsWith(base + '.lock.steal.')), [], 'append-only creates NO steal file');
  } finally { cleanup(); }
});

// --- fold / dedup correctness ----------------------------------------------
test('foldReplyLog: folds duplicate + out-of-order records to max ts per sender', () => {
  const raw =
    JSON.stringify({ m: 'a', t: 10 }) + '\n' +
    JSON.stringify({ m: 'b', t: 5 }) + '\n' +
    JSON.stringify({ m: 'a', t: 30 }) + '\n' +
    JSON.stringify({ m: 'a', t: 20 }) + '\n' + // out of order, must not regress a
    JSON.stringify({ m: 'b', t: 25 }) + '\n';
  const folded = M.foldReplyLog(raw);
  assert.equal(folded['a'].lastReplyTs, 30);
  assert.equal(folded['b'].lastReplyTs, 25);
  assert.equal(Object.keys(folded).length, 2);
});

test('foldReplyLog: reads a LEGACY single-merged-object line (backward compatible)', () => {
  const legacy = JSON.stringify({ 'child-a': { lastReplyTs: 111 }, 'child-b': { lastReplyTs: 222 } });
  const folded = M.foldReplyLog(legacy);
  assert.equal(folded['child-a'].lastReplyTs, 111);
  assert.equal(folded['child-b'].lastReplyTs, 222);
});

test('foldReplyLog: reads a MIXED legacy-line + appended-records file (folds both, max wins)', () => {
  const raw =
    JSON.stringify({ 'child-a': { lastReplyTs: 111 }, 'child-b': { lastReplyTs: 222 } }) + '\n' +
    JSON.stringify({ m: 'child-a', t: 500 }) + '\n' + // newer than legacy 111
    JSON.stringify({ m: 'child-c', t: 333 }) + '\n';
  const folded = M.foldReplyLog(raw);
  assert.equal(folded['child-a'].lastReplyTs, 500, 'appended record overtakes the legacy value');
  assert.equal(folded['child-b'].lastReplyTs, 222, 'legacy-only sender preserved');
  assert.equal(folded['child-c'].lastReplyTs, 333);
});

// The append-record discriminator must not misread a legacy map that literally
// keys a sender named "m": its o.m is an OBJECT, so isAppendRecord is false and
// it is folded as a legacy map, not mistaken for a `{m,t}` record.
test('isAppendRecord / fold: a legacy map keyed by a sender literally named "m" is not mistaken for an append record', () => {
  assert.strictEqual(M.isAppendRecord({ m: { lastReplyTs: 5 } }), false);
  assert.strictEqual(M.isAppendRecord({ m: 'child-a', t: 5 }), true);
  const folded = M.foldReplyLog(JSON.stringify({ m: { lastReplyTs: 5 }, t: { lastReplyTs: 9 } }));
  assert.equal(folded['m'].lastReplyTs, 5);
  assert.equal(folded['t'].lastReplyTs, 9);
});

// --- concurrent-writer no-loss (THE core win) ------------------------------
// The old read-modify-write shape lost entries under concurrency (40 writers
// retained only ~30). Append-only makes a lost update structurally impossible.
// N=40 REAL concurrent OS-thread writers (worker_threads — a same-thread
// Promise.all over sync fs calls would never reproduce genuine interleaving),
// each appending a DIFFERENT sender to the SAME file, all released from a shared
// barrier at once. ALL 40 must survive, and NO lock/tmp sibling may be created.
test('recordReply: N concurrent OS-thread writers to the SAME repoKey all survive (append-only, lock-free)', async () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'concurrent-repo';
    const p = M.replyStatePathFor(repoKey, home);
    const WORKER_PATH = path.join(__dirname, '..', 'helpers', 'reply-state-race-worker.js');
    const N = 40;
    const sab = new Int32Array(new SharedArrayBuffer(4));
    const runs = [];
    for (let i = 0; i < N; i++) {
      const w = new Worker(WORKER_PATH, { workerData: { i, home, repoKey, sabBuffer: sab.buffer, modulePath: MODULE_PATH } });
      runs.push(new Promise((resolve, reject) => {
        w.on('error', reject);
        w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker ' + i + ' exited ' + code))));
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    Atomics.store(sab, 0, 1);
    Atomics.notify(sab, 0);
    await Promise.all(runs);

    const state = M.readReplyState(repoKey, home);
    const keys = Object.keys(state);
    assert.equal(keys.length, N, 'all ' + N + ' concurrent writers must survive (got ' + keys.length + ')');
    for (let i = 0; i < N; i++) {
      assert.ok(state['child-' + i], 'entry from concurrent worker ' + i + ' must not be lost');
      assert.equal(state['child-' + i].lastReplyTs, 1000 + i);
    }
    const base = path.basename(p);
    const siblings = fs.readdirSync(path.dirname(p));
    assert.ok(!siblings.includes(base + '.lock'), 'no lock file is ever created by the append-only path');
    assert.deepEqual(siblings.filter((f) => f.startsWith(base + '.tmp.')), [], 'no tmp staging file is ever created');
  } finally { cleanup(); }
});

// --- forward migration: legacy merged-object -> append-only JSONL ----------
// The ONLY released on-disk form was the single merged object
// `{ [meshId]: { lastReplyTs } }` (v0.69.0 .. v0.70.1). Migration folds it to
// append-only losslessly.
test('migrateReplyState: converts a legacy merged-object file to append-only JSONL, losslessly', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'legacy-repo';
    const p = M.replyStatePathFor(repoKey, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ 'child-a': { lastReplyTs: 111 }, 'child-b': { lastReplyTs: 222 } }));

    const report = M.migrateReplyState(home);
    assert.equal(report.scanned, 1);
    assert.equal(report.migrated, 1);
    assert.equal(report.errors, 0);

    // On-disk: now pure append-only records, one per sender, sorted, no data lost.
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(M.isAppendRecord(JSON.parse(line)));

    const state = M.readReplyState(repoKey, home);
    assert.equal(state['child-a'].lastReplyTs, 111);
    assert.equal(state['child-b'].lastReplyTs, 222);
  } finally { cleanup(); }
});

test('migrateReplyState: idempotent — a second run converts nothing (already append-only), state unchanged', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'idempotent-repo';
    const p = M.replyStatePathFor(repoKey, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ 'child-a': { lastReplyTs: 111 } }));

    const first = M.migrateReplyState(home);
    assert.equal(first.migrated, 1);
    const afterFirst = fs.readFileSync(p, 'utf8');

    const second = M.migrateReplyState(home);
    assert.equal(second.migrated, 0, 'nothing left to migrate');
    assert.equal(second.alreadyAppendOnly, 1, 'the already-normalized file is detected and skipped');
    assert.equal(fs.readFileSync(p, 'utf8'), afterFirst, 're-run is byte-identical (no churn)');
  } finally { cleanup(); }
});

test('migrateReplyState: dryRun counts pending WITHOUT writing anything', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'dryrun-repo';
    const p = M.replyStatePathFor(repoKey, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const legacy = JSON.stringify({ 'child-a': { lastReplyTs: 111 } });
    fs.writeFileSync(p, legacy);

    const report = M.migrateReplyState(home, { dryRun: true });
    assert.equal(report.pending, 1, 'dryRun reports the file as pending');
    assert.equal(report.migrated, 0, 'dryRun writes nothing');
    assert.equal(fs.readFileSync(p, 'utf8'), legacy, 'file is untouched in dryRun');
  } finally { cleanup(); }
});

// A legacy file keyed by a session_id-style basename (the never-released dev
// form) is migrated identically — the migration operates on every
// *-replies.json regardless of how its basename was keyed.
test('migrateReplyState: also normalizes a legacy file whose basename came from a session_id (prior dev form)', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'parent-gate');
    fs.mkdirSync(dir, { recursive: true });
    // A session-id-shaped safe name, ending in the same -replies.json suffix.
    const p = path.join(dir, 'sess_abc123_def456-replies.json');
    fs.writeFileSync(p, JSON.stringify({ 'child-x': { lastReplyTs: 42 } }));

    const report = M.migrateReplyState(home);
    assert.equal(report.migrated, 1);
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { m: 'child-x', t: 42 });
  } finally { cleanup(); }
});

test('migrateReplyState: a MIXED legacy-line + appended-records file folds to max, losslessly', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'mixed-repo';
    const p = M.replyStatePathFor(repoKey, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p,
      JSON.stringify({ 'child-a': { lastReplyTs: 100 }, 'child-b': { lastReplyTs: 200 } }) + '\n' +
      JSON.stringify({ m: 'child-a', t: 900 }) + '\n');

    const report = M.migrateReplyState(home);
    assert.equal(report.migrated, 1);
    const state = M.readReplyState(repoKey, home);
    assert.equal(state['child-a'].lastReplyTs, 900, 'max across legacy + appended survives');
    assert.equal(state['child-b'].lastReplyTs, 200);
    // After migration every line is a pure append record.
    for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      assert.ok(M.isAppendRecord(JSON.parse(line)));
    }
  } finally { cleanup(); }
});

test('migrateReplyState: missing parent-gate dir is a safe zeroed no-op (fail-open)', () => {
  const { home, cleanup } = makeHome();
  try {
    const report = M.migrateReplyState(home);
    assert.deepEqual(report, { scanned: 0, migrated: 0, alreadyAppendOnly: 0, pending: 0, errors: 0 });
    assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'parent-gate')), false);
  } finally { cleanup(); }
});

// The doctor + update.js both reach the migration through migrate-state.js's
// thin wrapper — confirm it delegates to the same code path.
test('migrate-state.js migrateReplyState wrapper delegates to the reply-state module', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'wrapper-repo';
    const p = M.replyStatePathFor(repoKey, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ 'child-a': { lastReplyTs: 7 } }));

    const migrateState = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'migrate-state.js'));
    const dry = migrateState.migrateReplyState({ dryRun: true, home });
    assert.equal(dry.pending, 1);
    const applied = migrateState.migrateReplyState({ home });
    assert.equal(applied.migrated, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)[0]), { m: 'child-a', t: 7 });
  } finally { cleanup(); }
});

// --- unansweredQuestions (unchanged consumer contract) ---------------------
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

// End-to-end through the real write+read path: a recorded reply clears its
// question via unansweredQuestions (the decide+reply gate semantics preserved).
test('recordReply -> readReplyState -> unansweredQuestions: a recorded reply clears its pending question', () => {
  const { home, cleanup } = makeHome();
  try {
    const repoKey = 'gate-semantics-repo';
    const pending = [{ from: 'child-a', ts: 1000, seq: 1 }];
    // Before any reply: the question is unanswered (blocks the gate).
    assert.equal(M.unansweredQuestions(pending, M.readReplyState(repoKey, home)).length, 1);
    // Record a reply strictly newer than the question ts.
    M.recordReply(repoKey, home, 'child-a', 1001);
    assert.deepEqual(M.unansweredQuestions(pending, M.readReplyState(repoKey, home)), [],
      'a reply newer than the question ts clears it');
    // A reply OLDER than a newer question does not clear that newer question.
    const pending2 = [{ from: 'child-a', ts: 5000, seq: 2 }];
    assert.equal(M.unansweredQuestions(pending2, M.readReplyState(repoKey, home)).length, 1,
      'gate still blocks on a question newer than the last observed reply');
  } finally { cleanup(); }
});

test('unansweredQuestions: fails open toward unanswered on malformed input, never throws', () => {
  assert.doesNotThrow(() => M.unansweredQuestions(null, {}));
  assert.deepEqual(M.unansweredQuestions(null, {}), []);
  assert.deepEqual(M.unansweredQuestions('not-an-array', {}), []);

  const malformedEntry = [{ ts: 100, seq: 1 }]; // no `from`
  assert.doesNotThrow(() => M.unansweredQuestions(malformedEntry, {}));
  assert.equal(M.unansweredQuestions(malformedEntry, {}).length, 1, 'a question missing `from` must be kept as unanswered, not dropped');

  const questions = [{ from: 'child-a', ts: 100, seq: 1 }];
  assert.doesNotThrow(() => M.unansweredQuestions(questions, 'not-an-object'));
  assert.equal(M.unansweredQuestions(questions, 'not-an-object').length, 1, 'a malformed replyState must not silently clear a real question');

  assert.doesNotThrow(() => M.unansweredQuestions(questions, null));
  assert.equal(M.unansweredQuestions(questions, null).length, 1);

  const weirdEntries = [null, undefined, 42, 'str', { from: 'child-a', ts: 5, seq: 9 }];
  assert.doesNotThrow(() => M.unansweredQuestions(weirdEntries, {}));
  assert.equal(M.unansweredQuestions(weirdEntries, {}).length, weirdEntries.length, 'every malformed entry must be kept as unanswered too');
});
