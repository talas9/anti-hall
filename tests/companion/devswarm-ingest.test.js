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
    // 4 heartbeats from the top-of-iteration write (once per cycle) PLUS one
    // extra heartbeat per non-final iteration's success-path pacing sleep (3 of
    // the 4 iterations pace via backoffWithHeartbeat, which itself heartbeats
    // before its slice-sleep — see the pacing fix above) = 4 + 3 = 7.
    assert.equal(hbWrites, 7, 'heartbeat written once per bounded cycle PLUS once per pacing sleep (independent of message arrival)');
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

// ---------------------------------------------------------------------------
// CODE-VERSION STAMP (pacing-fix delivery gap): the daemon's heartbeat now
// carries `codeVersion` (the installed plugin.json version, resolved once at
// startup) so doctor/update can tell a STILL-RUNNING pre-fix daemon apart from
// one that already re-exec'd onto new content — `git pull` rewrites the stable
// ExecStart script on disk, but this daemon's own main loop
// (maxIterations:Infinity) only re-execs on crash, so the running process would
// otherwise keep executing whatever it loaded at ITS OWN startup forever.
// ---------------------------------------------------------------------------

test('readInstalledPluginVersion: reads THIS repo\'s real plugin.json version (fail-open helper, direct unit test)', () => {
  const realJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(ingest.readInstalledPluginVersion(), realJson.version);
});

test('readInstalledPluginVersion: unreadable/malformed plugin.json -> null, never throws (fail-open)', () => {
  const throwingFs = { readFileSync: () => { throw new Error('ENOENT: no such file'); } };
  assert.equal(ingest.readInstalledPluginVersion(throwingFs), null);
  const malformedFs = { readFileSync: () => 'not json{{{' };
  assert.equal(ingest.readInstalledPluginVersion(malformedFs), null);
});

test('runIngestLoop: the heartbeat carries codeVersion (the real installed plugin.json version) and startedAtMs', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const hash = repokey.repoKeyForWorktree(wt);
    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    const realVersion = ingest.readInstalledPluginVersion();
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, now: 4242,
    });
    assert.equal(summary.started, true);
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.codeVersion, realVersion, 'heartbeat stamps the real installed plugin.json version');
    assert.equal(typeof beat.startedAtMs, 'number', 'heartbeat stamps a numeric daemon start time');
  } finally { rm(home); }
});

test('runIngestLoop: explicit opts.pluginVersion overrides the real on-disk read (test/tuning determinism)', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const hash = repokey.repoKeyForWorktree(wt);
    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, pluginVersion: '9.9.9-test',
    });
    assert.equal(summary.started, true);
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.codeVersion, '9.9.9-test');
  } finally { rm(home); }
});

// VACUOUS-RED PROOF for the "fail-open, never crashes the loop" behavior: when
// the plugin.json read itself throws (e.g. a marketplace clone mid-update, a
// permissions error), the daemon must still start and heartbeat — codeVersion
// degrades to null rather than taking the whole loop down with it.
test('runIngestLoop: a plugin.json read failure at startup is fail-open — codeVersion is null, the loop still starts and heartbeats normally', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd();
    const hash = repokey.repoKeyForWorktree(wt);
    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    const spyFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'readFileSync') {
          return function (p, ...rest) {
            if (typeof p === 'string' && p.endsWith(path.join('.claude-plugin', 'plugin.json'))) {
              throw new Error('simulated unreadable plugin.json');
            }
            return target.readFileSync(p, ...rest);
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: wt,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, io: { storeFs: spyFs },
    });
    assert.equal(summary.started, true, 'an unreadable plugin.json must never prevent the daemon from starting');
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.codeVersion, null, 'codeVersion degrades to null rather than crashing the read');
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

