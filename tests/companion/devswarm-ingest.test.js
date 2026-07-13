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
    // Per-worktree keying: hold the SAME worktree's lock the loop will derive, then
    // prove the loop refuses. `worktree: null` in both would exercise the legacy global
    // lock; here we use an explicit worktree so the two paths agree deterministically.
    const wt = process.cwd(); // any real git worktree
    const held = ingest.acquireIngestLock(home, undefined, wt);
    assert.ok(held, 'pre-held the per-worktree lock');
    try {
      const summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
        run: () => ({ ok: true, raw: '[]' }),
        sleep: () => {},
      });
      assert.equal(summary.started, false);
      assert.match(summary.reason, /already running/);
    } finally { held(); }
  } finally { rm(home); }
});

test('ingestLockPath is PER-WORKTREE — different repos get different lock files (no cross-repo collision)', () => {
  const home = tmpHome();
  try {
    const a = ingest.ingestLockPath(home, '/repo/a');
    const b = ingest.ingestLockPath(home, '/repo/b');
    const legacy = ingest.ingestLockPath(home);
    assert.notEqual(a, b, 'two worktrees -> two distinct lock files');
    assert.match(a, /ingest-[0-9a-f]{8}\.lock$/, 'per-worktree lock carries the 8-hex worktree hash');
    assert.match(legacy, /ingest\.lock$/, 'no worktree -> the legacy global lock (backward compat)');
    // Two DIFFERENT repos can each hold their own lock simultaneously.
    const relA = ingest.acquireIngestLock(home, undefined, '/repo/a');
    const relB = ingest.acquireIngestLock(home, undefined, '/repo/b');
    assert.ok(relA && relB, 'a second daemon for a DIFFERENT repo is NOT blocked by the first');
    relA(); relB();
  } finally { rm(home); }
});

test('runIngestLoop writes a per-worktree daemon heartbeat every sweep (even a quiet 0-insert cycle)', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const hash = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js').worktreeHash(wt);
    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    // A quiet poll (empty batch -> 0 inserts): the heartbeat must STILL be written.
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, now: 4242,
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.inserted, 0, 'quiet cycle inserted nothing');
    assert.ok(fs.existsSync(hbPath), 'daemon heartbeat written on a quiet cycle: ' + hbPath);
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.ts, 4242, 'heartbeat carries the sweep timestamp');
    assert.equal(beat.workspaceId, 'p');
    assert.equal(beat.workingDir, wt);
    assert.equal(typeof beat.pid, 'number');
  } finally { rm(home); }
});

test('runIngestLoop bounds EVERY monitor call with the default timeout (no unbounded/blocking monitor call)', () => {
  const home = tmpHome();
  try {
    const seen = [];
    const run = (opts) => { seen.push(opts.timeoutSec); return { ok: true, raw: '[]' }; };
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 3,
      run, sleep: () => {},
    });
    assert.equal(summary.started, true);
    assert.deepEqual(seen, [
      ingest.DEFAULT_MONITOR_TIMEOUT_SEC,
      ingest.DEFAULT_MONITOR_TIMEOUT_SEC,
      ingest.DEFAULT_MONITOR_TIMEOUT_SEC,
    ], 'every iteration passes a bounded -t timeout to the monitor call, never undefined/unbounded');
  } finally { rm(home); }
});

test('runIngestLoop resolves the bounded monitor timeout from ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC when set', () => {
  const home = tmpHome();
  try {
    const seen = [];
    const run = (opts) => { seen.push(opts.timeoutSec); return { ok: true, raw: '[]' }; };
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run, sleep: () => {}, env: { ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: '7' },
    });
    assert.equal(summary.started, true);
    assert.equal(seen[0], 7, 'the env knob overrides the default bounded timeout');
  } finally { rm(home); }
});

