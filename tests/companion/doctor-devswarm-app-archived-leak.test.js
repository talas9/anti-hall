'use strict';
// 0.109.1 field defect — doctor part (b): a REPORT-ONLY leak check for a
// `claude` session still alive in a workspace the DevSwarm app reports
// archived (isActive=0, isHidden=1). The field incident: a terminal tab was
// left OPEN (its AI terminal row still isActive=1) on an archived workspace;
// the killed `claude` process relaunched within ~10s. This never kills
// anything or archives anything — it only names the leak (workspace title +
// pid) so a human can close it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const doc = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function msgs(rows) { return rows.map((r) => r.status + ' ' + r.message).join('\n'); }
function writeSessionFile(home, pid, rec) {
  const dir = liveness.sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid) + '.json'), JSON.stringify(rec));
}

// fixture(opts) -> a home + an app DB with ONE archived builder ('w-arch',
// isActive=0/isHidden=1, label "Archived task") whose AI terminal is still
// OPEN (isActive=1) — the exact field shape: the workspace is archived, but
// its terminal tab was left open, so a relaunched `claude` process can still
// be attached to it. opts.terminalActive lets the "tab already closed" case
// be exercised too (no leak: same as no session file).
function fixture(opts) {
  const o = opts || {};
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-appdb-leak-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const repoPath = path.join(base, 'repo'); fs.mkdirSync(repoPath);
  const wtArch = path.join(base, 'wt-arch'); fs.mkdirSync(wtArch);
  const dbFile = path.join(base, 'app', 'devswarm.db');
  fs.mkdirSync(path.dirname(dbFile));
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, label TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  db.exec('CREATE TABLE builder_terminals (id TEXT PRIMARY KEY, builderId TEXT, terminalId TEXT, terminalType TEXT, ai_session_config TEXT, isActive INTEGER, createdAt TEXT)');
  db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, label, isHidden, isActive) VALUES (?, ?, ?, ?, 1, 0)')
    .run('w-arch', 'r1', wtArch, 'Archived task');
  db.prepare('INSERT INTO builder_terminals (id, builderId, terminalId, terminalType, ai_session_config, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('t-arch', 'w-arch', '0.t1', 'ai', JSON.stringify({ sessionId: 'sess-arch' }), o.terminalActive === false ? 0 : 1, new Date().toISOString());
  db.close();
  const env = { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  return { base, home, env, repoPath, wtArch };
}

test('doctor reports a live claude session in an archived workspace, with its pid, and never kills/archives anything', { skip }, () => {
  const f = fixture();
  try {
    // process.kill(pid, 0) on our OWN pid always succeeds, so it reads as a
    // genuinely live session without spawning anything.
    writeSessionFile(f.home, process.pid, { pid: process.pid, sessionId: 'sess-arch', cwd: f.wtArch, status: 'running' });

    const rows = doc.appDbChecks({ home: f.home, env: f.env, cwd: f.repoPath });
    const m = msgs(rows);
    assert.ok(/claude session alive in an archived workspace/.test(m), 'leak reported: ' + m);
    assert.ok(m.includes('Archived task'), 'workspace title named: ' + m);
    assert.ok(m.includes('(pid ' + process.pid + ')'), 'pid named: ' + m);
    const leakRow = rows.find((r) => /claude session alive/.test(r.message));
    assert.strictEqual(leakRow.status, 'WARN');
    assert.deepStrictEqual(leakRow.appArchivedLiveSessions.map((x) => x.pid), [process.pid]);
    // REPORT ONLY: the message only ever SUGGESTS the two safe closing
    // actions; nothing here calls hivecontrol or kills anything (a pure
    // fs/sqlite read function cannot).
    assert.ok(/close the DevSwarm tab, or run `hivecontrol workspace archive <full id>`/.test(leakRow.message));
  } finally { rm(f.base); }
});

test('the terminal tab is already closed (isActive=0) -> no leak reported', { skip }, () => {
  const f = fixture({ terminalActive: false });
  try {
    writeSessionFile(f.home, process.pid, { pid: process.pid, sessionId: 'sess-arch', cwd: f.wtArch, status: 'running' });
    const rows = doc.appDbChecks({ home: f.home, env: f.env, cwd: f.repoPath });
    assert.ok(!/claude session alive in an archived workspace/.test(msgs(rows)));
  } finally { rm(f.base); }
});

test('no session file for the archived terminal -> no leak reported', { skip }, () => {
  const f = fixture();
  try {
    const rows = doc.appDbChecks({ home: f.home, env: f.env, cwd: f.repoPath });
    assert.ok(!/claude session alive in an archived workspace/.test(msgs(rows)));
  } finally { rm(f.base); }
});

test('a DEAD pid recorded for the archived session -> no leak reported', { skip }, () => {
  const f = fixture();
  try {
    const deadPid = 2147480000; // astronomically unlikely to exist
    writeSessionFile(f.home, deadPid, { pid: deadPid, sessionId: 'sess-arch', cwd: f.wtArch, status: 'running' });
    const rows = doc.appDbChecks({ home: f.home, env: f.env, cwd: f.repoPath });
    assert.ok(!/claude session alive in an archived workspace/.test(msgs(rows)));
  } finally { rm(f.base); }
});