// Codex review P1-2 fix: heartbeat's tri-state contract (true / false / 'error')
// — a transient FS error must never be conflated with a definitive, provable
// lock loss (see heartbeat's own contract comment in acquireIngestLock).
test('release.heartbeat returns false (definitive loss) when the lock file is genuinely GONE (ENOENT)', () => {
  const home = tmpHome();
  try {
    const rel = ingest.acquireIngestLock(home);
    assert.ok(rel, 'acquired');
    fs.unlinkSync(ingest.ingestLockPath(home)); // simulate the lock vanishing out from under us
    assert.equal(rel.heartbeat(), false, 'ENOENT on read is definitive loss');
  } finally { rm(home); }
});

test('release.heartbeat returns false (definitive loss) when the lock file parses cleanly but the token no longer matches ours', () => {
  const home = tmpHome();
  try {
    const rel = ingest.acquireIngestLock(home);
    assert.ok(rel, 'acquired');
    const p = ingest.ingestLockPath(home);
    fs.writeFileSync(p, JSON.stringify({ pid: 99999, ts: Date.now(), token: 'someone-elses-token' }));
    assert.equal(rel.heartbeat(), false, 'a clean parse with a foreign token is definitive loss (reclaimed by another starter)');
  } finally { rm(home); }
});

test('release.heartbeat returns \'error\' (NOT false) on a transient non-ENOENT read failure — never conflated with lock loss', () => {
  const home = tmpHome();
  try {
    const rel = ingest.acquireIngestLock(home);
    assert.ok(rel, 'acquired');
    const realReadFileSync = fs.readFileSync;
    const p = ingest.ingestLockPath(home);
    fs.readFileSync = function (file, ...rest) {
      if (file === p) { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; }
      return realReadFileSync.call(fs, file, ...rest);
    };
    try {
      assert.equal(rel.heartbeat(), 'error', 'a non-ENOENT read error is transient, not proof of loss');
    } finally { fs.readFileSync = realReadFileSync; }
  } finally { rm(home); }
});

test('release.heartbeat returns \'error\' on a torn/unparseable read (racing a concurrent tmp+rename) — never conflated with lock loss', () => {
  const home = tmpHome();
  try {
    const rel = ingest.acquireIngestLock(home);
    assert.ok(rel, 'acquired');
    fs.writeFileSync(ingest.ingestLockPath(home), '{not valid json, caught mid-write');
    assert.equal(rel.heartbeat(), 'error', 'a torn/unparseable read is transient, not proof of loss');
  } finally { rm(home); }
});

