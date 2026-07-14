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
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

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
    // v0.57 mesh (D1/D9/Phase5): the daemon's heartbeat is now keyed by repoKey
    // (the shared per-project store key) when resolvable — `wt` is a real git
    // worktree here, so repoKey resolves.
    const hash = repokey.repoKeyForWorktree(wt);
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

// P0 FIX (production incident, v0.58.0): a real-world ingest daemon was observed
// refusing to start for ~15 HOURS straight — thousands of "another monitor consumer
// is already running" refusals, far past the 15-min INGEST_LOCK_STALE_MS window,
// with ZERO error/crash lines logged the entire time. Root cause: main() never gave
// defaultMonitorRun's spawnSync call a `timeout` (hardTimeoutMs), so a hivecontrol
// child that didn't honor its own soft `-t` deadline could block spawnSync — and
// thus the WHOLE daemon, including the lock heartbeat that only advances BETWEEN
// loop iterations — indefinitely. The daemon was then genuinely, correctly reported
// alive by isAlive() the entire time (working as designed: never steal a live
// holder), so no OTHER starter could ever reclaim the lock until the wedged process
// eventually died on its own. This test proves runIngestLoop now bounds every
// monitor call with a real, finite hardTimeoutMs by default. FAILS on pre-fix code
// (hardTimeoutMs was always `undefined` there).
test('runIngestLoop passes a bounded hardTimeoutMs to EVERY monitor call by default (P0 fix — an unbounded/wedged monitor call can no longer block the lock holder forever)', () => {
  const home = tmpHome();
  try {
    const seen = [];
    const run = (opts) => { seen.push(opts.hardTimeoutMs); return { ok: true, raw: '[]' }; };
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 3,
      run, sleep: () => {},
    });
    assert.equal(summary.started, true);
    for (const v of seen) {
      assert.ok(Number.isFinite(v) && v > 0, 'hardTimeoutMs must be a real, positive, finite bound, never undefined/unbounded — got ' + v);
    }
    // The hard bound must sit strictly ABOVE the soft -t deadline (else spawnSync
    // could kill the child before hivecontrol's own timeout ever gets a chance to
    // return cleanly with an empty/quiet result).
    assert.ok(seen[0] > ingest.DEFAULT_MONITOR_TIMEOUT_SEC * 1000, 'the hard kill bound leaves headroom above the soft -t deadline');
  } finally { rm(home); }
});

test('runIngestLoop: explicit opts.hardTimeoutMs still overrides the new default (tuning/tests unaffected)', () => {
  const home = tmpHome();
  try {
    const seen = [];
    const run = (opts) => { seen.push(opts.hardTimeoutMs); return { ok: true, raw: '[]' }; };
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run, sleep: () => {}, hardTimeoutMs: 5000,
    });
    assert.equal(summary.started, true);
    assert.equal(seen[0], 5000, 'an explicit hardTimeoutMs always wins over the computed default');
  } finally { rm(home); }
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
    const hash = repokey.repoKeyForWorktree(wt); // v0.57 mesh: heartbeat keyed by repoKey (D1/D9)
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
    const hash = repokey.repoKeyForWorktree(wt); // v0.57 mesh: heartbeat keyed by repoKey (D1/D9)
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

// P1-B FIX (v0.58.1): a lock leaked by a killed daemon used to be reclaimable only
// once BOTH stale AND dead — stranding ingestion for up to INGEST_LOCK_STALE_MS
// (~15min) behind a holder that could never come back (Node cannot run a
// SIGTERM/SIGINT handler while the event loop is blocked inside spawnSync, so a
// daemon killed mid-spawn never gets a chance to release its own lock). A holder
// with a KNOWN pid confirmed DEAD is now reclaimed IMMEDIATELY, without waiting
// out the staleness window. FAILS on pre-fix code (which required stale && !alive
// and refused this exact dead-but-fresh case).
test('acquireIngestLock RECLAIMS a DEAD holder IMMEDIATELY even when its lock is still FRESH (P1-B fix)', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = 100000;
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts, token: 'fresh-dead' }));
    // Dead AND NOT stale (heartbeat window not elapsed) -> reclaimed immediately;
    // a dead pid can never come back, so there is nothing to gain by waiting.
    const rel = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => ts + 1000 });
    assert.ok(rel, 'a dead holder is reclaimed immediately, even with a fresh timestamp');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.notEqual(cur.token, 'fresh-dead', 'the reclaimed lock is now ours');
    rel();
  } finally { rm(home); }
});

