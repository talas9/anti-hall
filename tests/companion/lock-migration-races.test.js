'use strict';
// Regression tests for the races the lock.js migration fixed in each former
// hand-written lock. Two shapes recur:
//   RECLAIM RACE — two contenders both judge the SAME dead/stale holder and
//     both blind-unlinkSync(p); the second unlink deletes the FIRST's fresh
//     lock and both "win". lock.js renames the judged file aside and verifies
//     its token, so the second contender respects the fresh lock.
//   TORN READ — a live holder is briefly an EMPTY file (O_EXCL create ->
//     write). A contender that read an empty/unparseable holder as "ownerless,
//     stale" stole a live lock. lock.js dates it by mtime instead.
// Each test injects a nested contender at the exact window (inside the outer
// call's read of the holder), tighter than two real processes can guarantee.
// All homes are fresh tmpdirs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
// Isolate the central log before anything that may log is required.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lockrace-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lockrace-')); }
function rm(d) { fs.rmSync(d, { recursive: true, force: true }); }
function isFn(x) { return typeof x === 'function' || (x && typeof x === 'object'); }

// reclaimRace(lockPath, seed, acquire) — `acquire(fsOverride)` returns a
// truthy handle or null. The seeded holder is dead/stale for both contenders.
function reclaimRace(lockPath, seed, acquire) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(seed));
  let nested = 'not-run';
  const racing = Object.assign({}, fs, {
    readFileSync(file, enc) {
      const raw = fs.readFileSync(file, enc);
      if (file === lockPath && nested === 'not-run') { nested = null; nested = acquire(fs); }
      return raw;
    },
  });
  const outer = acquire(racing);
  assert.notStrictEqual(nested, 'not-run', 'precondition: the nested contender ran inside the window');
  const winners = [outer, nested].filter(isFn);
  assert.strictEqual(winners.length, 1, 'exactly one contender wins the reclaim, never both');
  const left = fs.readdirSync(path.dirname(lockPath)).filter((n) => /\.(reap|tmp)-/.test(n));
  assert.deepStrictEqual(left, [], 'no scratch left behind');
  return winners[0];
}

// tornFresh(lockPath, acquire) — an EMPTY lock file with a fresh mtime is a
// live holder mid-write and must be respected.
function tornFresh(lockPath, acquire) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');
  const got = acquire(fs);
  assert.ok(!isFn(got), 'a fresh empty (mid-write) lock is never stolen');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), '', 'the live holder\'s file is untouched');
}

test('supervisor sweep lock: reclaim race + torn read', () => {
  const sup = require(path.join(ROOT, 'companion', 'devswarm-supervisor.js'));
  const home = tmpHome();
  try {
    const p = sup.sweepLockPath(home);
    const w = reclaimRace(p, { pid: 999999, ts: Date.now(), token: 'dead' },
      (F) => sup.acquireSweepLock(home, { fs: F, isAlive: (pid) => pid === process.pid }));
    w();
    tornFresh(p, (F) => sup.acquireSweepLock(home, { fs: F, isAlive: () => true }));
  } finally { rm(home); }
});

test('migrate lock: reclaim race (stale + dead holder) + torn read', () => {
  const mig = require(path.join(ROOT, 'companion', 'devswarm-migrate.js'));
  const home = tmpHome();
  try {
    const p = mig.migrateLockPath(home);
    const w = reclaimRace(p, { pid: 999999, ts: 1000, token: 'dead' },
      (F) => mig.acquireMigrateLock(home, { fs: F, isAlive: (pid) => pid === process.pid }));
    w();
    tornFresh(p, (F) => mig.acquireMigrateLock(home, { fs: F, isAlive: () => false }));
  } finally { rm(home); }
});