test('release.heartbeat returns \'error\' when the write/rename step itself fails, leaving the still-valid lock in place — never conflated with lock loss', () => {
  const home = tmpHome();
  try {
    const rel = ingest.acquireIngestLock(home);
    assert.ok(rel, 'acquired');
    const realWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function (file, ...rest) {
      if (String(file).includes('.hb.')) { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; }
      return realWriteFileSync.call(fs, file, ...rest);
    };
    try {
      assert.equal(rel.heartbeat(), 'error', 'a write/rename failure is transient, not proof of loss');
    } finally { fs.writeFileSync = realWriteFileSync; }
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

// REVERSED (was P0 "signal-safe release"): registering a JS SIGTERM/SIGINT
// listener DISABLES Node's default terminate-on-signal disposition, making the
// process's death depend entirely on that listener actually running. But a JS
// signal handler can only run from the event loop, and this daemon spends its
// entire risky window blocked in a synchronous call (spawnSync / Atomics.wait)
// — so the listener was UNDELIVERABLE for as long as that block lasted, which
// in production is effectively always. This was CONFIRMED LIVE: 12 duplicate
// daemons, 7-12 days old, that ignored SIGTERM and only died to SIGKILL.
// runIngestLoop no longer registers any SIGTERM/SIGINT listener at all, so
// Node's default disposition (immediate termination, enforced by the runtime
// without needing the event loop to run any JS) governs instead. A lock left
// behind by a killed daemon self-heals via acquireIngestLock's
// dead-holder-immediate-reclaim path (P1-B) — no graceful in-process release
// is needed. `io.process` remains available as a DI seam for other tests, but
// there are no listeners left for it to intercept.
function fakeProcess() {
  const handlers = {};
  return {
    on(sig, fn) { (handlers[sig] = handlers[sig] || []).push(fn); },
    removeListener(sig, fn) {
      if (!handlers[sig]) return;
      handlers[sig] = handlers[sig].filter((h) => h !== fn);
    },
    listenerCount(sig) { return (handlers[sig] || []).length; },
    fire(sig) { for (const fn of (handlers[sig] || []).slice()) fn(); },
  };
}

test('runIngestLoop registers NO SIGTERM/SIGINT listener — Node default disposition (terminate) governs instead of an event-loop-bound JS handler', () => {
  const home = tmpHome();
  try {
    const proc = fakeProcess();
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {}, io: { process: proc },
    });
    assert.equal(summary.started, true);
    assert.equal(proc.listenerCount('SIGTERM'), 0, 'no SIGTERM listener registered — default (terminate) disposition applies');
    assert.equal(proc.listenerCount('SIGINT'), 0, 'no SIGINT listener registered — default (terminate) disposition applies');
  } finally { rm(home); }
});

// Real-process regression test (the actual behavior this fix restores) lives in
// devswarm-ingest-sigterm.test.js: it spawns runIngestLoop in a genuine CHILD
// PROCESS and asserts a real SIGTERM kills it promptly.

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
    s.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null });
    const batch = JSON.stringify([
      { fromBranch: 'c', toBranch: 'p', message: 'one', createdAt: '2026-01-01T00:00:00Z' },
      { fromBranch: 'c', toBranch: 'p', message: 'two', createdAt: '2026-01-01T00:00:01Z' },
    ]);
    const r1 = ingest.ingestPayload(s, batch, { workspaceId: 'p', home });
    assert.equal(r1.inserted, 2);
    const r2 = ingest.ingestPayload(s, batch, { workspaceId: 'p', home }); // replay
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

test('runIngestLoop self-registration is FAIL-OPEN — a registry-write error never crashes the daemon or drops the batch (kept in the WAL, ingested once registration lands)', () => {
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
    }, 'a self-registration failure must never crash the daemon');
    assert.equal(summary.started, true);
    assert.equal(summary.stats.inserted, 0, 'the unregistered partition refuses the write (partition door)');
    const logContent = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(logContent, /WARN: self-registration failed \(workspaceId=p\): registry write boom/);
    // Registration works again: the next run replays the pending WAL batch.
    const s2 = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run: () => ({ ok: true, raw: '' }), sleep: () => {},
    });
    assert.equal(s2.stats.inserted, 1, 'the batch was kept pending in the WAL and lands once registered');
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
    assert.equal(summary.stats.errors, 2, 'both lock errors are counted, not fatal');
    // Phase 5 delivery WAL: poll 1's batch (already POPPED from the destructive
    // native queue) is kept pending in the WAL and replayed — the pre-WAL
    // "replay next poll" silently lost m1. Iteration 2's replay hits the second
    // lock error, so NO new destructive monitor read runs (admission control);
    // iteration 3 replays m1, then polls m2.
    assert.equal(summary.stats.iterations, 2, 'no monitor read while a WAL batch is pending');
    assert.equal(summary.stats.walReplayed, 1);
    assert.equal(summary.stats.inserted, 2, 'm1 (replayed from the WAL) and m2 both land');
    const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try {
      assert.equal(s.messageCount('p'), 2);
      assert.deepEqual(s.listMessages('p').map((r) => r.body), ['m1', 'm2'], 'the popped-then-lock-failed batch is recovered');
    } finally { s.close(); }
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