test('resolveMonitorTimeoutSec: explicit opts.timeoutSec wins over env and default', () => {
  assert.equal(ingest.resolveMonitorTimeoutSec(5, { ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: '99' }), 5);
  assert.equal(ingest.resolveMonitorTimeoutSec(undefined, { ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: '12' }), 12);
  assert.equal(ingest.resolveMonitorTimeoutSec(undefined, { ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: 'not-a-number' }), ingest.DEFAULT_MONITOR_TIMEOUT_SEC);
  assert.equal(ingest.resolveMonitorTimeoutSec(undefined, { ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: '-3' }), ingest.DEFAULT_MONITOR_TIMEOUT_SEC, 'non-positive env value falls back to default');
  assert.equal(ingest.resolveMonitorTimeoutSec(undefined, undefined), ingest.DEFAULT_MONITOR_TIMEOUT_SEC);
});

test('defaultMonitorRun: a bounded monitor call that times out with NO messages is NOT an error (empty is normal)', () => {
  // Injectable spawnSync-free check via the real defaultMonitorRun using a stub binary
  // path that fails to spawn is out of scope here (that's an ENOENT -> ok:false, tested
  // implicitly by production error handling); this proves the CONTRACT the loop relies
  // on: ok:true with empty raw stdout on a timed-out/quiet window is treated as success,
  // not an error, by runIngestLoop (stats.errors stays 0, no crash-loop backoff fires).
  const home = tmpHome();
  try {
    let calls = 0;
    const run = () => { calls++; return { ok: true, raw: '' }; }; // bounded monitor: timed out, 0 messages
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 3,
      run, sleep: () => {}, restartBackoffMs: 0,
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.errors, 0, 'a bounded monitor timeout with zero messages is NOT counted as an error');
    assert.equal(summary.stats.iterations, 3);
    assert.equal(calls, 3, 'the loop keeps re-polling after every empty bounded cycle — no message is lost, no crash');
  } finally { rm(home); }
});

test('runIngestLoop heartbeats EVERY bounded cycle even when every cycle is quiet — periodicity independent of message arrival', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const hash = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js').worktreeHash(wt);
    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    let hbWrites = 0;
    // A thin fs proxy: delegates everything to the real fs, only COUNTING renameSync
    // calls whose destination is the daemon heartbeat file (the atomic tmp->rename
    // writeIngestHeartbeat performs each sweep). Store operations pass through untouched.
    const spyFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'renameSync') {
          return function (src, dest) {
            if (dest === hbPath) hbWrites++;
            return target.renameSync(src, dest);
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    const timeoutsSeen = [];
    const run = (opts) => { timeoutsSeen.push(opts.timeoutSec); return { ok: true, raw: '[]' }; };
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 4, worktree: wt,
      run, sleep: () => {}, io: { storeFs: spyFs },
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.inserted, 0, 'every cycle was quiet — zero messages the whole run');
    assert.equal(hbWrites, 4, 'heartbeat written once per bounded cycle (4 of 4), independent of message arrival');
    assert.deepEqual(timeoutsSeen, [
      ingest.DEFAULT_MONITOR_TIMEOUT_SEC, ingest.DEFAULT_MONITOR_TIMEOUT_SEC,
      ingest.DEFAULT_MONITOR_TIMEOUT_SEC, ingest.DEFAULT_MONITOR_TIMEOUT_SEC,
    ], 'every cycle bounds the monitor call — a quiet workspace cannot block the loop indefinitely');
  } finally { rm(home); }
});

test('runIngestLoop heartbeats a message-arrival cycle too (not just quiet cycles)', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const hash = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js').worktreeHash(wt);
    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    const batch = JSON.stringify([{ fromBranch: 'c', toBranch: 'p', message: 'hi', createdAt: '2026-01-01T00:00:00Z' }]);
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: batch }), sleep: () => {}, now: 9999,
    });
    assert.equal(summary.stats.inserted, 1);
    assert.ok(fs.existsSync(hbPath), 'heartbeat written on a message-arrival cycle too');
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.ts, 9999);
  } finally { rm(home); }
});