test('pull lock (acquireExclLock, also wake-watch): reclaim race (stale + dead holder) + torn read', () => {
  const pull = require(path.join(ROOT, 'companion', 'lib', 'devswarm-pull.js'));
  const home = tmpHome();
  try {
    const p = path.join(home, 'locks', 'pull-x.lock');
    const w = reclaimRace(p, { pid: 999999, ts: 1000, token: 'dead' },
      (F) => pull.acquireExclLock(p, { fs: F, isAlive: (pid) => pid === process.pid }, 60000));
    w();
    tornFresh(p, (F) => pull.acquireExclLock(p, { fs: F, isAlive: () => false, allowStaleLiveSteal: true }, 60000));
  } finally { rm(home); }
});

// globalReclaimRace — for a lock whose module has no fs seam: interpose on the
// real fs.readFileSync for the duration of the outer call.
function globalReclaimRace(t, lockPath, seed, acquire) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(seed));
  const real = fs.readFileSync;
  let nested = 'not-run';
  const m = t.mock.method(fs, 'readFileSync', function (file, enc) {
    const raw = real.call(fs, file, enc);
    if (file === lockPath && nested === 'not-run') { nested = null; nested = acquire(); }
    return raw;
  });
  let outer;
  try { outer = acquire(); } finally { m.mock.restore(); }
  assert.notStrictEqual(nested, 'not-run', 'precondition: the nested contender ran inside the window');
  const winners = [outer, nested].filter(isFn);
  assert.strictEqual(winners.length, 1, 'exactly one contender wins the reclaim, never both');
  return winners[0];
}

test('retention lock: reclaim race (dead holder) + torn read', (t) => {
  const ret = require(path.join(ROOT, 'companion', 'lib', 'devswarm-retention.js'));
  const home = tmpHome();
  try {
    const p = ret.lockPath(home);
    // pid 2147483646 exceeds any pid_max -> kill(pid,0) is ESRCH (dead).
    const w = globalReclaimRace(t, p, { pid: 2147483646, ts: Date.now(), token: 'dead' }, () => ret.acquireLock(home));
    w();
    tornFresh(p, () => ret.acquireLock(home));
  } finally { rm(home); }
});

test('log rotate lock: reclaim race (stale + dead holder) + torn read', (t) => {
  const alog = require(path.join(ROOT, 'companion', 'lib', 'anti-hall-log.js'));
  const p = alog.rotateLockPath();
  const w = globalReclaimRace(t, p, { pid: 2147483646, ts: 1000, token: 'dead' }, () => alog.acquireRotateLockBlocking());
  w.release();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  const t0 = Date.now();
  assert.strictEqual(alog.acquireRotateLockBlocking(), null, 'a fresh empty (mid-write) lock is waited on, never stolen');
  assert.ok(Date.now() - t0 >= 250, 'the bounded 300ms wait budget was used');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '');
  fs.unlinkSync(p);
});

test('store journal messages.lock: a writer that judged a stale dead holder never deletes a fresh lock published meanwhile', () => {
  const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
  const lockLib = require(path.join(ROOT, 'companion', 'lib', 'lock.js'));
  const home = tmpHome();
  try {
    const dir = store.journalDir(home);
    const p = path.join(dir, 'messages.lock');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: 2147483646, ts: 1000, token: 'dead' }));
    // The competing writer reclaims the dead lock first and is MID-critical-
    // section (holds it, not yet released) when our writer acts on its read.
    let other = 'not-run';
    const spy = Object.create(fs);
    spy.readFileSync = (file, enc) => {
      const raw = fs.readFileSync(file, enc);
      if (file === p && other === 'not-run') {
        other = null;
        other = lockLib.acquire(p, { publish: 'excl', staleMs: 10000, liveStaleMs: 300000 });
      }
      return raw;
    };
    const s = store.openStore({ home, backend: 'journal', fsi: spy, lock: { maxTries: 3, appendRetries: 1 } });
    try {
      assert.throws(() => s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'h1' }), (e) => e.code === 'ELOCKUNAVAIL',
        'the writer must wait on the live holder, never append concurrently with it');
      assert.ok(other && other.token, 'precondition: the competing writer holds the lock');
      assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).token, other.token, 'the live holder\'s lock survived');
      other.release();
      assert.deepStrictEqual(s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'h1' }), { inserted: true });
    } finally { s.close(); }
  } finally { rm(home); }
});