// --- SUCCESS-PATH PACING (kernel-leak fix) ---------------------------------
// Root cause: `run` (hivecontrol workspace monitor -i/-t) is EXPECTED to
// long-poll for ~intervalSec, but production hivecontrol regularly returns in
// well under a second, and the loop previously had NO pacing sleep on the
// SUCCESS path — only the failure path backed off. With nothing to slow it
// down, a fast-returning `run` busy-spins the loop, spawning hivecontrol far
// more than once per intervalSec: a sustained macOS kernel-allocator leak
// (data.kalloc.1024) plus needless CPU. These tests prove the loop now paces
// itself to ~intervalSec between spawns on the success path, without touching
// the failure/backoff path.

// fakeClock(sequence) -> o.clock: a deterministic wall-clock stand-in for
// runIngestLoop's pacing window (iterationStart/elapsed — see pacingClock in
// devswarm-ingest.js). Returns each value in `sequence` in call order, then
// keeps returning the last value once exhausted. Each success iteration calls
// it once for iterationStart, and once more for the elapsed read UNLESS it's
// the final iteration (pacing is skipped there — nothing left to pace before).
//
// This replaces measuring REAL wall-clock time via busyWaitMs()+Date.now(),
// which is what made "pacing is ELAPSED-AWARE" flake on a loaded CI runner
// (macOS + node 24, run 36163517496): busyWaitMs(40) is a best-effort spin,
// not a guaranteed 40ms — under scheduler contention the actual measured span
// can be far shorter (observed: "expected ~114ms, got 24ms") or longer,
// blowing PACE_TOLERANCE_MS. A fake clock makes iterationStart/elapsed EXACT
// numbers chosen by the test, so the expected pace is computed, not measured,
// and every run of these tests is bit-for-bit reproducible under any load.
function fakeClock(sequence) {
  let i = 0;
  return () => {
    const v = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return v;
  };
}

test('runIngestLoop PACES the success path — a fast-returning run() does not busy-spin', () => {
  const home = tmpHome();
  try {
    const sleepCalls = [];
    const intervalMs = 100;
    // Deterministic clock: each success iteration's run() "costs" exactly 5ms
    // of the pacing window (iter0: 0 -> 5, iter1: 10 -> 15); iter2 is the
    // final iteration, so only its iterationStart (20) is ever read.
    const clock = fakeClock([0, 5, 10, 15, 20]);
    const run = () => ({ ok: true, raw: '[]' }); // "instant" success — clock alone drives elapsed
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 3,
      run, sleep: (ms) => sleepCalls.push(ms), intervalSec: intervalMs / 1000, // 100ms cadence, short so the test stays fast
      clock,
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.iterations, 3);
    // Every success iteration EXCEPT the last should have paced once via sleep()
    // (routed through backoffWithHeartbeat, the same primitive the failure path
    // already used — see the loop's sleep() call sites, there are only two:
    // backoffWithHeartbeat's slice sleep and the ELOCKFS/ELOCKUNAVAIL retry).
    assert.equal(sleepCalls.length, 2, 'paces after each success iteration except the final one (2 of 3)');
    // Exact, not approximate: pace = intervalMs(100) - elapsed(5) = 95, every time.
    assert.deepEqual(sleepCalls, [95, 95], 'pace must exactly track intervalMs - elapsed for each paced iteration');
  } finally { rm(home); }
});

test('runIngestLoop pacing is ELAPSED-AWARE — requires a nonzero, magnitude-correct pace when elapsed < interval', () => {
  const home = tmpHome();
  try {
    const sleepCalls = [];
    const intervalMs = 200;
    // Deterministic clock: iteration 0's run() "costs" exactly 40ms of the
    // 200ms budget (0 -> 40) — pacing should top up only the remainder
    // (proving pace = intervalMs - elapsed, not a flat sleep). Iteration 1 is
    // the last iteration, so only its iterationStart (200) is ever read.
    const clock = fakeClock([0, 40, 200]);
    const run = () => ({ ok: true, raw: '[]' });
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run, sleep: (ms) => sleepCalls.push(ms), intervalSec: intervalMs / 1000,
      clock,
    });
    assert.equal(sleepCalls.length, 1, 'iteration 0 must pace exactly once (iteration 1 is last, unpaced)');
    // Exact, not approximate: pace = intervalMs(200) - elapsed(40) = 160.
    assert.equal(sleepCalls[0], 160,
      'pace must be exactly intervalMs - elapsed — nonzero here, proving this is not the busy-spin regression this test guards against');
  } finally { rm(home); }
});