test('runIngestLoop is FAIL-OPEN when the heartbeat write itself errors — never crashes the loop', () => {
  const home = tmpHome();
  try {
    const boomFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'mkdirSync') {
          return function (dir, opts) {
            if (typeof dir === 'string' && dir.includes('heartbeats')) throw new Error('disk full');
            return target.mkdirSync(dir, opts);
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    let calls = 0;
    const run = () => { calls++; return { ok: true, raw: '[]' }; };
    let summary;
    assert.doesNotThrow(() => {
      summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
        run, sleep: () => {}, io: { storeFs: boomFs },
      });
    }, 'a heartbeat-write error must never crash the loop (writeIngestHeartbeat is fully try/catch-wrapped)');
    assert.equal(summary.started, true);
    assert.equal(summary.stats.iterations, 2, 'the loop kept iterating despite every heartbeat write failing');
    assert.equal(calls, 2);
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
    // PER-PROJECT: the registry entry must land in the SAME per-project store the
    // daemon opens (workspaceId 'p'), else deriveSummary on 'p's store sees no row.
    const reg = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try { reg.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null }); }
    finally { reg.close(); }

    const s1 = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', maxIterations: 1, run, sleep: () => {} });
    assert.equal(s1.started, true);
    assert.equal(s1.stats.inserted, 1);
    // projection written to THIS project's summaries/<hash>.json
    assert.ok(storeLib.readSummary(home, 'p').workspaces.p);

    // a second run re-observing the same in-flight batch imports nothing new
    const s2 = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', maxIterations: 1, run, sleep: () => {} });
    assert.equal(s2.stats.inserted, 0);
    assert.equal(s2.stats.duplicate, 1);
    const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try { assert.equal(s.messageCount('p'), 1); } finally { s.close(); }
  } finally { rm(home); }
});

test('runIngestLoop SELF-REGISTERS its own primary/worktree id (#34 fix) — Primary sees its OWN inbound unread with NO explicit register/register-primary call anywhere', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const primaryId = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js').primaryWorkspaceId(wt);
    const batch = JSON.stringify([
      { fromBranch: 'c', toBranch: primaryId, message: 'msg-one', createdAt: '2026-01-01T00:00:00Z' },
      { fromBranch: 'c', toBranch: primaryId, message: 'msg-two', createdAt: '2026-01-01T00:00:01Z' },
    ]);
    const run = () => ({ ok: true, raw: batch });

    // NO manual upsertRegistry/register-primary anywhere — only runIngestLoop, exactly
    // as a real daemon starts up. workspaceId is left to derive from the worktree
    // (primaryWorkspaceId), not passed explicitly, so this exercises the same
    // derivation main() uses on a real box. Before the fix, deriveSummary's
    // workspaces{} projection is built ONLY from store.listRegistry() ids, and
    // nothing on this path ever registered `primary-<hash>` — so
    // workspaces[primaryId] would never exist and readOwnUnread/own-unread always
    // read 0 even with real unread messages sitting in the store.
    const summary = ingest.runIngestLoop({ home, backend: 'journal', worktree: wt, maxIterations: 1, run, sleep: () => {} });
    assert.equal(summary.started, true);
    assert.equal(summary.workspaceId, primaryId);
    assert.equal(summary.stats.inserted, 2);

    const s = storeLib.readSummary(home, primaryId);
    assert.ok(s, 'a summary projection was written');
    assert.ok(s.workspaces[primaryId], 'the daemon\'s own primary/worktree id IS present in workspaces{} — was previously never registered, so this key never existed');
    assert.equal(s.workspaces[primaryId].total, 2);
    assert.equal(s.workspaces[primaryId].cursor, 0, 'nothing consumed yet');
    assert.equal(s.workspaces[primaryId].unread, 2, 'unread = appended (2) minus cursor (0)');

    // Advance the cursor (e.g. an inbox ack) and re-derive: unread must reflect
    // appended-minus-cursor, not just total — proving this is a live projection, not
    // a hand-written fixture.
    const s2store = storeLib.openStore({ home, workspaceId: primaryId, backend: 'journal' });
    try {
      s2store.setCursor(primaryId, 1);
      storeLib.deriveSummary(s2store, { home });
    } finally { s2store.close(); }
    const s2 = storeLib.readSummary(home, primaryId);
    assert.equal(s2.workspaces[primaryId].unread, 1, 'unread updates to appended(2) - cursor(1) = 1 after ack');
  } finally { rm(home); }
});

