'use strict';
// devswarm-ingest — the supervised monitor->store daemon. Unit-tests the pure
// pieces (lock refusal, dedupe/replay idempotence, payload normalization, hash
// stability, one supervised loop iteration) WITHOUT spawning real hivecontrol —
// the monitor runner + clock are injected.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

test('acquireIngestLock enforces the single-native-consumer invariant', () => {
  const home = tmpHome();
  try {
    const rel1 = ingest.acquireIngestLock(home);
    assert.ok(rel1, 'first consumer acquires the lock');
    const rel2 = ingest.acquireIngestLock(home);
    assert.equal(rel2, null, 'second consumer is refused while the first is live');
    rel1();
    const rel3 = ingest.acquireIngestLock(home);
    assert.ok(rel3, 'after release a new consumer may start');
    rel3();
  } finally { rm(home); }
});

test('runIngestLoop REFUSES to start when another monitor consumer holds the lock', () => {
  const home = tmpHome();
  try {
    const held = ingest.acquireIngestLock(home);
    try {
      const summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
        run: () => ({ ok: true, raw: '[]' }),
        sleep: () => {},
      });
      assert.equal(summary.started, false);
      assert.match(summary.reason, /already running/);
    } finally { held(); }
  } finally { rm(home); }
});

test('acquireIngestLock does NOT steal a LIVE holder even when its timestamp is old', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const oldTs = 1000; // ancient (far older than the 15-min stale window)
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts: oldTs, token: 'live-holder' }));
    // Holder reads as ALIVE; even though the timestamp is stale, the lock is a live
    // `monitor` consumer and MUST NOT be stolen (stealing it splits the destructive
    // native queue -> data loss). Requires BOTH stale AND not-alive to steal.
    const rel = ingest.acquireIngestLock(home, { isAlive: () => true, now: () => oldTs + 60 * 60 * 1000 });
    assert.equal(rel, null, 'a live holder is never stolen, however old its ts');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(cur.token, 'live-holder', 'the live holder lock is left intact');
  } finally { rm(home); }
});

test('acquireIngestLock RECLAIMS a dead + stale holder', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const oldTs = 1000;
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts: oldTs, token: 'dead-holder' }));
    // Holder is DEAD and its lock is stale -> reclaimable.
    const rel = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => oldTs + 60 * 60 * 1000 });
    assert.ok(rel, 'a dead + stale holder is reclaimed');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.notEqual(cur.token, 'dead-holder', 'the reclaimed lock is now ours');
    rel();
  } finally { rm(home); }
});

test('acquireIngestLock does NOT steal a dead holder whose lock is still FRESH', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = 100000;
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts, token: 'fresh-dead' }));
    // Dead but NOT yet stale (heartbeat window not elapsed) -> both conditions
    // required, so refuse rather than steal.
    const rel = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => ts + 1000 });
    assert.equal(rel, null, 'a fresh lock is not stolen even from a dead holder');
  } finally { rm(home); }
});

test('acquireIngestLock does NOT steal a TORN/EMPTY lock whose MTIME is FRESH (live holder mid-write)', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A live holder is briefly a 0-byte file between openSync('wx') and writeSync.
    fs.writeFileSync(p, ''); // torn/empty -> unparseable (holderTs would be null)
    const mt = fs.statSync(p).mtimeMs;
    // No parseable pid (alive=false) AND no parseable ts, but a FRESH mtime -> the
    // holder is a live consumer mid-write and MUST NOT be stolen (stealing it splits
    // the destructive native queue -> lost messages).
    const rel = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => mt + 1000 });
    assert.equal(rel, null, 'a torn/empty lock with a FRESH mtime is not stolen');
    assert.equal(fs.readFileSync(p, 'utf8'), '', 'the live holder empty lock is left intact');
  } finally { rm(home); }
});