// A genuinely UNKNOWN holder (no pid to check — unparseable/torn record) is a
// DIFFERENT case from a KNOWN-dead pid: liveness can only be inferred from mtime,
// never confirmed, so it still needs BOTH stale AND not-alive before reclaim —
// unchanged by P1-B. Covered by the TORN/EMPTY-lock tests below.

test('acquireIngestLock: TWO concurrent starters racing a DEAD-but-FRESH lock (P1-B immediate-reclaim path) — exactly ONE wins, never both', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = 100000; // fresh — NOT past INGEST_LOCK_STALE_MS
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts, token: 'dead-holder' }));
    // Simulate two processes racing on the exact same dead-but-fresh lock (mirrors
    // the existing stale-lock race test below, but exercises the NEW immediate-
    // reclaim branch specifically — staleness never enters into it here). isAlive
    // is pid-aware (dead only for the original holder's pid 4242) rather than a
    // blanket `false`: a blanket false would also mis-report the WINNING racer's
    // own real process as dead once the losing racer re-reads the file on its
    // second attempt, causing it to wrongly steal the winner's fresh lock right
    // back — an artifact of the mock, not a real possibility (a process can never
    // observe its own live pid as dead).
    const isAliveExceptOriginal = (pid) => pid !== 4242;
    let otherRacerRan = false;
    let otherRacerResult;
    const racerFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'unlinkSync') {
          return function (target_p) {
            const r = target.unlinkSync(target_p);
            if (!otherRacerRan && target_p === p) {
              otherRacerRan = true;
              otherRacerResult = ingest.acquireIngestLock(home, { isAlive: isAliveExceptOriginal, now: () => ts + 1000 });
            }
            return r;
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    const first = ingest.acquireIngestLock(home, { isAlive: isAliveExceptOriginal, now: () => ts + 1000, fs: racerFs });
    assert.ok(otherRacerRan, 'the injected race actually ran');
    assert.ok(otherRacerResult, 'the OTHER racer (which reclaimed first) got the lock');
    assert.equal(first, null, 'the ORIGINAL racer must back off once it sees the lock was already re-claimed — never a double-consumer, even on the not-yet-stale immediate-reclaim path');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.notEqual(cur.token, 'dead-holder', 'the lock is held by exactly the winning racer');
    otherRacerResult();
  } finally { rm(home); }
});

test('runIngestLoop: a DEAD-but-FRESH lock is reclaimed immediately and the daemon STARTS (P1-B, full daemon-level proof)', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const p = ingest.ingestLockPath(home, wt);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = 100000; // fresh, NOT stale
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts, token: 'dead-holder' }));
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { isAlive: () => false, now: () => ts + 1000 },
    });
    assert.equal(summary.started, true, 'the daemon starts immediately once the dead holder is confirmed dead, without waiting out the staleness window');
  } finally { rm(home); }
});

test('runIngestLoop: an ALIVE holder still REFUSES the daemon (single-consumer invariant preserved by the P1-B fix)', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const p = ingest.ingestLockPath(home, wt);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = 1000; // old, but the holder is ALIVE — must never be stolen
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts, token: 'live-holder' }));
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { isAlive: () => true, now: () => ts + 60 * 60 * 1000 },
    });
    assert.equal(summary.started, false, 'a live holder is never stolen, so the daemon correctly refuses to start');
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
    // A would-be thief checking at this moment: the holder is a REAL live process
    // (our own test pid), so the default isAlive() correctly reports it as alive
    // and refuses regardless of how fresh/stale the heartbeat looks (P1-B's
    // immediate-reclaim path only ever applies to a CONFIRMED-dead pid).
    const thief = ingest.acquireIngestLock(home, { now: () => t + 1000 });
    assert.equal(thief, null, 'a live holder (even freshly heartbeated) is never stolen');
    rel();
  } finally { rm(home); }
});

test('acquireIngestLock RECLAIMS a CORRUPT (non-empty garbage) lock file once its mtime is stale — no crash', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json at all'); // corrupt, not merely empty
    const mt = fs.statSync(p).mtimeMs;
    let rel;
    assert.doesNotThrow(() => {
      rel = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => mt + 16 * 60 * 1000 });
      assert.ok(rel, 'a corrupt lock with an OLD mtime is reclaimed, not just an empty one');
    }, 'a corrupt/unparseable lock record must never crash acquisition');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(cur.token, 'the reclaimed lock now carries a real token');
    rel();
  } finally { rm(home); }
});

