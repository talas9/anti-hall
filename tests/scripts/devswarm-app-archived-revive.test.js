'use strict';
// 0.109.1 field defect: two workspaces ARCHIVED in DevSwarm (app DB
// isActive=0, isHidden=1) had their terminal tabs left open. When the running
// `claude` process was killed, the tab's login shell relaunched claude within
// ~10s; the new session re-registered and heartbeated, and anti-hall's roster
// flipped both rows from archived back to ACTIVE. Owner rule: the app DB is
// ground truth over anti-hall's own markers for archived state — a row it
// reports archived must STAY archived regardless of new heartbeats or
// registrations, and be flagged "live session in archived workspace". If the
// app DB can't be read, keep the current (pre-fix) behavior.
//
// Covers:
//   (a) an archived app-DB row + a fresh `register`/`ensure`/`heartbeat` call
//       -> refused (never revives the row); the roster still says archived,
//       with the "live session in archived workspace" flag when a fresh
//       heartbeat exists.
//   (b) an app DB that can't be read -> old behavior (register/heartbeat
//       succeed normally, exactly as before this fix).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// Isolate the shared central logger BEFORE requiring anything that may log —
// see tests/scripts/devswarm-v064.test.js for the established pattern; a test
// must never write into the real ~/.anti-hall/logs.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-app-arch-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const appDb = require('../../plugins/anti-hall/companion/lib/devswarm-app-db.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-app-arch-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// fixture() -> a home + a real git worktree registered as an ACTIVE app-DB
// builder ('w-arch'). appDb.setArchived() flips it to archived mid-test
// (isActive=0, isHidden=1) — mirrors the field scenario: the workspace was
// active when anti-hall first registered it, then the owner archived it in
// the DevSwarm app.
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-app-arch-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const wt = makeGitRepo('w-arch');
  const dbFile = path.join(base, 'app', 'devswarm.db');
  fs.mkdirSync(path.dirname(dbFile));
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, 0, 1)').run('w-arch', 'r1', wt);
  db.close();
  const env = { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  return { base, home, wt, dbFile, env };
}
function archiveRow(dbFile, id) {
  const db = new sqlite.DatabaseSync(dbFile);
  db.prepare('UPDATE builders SET isActive = 0, isHidden = 1 WHERE id = ?').run(id);
  db.close();
}
const ctx = (home, cwd, env) => Object.assign({ home, backend: 'journal', cwd, env: env || {} });

test('(a) register refused on an app-archived row, both when the descriptor exists (ensure) and does not (create)', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const inbox = path.join(f.base, 'inbox.ndjson');
    const cursor = path.join(f.base, 'cursor.json');
    // First register while the app DB still says active: succeeds normally.
    const r0 = cli.run(['register', 'w-arch', '--worktree', f.wt, '--session', 's1',
      '--inbox', inbox, '--cursor', cursor], ctx(f.home, f.wt, f.env)).result;
    assert.strictEqual(r0.ok, true, JSON.stringify(r0));

    // Owner archives the workspace in the DevSwarm app.
    archiveRow(f.dbFile, 'w-arch');
    appDb.resetCache();

    // A still-running child's routine `ensure` (requireNew) must not revive it.
    const rEnsure = cli.run(['ensure', 'w-arch', '--worktree', f.wt, '--session', 's2',
      '--inbox', inbox, '--cursor', cursor], ctx(f.home, f.wt, f.env)).result;
    assert.strictEqual(rEnsure.ok, false, JSON.stringify(rEnsure));
    assert.strictEqual(rEnsure.archived, true);
    assert.strictEqual(rEnsure.appArchived, true);

    // An explicit `register` (the "deliberate revival escape hatch" for
    // anti-hall's OWN marker) must ALSO be refused — the owner rule is the app
    // DB wins "regardless of new heartbeats or registrations", not just the
    // routine auto-ensure path.
    const rExplicit = cli.run(['register', 'w-arch', '--worktree', f.wt, '--session', 's3',
      '--inbox', inbox, '--cursor', cursor], ctx(f.home, f.wt, f.env)).result;
    assert.strictEqual(rExplicit.ok, false, JSON.stringify(rExplicit));
    assert.strictEqual(rExplicit.appArchived, true);

    // A heartbeat must not clear liveness back to alive or broadcast.
    const rBeat = cli.run(['heartbeat', 'w-arch', '--session', 's2', '--summary', 'idle — awaiting task brief'],
      ctx(f.home, f.wt, f.env)).result;
    assert.strictEqual(rBeat.appArchived, true, JSON.stringify(rBeat));
    assert.strictEqual(rBeat.meshBroadcast && rBeat.meshBroadcast.dropped, true, JSON.stringify(rBeat.meshBroadcast));

    // The roster still says archived, with the leak flag (a fresh heartbeat
    // file DOES exist — the base heartbeat write above always happens).
    const roster = cli.run(['roster'], ctx(f.home, f.wt, f.env)).result;
    assert.strictEqual(roster.ok, true, JSON.stringify(roster));
    const row = (roster.workspaces || []).find((w) => w.id === 'w-arch');
    assert.ok(row, 'w-arch is still listed on the roster: ' + JSON.stringify(roster.workspaces));
    assert.ok(row.hints.includes('archived'), 'still archived: ' + JSON.stringify(row.hints));
    assert.ok(row.hints.includes('live session in archived workspace'), 'leak flag present: ' + JSON.stringify(row.hints));
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(b) app DB unreadable -> old behavior (register/heartbeat succeed normally)', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const inbox = path.join(f.base, 'inbox.ndjson');
    const cursor = path.join(f.base, 'cursor.json');
    // Point ANTIHALL_DEVSWARM_APP_DB at a file that does not exist.
    const badEnv = { ANTIHALL_DEVSWARM_APP_DB: path.join(f.base, 'missing.db'), ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    const r = cli.run(['register', 'w-noappdb', '--worktree', f.wt, '--session', 's1',
      '--inbox', inbox, '--cursor', cursor], ctx(f.home, f.wt, badEnv)).result;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const rBeat = cli.run(['heartbeat', 'w-noappdb', '--session', 's1'], ctx(f.home, f.wt, badEnv)).result;
    assert.strictEqual(rBeat.ok, true, JSON.stringify(rBeat));
    assert.ok(!rBeat.appArchived);
  } finally { rm(f.base); appDb.resetCache(); }
});