test('runIngestLoop pacing yields ~ZERO wait once elapsed already meets/exceeds the interval', () => {
  const home = tmpHome();
  try {
    const sleepCalls = [];
    const intervalMs = 100;
    // Deterministic clock: iteration 0's run() "costs" exactly 130ms — MORE
    // than the full 100ms interval budget — so pacing must not add any
    // further wait (pace clamps to 0 via Math.max(0, ...)). Iteration 1 is
    // the last iteration, so only its iterationStart (130) is ever read.
    const clock = fakeClock([0, 130, 130]);
    const run = () => ({ ok: true, raw: '[]' });
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
      run, sleep: (ms) => sleepCalls.push(ms), intervalSec: intervalMs / 1000,
      clock,
    });
    assert.equal(sleepCalls.length, 0, 'elapsed >= interval must produce a zero pace — backoffWithHeartbeat is skipped entirely (pace > 0 guard)');
  } finally { rm(home); }
});

test('runIngestLoop success-path pacing is SKIPPED on the final iteration', () => {
  const home = tmpHome();
  try {
    const sleepCalls = [];
    const run = () => ({ ok: true, raw: '[]' });
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
      run, sleep: (ms) => sleepCalls.push(ms), intervalSec: 0.1,
    });
    assert.equal(sleepCalls.length, 0, 'a single-iteration run never paces — nothing left to pace before');
  } finally { rm(home); }
});

test('runIngestLoop success-path pacing falls back to DEFAULT_MONITOR_INTERVAL_SEC on a bad intervalSec (0/negative/NaN)', () => {
  const home = tmpHome();
  for (const badInterval of [0, -5, NaN]) {
    const home2 = tmpHome();
    try {
      const sleepCalls = [];
      const run = () => ({ ok: true, raw: '[]' });
      ingest.runIngestLoop({
        home: home2, backend: 'journal', workspaceId: 'p', maxIterations: 2,
        run, sleep: (ms) => sleepCalls.push(ms), intervalSec: badInterval,
      });
      // Must still pace (not throw, not busy-spin unpaced) — falls back to the
      // 3s default, so the single pacing sleep (iteration 0) should be a large,
      // sane value bounded by DEFAULT_MONITOR_INTERVAL_SEC*1000 (3000ms), not 0
      // and not NaN/negative.
      assert.equal(sleepCalls.length, 1, `bad intervalSec (${badInterval}) still paces via the fallback default`);
      // run() is instant here (no busyWaitMs), so the expected pace is close to
      // the full DEFAULT_MONITOR_INTERVAL_SEC*1000 (3000ms) budget. Require the
      // pace to be MEANINGFULLY close to that bound (not just "some positive
      // number under 3000") — a broken constant 1ms sleep would satisfy the old
      // `> 0 && <= 3000` check but must fail this one.
      assert.ok(Number.isFinite(sleepCalls[0]) && sleepCalls[0] > 2500 && sleepCalls[0] <= 3000,
        `pace for bad intervalSec ${badInterval} should fall back to ~DEFAULT_MONITOR_INTERVAL_SEC (3000ms), got ${sleepCalls[0]}`);
    } finally { rm(home2); }
  }
  rm(home);
});