test('runIngestLoop: WORKTREE is ground truth over env.DEVSWARM_BUILDER_ID — a daemon that inherits a CHILD id in its env still ingests + self-registers under the resolved worktree\'s primary id, never clobbering the child\'s registry row', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const primaryId = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js').primaryWorkspaceId(wt);
    const childId = 'child-should-never-be-used';

    // Pre-seed a registry row for the CHILD id, as if that child had already
    // registered itself (real inboxPath/cursorPath) BEFORE this daemon starts.
    const seedStore = storeLib.openStore({ home, workspaceId: childId, backend: 'journal' });
    try {
      seedStore.upsertRegistry({
        id: childId, worktreePath: '/some/child/worktree', sessionId: childId,
        inboxPath: '/some/child/inbox.json', cursorPath: '/some/child/cursor.json', nudgeCommand: null,
      });
    } finally { seedStore.close(); }

    const batch = JSON.stringify([
      { fromBranch: 'c', toBranch: primaryId, message: 'hello', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const run = () => ({ ok: true, raw: batch });

    // env carries a DEVSWARM_BUILDER_ID naming the CHILD — ordinary env inheritance
    // from a parent process, or a stray export. worktree resolves (wt is a real git
    // worktree), so it MUST win: identity derives from cwd, not the inherited env.
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', worktree: wt, maxIterations: 1, run, sleep: () => {},
      env: { DEVSWARM_BUILDER_ID: childId },
    });
    assert.equal(summary.started, true);
    assert.equal(summary.workspaceId, primaryId, 'worktree-derived id wins over env.DEVSWARM_BUILDER_ID');
    assert.equal(summary.stats.inserted, 1, 'the message was ingested under the worktree-derived partition');

    // Registration + ingest are the SAME id: the primary's own store partition (keyed
    // by the WORKTREE hash, not the child's id-derived hash) now carries its own row.
    const reg = storeLib.openStore({ home, workspaceId: primaryId, backend: 'journal' });
    try {
      const primaryRow = reg.listRegistry().find((r) => r.id === primaryId);
      assert.ok(primaryRow, 'the daemon registered under the worktree-derived primary id');
    } finally { reg.close(); }

    // The child's OWN store partition (a DIFFERENT hash, derived from its own id) must
    // be untouched — before the fix, an env-first daemon would have opened THIS SAME
    // partition (workspaceId=childId) and upserted id:childId into it, clobbering the
    // child's real inboxPath/cursorPath with the daemon's own (null) fields.
    const childStore = storeLib.openStore({ home, workspaceId: childId, backend: 'journal' });
    try {
      const childRow = childStore.listRegistry().find((r) => r.id === childId);
      assert.ok(childRow, 'the child\'s row still exists — never overwritten');
      assert.equal(childRow.inboxPath, '/some/child/inbox.json', 'the child\'s registry row was NOT clobbered');
      assert.equal(childRow.cursorPath, '/some/child/cursor.json', 'the child\'s registry row was NOT clobbered');
    } finally { childStore.close(); }
  } finally { rm(home); }
});

