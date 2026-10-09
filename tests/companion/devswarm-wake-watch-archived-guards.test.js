'use strict';
// Guards around the archived-child silence (reviewer findings): a LIVE child
// must never go silent because of twin state (archived/<id>.json marker next to
// an ACTIVE workspaces/<id>.json), nor because a brand-new, not-yet-registered
// child sits on a worktree that only has archived app builders (the app DB's
// by-worktree rule judges that archived). An in-process archived -> restored
// transition resumes and delivers mail that arrived while silent. Home is
// isolated via HOME / ANTIHALL_DEVSWARM_APP_DB.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const MODULE_PATH = path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
const { isOwnChildArchived, saveSeenState, ARCHIVED_RECHECK_MS } = require(MODULE_PATH);
const pull = require(path.join(ROOT, 'companion', 'lib', 'devswarm-pull.js'));
const appDb = require(path.join(ROOT, 'companion', 'lib', 'devswarm-app-db.js'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skipDb = sqlite ? false : 'node:sqlite unavailable';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function tmpHome() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-guards-'))); }
function makeGitRepo(tag) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-guards-repo-' + tag + '-')));
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function dsRoot(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function writeDescriptor(home, kind, id, wt, sessionId) {
  const dir = path.join(dsRoot(home), kind);
  fs.mkdirSync(dir, { recursive: true });
  const d = { id, worktreePath: wt };
  if (sessionId) d.sessionId = sessionId;
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(d));
}
const ident = (home, id, cwd) => ({ role: 'child', id, home, cwd });

function startWatcher(env, cwd) {
  const child = spawn(process.execPath, [MODULE_PATH], { env, cwd });
  const out = { stdout: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.on('error', () => {});
  out.kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function childEnv(home, id, extra) {
  return Object.assign({
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: id,
    ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '250',
    ANTIHALL_DEVSWARM_APP_DB: 'off',
  }, extra || {});
}

test('recheck interval is 120 s', () => {
  assert.strictEqual(ARCHIVED_RECHECK_MS, 120 * 1000);
});

test('twin state (archived marker + ACTIVE descriptor), with and without a sessionId -> NOT archived', () => {
  const home = tmpHome();
  const repo = makeGitRepo('twin');
  try {
    const env = { HOME: home, ANTIHALL_DEVSWARM_APP_DB: 'off' };
    for (const sid of ['s-twin', null]) {
      fs.mkdirSync(path.join(dsRoot(home), 'archived'), { recursive: true });
      fs.writeFileSync(path.join(dsRoot(home), 'archived', 'kid.json'), JSON.stringify({ id: 'kid', worktreePath: repo, sessionId: sid || undefined }));
      writeDescriptor(home, 'workspaces', 'kid', repo, sid);
      assert.strictEqual(isOwnChildArchived(ident(home, 'kid', repo), env), false, 'sessionId=' + sid);
    }
  } finally { rm(home); rm(repo); }
});

test('twin state: the watcher PROCESS keeps emitting', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('twin-proc');
  try {
    writeDescriptor(home, 'archived', 'kid', repo, 's1');
    writeDescriptor(home, 'workspaces', 'kid', repo, 's1');
    const w = startWatcher(childEnv(home, 'kid'), repo);
    await sleep(2500); w.kill();
    assert.match(w.stdout, /\[wake-watch\] armed: watching child kid/);
  } finally { rm(home); rm(repo); }
});

test('marker only (no active descriptor) -> archived; no descriptor at all (unregistered new child) -> NOT archived', () => {
  const home = tmpHome();
  const repo = makeGitRepo('unreg');
  try {
    const env = { HOME: home, ANTIHALL_DEVSWARM_APP_DB: 'off' };
    assert.strictEqual(isOwnChildArchived(ident(home, 'fresh', repo), env), false);
    writeDescriptor(home, 'archived', 'fresh', repo, 's1');
    assert.strictEqual(isOwnChildArchived(ident(home, 'fresh', repo), env), true);
  } finally { rm(home); rm(repo); }
});

test('app DB by-worktree rule: a NEW unregistered child on a worktree with only archived builders is NOT archived (the raw verdict says it is)', { skip: skipDb }, () => {
  const home = tmpHome();
  const repo = makeGitRepo('appdb');
  try {
    const dbFile = path.join(home, 'app', 'devswarm.db');
    fs.mkdirSync(path.dirname(dbFile));
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
    db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)').run('old-builder', 'r1', repo, 1, 0);
    db.close();
    const env = { HOME: home, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    assert.strictEqual(appDb.appArchivedVerdict({ home, env, id: 'brand-new', worktreePath: repo }), true, 'repro: the by-worktree verdict over-reports archived');
    assert.strictEqual(isOwnChildArchived(ident(home, 'brand-new', repo), env), false, 'no descriptor for the own id -> keep emitting');
    // active descriptor + app DB positively archived BY ID -> silent
    const db2 = new sqlite.DatabaseSync(dbFile);
    db2.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)').run('app-arch', 'r1', repo, 1, 0);
    db2.close();
    writeDescriptor(home, 'workspaces', 'app-arch', repo, 's1');
    assert.strictEqual(isOwnChildArchived(ident(home, 'app-arch', repo), env), true, 'app-DB-archived by id with an active descriptor');
  } finally { rm(home); rm(repo); }
});

test('settings off (devswarm.archivedChildStop=false) -> never archived, even marker-only', () => {
  const home = tmpHome();
  const repo = makeGitRepo('off');
  try {
    writeDescriptor(home, 'archived', 'kid', repo, 's1');
    assert.strictEqual(isOwnChildArchived(ident(home, 'kid', repo), { HOME: home, ANTIHALL_DEVSWARM_APP_DB: 'off', ANTIHALL_DEVSWARM_ARCHIVED_CHILD_STOP: 'false' }), false);
  } finally { rm(home); rm(repo); }
});

test('in-process archived -> restored: silent while archived, then resumes and wakes on mail that arrived while silent', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('trans');
  try {
    const id = 'kidt';
    // baseline seen-state (0 messages) so later mail is a genuine delta
    saveSeenState(home, id, { lastTotal: 0, lastTotal2: 0, lastBroadcastUnread: 0 }, fs, 'child');
    writeDescriptor(home, 'archived', id, repo, 's1');
    const w = startWatcher(childEnv(home, id, { ANTIHALL_DEVSWARM_WAKE_WATCH_ARCHIVED_RECHECK_MS: '300' }), repo);
    await sleep(1500);
    assert.strictEqual(w.stdout, '', 'silent while archived');
    // mail lands while silent
    const inbox = pull.inboxDefaultPath(home, id);
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    fs.writeFileSync(inbox, JSON.stringify({ seq: 1, body: 'hi' }) + '\n');
    await sleep(800);
    assert.strictEqual(w.stdout, '', 'still silent: mail while archived must not wake');
    // restore
    fs.unlinkSync(path.join(dsRoot(home), 'archived', id + '.json'));
    writeDescriptor(home, 'workspaces', id, repo, 's1');
    await sleep(2500); w.kill();
    assert.match(w.stdout, /armed: watching child kidt/);
    assert.match(w.stdout, /new mesh mail for child kidt/, 'mail delivered after restore; got ' + JSON.stringify(w.stdout));
  } finally { rm(home); rm(repo); }
});