test('runIngestLoop success-path pacing CLAMPS an absurd/overflowing intervalSec to MAX_PACE_MS — no Infinity/0 busy-spin', () => {
  const sleepCalls = [];
  const run = () => ({ ok: true, raw: '[]' }); // instant success, elapsed ~0
  // 1e12: a merely-absurd but still-finite intervalSec (must clamp to MAX_PACE_MS).
  // 2e306: `paceIntervalSec > 0` so it passes the pre-existing NaN/negative
  // guard unchanged, but `paceIntervalSec * 1000` OVERFLOWS to Infinity — the
  // exact P2 defect (a huge finite intervalSec surviving the earlier guard
  // only to blow up on the *1000 multiply). Both must land on the same finite,
  // bounded pace.
  for (const hugeInterval of [1e12, 2e306]) {
    assert.ok(Number.isFinite(hugeInterval), 'sanity: intervalSec itself must be finite for this case');
    assert.equal(Number.isFinite(hugeInterval * 1000), hugeInterval !== 2e306, 'sanity: 2e306*1000 overflows, 1e12*1000 does not');
    const home = tmpHome();
    try {
      const summary = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 2,
        run, sleep: (ms) => sleepCalls.push(ms), intervalSec: hugeInterval,
      });
      assert.equal(summary.started, true);
    } finally { rm(home); }
  }
  // Each run's single paced iteration should produce exactly one 60s heartbeat
  // slice per full BACKOFF_HEARTBEAT_SLICE_MS chunk of MAX_PACE_MS (5 min / 1
  // min slices = 5 slices) — i.e. 5 sleep() calls per run, 10 total.
  assert.equal(sleepCalls.length, 10, '5 heartbeat-sliced sleep calls per run (MAX_PACE_MS / 60s slice) x 2 huge intervalSec cases');
  for (const ms of sleepCalls) {
    // The core P2 regression check: every slice must be a FINITE, bounded,
    // meaningfully-large number. Infinity (overflow) or 0/near-0 (the
    // busy-spin this whole fix exists to prevent — Infinity coerces to 0 in
    // both Number.isFinite-guarded backoffWithHeartbeat and sleepSync's
    // `ms | 0`) must NOT reach the sleep primitive.
    assert.ok(Number.isFinite(ms), `pace slice must be finite, got ${ms}`);
    assert.ok(ms > 0, `pace slice must be a real, positive wait — not a near-zero busy-spin value, got ${ms}ms`);
  }
  const totalPerRun = sleepCalls.slice(0, 5).reduce((a, b) => a + b, 0);
  assert.ok(totalPerRun <= ingest.MAX_PACE_MS, `total paced wait must be clamped to MAX_PACE_MS (${ingest.MAX_PACE_MS}ms), got ${totalPerRun}ms`);
});

test('REGRESSION: runIngestLoop FAILURE path still backs off exactly as before (pacing change is success-path only)', () => {
  const home = tmpHome();
  try {
    const sleepCalls = [];
    const run = () => ({ ok: false, raw: '', error: 'boom', code: 'ETIMEDOUT' });
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 3,
      run, sleep: (ms) => sleepCalls.push(ms), restartBackoffMs: 250, intervalSec: 0.1,
    });
    assert.equal(summary.stats.errors, 3);
    // The failure path backs off from restartBackoffMs (250ms here), NOT the
    // success-path pacing formula. Since 0.108.5 a TRANSIENT failure backs off
    // EXPONENTIALLY (250 -> 500), each under BACKOFF_HEARTBEAT_SLICE_MS so
    // sliced once — proving pacing did not leak into the failure/backoff path.
    assert.equal(sleepCalls.length, 2, 'backs off after each failure except the final iteration (2 of 3)');
    assert.deepEqual(sleepCalls, [250, 500], 'failure-path backoff is restartBackoffMs-based and doubles per consecutive transient failure');
  } finally { rm(home); }
});

