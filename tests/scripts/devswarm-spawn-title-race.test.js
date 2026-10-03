'use strict';
// Task #36(a): `devswarm.js spawn <branch> -p "<brief>"` sometimes titled a
// workspace from the branch name and sometimes from the brief's first line —
// a RACE, not a deterministic rule.
//
// PROVEN ROOT CAUSE: `cmdSpawn` derives a title (explicit -t/--title, else
// deriveTitleFromBrief) and applies it via a SEPARATE `hivecontrol workspace
// update-title` call, made AFTER `hivecontrol workspace create` (which
// defaults the workspace's label to the raw branch name — devswarm-names.js's
// own header). Independently, `refreshNamesFromApp` (invoked by the
// supervisor's periodic app-DB sync AND by `cmdReconcile`'s names backfill,
// off its own timer, with NO ordering relationship to spawn's two hivecontrol
// round-trips, against a snapshot that can itself be stale by the app-DB's
// own cache window) mirrors the app DB's CURRENT `builders.label` into the
// SAME names/<id>.json cache whenever it differs — with no recency check.
// If that mirror samples the window between `create` and `update-title` (or a
// stale cached snapshot predating the retitle), it clobbers the just-set
// brief-derived title back down to the bare branch name. Whichever writer
// lands last wins — a race, exactly the field symptom.
//
// FIX: refreshNamesFromApp never lets an app label that is STILL the raw
// branch name overwrite an already-cached, DIFFERENT name (a real owner
// rename in the app is never literally the branch string).
//
// These tests exercise refreshNamesFromApp directly (the shared writer both
// the supervisor sweep and cmdReconcile call) against a minimal fixture app
// DB, simulating both race orderings.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const names = require('../../plugins/anti-hall/companion/lib/devswarm-names.js');

function buildDb(dbFile, label, branchName) {
  const sqlite = require('node:sqlite');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT)');
  db.exec('CREATE TABLE pull_requests (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT)');
  db.exec('CREATE TABLE repositories (id TEXT PRIMARY KEY, path TEXT, name TEXT, defaultBaseBranch TEXT)');
  db.exec('CREATE TABLE workspace_messages (repositoryId TEXT, toBranch TEXT, createdAt TEXT)');
  db.prepare('INSERT INTO builders (id, repositoryId, branchName, worktreePath, label, isHidden, isActive, builderType) VALUES (?,?,?,?,?,0,1,?)')
    .run('child-1', 'repo-1', branchName, '/tmp/wt-child-1', label, 'standard');
  db.close();
}

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-title-race-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
  const dbFile = path.join(base, 'devswarm.db');
  const env = { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  return { base, home, dbFile, env };
}
const rm = (f) => { try { fs.rmSync(f.base, { recursive: true, force: true }); } catch (_) {} };

test('title race, order A: app DB still shows the raw branch (pre-retitle window) AFTER the brief title is already cached -> the branch never clobbers it', () => {
  const f = fixture();
  try {
    // cmdSpawn's own update-title confirmation already cached the derived title.
    names.writeName(f.home, 'child-1', 'own the API layer', Date.now());
    // The app DB snapshot the supervisor sweep samples is still pre-retitle:
    // label == branchName (hivecontrol's create-time default).
    buildDb(f.dbFile, 'fix/own-api', 'fix/own-api');
    const r = cli.refreshNamesFromApp(f.home, f.env, [{ id: 'child-1', worktreePath: '/tmp/wt-child-1' }], Date.now());
    assert.strictEqual(r.refreshed, 0, 'the branch-name label must not overwrite the already-cached brief title');
    assert.strictEqual(names.readName(f.home, 'child-1'), 'own the API layer');
  } finally { rm(f); }
});

test('title race, order B: app DB has already caught up to the retitle -> it propagates normally (not blocked)', () => {
  const f = fixture();
  try {
    names.writeName(f.home, 'child-1', 'own the API layer', Date.now());
    // The app DB (and hivecontrol) confirm the SAME retitle - refresh is a no-op
    // (identical value), proven separately from an actual owner rename below.
    buildDb(f.dbFile, 'own the API layer', 'fix/own-api');
    const r = cli.refreshNamesFromApp(f.home, f.env, [{ id: 'child-1', worktreePath: '/tmp/wt-child-1' }], Date.now());
    assert.strictEqual(r.refreshed, 0);
    assert.strictEqual(names.readName(f.home, 'child-1'), 'own the API layer');
  } finally { rm(f); }
});

test('a genuine owner rename in the app (not the branch string) still propagates', () => {
  const f = fixture();
  try {
    names.writeName(f.home, 'child-1', 'own the API layer', Date.now());
    buildDb(f.dbFile, 'Renamed by owner in the app', 'fix/own-api');
    const r = cli.refreshNamesFromApp(f.home, f.env, [{ id: 'child-1', worktreePath: '/tmp/wt-child-1' }], Date.now());
    assert.strictEqual(r.refreshed, 1, 'a real rename (not the branch string) must still win');
    assert.strictEqual(names.readName(f.home, 'child-1'), 'Renamed by owner in the app');
  } finally { rm(f); }
});

test('brand-new workspace, nothing cached yet: the branch-name default still backfills (never blocked)', () => {
  const f = fixture();
  try {
    buildDb(f.dbFile, 'fix/own-api', 'fix/own-api');
    const r = cli.refreshNamesFromApp(f.home, f.env, [{ id: 'child-1', worktreePath: '/tmp/wt-child-1' }], Date.now());
    assert.strictEqual(r.refreshed, 1);
    assert.strictEqual(names.readName(f.home, 'child-1'), 'fix/own-api');
  } finally { rm(f); }
});

test('deriveTitleFromBrief: -t/--title wins over a brief when both are present at spawn', () => {
  assert.strictEqual(cli.deriveTitleFromBrief('own the API layer\nsecond line'), 'own the API layer');
  assert.strictEqual(cli.deriveTitleFromBrief('# heading marker'), 'heading marker');
  assert.strictEqual(cli.deriveTitleFromBrief('   '), null);
  assert.strictEqual(cli.deriveTitleFromBrief(null), null);
});
