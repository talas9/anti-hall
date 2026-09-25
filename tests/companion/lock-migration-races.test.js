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