// FIX B (lost-lock exit): release.heartbeat() returning false means the lock
// file no longer holds OUR token — another starter has reclaimed it as a dead
// holder (or it was deleted out from under us). Continuing to run after that
// would put TWO consumers on the same destructive native queue. The loop must
// stop as soon as that is detected, rather than discarding the return value
// (the pre-fix behavior) and running to maxIterations regardless.
test('runIngestLoop STOPS as soon as release.heartbeat() reports the lock was lost (does not keep running as a second consumer)', () => {
  const home = tmpHome();
  try {
    let heartbeatCalls = 0;
    let releaseCalled = false;
    const fakeRelease = Object.assign(
      () => { releaseCalled = true; },
      {
        heartbeat: () => {
          heartbeatCalls++;
          return heartbeatCalls < 2; // true on iteration 1, false starting iteration 2
        },
      },
    );
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 5,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { lock: () => fakeRelease },
    });
    assert.equal(summary.started, true);
    assert.ok(summary.stats.iterations < 5, `loop must stop early once the lock is lost, got ${summary.stats.iterations} iterations`);
    assert.equal(releaseCalled, true, 'the (now-moot) release() is still called in the finally cleanup');
  } finally { rm(home); }
});

test('runIngestLoop logs a clear line when it stops because the lock was lost', () => {
  const home = tmpHome();
  try {
    let heartbeatCalls = 0;
    const fakeRelease = Object.assign(
      () => {},
      { heartbeat: () => { heartbeatCalls++; return heartbeatCalls < 1; } }, // lost on the very first check
    );
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 5,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { lock: () => fakeRelease },
    });
    const log = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(log, /lock was reclaimed by another consumer|lost heartbeat/, 'log records why the daemon stopped');
  } finally { rm(home); }
});

// Codex review P1-2 fix at the runIngestLoop level: a heartbeat that reports
// 'error' (transient) on EVERY call must NOT stop the loop — only a definitive
// `false` may. This is the loop-level counterpart to the acquireIngestLock-level
// heartbeat() contract tests above.
test('runIngestLoop KEEPS RUNNING through persistent transient heartbeat errors (never conflates \'error\' with lock loss)', () => {
  const home = tmpHome();
  try {
    let heartbeatCalls = 0;
    const fakeRelease = Object.assign(
      () => {},
      { heartbeat: () => { heartbeatCalls++; return 'error'; } }, // always transient, never a definitive loss
    );
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 4,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { lock: () => fakeRelease },
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.iterations, 4, 'ran to completion — a transient heartbeat error is never treated as lock loss');
    assert.ok(heartbeatCalls >= 4, 'heartbeat was still consulted every cycle despite always erroring');
  } finally { rm(home); }
});

test('runIngestLoop logs a transient heartbeat error ONCE (not per-cycle) and does not log the lock-lost line for it', () => {
  const home = tmpHome();
  try {
    const fakeRelease = Object.assign(() => {}, { heartbeat: () => 'error' });
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 4,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { lock: () => fakeRelease },
    });
    const log = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    const transientLines = log.split('\n').filter((l) => l.includes('heartbeat failed transiently'));
    assert.equal(transientLines.length, 1, 'the transient-error line is logged exactly once, not once per cycle');
    assert.doesNotMatch(log, /lock was reclaimed by another consumer/, 'a transient error must never log the lock-lost line');
  } finally { rm(home); }
});

