'use strict';
// #6 (mesh redesign Phase 5 routing): `send --to <exactId>` took the exact-id
// branch with NO liveness/coherence check, so a stale twin row — a row that
// carries another live row's sessionId but sits in a different worktree —
// received the message into a partition nobody drains. Fix: the exact-id branch
// reroutes ONLY to a provable same-session successor (identity.sessionWorktree
// Coherent + strict routing liveness); with no such proof it delivers to the
// exact id as before (never drop). All fixtures live under an isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-twin-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-twin-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', '-q', wt, '-b', 'b-' + tag]);
  return wt;
}
function writeHeartbeat(home, id, ts) {
  const p = liveness.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts, state_ts: ts, source: 'cli-heartbeat' }));
}
function writeSession(home, rec) {
  const dir = liveness.sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(rec.pid) + '.json'), JSON.stringify(rec));
}

function fixture(tag, withSuccessor, successorWorktree) {
  const home = tmpHome();
  const main = makeGitRepo(tag);
  const wtTwin = addWorktree(main, 'twin');
  const wtSender = addWorktree(main, 'sender');
  const repoKey = repokey.repoKeyForWorktree(main);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    // The twin: registered for the CHILD worktree but carrying the Primary's
    // live session id (the recorded specimen shape).
    s.upsertRegistry({ id: 'primary-twin', worktreePath: inst.resolveWorktree(wtTwin), sessionId: 'S-live' });
    if (withSuccessor) {
      s.upsertRegistry({ id: 'primary-live', worktreePath: successorWorktree === undefined ? inst.resolveWorktree(main) : successorWorktree, sessionId: 'S-live' });
    }
  } finally { s.close(); }
  if (withSuccessor) writeHeartbeat(home, 'primary-live', Date.now());
  // The live harness session S-live runs in the MAIN worktree (this process's pid).
  writeSession(home, { pid: process.pid, sessionId: 'S-live', cwd: inst.resolveWorktree(main) });
  return {
    home, main, wtTwin, wtSender, repoKey,
    cleanup() { rm(home); rm(wtTwin); rm(wtSender); rm(main); },
  };
}

test('#6: send --to <stale twin exact id> lands in the live same-session partition and is counted unread there', () => {
  const fx = fixture('reroute', true);
  try {
    const r = cli.run(['send', '--to', 'primary-twin', '--message', 'for the primary'],
      { home: fx.home, backend: 'journal', env: {}, cwd: fx.wtSender });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.rerouted, true, 'the send must say it rerouted');
    assert.equal(r.result.reroutedFrom, 'primary-twin');
    assert.equal(r.result.toId, 'primary-live', 'the delivered partition');
    const s = storeLib.openStore({ home: fx.home, hash: fx.repoKey, backend: 'journal' });
    try {
      assert.equal(s.messageCount('primary-live'), 1, 'delivered into the partition the live session drains');
      assert.equal(s.messageCount('primary-twin'), 0, 'nothing stranded in the twin partition');
    } finally { s.close(); }
    const peek = cli.run(['inbox', 'peek-primary', 'primary-live'], { home: fx.home, backend: 'journal', env: {}, cwd: fx.main });
    assert.equal(peek.result.unreadCount, 1, 'counted unread for the live reader: ' + JSON.stringify(peek.result));
  } finally { fx.cleanup(); }
});

test('#6 control: with no provable live successor, send --to <exact id> still delivers to that id (never dropped)', () => {
  const fx = fixture('nosucc', false);
  try {
    const r = cli.run(['send', '--to', 'primary-twin', '--message', 'still delivered'],
      { home: fx.home, backend: 'journal', env: {}, cwd: fx.wtSender });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.ok(!r.result.rerouted);
    assert.equal(r.result.toId, 'primary-twin');
    const s = storeLib.openStore({ home: fx.home, hash: fx.repoKey, backend: 'journal' });
    try { assert.equal(s.messageCount('primary-twin'), 1); } finally { s.close(); }
  } finally { fx.cleanup(); }
});

test('#6 review: a successor WITHOUT a worktree (no coherence proof) is NOT a reroute target — exact-id delivery', () => {
  const fx = fixture('noproof', true, null);
  try {
    const r = cli.run(['send', '--to', 'primary-twin', '--message', 'no proof'],
      { home: fx.home, backend: 'journal', env: {}, cwd: fx.wtSender });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.ok(!r.result.rerouted, 'no reroute without positive coherence proof');
    assert.equal(r.result.toId, 'primary-twin');
  } finally { fx.cleanup(); }
});