test('runIngestLoop: env.DEVSWARM_BUILDER_ID IS honored when the worktree does not resolve at all (no ground truth to contradict it)', () => {
  const home = tmpHome();
  try {
    const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-nogit-'));
    try {
      const batch = JSON.stringify([{ fromBranch: 'c', message: 'x', createdAt: '2026-01-01T00:00:00Z' }]);
      const summary = ingest.runIngestLoop({
        home, backend: 'journal', worktree: null, cwd: nogit, maxIterations: 1,
        run: () => ({ ok: true, raw: batch }), sleep: () => {},
        env: { DEVSWARM_BUILDER_ID: 'declared-id' },
      });
      assert.equal(summary.started, true);
      assert.equal(summary.workspaceId, 'declared-id', 'no worktree to contradict env — the declared id is trusted');
    } finally { fs.rmSync(nogit, { recursive: true, force: true }); }
  } finally { rm(home); }
});

test('runIngestLoop self-registration MERGE-PRESERVES an existing fuller registry row (P2) — a prior register-primary\'s real inboxPath/cursorPath/nudgeCommand survive every subsequent daemon startup instead of being nulled out', () => {
  const home = tmpHome();
  try {
    // Simulate a prior explicit `register-primary` CLI call that wrote a fuller row.
    const seedStore = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try {
      seedStore.upsertRegistry({
        id: 'p', worktreePath: '/real/worktree', sessionId: 'p',
        inboxPath: '/real/inbox.json', cursorPath: '/real/cursor.json', nudgeCommand: 'echo nudge',
      });
    } finally { seedStore.close(); }

    const batch = JSON.stringify([{ fromBranch: 'c', message: 'x', createdAt: '2026-01-01T00:00:00Z' }]);
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run: () => ({ ok: true, raw: batch }), sleep: () => {},
    });

    const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try {
      const row = s.listRegistry().find((r) => r.id === 'p');
      assert.ok(row, 'the row still exists after the daemon\'s startup self-registration');
      assert.equal(row.inboxPath, '/real/inbox.json', 'inboxPath preserved, not nulled out');
      assert.equal(row.cursorPath, '/real/cursor.json', 'cursorPath preserved, not nulled out');
      assert.equal(row.nudgeCommand, 'echo nudge', 'nudgeCommand preserved, not nulled out');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('runIngestLoop self-registration is FAIL-OPEN — a registry-write error never blocks message ingestion', () => {
  const home = tmpHome();
  try {
    const io = {
      openStore(args) {
        const real = storeLib.openStore(args);
        real.upsertRegistry = function () { throw new Error('registry write boom'); };
        return real;
      },
    };
    const batch = JSON.stringify([{ fromBranch: 'c', message: 'x', createdAt: '2026-01-01T00:00:00Z' }]);
    let summary;
    assert.doesNotThrow(() => {
      summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
        run: () => ({ ok: true, raw: batch }), sleep: () => {}, io,
      });
    }, 'a self-registration failure must never crash or block the daemon\'s core drain');
    assert.equal(summary.started, true);
    assert.equal(summary.stats.inserted, 1, 'the message was still ingested despite the registry-write error');
    const logContent = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(logContent, /WARN: self-registration failed \(workspaceId=p\): registry write boom/);
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
    // Register 'p' so a successful poll can project it (into 'p's per-project store).
    const reg = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
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
    const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
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

// ---------------------------------------------------------------------------
// Daemon error/crash logging (P0 fix): a startup or main-loop failure used to
// exit silently — nothing captured anywhere. Every failure path now appends a
// timestamped line to ~/.anti-hall/devswarm-ingest.log (the SAME stable log
// install-devswarm-ingest.js wires launchd/systemd/cron's stdout+stderr into)
// BEFORE the process would exit non-zero.
// ---------------------------------------------------------------------------

test('logFilePath matches the installer\'s stable LOG constant (same file both sides write/read)', () => {
  const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
  const home = tmpHome();
  try {
    assert.strictEqual(ingest.logFilePath(home), path.join(home, '.anti-hall', 'devswarm-ingest.log'));
    // Confirm this derivation is byte-identical to the installer's LOG (built from
    // os.homedir()) shape: same relative suffix under the home dir.
    assert.ok(installer.LOG.endsWith(path.join('.anti-hall', 'devswarm-ingest.log')));
  } finally { rm(home); }
});

test('appendLog writes a timestamped [ISO] line and appends (never truncates) across multiple calls', () => {
  const home = tmpHome();
  try {
    ingest.appendLog(home, 'first line');
    ingest.appendLog(home, 'second line');
    const content = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] first line$/);
    assert.match(lines[1], /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] second line$/);
  } finally { rm(home); }
});

