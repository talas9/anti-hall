'use strict';
// PRIMARY SESSION DRIFT (v0.108.0). The Primary anchor records a sessionId;
// after a /clear the live session is a new transcript but the anchor kept the
// old id, so a DevSwarm restart resumed the OLD session. Pins: the read-only
// drift detector + notice, the parent-inbox injection, and the anchor refresh
// on the running session's tick/heartbeat (never while the old one is alive).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-drift-log-'));
const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const drift = require(path.join(ROOT, 'companion', 'lib', 'primary-session-drift.js'));
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const { testHook } = require('../helpers/spawn-hook.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-drift-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-drift-repo-')));
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return { home, repo, cleanup() { rm(home); rm(repo); } };
}
function transcript(f, sid, cwd, iso) {
  const dir = drift.projectDirFor(f.repo, f.home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'),
    JSON.stringify({ type: 'custom-title', sessionId: sid }) + '\n'
    + JSON.stringify({ type: 'user', cwd, sessionId: sid, timestamp: iso }) + '\n');
}
function liveSession(f, sid) {
  const dir = path.join(f.home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.json'), JSON.stringify({ pid: process.pid, sessionId: sid }));
}

test('detector: anchor on an older session than the newest transcript -> drift + notice; newest session itself gets none', () => {
  const f = fixture();
  try {
    transcript(f, 'sess-old', f.repo, '2026-09-20T10:00:00.000Z');
    transcript(f, 'sess-new', path.join(f.repo, 'sub'), '2026-09-21T10:00:00.000Z');
    transcript(f, 'sess-other', '/somewhere/else', '2026-09-22T10:00:00.000Z'); // lossy-encoding collision: ignored
    const d = drift.anchorSessionDrift({ anchorSessionId: 'sess-old', worktree: f.repo, home: f.home });
    assert.deepEqual({ a: d.anchorSessionId, n: d.newestSessionId }, { a: 'sess-old', n: 'sess-new' });
    const notice = drift.driftNotice(d, 'sess-old');
    assert.match(notice, /you are this project's only Primary; a newer session exists: sess-new/);
    assert.match(notice, /\/resume it if it owns the live lanes/);
    assert.match(notice, /never stand down on a label alone/);
    assert.equal(drift.driftNotice(d, 'sess-new'), '', 'the newest session is told nothing (its tick refreshes the anchor)');
    assert.equal(drift.anchorSessionDrift({ anchorSessionId: 'sess-new', worktree: f.repo, home: f.home }), null);
    assert.equal(drift.anchorSessionDrift({ anchorSessionId: 'unclaimed:primary-x', worktree: f.repo, home: f.home }), null);
    assert.equal(drift.anchorSessionDrift({ anchorSessionId: 'sess-old', worktree: f.repo, home: path.join(f.home, 'nope') }), null);
  } finally { f.cleanup(); }
});

test('parent-inbox: the Primary sees the drift notice (read-only)', () => {
  const f = fixture();
  try {
    const rp = cli.run(['register-primary'], { home: f.home, env: { CLAUDE_CODE_SESSION_ID: 'sess-old', ANTIHALL_DEVSWARM_APP_DB: 'off' }, cwd: f.repo });
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    transcript(f, 'sess-old', f.repo, '2026-09-20T10:00:00.000Z');
    transcript(f, 'sess-new', f.repo, '2026-09-21T10:00:00.000Z');
    const r = testHook('devswarm-parent-inbox.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-old', prompt: 'hi', cwd: f.repo },
      { home: f.home, env: { DEVSWARM_REPO_ID: 'repo-1', ANTIHALL_DEVSWARM_APP_DB: 'off' }, expectJson: true });
    const ctxText = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
    assert.match(ctxText, /a newer session exists: sess-new/, ctxText);
    const desc = JSON.parse(fs.readFileSync(path.join(f.home, '.anti-hall', 'devswarm', 'workspaces', inst.primaryWorkspaceId(f.repo) + '.json'), 'utf8'));
    assert.equal(desc.sessionId, 'sess-old', 'detection never writes');
  } finally { f.cleanup(); }
});

test('anchor refresh: the running session\'s tick re-points the anchor; never while the recorded session is alive', () => {
  const f = fixture();
  try {
    const env0 = { CLAUDE_CODE_SESSION_ID: 'sess-old', ANTIHALL_DEVSWARM_APP_DB: 'off' };
    assert.equal(cli.run(['register-primary'], { home: f.home, env: env0, cwd: f.repo }).result.ok, true);
    const id = inst.primaryWorkspaceId(f.repo);
    const descPath = path.join(f.home, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
    const env1 = { CLAUDE_CODE_SESSION_ID: 'sess-new', ANTIHALL_DEVSWARM_APP_DB: 'off' };
    // Old session still running: refused (live-primary-conflict), anchor unchanged.
    liveSession(f, 'sess-old');
    liveSession(f, 'sess-new');
    const t0 = cli.run(['inbox', 'tick', id], { home: f.home, env: env1, cwd: f.repo });
    assert.equal(t0.result.anchorRefresh, undefined);
    assert.equal(JSON.parse(fs.readFileSync(descPath, 'utf8')).sessionId, 'sess-old');
    // Old session gone (/clear replaced it): the tick moves the anchor.
    fs.rmSync(path.join(f.home, '.claude', 'sessions', 'sess-old.json'));
    const t1 = cli.run(['inbox', 'tick', id], { home: f.home, env: env1, cwd: f.repo });
    assert.deepEqual(t1.result.anchorRefresh, { refreshed: true, id, from: 'sess-old', to: 'sess-new' });
    assert.equal(JSON.parse(fs.readFileSync(descPath, 'utf8')).sessionId, 'sess-new');
    // Idempotent: nothing to do once it matches.
    const t2 = cli.run(['inbox', 'tick', id], { home: f.home, env: env1, cwd: f.repo });
    assert.equal(t2.result.anchorRefresh, undefined);
  } finally { f.cleanup(); }
});
