'use strict';
// defect 84c0b4385f68 (REOPENED): `send`'s `ok:true` was never actually proof
// the message landed somewhere a reader can see it — better-sqlite3's INSERT
// being synchronous only proves the WRITE completed, not that a re-select
// against the same partition finds the row. A prior fix (v0.77.0) only added
// `bytes`/`hash` echo fields to the return value ("purely additive", per its
// own comment) without ever reading anything back. This file exercises the
// NEW readback verification added to doAppend() in cmdSend (scripts/
// devswarm.js): a normal send is confirmed via s.listMessages(), a genuine
// (simulated) absence is reported honestly (never a bare ok:true), and a
// verification-step ERROR (as opposed to a positive absence) degrades to
// "unverified", never to a false failure.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-verify-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-verify-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// ---- 1: a normal send reports verified:true, backed by a real readback ----

test('send verification: a normal broadcast send reports verified:true, confirmed via listMessages readback', () => {
  const home = tmpHome();
  const repo = makeGitRepo('normal');
  try {
    const r = cli.run(['send', '--broadcast', '--message', 'hello mesh'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.verified, true, 'a real, successful send must be positively verified: ' + JSON.stringify(r.result));
    assert.equal(r.result.verifyError, undefined);
    assert.equal(r.result.sent, true);
    assert.ok(r.result.hash);
  } finally { rm(home); rm(repo); }
});

// ---- 2: a readback that finds NOTHING does not report plain success -------

test('send verification: a readback that positively finds the row absent does NOT report plain ok:true success', () => {
  const home = tmpHome();
  const repo = makeGitRepo('absent');
  const origOpenStore = storeLib.openStore;
  try {
    // Simulate the exact hazard this defect is about: appendMeshMessage()
    // succeeds (the write happens against the REAL handle) but the readback
    // this fix adds queries a handle whose listMessages() is wired to report
    // the target partition as genuinely EMPTY — i.e. the row is not visible
    // to a reader, the precise gap the old "ok:true is not proof of arrival"
    // defect described.
    storeLib.openStore = function (...args) {
      const real = origOpenStore.apply(storeLib, args);
      const wrapped = Object.create(real);
      wrapped.listMessages = function () { return []; };
      return wrapped;
    };
    const r = cli.run(['send', '--broadcast', '--message', 'vanishes'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false, 'ok:true must never be claimed when the readback positively shows absence: ' + JSON.stringify(r.result));
    assert.equal(r.result.verified, false);
    assert.equal(r.result.verifyError, undefined, 'this is a positive-absence case, not an errored verification');
    assert.equal(r.result.reason, 'send-not-verified');
    assert.ok(r.result.error && /not confirmed delivered/i.test(r.result.error));
    // The append itself still happened (sent:true) — this call proves the
    // VERIFICATION gap, not that appendMeshMessage silently no-oped.
    assert.equal(r.result.sent, true);
  } finally {
    storeLib.openStore = origOpenStore;
    rm(home); rm(repo);
  }
});

// ---- 3: a verification-step ERROR is "unverified", never a false failure --

test('send verification: an error thrown by the readback step itself is reported unverified, NOT as a failure', () => {
  const home = tmpHome();
  const repo = makeGitRepo('errored');
  const origOpenStore = storeLib.openStore;
  const origDeriveSummary = storeLib.deriveSummary;
  try {
    // deriveSummary() (called BEFORE this fix's readback) ALSO calls
    // listMessages() internally (computeSummary reads the broadcast
    // partition unconditionally) — a naive unconditional throw on
    // listMessages would break deriveSummary too, not just the readback this
    // test targets. Arm the throw only AFTER deriveSummary has run, so only
    // THIS fix's own verification read is what fails.
    storeLib.openStore = function (...args) {
      const real = origOpenStore.apply(storeLib, args);
      const wrapped = Object.create(real);
      let armed = false;
      wrapped.listMessages = function (...a) {
        if (armed) throw new Error('simulated readback failure');
        return real.listMessages.apply(real, a);
      };
      wrapped.__armReadbackFailure = function () { armed = true; };
      return wrapped;
    };
    storeLib.deriveSummary = function (storeHandle, opts) {
      const r = origDeriveSummary(storeHandle, opts);
      if (storeHandle && typeof storeHandle.__armReadbackFailure === 'function') storeHandle.__armReadbackFailure();
      return r;
    };
    const r = cli.run(['send', '--broadcast', '--message', 'unknown fate'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, 'a verification ERROR (not a positive absence) must fail OPEN, never flip ok:false: ' + JSON.stringify(r.result));
    assert.equal(r.result.verified, false);
    assert.ok(r.result.verifyError && /simulated readback failure/.test(r.result.verifyError));
    assert.equal(r.result.reason, undefined, 'an errored check is not the same failure path as a positive absence');
    assert.equal(r.result.sent, true);
  } finally {
    storeLib.openStore = origOpenStore;
    storeLib.deriveSummary = origDeriveSummary;
    rm(home); rm(repo);
  }
});

// ---- 4: a direct (--to) send is verified against the RECIPIENT partition --

test('send verification: a direct --to send is verified against the recipient partition, not the sender\'s', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('direct-main');
  try {
    // Register a recipient directly via the store (mirrors devswarm-send.test.js's seedRegistry).
    const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
    const repoKey = repokey.repoKeyForWorktree(mainRepo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.upsertRegistry({ id: 'child-recipient', worktreePath: path.join(os.tmpdir(), 'zzz-not-main-' + Date.now()), sessionId: 's' }); }
    finally { s.close(); }
    const r = cli.run(['send', '--to', 'child-recipient', '--message', 'direct hello'], ctx(home, { cwd: mainRepo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.verified, true);
    assert.equal(r.result.toId, 'child-recipient');
    const s2 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const msgs = s2.listMessages('child-recipient');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].hash, r.result.hash);
    } finally { s2.close(); }
  } finally { rm(home); rm(mainRepo); }
});
