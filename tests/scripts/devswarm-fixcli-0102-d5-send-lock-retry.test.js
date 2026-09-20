'use strict';
// D5 (fix-cli-0102) — `send --to` used to take the per-id advisory lock
// (companion/lib/recovery.js acquireLock, via devswarm.js's withIdLock/
// acquireIdLock) exactly ONCE (acquireIdLock's own 2s internal budget) and
// fail CLOSED with `{ok:false, lockBusy:true}` the instant a contender (every
// `inbox pull`'s cmdRegister/ensure — cmdRegister runs on every pull — or the
// child-turn hook) held it a moment longer than that. The documented contract
// ("retry shortly") was correct; nothing on the CLIENT side actually did it.
//
// FIX (scripts/devswarm.js, cmdSend's direct-send branch): a bounded OUTER
// retry (3 attempts total, jittered exponential backoff between them) around
// the whole withIdLock critical section.
//
// SAFETY (idempotency): `now` (and therefore `fields`/`hash` inside doAppend)
// is captured ONCE, well above this retry loop, before any lock attempt — see
// scripts/devswarm.js:12334's `const now = ...`. The retry loop only retries
// the LOCK ACQUISITION; `withIdLock` never runs `fn` (`doAppend`) at all on a
// `lockBusy` result, so `doAppend()` executes AT MOST ONCE regardless of how
// many lock attempts this call makes, and `appendMeshRow`'s `INSERT OR IGNORE`
// on the unique `hash` (which is derived from that single fixed `now`) means a
// hypothetical double-run would be idempotent anyway — belt and suspenders.
//
// A genuine OS-level lock-holder is required to exercise the ~2s-plus
// contention window realistically: a single Node process cannot contend
// against itself (Atomics.wait blocks the ONE thread doing the polling), so
// tests/helpers/fixcli-0102-hold-lock.js holds the lock in a SEPARATE spawned
// process.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const PLUGIN = path.join(__dirname, '../../plugins/anti-hall');
const cli = require(path.join(PLUGIN, 'scripts/devswarm.js'));
const storeLib = require(path.join(PLUGIN, 'companion/lib/devswarm-store.js'));
const repokey = require(path.join(PLUGIN, 'companion/lib/devswarm-repokey.js'));
const recovery = require(path.join(PLUGIN, 'companion/lib/recovery.js'));
const HOLD_LOCK_HELPER = path.join(__dirname, '../helpers/fixcli-0102-hold-lock.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fixcli0102-d5-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixcli0102-d5-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function waitForFile(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + p);
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, 20);
  }
}

test('D5: a lockBusy first attempt retries and succeeds once the holder releases, with NO duplicate row (same hash)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('d5-retry');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'd5-retry');
    const id = 'child-d5-retry';
    const repoKey = repokey.repoKeyForWorktree(childWt);
    const rReg = cli.run(['register', id, '--worktree', childWt, '--session', 's-' + id], ctx(home, { cwd: childWt }));
    assert.ok(rReg.result.ok, 'register failed: ' + JSON.stringify(rReg.result));

    // A separate OS process holds the lock for LONGER than acquireIdLock's own
    // 2000ms internal budget (so the retry loop's FIRST attempt genuinely
    // times out to lockBusy) but well inside the outer retry's total window,
    // then releases — the SECOND attempt must then succeed.
    const readyFile = path.join(home, 'lock-ready.txt');
    const holdMs = 2300;
    const holder = cp.spawn(process.execPath, [HOLD_LOCK_HELPER, PLUGIN, home, id, String(holdMs), readyFile], { stdio: 'ignore' });
    try {
      waitForFile(readyFile, 5000);

      const startedAt = Date.now();
      const r = cli.run(['send', '--to', id, '--message', 'hello under contention'], ctx(home, { cwd: mainRepo }));
      const elapsedMs = Date.now() - startedAt;

      assert.equal(r.result.ok, true, 'send must eventually succeed once the lock is released: ' + JSON.stringify(r.result));
      assert.equal(r.result.sent, true);
      assert.ok(!r.result.lockBusy, 'the FINAL result must not report lockBusy once a retry succeeded: ' + JSON.stringify(r.result));
      assert.equal(r.code, 0, 'exit code must be 0 for a send that eventually succeeded');
      assert.ok(elapsedMs >= holdMs - 250,
        'this call must have genuinely waited out the holder (elapsed ' + elapsedMs + 'ms, holdMs ' + holdMs + 'ms) '
        + '— a near-instant success would mean the retry never actually contended');

      // NO DUPLICATE: exactly one row landed in the recipient's partition,
      // and its hash matches what a single `doAppend()` call would produce.
      const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
      let rows;
      try { rows = s.listMessages(id) || []; } finally { s.close(); }
      assert.equal(rows.length, 1, 'exactly one message row must exist after the retry succeeded — got ' + rows.length);
      assert.equal(rows[0].body, 'hello under contention');
      assert.equal(rows[0].hash, r.result.hash, 'the stored row\'s hash must match the hash this send reported');
    } finally {
      try { holder.kill(); } catch (_) {}
    }
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});

test('D5: exit code is non-zero (never 0) when every retry attempt is lockBusy — a caller doing `send ... && echo ok` must not see a dropped send as success', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('d5-exitcode');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'd5-exitcode');
    const id = 'child-d5-exitcode';
    const rReg = cli.run(['register', id, '--worktree', childWt, '--session', 's-' + id], ctx(home, { cwd: childWt }));
    assert.ok(rReg.result.ok, 'register failed: ' + JSON.stringify(rReg.result));

    // The lock is held for the ENTIRE test (same-process, never released) —
    // every one of the 3 outer-retry attempts must see it busy.
    const release = recovery.acquireLock(id, home);
    assert.equal(typeof release, 'function', 'precondition: the lock is genuinely held');
    try {
      const r = cli.run(['send', '--to', id, '--message', 'should never land'], ctx(home, { cwd: mainRepo }));
      assert.equal(r.result.ok, false, 'send must report failure when every attempt was lockBusy: ' + JSON.stringify(r.result));
      assert.equal(r.result.lockBusy, true);
      assert.equal(r.result.retriedAttempts, 3, 'must report it genuinely exhausted the retry budget, not failed on the first try');
      assert.notEqual(r.code, 0, 'THE FIX (verified): exit code must be non-zero on a fully-failed send — got ' + r.code);
      assert.equal(r.code, 2, 'matches run()\'s own `send` case: `code: r.ok ? 0 : 2`');
    } finally { release(); }

    // Nothing was ever appended.
    const repoKey = repokey.repoKeyForWorktree(childWt);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let rows;
    try { rows = s.listMessages(id) || []; } finally { s.close(); }
    assert.equal(rows.length, 0, 'a fully lockBusy send must not have appended anything');
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});