test('appendLog is FAIL-OPEN: a logging failure is swallowed and never throws', () => {
  const boomFs = {
    mkdirSync() { throw new Error('disk full'); },
    appendFileSync() { throw new Error('disk full'); },
  };
  assert.doesNotThrow(() => ingest.appendLog('/does/not/matter', 'x', boomFs));
});

test('runIngestLoop logs the lock-refusal reason to the stable log before returning started:false', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const held = ingest.acquireIngestLock(home, undefined, wt);
    assert.ok(held, 'pre-held the lock');
    try {
      const summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
        run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      });
      assert.equal(summary.started, false);
      const logContent = fs.readFileSync(ingest.logFilePath(home), 'utf8');
      assert.match(logContent, /\[\d{4}-\d{2}-\d{2}T.*\] ingest daemon refused to start: another monitor consumer is already running/);
    } finally { held(); }
  } finally { rm(home); }
});

test('runIngestLoop logs a startup line with worktree + workspaceId once the store opens', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
    });
    assert.equal(summary.started, true);
    const logContent = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(logContent, new RegExp('\\[\\d{4}-\\d{2}-\\d{2}T.*\\] ingest daemon started, worktree=' + wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ', workspaceId=p'));
  } finally { rm(home); }
});

test('runIngestLoop APPENDS a timestamped ERROR+stack line to the log BEFORE rethrowing a startup (store-open) failure', () => {
  const home = tmpHome();
  try {
    const io = {
      openStore() { throw new Error('store open boom'); },
    };
    assert.throws(() => ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, io,
    }), /store open boom/);
    const logContent = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] ERROR: store open boom$/m, 'the ERROR line carries the message');
    assert.match(logContent, /Error: store open boom\n\s+at /, 'a stack trace follows the ERROR line');
  } finally { rm(home); }
});

test('runIngestLoop APPENDS a timestamped ERROR+stack line for a NON-lock mid-loop failure too, before rethrowing', () => {
  const home = tmpHome();
  try {
    const io = {
      openStore(args) {
        const real = storeLib.openStore(args);
        real.appendMessage = function () { throw new Error('unexpected mid-loop bug'); };
        return real;
      },
    };
    const run = () => ({ ok: true, raw: JSON.stringify([{ message: 'x', createdAt: '2026-01-01T00:00:00Z' }]) });
    assert.throws(() => ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run, sleep: () => {}, restartBackoffMs: 0, io,
    }), /unexpected mid-loop bug/);
    const logContent = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(logContent, /ERROR: unexpected mid-loop bug/);
  } finally { rm(home); }
});

test('runIngestLoop is FAIL-OPEN when the ERROR log write itself fails — the original error still propagates, unmasked', () => {
  const home = tmpHome();
  try {
    const boomLogFs = {
      mkdirSync() { throw new Error('log disk full'); },
      appendFileSync() { throw new Error('log disk full'); },
    };
    const io = {
      openStore() { throw new Error('store open boom'); },
      logFs: boomLogFs,
    };
    assert.throws(() => ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, io,
    }), /store open boom/, 'the original error still propagates even though logging it failed');
  } finally { rm(home); }
});

test('a lock leaked by NO earlier release is still released when store-open throws (finally always runs)', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const io = { openStore() { throw new Error('store open boom'); } };
    assert.throws(() => ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, io,
    }));
    // The lock must have been released in `finally` despite the throw — a fresh
    // acquire must succeed immediately (no leaked lock forcing a stale-steal wait).
    const rel = ingest.acquireIngestLock(home, undefined, wt);
    assert.ok(rel, 'lock was released despite the startup failure — not leaked');
    rel();
  } finally { rm(home); }
});
