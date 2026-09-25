'use strict';
// row-eligibility — THE one per-row projection (archived sources, held,
// archive-ignore, liveness). Isolated tmp HOME per test; the app DB is
// disabled ('off') unless a test builds its own fixture DB.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib');
const re = require(path.join(LIB, 'row-eligibility.js'));
const cacheLib = require(path.join(LIB, 'devswarm-archived-cache.js'));
const appDb = require(path.join(LIB, 'devswarm-app-db.js'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function mkHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rowelig-')));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function root(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function writeDesc(home, dir, id, desc) {
  fs.mkdirSync(path.join(root(home), dir), { recursive: true });
  fs.writeFileSync(path.join(root(home), dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc || {})));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function envFor(home, extra) {
  return Object.assign({ HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_APP_DB: 'off' }, extra || {});
}

// app-archived by active-list absence (same fixture shape as row-state.test.js).
function appArchivedFixture(home, id) {
  const wt = path.join(home, '.devswarm', 'repos', 'proj', 'wt-' + id);
  fs.mkdirSync(wt, { recursive: true });
  writeDesc(home, 'workspaces', id, { worktreePath: wt, sessionId: 's-' + id });
  const old = Date.now() - 3600 * 1000;
  fs.utimesSync(path.join(root(home), 'workspaces', id + '.json'), old / 1000, old / 1000);
  const other = path.join(home, '.devswarm', 'repos', 'proj', 'wt-other');
  cacheLib.writeActiveCache({ home, byRepoKey: { 'proj-abc123': [{ id: 'other', worktreePath: other }] }, now: Date.now() });
  return wt;
}

test('plain active row: nothing fires, reason eligible, liveness null unless asked', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    const e = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home) });
    assert.deepStrictEqual(e, {
      id: 'w1', archived: false, archivedBy: [], markerArchived: false, appArchived: false,
      status: 'active', present: true, held: false, ignored: false,
      live: null, busy: null, waitingOnUser: null, waitingQuestion: null, reason: 'eligible',
    });
  } finally { rm(home); }
});

test('marker source: archived, archivedBy [marker], reason archived:marker', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    writeDesc(home, 'archived', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    const e = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home) });
    assert.strictEqual(e.archived, true);
    assert.deepStrictEqual(e.archivedBy, ['marker']);
    assert.strictEqual(e.markerArchived, true);
    assert.strictEqual(e.appArchived, false);
    assert.strictEqual(e.reason, 'archived:marker');
    // A marker for a different worktree (reused id) is not this row's archive.
    const other = re.rowEligibility({ id: 'w1', worktreePath: '/x/new' }, { home, env: envFor(home) });
    assert.strictEqual(other.archived, false);
    // A marker superseded by a different live session is not this row's archive.
    const sup = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1', sessionId: 's-new' }, { home, env: envFor(home) });
    assert.strictEqual(sup.archived, false);
  } finally { rm(home); }
});

test('active-list source: app-archived by absence, needs the repoKey', () => {
  const home = mkHome();
  try {
    const wt = appArchivedFixture(home, 'wsA');
    const e = re.rowEligibility({ id: 'wsA', worktreePath: wt, repoKey: 'proj-abc123' }, { home, env: envFor(home) });
    assert.strictEqual(e.archived, true);
    assert.deepStrictEqual(e.archivedBy, ['active-list']);
    assert.strictEqual(e.appArchived, true);
    assert.strictEqual(e.markerArchived, false);
    assert.strictEqual(e.reason, 'archived:active-list');
    const noKey = re.rowEligibility({ id: 'wsA', worktreePath: wt }, { home, env: envFor(home) });
    assert.strictEqual(noKey.archived, false, 'no repoKey -> no snapshot to judge by');
  } finally { rm(home); }
});

test('marker + active-list together: both sources listed, marker first', () => {
  const home = mkHome();
  try {
    const wt = appArchivedFixture(home, 'wsA');
    writeDesc(home, 'archived', 'wsA', { worktreePath: wt, sessionId: 's-wsA' });
    const e = re.rowEligibility({ id: 'wsA', worktreePath: wt, repoKey: 'proj-abc123' }, { home, env: envFor(home) });
    assert.deepStrictEqual(e.archivedBy, ['marker', 'active-list']);
    assert.strictEqual(e.reason, 'archived:marker');
  } finally { rm(home); }
});