test('acquireIngestLock: TWO concurrent starters racing to steal the SAME stale lock — exactly ONE wins, never both (single-consumer invariant preserved)', () => {
  const home = tmpHome();
  try {
    const p = ingest.ingestLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const oldTs = 1000;
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts: oldTs, token: 'dead-holder' }));
    // Simulate two processes racing on the exact same stale+dead lock: the FIRST
    // acquireIngestLock's unlinkSync (the steal) is intercepted so a SECOND, fully
    // independent acquireIngestLock call runs to completion "in between" — exactly
    // the two-daemons-racing-a-stale-lock scenario the single-consumer invariant
    // must survive (stealing a lock that's ALREADY been re-claimed by someone else
    // would split the destructive native queue between two live consumers). isAlive
    // is pid-aware (dead only for the original holder's pid 4242) rather than a
    // blanket `false`: a blanket false would also mis-report the WINNING racer's
    // own real process as dead once the losing racer re-reads the file on its
    // second attempt (P1-B's immediate-reclaim path), wrongly stealing the
    // winner's fresh lock right back — an artifact of the mock, not a real
    // possibility (a process can never observe its own live pid as dead).
    const isAliveExceptOriginal = (pid) => pid !== 4242;
    let otherRacerRan = false;
    let otherRacerResult;
    const racerFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'unlinkSync') {
          return function (target_p) {
            const r = target.unlinkSync(target_p);
            if (!otherRacerRan && target_p === p) {
              otherRacerRan = true;
              // The "other" racer sees the file gone and reclaims it FIRST.
              otherRacerResult = ingest.acquireIngestLock(home, { isAlive: isAliveExceptOriginal, now: () => oldTs + 60 * 60 * 1000 });
            }
            return r;
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    const first = ingest.acquireIngestLock(home, { isAlive: isAliveExceptOriginal, now: () => oldTs + 60 * 60 * 1000, fs: racerFs });
    assert.ok(otherRacerRan, 'the injected race actually ran');
    assert.ok(otherRacerResult, 'the OTHER racer (which reclaimed first) got the lock');
    assert.equal(first, null, 'the ORIGINAL racer must back off once it sees the lock was already re-claimed — never a double-consumer');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.notEqual(cur.token, 'dead-holder', 'the lock is held by exactly the winning racer');
    otherRacerResult();
  } finally { rm(home); }
});

// P0 FIX (signal-safe release): a normal return/throw already releases the lock via
// runIngestLoop's `finally`, but that's ordinary JS control flow — an OS SIGTERM
// (launchd stopping/restarting this unit) or SIGINT (Ctrl-C) bypasses it entirely
// (Node's default disposition is immediate termination), leaking the lock and
// forcing every OTHER starter to wait out the full stale window. SIGTERM/SIGINT are
// trappable (unlike SIGKILL/a hard OOM-kill, which no userland code can intercept —
// those still rely on the stale+dead reclaim path, unchanged). `io.process` is a
// fake process-like object (mirrors the file's other io.fs/io.isAlive/io.now DI
// seams) so this is fully deterministic — no real OS signal is sent to the test
// worker.
function fakeProcess() {
  const handlers = {};
  let exitCode = null;
  return {
    on(sig, fn) { (handlers[sig] = handlers[sig] || []).push(fn); },
    removeListener(sig, fn) {
      if (!handlers[sig]) return;
      handlers[sig] = handlers[sig].filter((h) => h !== fn);
    },
    exit(code) { exitCode = code; },
    listenerCount(sig) { return (handlers[sig] || []).length; },
    fire(sig) { for (const fn of (handlers[sig] || []).slice()) fn(); },
    get exitCode() { return exitCode; },
  };
}

// These two tests check the lock file's state SYNCHRONOUSLY, mid-loop, in the same
// tick the signal fires — i.e. strictly BEFORE runIngestLoop's own pre-existing
// `finally` (which ALSO releases the lock, on ANY normal loop completion, pre-fix
// included) ever gets a chance to run. That isolates the assertion to the NEW
// signal-handler code path only — a test that merely checked "is the lock gone
// after runIngestLoop returns" would pass even on pre-fix code (the ordinary
// finally already released it once the mocked loop reached maxIterations), so it
// would NOT be stash-proof.
test('runIngestLoop releases the lock on SIGTERM IMMEDIATELY, mid-loop — independent of the eventual finally cleanup (was previously UNHANDLED)', () => {
  const home = tmpHome();
  const proc = fakeProcess();
  const lockPath = ingest.ingestLockPath(home);
  let releasedDuringSignal = null;
  const run = () => {
    const before = fs.existsSync(lockPath);
    proc.fire('SIGTERM'); // simulate the signal arriving while the daemon is mid-poll
    const after = fs.existsSync(lockPath);
    releasedDuringSignal = before && !after;
    return { ok: true, raw: '[]' };
  };
  try {
    // worktree: null forces the SAME legacy global lock path `lockPath` above was
    // computed with (ingest.ingestLockPath(home) with no worktree arg) — without
    // this the loop resolves the test process's OWN real git worktree and locks a
    // DIFFERENT (per-project) file, making the existsSync checks below check the
    // wrong path entirely.
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: null,
      run, sleep: () => {}, io: { process: proc },
    });
  } finally { rm(home); }
  assert.equal(proc.exitCode, 0, 'the signal handler called process.exit(0)');
  assert.equal(releasedDuringSignal, true, 'the lock was gone IMMEDIATELY when the signal fired — released by the SIGTERM handler itself, not merely by the pre-existing finally afterward');
});