test('acquireIngestLock RECLAIMS a TORN/EMPTY lock whose MTIME is OLD (dead holder)', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, ''); // torn/empty, but written long ago (dead holder)
    const mt = fs.statSync(p).mtimeMs;
    // Unparseable AND its mtime is older than the 15-min stale window -> genuinely dead
    // holder -> reclaimable.
    const rel = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => mt + 16 * 60 * 1000 });
    assert.ok(rel, 'a torn/empty lock with an OLD mtime (dead holder) is reclaimed');
    assert.notEqual(fs.readFileSync(p, 'utf8'), '', 'the reclaimed lock now carries our token');
    rel();
  } finally { rm(home); }
});

test('release.heartbeat refreshes the lock ts so a long-lived daemon stays fresh', () => {
  const home = tmpHome();
  try {
    let t = 1000;
    const rel = ingest.acquireIngestLock(home, { now: () => t });
    assert.ok(rel, 'acquired');
    assert.equal(typeof rel.heartbeat, 'function', 'release carries a heartbeat');
    t = 1000 + 20 * 60 * 1000; // 20 min later (past the 15-min stale window)
    assert.equal(rel.heartbeat(t), true, 'heartbeat refreshed our own lock');
    const cur = JSON.parse(fs.readFileSync(ingest.ingestLockPath(home), 'utf8'));
    assert.equal(cur.ts, t, 'the lock ts advanced to the heartbeat time');
    // A would-be thief checking at this moment sees a fresh (refreshed) lock.
    const thief = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => t + 1000 });
    assert.equal(thief, null, 'the heartbeat kept the lock fresh -> not stealable');
    rel();
  } finally { rm(home); }
});

test('normalizeMonitorPayload tolerates every plausible JSON shape', () => {
  const N = ingest.normalizeMonitorPayload;
  assert.equal(N('').length, 0);
  assert.equal(N('not json').length, 0);
  assert.equal(N('[]').length, 0);
  assert.equal(N(JSON.stringify([{ message: 'a' }, { message: 'b' }])).length, 2);
  assert.equal(N(JSON.stringify({ messages: [{ message: 'a' }] })).length, 1);
  assert.equal(N(JSON.stringify({ data: [{ fromBranch: 'c' }] })).length, 1);
  assert.equal(N(JSON.stringify({ message: 'solo', fromBranch: 'c' })).length, 1); // single object
  assert.equal(N(JSON.stringify({ unrelated: 1 })).length, 0); // no message fields -> ignore
  // already-parsed values pass through too
  assert.equal(N([{ message: 'x' }]).length, 1);
});

test('messageHash is stable + content-sensitive', () => {
  const m = { fromBranch: 'c', toBranch: 'p', message: 'hi', createdAt: 't1' };
  assert.equal(ingest.messageHash('p', m), ingest.messageHash('p', m));
  assert.notEqual(ingest.messageHash('p', m), ingest.messageHash('p', Object.assign({}, m, { message: 'bye' })));
  assert.notEqual(ingest.messageHash('p', m), ingest.messageHash('other', m)); // keyed by workspace
});

test('ingestPayload is idempotent on replay (dedupe hash)', () => {
  const home = tmpHome();
  const s = storeLib.openStore({ home, backend: 'journal' });
  try {
    const batch = JSON.stringify([
      { fromBranch: 'c', toBranch: 'p', message: 'one', createdAt: '2026-01-01T00:00:00Z' },
      { fromBranch: 'c', toBranch: 'p', message: 'two', createdAt: '2026-01-01T00:00:01Z' },
    ]);
    const r1 = ingest.ingestPayload(s, batch, { workspaceId: 'p' });
    assert.equal(r1.inserted, 2);
    const r2 = ingest.ingestPayload(s, batch, { workspaceId: 'p' }); // replay
    assert.equal(r2.inserted, 0);
    assert.equal(r2.duplicate, 2);
    assert.equal(s.messageCount('p'), 2);
  } finally { s.close(); rm(home); }
});

