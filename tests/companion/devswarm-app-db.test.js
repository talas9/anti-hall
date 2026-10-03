'use strict';
// v0.107.1 — workspaces archived in the DevSwarm APP kept nagging the Primary.
// Archive detection was "by absence" from `hivecontrol workspace list all`, but
// that command lists archived builders too (no state field), so nothing was
// ever absent. The app's own database (table `builders`: isActive / isHidden) is
// the ground truth; archived = isActive 0 AND isHidden 1.
//   (a) appArchivedVerdict: by id, by a twin row on an archived worktree, an
//       active builder on the worktree wins, unknown -> null; fail-open on a
//       missing file / table / column, `off` disables
//   (b) rowState reports appArchived from the DB (no repoKey / cache needed)
//   (c) repair (markAppArchivedDescriptors / 'mark-app-archived'): writes the
//       archived marker for app-archived descriptors, never clobbers, never
//       touches descriptors, dry-run writes nothing, second run is a no-op
//   (d) the parent-inbox hook never nags about an app-archived row or its twin

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const appDb = require(path.join(ROOT, 'companion', 'lib', 'devswarm-app-db.js'));
const { rowState } = require(path.join(ROOT, 'companion', 'lib', 'row-state.js'));
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const M = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const { testHook } = require('../helpers/spawn-hook.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// fixture() -> a home, three worktrees, and an app DB holding one ACTIVE and
// one ARCHIVED builder (+ one inactive-but-not-hidden builder).
function fixture(opts) {
  const o = opts || {};
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-app-db-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const wtActive = path.join(base, 'wt-active'); fs.mkdirSync(wtActive);
  const wtArch = path.join(base, 'wt-archived'); fs.mkdirSync(wtArch);
  const wtOther = path.join(base, 'wt-other'); fs.mkdirSync(wtOther);
  const dbFile = path.join(base, 'app', 'devswarm.db');
  fs.mkdirSync(path.dirname(dbFile));
  const db = new sqlite.DatabaseSync(dbFile);
  const cols = o.noIsActive ? 'id TEXT PRIMARY KEY, worktreePath TEXT, isHidden INTEGER'
    : 'id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1';
  db.exec('CREATE TABLE builders (' + cols + ')');
  if (!o.noIsActive) {
    const ins = db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)');
    ins.run('b-active', 'r1', wtActive, 0, 1);
    ins.run('b-archived', 'r1', wtArch, 1, 0);
    ins.run('b-paused', 'r1', wtOther, 0, 0);
  }
  db.close();
  const env = { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  return { base, home, env, dbFile, wtActive, wtArch, wtOther };
}
function writeDescriptor(f, id, worktreePath) {
  const dir = path.join(f.home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, id + '.json');
  fs.writeFileSync(p, JSON.stringify({ id, worktreePath, sessionId: null }));
  return p;
}
const markerPath = (f, id) => path.join(f.home, '.anti-hall', 'devswarm', 'archived', id + '.json');

test('(a) appArchivedVerdict: id, twin-by-worktree, active wins, unknown -> null, fail-open', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const v = (id, wt, env) => appDb.appArchivedVerdict({ home: f.home, env: env || f.env, id, worktreePath: wt });
    assert.strictEqual(v('b-archived', null), true, 'archived builder by id');
    assert.strictEqual(v('b-active', null), false, 'active builder by id');
    assert.strictEqual(v('b-paused', null), false, 'inactive but not hidden is not archived');
    assert.strictEqual(v('primary-twin', f.wtArch), true, 'a twin row on an archived worktree');
    assert.strictEqual(v('primary-root', f.wtActive), false, 'an active builder on the worktree wins');
    assert.strictEqual(v('unknown', path.join(f.base, 'nowhere')), null, 'no record -> no opinion');
    assert.strictEqual(v('b-archived', null, { ANTIHALL_DEVSWARM_APP_DB: 'off' }), null, 'off disables');
    assert.strictEqual(v('b-archived', null, { ANTIHALL_DEVSWARM_APP_DB: path.join(f.base, 'missing.db'), ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' }), null, 'missing file -> null');
    assert.strictEqual(appDb.appArchivedVerdict({ home: null, env: {}, id: 'b-archived' }), null, 'no home, no override -> never reads the real home');
  } finally { rm(f.base); appDb.resetCache(); }
  const g = fixture({ noIsActive: true });
  try {
    appDb.resetCache();
    assert.strictEqual(appDb.appArchivedVerdict({ home: g.home, env: g.env, id: 'b-archived' }), null, 'missing isActive column -> null');
  } finally { rm(g.base); appDb.resetCache(); }
});

test('(b) rowState reports appArchived from the app DB without a repoKey', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    assert.strictEqual(rowState({ home: f.home, env: f.env, id: 'b-archived', worktreePath: f.wtArch }).appArchived, true);
    assert.strictEqual(rowState({ home: f.home, env: f.env, id: 'b-archived', worktreePath: f.wtArch }).status, 'app-archived');
    assert.strictEqual(rowState({ home: f.home, env: f.env, id: 'b-active', worktreePath: f.wtActive }).appArchived, false);
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(c) repair marks app-archived descriptors: never-clobber, no-delete, dry-run, idempotent', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const dArch = writeDescriptor(f, 'b-archived', f.wtArch);
    const dTwin = writeDescriptor(f, 'primary-twin', f.wtArch);
    const dActive = writeDescriptor(f, 'b-active', f.wtActive);
    const dClob = writeDescriptor(f, 'primary-clob', f.wtArch);
    fs.mkdirSync(path.dirname(markerPath(f, 'x')), { recursive: true });
    fs.writeFileSync(markerPath(f, 'primary-clob'), '{"keep":"me"}');
    const before = [dArch, dTwin, dActive, dClob].map((p) => fs.readFileSync(p, 'utf8'));

    const dry = dw.markAppArchivedDescriptors(f.home, { env: f.env, dryRun: true });
    assert.strictEqual(dry.pending, 2, JSON.stringify(dry));
    assert.ok(!fs.existsSync(markerPath(f, 'b-archived')), 'dry run writes nothing');

    const rows = M.runMigrations({ home: f.home, env: f.env, version: '9.9.9', devswarm: dw });
    const row = rows.find((x) => x.id === 'mark-app-archived');
    assert.strictEqual(row.status, 'fixed', row.msg);
    assert.strictEqual(M.isApplied(M.readMarkers(f.home), 'markAppArchived', '9.9.9'), true);
    for (const id of ['b-archived', 'primary-twin']) {
      const m = JSON.parse(fs.readFileSync(markerPath(f, id), 'utf8'));
      assert.strictEqual(m.id, id);
      assert.strictEqual(m.archivedBy, 'devswarm-app');
    }
    assert.ok(!fs.existsSync(markerPath(f, 'b-active')), 'active builder never marked');
    assert.strictEqual(fs.readFileSync(markerPath(f, 'primary-clob'), 'utf8'), '{"keep":"me"}', 'existing marker never clobbered');
    assert.deepStrictEqual([dArch, dTwin, dActive, dClob].map((p) => fs.readFileSync(p, 'utf8')), before, 'descriptors untouched');

    const again = dw.markAppArchivedDescriptors(f.home, { env: f.env });
    assert.strictEqual(again.marked, 0, 'second run is a no-op');
    assert.strictEqual(again.errors, 0);
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(d) parent-inbox never nags about an app-archived row or its twin; a live row still nags', { skip }, () => {
  const f = fixture();
  try {
    const REPO_CWD = process.cwd();
    const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
    const dir = path.join(f.home, '.anti-hall', 'devswarm', 'summaries');
    fs.mkdirSync(dir, { recursive: true });
    const ws = (wt, extra) => Object.assign({ worktreePath: wt, sessionId: null, total: 3, cursor: 0, unread: 3, directUnread: 3, urgencyMax: 'urgent', gates: {}, archive_ready: false }, extra || {});
    fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({
      generatedAt: Date.now(), requiredGates: ['done'], recent: [], archivedRegistryRows: [],
      workspaces: {
        'b-archived': ws(f.wtArch, { gates: { done: true }, archive_ready: true }),
        'primary-twin': ws(f.wtArch),
        'b-active': ws(f.wtActive),
      },
    }));
    const r = testHook('devswarm-parent-inbox.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
      { home: f.home, env: Object.assign({ DEVSWARM_REPO_ID: 'repo-1' }, f.env), expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
    const nag = c.split('\n\n').filter((s) => /^DEVSWARM (URGENT|PARENT) INBOX/.test(s)).join('\n');
    assert.ok(nag.includes('b-active'), 'the live row still nags: ' + c);
    assert.ok(!nag.includes('b-archived'), 'app-archived row never nags: ' + nag);
    assert.ok(!nag.includes('primary-twin'), 'its twin on the archived worktree never nags: ' + nag);
    const archSeg = c.split('\n\n').find((s) => s.startsWith('DEVSWARM ARCHIVE-READY')) || '';
    assert.ok(!archSeg.includes('b-archived'), 'no archive-ready nudge for an already-archived workspace: ' + archSeg);
  } finally { rm(f.base); }
});
