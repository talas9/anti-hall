'use strict';
// Defect 7d0a948031cd (P1): cmdRegisterPrimary never checks for an existing
// LIVE Primary row on the same worktree/checkout before upserting.
//
// Root cause (file:line, HEAD 5631695): plugins/anti-hall/scripts/devswarm.js
// cmdRegisterPrimary (~7837-7863) derives a DETERMINISTIC id from the worktree
// (`inst.primaryWorkspaceId(worktree)`) and calls `cmdRegister(id, ...)`
// unconditionally. cmdRegister is a plain upsert keyed on that id — a SECOND
// register-primary call for the SAME worktree from a DIFFERENT session
// silently overwrites the row's sessionId with no warning at registration
// (verified: no read of the existing row, no liveness check, anywhere in
// cmdRegisterPrimary before it calls cmdRegister), even though `diagnose`'s
// computeDiagnosis already has machinery to SCORE two live rows on one meshId
// as a split — that machinery is just never consulted at the point the churn
// is created.
//
// Run against HEAD (RED) vs the patched copy (GREEN) via:
//   DEVSWARM_ANTIHALL_DIR=<path>/repo-orig             node --test 7d0a948031cd.test.js
//   DEVSWARM_ANTIHALL_DIR=<path>/repo-7d0a948031cd     node --test 7d0a948031cd.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const antiHallDir = process.env.DEVSWARM_ANTIHALL_DIR
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(antiHallDir, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(antiHallDir, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(antiHallDir, 'companion', 'lib', 'devswarm-repokey.js'));
const liveness = require(path.join(antiHallDir, 'companion', 'lib', 'liveness.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-regprimary-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// writeLiveSessionFile: stamps a harness session file naming a REAL, currently
// running pid (this test process's own `process.pid`, which pidIsAlive will
// find trivially alive) for `sessionId` — the ONLY thing isSessionAliveRow
// (the C fix's stricter predicate) accepts as positive proof of life. A bare
// heartbeat file alone does NOT satisfy this.
function writeLiveSessionFile(home, sessionId) {
  const dir = liveness.sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(process.pid) + '.json'), JSON.stringify({
    pid: process.pid, sessionId, cwd: process.cwd(), startedAt: Date.now() - 60000,
  }));
}

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-regprimary-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function currentSessionIdOf(home, repoKey, id) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    const row = (s.listRegistry() || []).find((r) => r && String(r.id) === String(id));
    return row ? row.sessionId : null;
  } finally { s.close(); }
}

test('a second register-primary from a session that only heartbeated (no proven-alive pid) is ALLOWED, not refused', () => {
  const home = tmpHome();
  const main = makeGitRepo('primary-heartbeat-only');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const regA = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-A' } }));
    assert.strictEqual(regA.result.ok, true, 'first register-primary should succeed');
    const id = regA.result.id;

    // A fresh heartbeat with NO corresponding harness session file (no proof
    // of a live pid) — the pre-fix bug over-refused on this alone (C fix
    // under test: isSessionAliveRow requires POSITIVE pid-alive proof, which
    // a bare heartbeat file can never supply).
    const beatA = cli.run(['heartbeat', id], ctx(home, { cwd: main }));
    assert.strictEqual(beatA.result.ok, true, 'heartbeat for session A should succeed');
    assert.strictEqual(currentSessionIdOf(home, repoKey, id), 'session-A');

    const regB = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-B' } }));
    assert.strictEqual(regB.result.ok, true,
      'a heartbeat-only row (no proven-alive session pid) must NOT block a re-register (got: '
      + JSON.stringify(regB.result) + ')');
    assert.strictEqual(currentSessionIdOf(home, repoKey, id), 'session-B',
      'session B should now own the row — heartbeat-only is not a live conflict');
  } finally {
    rm(main); rm(home);
  }
});

test('a second register-primary from a DIFFERENT session with a PROVEN-ALIVE pid is refused with live-primary-conflict and --force in the error text', () => {
  const home = tmpHome();
  const main = makeGitRepo('primary-alive-conflict');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const regA = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-A' } }));
    assert.strictEqual(regA.result.ok, true, 'first register-primary should succeed');
    const id = regA.result.id;

    // POSITIVE proof session A's harness process is alive: a session file
    // naming a real, currently-running pid (this test process's own).
    writeLiveSessionFile(home, 'session-A');
    assert.strictEqual(currentSessionIdOf(home, repoKey, id), 'session-A');

    const regB = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-B' } }));
    assert.strictEqual(regB.result.ok, false,
      'a second register-primary from a DIFFERENT, provably-alive session must be REFUSED (got: '
      + JSON.stringify(regB.result) + ')');
    assert.strictEqual(regB.result.reason, 'live-primary-conflict', 'refusal must name the conflict reason');
    assert.ok(regB.result.error && regB.result.error.includes('--force'), 'refusal error text must mention --force');
    assert.strictEqual(currentSessionIdOf(home, repoKey, id), 'session-A',
      'session A must still own the row after the refused conflicting call — no silent overwrite');

    // --force still allows an explicit, deliberate override.
    const regForce = cli.run(['register-primary', '--force'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-B' } }));
    assert.strictEqual(regForce.result.ok, true, '--force must still allow registering over a live conflict');
    assert.strictEqual(currentSessionIdOf(home, repoKey, id), 'session-B', '--force should actually apply the new session');
  } finally {
    rm(main); rm(home);
  }
});

test('a second register-primary from the SAME sessionId is always allowed (not a conflict)', () => {
  const home = tmpHome();
  const main = makeGitRepo('primary-same-session');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const regA = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-A' } }));
    assert.strictEqual(regA.result.ok, true);
    const id = regA.result.id;
    writeLiveSessionFile(home, 'session-A'); // even with proven-alive proof...

    const regAgain = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'session-A' } }));
    assert.strictEqual(regAgain.result.ok, true, 're-registering the SAME sessionId must never be treated as a conflict');
    assert.strictEqual(currentSessionIdOf(home, repoKey, id), 'session-A');
  } finally {
    rm(main); rm(home);
  }
});