test('runIngestLoop releases the lock on SIGINT IMMEDIATELY, mid-loop (Ctrl-C) — independent of the eventual finally cleanup', () => {
  const home = tmpHome();
  const proc = fakeProcess();
  const lockPath = ingest.ingestLockPath(home);
  let releasedDuringSignal = null;
  const run = () => {
    const before = fs.existsSync(lockPath);
    proc.fire('SIGINT');
    const after = fs.existsSync(lockPath);
    releasedDuringSignal = before && !after;
    return { ok: true, raw: '[]' };
  };
  try {
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: null,
      run, sleep: () => {}, io: { process: proc },
    });
  } finally { rm(home); }
  assert.equal(proc.exitCode, 0, 'the SIGINT handler called process.exit(0)');
  assert.equal(releasedDuringSignal, true, 'the lock was gone IMMEDIATELY when the signal fired — released by the SIGINT handler itself');
});

test('runIngestLoop de-registers its signal handlers on normal completion (no listener leak across daemon lifecycles)', () => {
  const home = tmpHome();
  try {
    const proc = fakeProcess();
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, io: { process: proc },
    });
    assert.equal(summary.started, true);
    assert.equal(proc.listenerCount('SIGTERM'), 0, 'SIGTERM handler removed once the loop completes normally');
    assert.equal(proc.listenerCount('SIGINT'), 0, 'SIGINT handler removed once the loop completes normally');
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

    // worktree: null pins this test to the LEGACY hash-based store selection
    // (workspaceId-driven) — this test is about generic loop mechanics
    // (ingest/derive/replay), independent of the v0.57 repoKey rekey (which is
    // covered by its own dedicated tests, tests/companion/devswarm-ingest-mesh.test.js).
    const s1 = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1, run, sleep: () => {} });
    assert.equal(s1.started, true);
    assert.equal(s1.stats.inserted, 1);
    // projection written to THIS project's summaries/<hash>.json
    assert.ok(storeLib.readSummary(home, 'p').workspaces.p);

    // a second run re-observing the same in-flight batch imports nothing new
    const s2 = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1, run, sleep: () => {} });
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
    const primaryId = installIngest.primaryWorkspaceId(wt);
    // v0.57 mesh (D1/D8/D24): the daemon now opens the SHARED per-project store
    // (store/<repoKey>/) when repoKey resolves — `primaryId` (worktree-hash
    // based, D19) stays the SELF-REGISTRATION id/partition INSIDE that store, it
    // no longer selects which physical store is opened.
    const repoKey = repokey.repoKeyForWorktree(wt);
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

    const s = storeLib.readSummaryForHash(home, repoKey);
    assert.ok(s, 'a summary projection was written');
    assert.ok(s.workspaces[primaryId], 'the daemon\'s own primary/worktree id IS present in workspaces{} — was previously never registered, so this key never existed');
    assert.equal(s.workspaces[primaryId].total, 2);
    assert.equal(s.workspaces[primaryId].cursor, 0, 'nothing consumed yet');
    assert.equal(s.workspaces[primaryId].unread, 2, 'unread = appended (2) minus cursor (0)');

    // Advance the cursor (e.g. an inbox ack) and re-derive: unread must reflect
    // appended-minus-cursor, not just total — proving this is a live projection, not
    // a hand-written fixture.
    const s2store = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s2store.setCursor(primaryId, 1);
      storeLib.deriveSummary(s2store, { home });
    } finally { s2store.close(); }
    const s2 = storeLib.readSummaryForHash(home, repoKey);
    assert.equal(s2.workspaces[primaryId].unread, 1, 'unread updates to appended(2) - cursor(1) = 1 after ack');
  } finally { rm(home); }
});

