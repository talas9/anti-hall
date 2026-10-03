'use strict';
// PRIMARY SEAT x CURSOR DOORS (v0.108.0 identity review P1). While two live
// sessions conflict over the Primary seat, the non-holder must not advance ANY
// reader cursor of the Primary: not only `inbox ack`/`ack-primary` (gated by
// verb since the seat feature landed) but every path that acks —
// drain-primary-legacy, --legacy-ack-now, mesh read, roster --ack, tick, read.
// The guard sits on the cursor-write doors themselves (commitInstanceAck,
// commitNdAck, advanceBroadcastCursor), so this test drives every verb that can
// reach one and proves (a) refusal or (b) no cursor movement, then that the
// holder still drains normally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-seatdoor-log-'));
const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));

const CHILD = 'c0ffee00-1111-4222-8333-444455556666';
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-seatdoor-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-seatdoor-repo-')));
  const repo = path.join(base, 'main');
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const child = path.join(base, 'fix-child');
  cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', child, '-b', 'fix-child']);
  const f = {
    home, base, repo, child, repoKey: repokey.repoKeyForWorktree(repo), PRIMARY: inst.primaryWorkspaceId(repo),
    env: (sid) => Object.assign({ ANTIHALL_DEVSWARM_APP_DB: 'off', DEVSWARM_REPO_ID: 'repo-1' }, sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}),
  };
  f.ctx = (sid) => ({ home, env: f.env(sid), cwd: repo });
  f.live = (sid) => fs.writeFileSync(path.join(home, '.claude', 'sessions', sid + '.json'), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: repo }));
  return f;
}
function withStore(f, fn) {
  const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
  try { return fn(s); } finally { s.close(); }
}
function unread(f) {
  const r = cli.run(['inbox', 'peek-primary', f.PRIMARY], f.ctx('sess-A'));
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  return (r.result.messages || []).length;
}
function seed(f) {
  f.live('sess-A');
  assert.equal(cli.run(['register-primary'], f.ctx('sess-A')).result.ok, true);
  withStore(f, (s) => s.upsertRegistry({ id: CHILD, worktreePath: f.child, sessionId: 'sess-child' }));
  const cenv = Object.assign({ DEVSWARM_BUILDER_ID: CHILD, ANTIHALL_DEVSWARM_APP_DB: 'off' });
  for (const m of ['one', 'two']) {
    const r = cli.run(['send', '--to-primary', '--message', m], { home: f.home, env: cenv, cwd: f.child });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
  }
  assert.equal(cli.run(['send', '--broadcast', '--message', 'b'], { home: f.home, env: cenv, cwd: f.child }).result.ok, true);
  f.live('sess-C'); // a second LIVE session on the Primary checkout -> seat conflict
}

test('a conflicted (non-holder) session cannot advance the Primary\'s cursors by ANY path', () => {
  const f = fixture();
  try {
    seed(f);
    assert.equal(unread(f), 2);
    const bcBefore = withStore(f, (s) => s.broadcastCursorValue(f.PRIMARY));
    const refused = [
      ['inbox', 'ack', f.PRIMARY],
      ['inbox', 'ack-primary', f.PRIMARY, '--receipt', 'r-any'],
      ['inbox', 'drain-primary-legacy', f.PRIMARY],
      ['inbox', 'messages', f.PRIMARY, '--ack', '--legacy-ack-now'],
      ['inbox', 'read-primary', f.PRIMARY, '--legacy-ack-now'],
      ['mesh', 'read'],
      ['roster', '--ack'],
    ];
    for (const argv of refused) {
      const r = cli.run(argv, f.ctx('sess-C'));
      assert.equal(r.result.reason, 'primary-seat-conflict', argv.join(' ') + ' -> ' + JSON.stringify(r.result).slice(0, 300));
      assert.equal(unread(f), 2, argv.join(' ') + ' must not move the Primary cursor');
    }
    // Read-only / deferred paths (and `inbox read`, which needs an NDJSON
    // inbox the store-only Primary does not have) may answer however they
    // answer, but must never move a cursor.
    for (const argv of [['inbox', 'read-primary', f.PRIMARY], ['inbox', 'messages', f.PRIMARY, '--ack'], ['inbox', 'read', f.PRIMARY], ['inbox', 'tick', f.PRIMARY]]) {
      cli.run(argv, f.ctx('sess-C'));
      assert.equal(unread(f), 2, argv.join(' ') + ' must not move the Primary cursor');
    }
    assert.equal(withStore(f, (s) => s.broadcastCursorValue(f.PRIMARY)), bcBefore, 'broadcast cursor unchanged');
    // The holder is unaffected: it drains its own mail.
    const d = cli.run(['inbox', 'drain-primary-legacy', f.PRIMARY], f.ctx('sess-A'));
    assert.equal(d.result.ok, true, JSON.stringify(d.result).slice(0, 300));
    assert.equal(unread(f), 0);
  } finally { rm(f.home); rm(f.base); }
});