test('app-db source: the app database decides when it has a record', { skip: sqlite ? false : 'node:sqlite unavailable' }, () => {
  const home = mkHome();
  try {
    const wtA = path.join(home, 'wt-arch'); fs.mkdirSync(wtA);
    const wtL = path.join(home, 'wt-live'); fs.mkdirSync(wtL);
    const dbFile = path.join(home, 'app', 'devswarm.db');
    fs.mkdirSync(path.dirname(dbFile));
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
    const ins = db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)');
    ins.run('b-arch', 'r1', wtA, 1, 0);
    ins.run('b-live', 'r1', wtL, 0, 1);
    db.close();
    appDb.resetCache();
    const env = envFor(home, { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' });
    const e = re.rowEligibility({ id: 'b-arch', worktreePath: wtA }, { home, env });
    assert.strictEqual(e.archived, true);
    assert.deepStrictEqual(e.archivedBy, ['app-db']);
    assert.strictEqual(e.reason, 'archived:app-db');
    const live = re.rowEligibility({ id: 'b-live', worktreePath: wtL }, { home, env });
    assert.strictEqual(live.archived, false);
    assert.deepStrictEqual(live.archivedBy, []);
  } finally { appDb.resetCache(); rm(home); }
});

test('held: from devswarm.heldPartitions (env) or an injected set; independent of archived', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1' });
    const viaEnv = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' },
      { home, env: envFor(home, { ANTIHALL_DEVSWARM_HELD_PARTITIONS: 'zz, w1' }) });
    assert.strictEqual(viaEnv.held, true);
    assert.strictEqual(viaEnv.archived, false);
    assert.strictEqual(viaEnv.reason, 'held');
    const viaSet = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home), heldIds: new Set(['w1']) });
    assert.strictEqual(viaSet.held, true);
    const notHeld = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home), heldIds: new Set(['w2']) });
    assert.strictEqual(notHeld.held, false);
  } finally { rm(home); }
});

test('ignored: archive-ignore/<id>.json marker; held + ignored + archived all reported', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    writeDesc(home, 'archive-ignore', 'w1', {});
    const e = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home) });
    assert.strictEqual(e.ignored, true);
    assert.strictEqual(e.reason, 'ignored');
    writeDesc(home, 'archived', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    const all = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home), heldIds: new Set(['w1']) });
    assert.strictEqual(all.archived, true);
    assert.strictEqual(all.held, true);
    assert.strictEqual(all.ignored, true);
    assert.strictEqual(all.reason, 'archived:marker', 'archive outranks held/ignored in `reason`');
  } finally { rm(home); }
});

test('liveness: no session -> not live/busy/waiting; a running session pid -> live', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1' });
    const dead = re.rowEligibility({ id: 'w1', worktreePath: '/x/w1' }, { home, env: envFor(home), liveness: true });
    assert.strictEqual(dead.live, false);
    assert.strictEqual(dead.busy, false);
    assert.strictEqual(dead.waitingOnUser, false);
    assert.strictEqual(dead.reason, 'eligible');
    const sessDir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: 'sess-live' }));
    const desc = { id: 'w2', worktreePath: '/x/w2', sessionId: 'sess-live' };
    const live = re.rowEligibility({ id: 'w2', worktreePath: '/x/w2', sessionId: 'sess-live', descriptor: desc },
      { home, env: envFor(home), liveness: true });
    assert.strictEqual(live.live, true);
    assert.strictEqual(live.busy, false, 'no transcript -> never busy');
    assert.strictEqual(live.reason, 'live');
  } finally { rm(home); }
});

test('context memoizes per row and the batch API keys by id', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1' });
    writeDesc(home, 'workspaces', 'w2', { worktreePath: '/x/w2' });
    writeDesc(home, 'archived', 'w2', { worktreePath: '/x/w2' });
    let cacheReads = 0;
    const ctx = re.createContext({ home, env: envFor(home), cache: () => { cacheReads++; return null; }, heldIds: new Set() });
    const a = ctx.of({ id: 'w1', worktreePath: '/x/w1' });
    assert.strictEqual(ctx.of({ id: 'w1', worktreePath: '/x/w1' }), a, 'same row -> same object, not recomputed');
    const m = ctx.all([{ id: 'w1', worktreePath: '/x/w1' }, { id: 'w2', worktreePath: '/x/w2' }, null, { id: null }]);
    assert.deepStrictEqual([...m.keys()], ['w1', 'w2']);
    assert.strictEqual(m.get('w1'), a);
    assert.strictEqual(m.get('w2').archived, true);
    assert.strictEqual(cacheReads, 2, 'one cache resolution per distinct row');
    const batch = re.rowEligibilities([{ id: 'w2', worktreePath: '/x/w2' }], { home, env: envFor(home) });
    assert.strictEqual(batch.get('w2').reason, 'archived:marker');
  } finally { rm(home); }
});

test('fail-open: unsafe id / empty row never archived, never held, never throws', () => {
  const home = mkHome();
  try {
    const e = re.rowEligibility({ id: '../x', registryRow: null }, { home, env: envFor(home), heldIds: new Set() });
    assert.strictEqual(e.archived, false);
    assert.strictEqual(e.status, 'unknown');
    const empty = re.rowEligibility(null, { home, env: envFor(home), heldIds: new Set() });
    assert.strictEqual(empty.archived, false);
    assert.strictEqual(empty.held, false);
  } finally { rm(home); }
});