test('runIngestLoop: WORKTREE is ground truth over env.DEVSWARM_BUILDER_ID — a daemon that inherits a CHILD id in its env still ingests + self-registers under the resolved worktree\'s primary id, never clobbering the child\'s registry row', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const primaryId = installIngest.primaryWorkspaceId(wt);
    // v0.57 mesh (D1/D8/D24): the daemon opens the SHARED per-project store
    // (store/<repoKey>/) — primaryId (worktree-hash based, D19) stays the
    // self-registration id/partition INSIDE that store.
    const repoKey = repokey.repoKeyForWorktree(wt);
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

    // Registration + ingest are the SAME id: the primary's own store partition (the
    // SHARED per-project repoKey store, not the child's id-derived legacy hash)
    // now carries its own row.
    const reg = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
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

// P1-A FIX (v0.58.1, message-loss guard): `hivecontrol workspace monitor` is
// DESTRUCTIVE — it pops messages off the native queue as it prints them. Node's
// spawnSync PRESERVES whatever a child already wrote to stdout before it was
// killed (verified: an ETIMEDOUT result still carries r.stdout). Pre-fix,
// defaultMonitorRun discarded r.stdout on ANY spawn error (including a
// hardTimeoutMs kill), and runIngestLoop skipped ingestion whenever `!res.ok` —
// so a monitor call that drained a real batch and THEN hung past its hard
// timeout would have its already-popped messages thrown away and PERMANENTLY
// lost (the native queue cannot re-deliver what it already handed out). FAILS on
// pre-fix code on both counts: defaultMonitorRun returned raw:'' on r.error, and
// runIngestLoop never even looked at res.raw when !res.ok.
test('defaultMonitorRun preserves stdout when the child is killed by hardTimeoutMs (spawnSync ETIMEDOUT) — P1-A fix', () => {
  if (process.platform === 'win32') return; // POSIX shebang script; not exercised on win32
  const home = tmpHome();
  try {
    const scriptPath = path.join(home, 'fake-hivecontrol.js');
    // Ignores whatever argv it's invoked with ('workspace monitor -i N -t N') —
    // writes a valid batch SYNCHRONOUSLY (fs.writeSync, guaranteed-flushed), then
    // blocks well past the hardTimeoutMs below so spawnSync is forced to kill it.
    fs.writeFileSync(scriptPath,
      '#!/usr/bin/env node\n'
      + 'require("fs").writeSync(1, JSON.stringify([{message:"drained-before-kill"}]));\n'
      + 'setTimeout(function(){}, 60000);\n');
    fs.chmodSync(scriptPath, 0o755);

    const res = ingest.defaultMonitorRun({ hivecontrol: scriptPath, hardTimeoutMs: 2000 });

    assert.equal(res.ok, false, 'a killed/timed-out child is still a failed attempt');
    assert.ok(res.error, 'the spawn error (ETIMEDOUT) is surfaced');
    assert.notEqual(res.raw, '', 'stdout the child already wrote before being killed must be PRESERVED, not discarded');
    assert.deepEqual(JSON.parse(res.raw), [{ message: 'drained-before-kill' }], 'the exact batch drained before the kill is intact');
  } finally { rm(home); }
});

test('runIngestLoop ingests stdout from a FAILED (ok:false) attempt instead of discarding it — P1-A fix', () => {
  const home = tmpHome();
  try {
    // Register 'p' so a successful projection can be built off the ingested batch.
    const reg = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try { reg.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null }); }
    finally { reg.close(); }

    // Simulates exactly what defaultMonitorRun now returns when spawnSync hits its
    // hard timeout (ETIMEDOUT) but the killed child had ALREADY written a valid
    // batch to stdout before being killed — ok:false AND non-empty raw, together.
    const batch = JSON.stringify([
      { fromBranch: 'c', toBranch: 'p', message: 'drained-before-timeout', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const run = () => ({ ok: false, raw: batch, error: 'ETIMEDOUT' });

    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1,
      run, sleep: () => {}, restartBackoffMs: 0,
    });

    assert.equal(summary.started, true);
    // The message already popped off the destructive native queue before the
    // timeout fired must NOT be discarded just because the attempt failed.
    assert.equal(summary.stats.inserted, 1, 'stdout from a failed/timed-out attempt is still ingested, not thrown away');
    // The attempt still counts as a failure for backoff/retry purposes — a
    // timeout is still a timeout even though its stdout happened to be salvaged.
    assert.equal(summary.stats.errors, 1, 'a failed attempt still counts as an error for backoff, even though its stdout was salvaged');

    const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
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
      // worktree: null pins this to the LEGACY hash-based store selection
      // (workspaceId-driven) — this test is about generic lock-error handling,
      // independent of the v0.57 repoKey rekey.
      summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 3,
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