// Phase 5 (Codex P0 on Phase 3): a REAL live holder of the journal messages
// lock while ingest processes a popped monitor batch. Pre-WAL, the batch was
// skipped on ELOCKUNAVAIL after the destructive read — permanent loss. Now it
// stays pending in the delivery WAL, no new destructive read runs while the
// lock is held, and once the holder releases, every message is in the store.
test('runIngestLoop: a live messages-lock holder during ingest loses nothing — the WAL batch lands after release', () => {
  const home = tmpHome();
  try {
    const reg = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    let lockPath;
    try {
      reg.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null });
    } finally { reg.close(); }
    lockPath = path.join(storeLib.journalDir(home, 'p'), 'messages.lock');
    // A LIVE holder (this very process's pid, fresh ts) — never stolen.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held-by-test' }));
    // Short contention budget so the test does not wait the production ~20s.
    const io = { openStore: (args) => storeLib.openStore(Object.assign({}, args, { lock: { maxTries: 2, appendRetries: 1 } })) };
    const batch = JSON.stringify([
      { fromBranch: 'c', message: 'held-1', createdAt: '2026-01-01T00:00:01Z' },
      { fromBranch: 'c', message: 'held-2', createdAt: '2026-01-01T00:00:02Z' },
    ]);
    let polls = 0;
    const run = () => { polls++; return { ok: true, raw: polls === 1 ? batch : '', error: null }; };
    const held = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 3, run, sleep: () => {}, restartBackoffMs: 0, io });
    assert.equal(held.started, true);
    assert.equal(polls, 1, 'no second destructive read while the popped batch cannot be stored');
    assert.equal(held.stats.inserted, 0);
    fs.unlinkSync(lockPath); // the holder releases
    const after = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1, run, sleep: () => {}, restartBackoffMs: 0, io });
    assert.equal(after.stats.walReplayed, 1);
    const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
    try {
      assert.deepEqual(s.listMessages('p').map((r) => r.body).sort(), ['held-1', 'held-2'], 'every popped message is in the store');
    } finally { s.close(); }
  } finally { rm(home); }
});

// Phase 5 review (P0 b): the monitor path fails CLOSED on an unwritable WAL.
test('runIngestLoop: an unwritable WAL path -> no destructive monitor read at all', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'wal'), 'not-a-directory');
    let polls = 0;
    const run = () => { polls++; return { ok: true, raw: '[]', error: null }; };
    const r = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 3, run, sleep: () => {}, restartBackoffMs: 0 });
    assert.equal(r.started, true);
    assert.equal(polls, 0, 'never pop the native queue into a WAL that cannot be written');
    assert.equal(r.stats.walBlocked, true);
  } finally { rm(home); }
});

test('runIngestLoop: a WAL batch-write failure spills the raw batch and blocks reads until it is absorbed', () => {
  const home = tmpHome();
  try {
    const readWal = require('../../plugins/anti-hall/companion/lib/devswarm-read-wal.js');
    const batch = JSON.stringify([{ fromBranch: 'c', message: 'spilled-1', createdAt: '2026-01-01T00:00:01Z' }]);
    const badFs = Object.assign({}, fs, {
      writeSync(fd, data, ...rest) {
        if (typeof data === 'string' && data.includes('"t":"batch"')) throw new Error('EIO simulated');
        return fs.writeSync(fd, data, ...rest);
      },
    });
    let polls = 0;
    const run = () => { polls++; return { ok: true, raw: polls === 1 ? batch : '', error: null }; };
    const bad = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 3, run, sleep: () => {}, restartBackoffMs: 0, io: { storeFs: badFs } });
    assert.equal(polls, 1, 'after the spill, no further destructive read');
    assert.equal(bad.stats.walBlocked, true);
    const walFile = fs.readdirSync(path.join(home, '.anti-hall', 'devswarm', 'wal')).map((n) => path.join(home, '.anti-hall', 'devswarm', 'wal', n)).find((f) => f.includes('monitor-'));
    const spilled = readWal.spillPending(fs, walFile);
    assert.equal(spilled.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(spilled[0], 'utf8')).raw, batch, 'byte-exact raw in the spill');
    const good = ingest.runIngestLoop({ home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1, run, sleep: () => {}, restartBackoffMs: 0 });
    assert.equal(good.stats.walReplayed, 1, 'the spilled batch is absorbed and replayed');
    assert.deepEqual(readWal.spillPending(fs, walFile), []);
    assert.deepEqual(readWal.pending(fs, walFile), []);
  } finally { rm(home); }
});