test('runIngestLoop ingests a batch, derives the projection, and replays idempotently', () => {
  const home = tmpHome();
  try {
    const batch = JSON.stringify([{ fromBranch: 'c', toBranch: 'p', message: 'hi', createdAt: '2026-01-01T00:00:00Z' }]);
    const run = () => ({ ok: true, raw: batch });

    // The projection only surfaces REGISTERED workspaces (registry is owned by
    // register/ensure; ingest only folds in messages). Register 'p' first.
    const reg = storeLib.openStore({ home, backend: 'journal' });
    try { reg.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null }); }
    finally { reg.close(); }

    const s1 = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', maxIterations: 1, run, sleep: () => {} });
    assert.equal(s1.started, true);
    assert.equal(s1.stats.inserted, 1);
    // projection written
    assert.ok(storeLib.readSummary(home).workspaces.p);

    // a second run re-observing the same in-flight batch imports nothing new
    const s2 = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', maxIterations: 1, run, sleep: () => {} });
    assert.equal(s2.stats.inserted, 0);
    assert.equal(s2.stats.duplicate, 1);
    const s = storeLib.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('p'), 1); } finally { s.close(); }
  } finally { rm(home); }
});

test('runIngestLoop survives a monitor crash (counts the error, keeps looping)', () => {
  const home = tmpHome();
  try {
    let calls = 0;
    const run = () => { calls++; return calls === 1 ? { ok: false, error: 'boom' } : { ok: true, raw: '[]' }; };
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run, sleep: () => {}, restartBackoffMs: 0,
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.errors, 1);
    assert.equal(summary.stats.iterations, 2);
  } finally { rm(home); }
});

test('runIngestLoop LOGS-AND-CONTINUES on a store-lock ELOCKFS/ELOCKUNAVAIL instead of crash-looping', () => {
  const home = tmpHome();
  try {
    // Register 'p' so a successful poll can project it.
    const reg = storeLib.openStore({ home, backend: 'journal' });
    try { reg.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null }); }
    finally { reg.close(); }

    // io.openStore returns a REAL store whose appendMessage throws the store's two
    // fail-closed lock signals on the first two polls, then succeeds. A crash-looping
    // daemon would throw out of the loop on poll 1 (re-exec'd every RESTART_SEC); the
    // fix must CATCH these two known-retryable codes, count them, and keep polling.
    let appendCalls = 0;
    const io = {
      openStore(args) {
        const real = storeLib.openStore(args);
        const orig = real.appendMessage.bind(real);
        real.appendMessage = function (m) {
          appendCalls++;
          if (appendCalls === 1) { const e = new Error('lock fs error'); e.code = 'ELOCKFS'; throw e; }
          if (appendCalls === 2) { const e = new Error('lock unavailable'); e.code = 'ELOCKUNAVAIL'; throw e; }
          return orig(m);
        };
        return real;
      },
    };
    // Distinct message per poll so the third (successful) append inserts a durable row.
    let poll = 0;
    const run = () => { poll++; return { ok: true, raw: JSON.stringify([{ fromBranch: 'c', message: 'm' + poll, createdAt: '2026-01-01T00:00:0' + poll + 'Z' }]) }; };

    let summary;
    assert.doesNotThrow(() => {
      summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 3,
        run, sleep: () => {}, restartBackoffMs: 0, io,
      });
    }, 'a store-lock fail-closed error must not crash the loop out');
    assert.equal(summary.started, true);
    assert.equal(summary.stats.iterations, 3);
    assert.equal(summary.stats.errors, 2, 'both lock errors are counted, not fatal');
    assert.equal(summary.stats.inserted, 1, 'the subsequent poll still ingests (idempotent replay)');
    // The subsequent poll's row is durable in the store — a later poll genuinely works.
    const s = storeLib.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('p'), 1); } finally { s.close(); }
  } finally { rm(home); }
});

test('runIngestLoop still surfaces a NON-lock store error (does not swallow arbitrary bugs)', () => {
  const home = tmpHome();
  try {
    const io = {
      openStore(args) {
        const real = storeLib.openStore(args);
        real.appendMessage = function () { throw new Error('unexpected bug'); };
        return real;
      },
    };
    const run = () => ({ ok: true, raw: JSON.stringify([{ message: 'x', createdAt: '2026-01-01T00:00:00Z' }]) });
    assert.throws(() => ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run, sleep: () => {}, restartBackoffMs: 0, io,
    }), /unexpected bug/, 'a non-lock error must still propagate (fail-open is only for the lock signals)');
  } finally { rm(home); }
});
