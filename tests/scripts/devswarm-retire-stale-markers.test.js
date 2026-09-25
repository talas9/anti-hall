'use strict';
// v0.108.3 — "retire marker, trust app": an anti-hall archived/<id>.json marker
// whose workspace the READABLE DevSwarm app DB shows open (isActive=1,
// isHidden=0) is retired — renamed into archived-retired/ with a `retired`
// record, never deleted — by the supervisor's app-DB sync (syncAppState) and by
// the 'retire-stale-archived-markers' migration (doctor --repair). P1-A: the
// workspace is RESTORED to active first (restoreArchivedDescriptor, the same
// logic cmdUnarchive runs); a failed restore keeps the marker; a marker from
// anti-hall's own `archive` verb is never auto-restored. Fixture app DB in
// tmpdir, isolated HOME; the real DB/store is never touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const M = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
const { isArchivedWorkspace } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-archived.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const HOUR = 3600e3;
const ds = (f) => path.join(f.home, '.anti-hall', 'devswarm');
const markerPath = (f, id) => path.join(ds(f), 'archived', id + '.json');
const retiredDir = (f) => path.join(ds(f), 'archived-retired');
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
const OWNER = storeLib.hashFromWorkspaceId('b-a');
function setup() {
  const f = buildAppDb();
  f.env = Object.assign({ HOME: f.home }, f.env);
  writeJson(path.join(ds(f), 'workspaces', 'b-a.json'), { id: 'b-a', worktreePath: f.wt.a, sessionId: null, ownerKey: OWNER });
  return f;
}
// CLI ctx for the fixture HOME, run from the child's own worktree (wt-a, which
// the fixture gives a .git dir), exactly as `archive`/`unarchive` are run.
function cliCtx(f) { return { home: f.home, backend: 'journal', env: {}, cwd: f.wt.a }; }
const liveOwner = (f) => JSON.parse(fs.readFileSync(path.join(ds(f), 'workspaces', 'b-a.json'), 'utf8')).ownerKey;
function registryCount(f, id) { return dw.run(['workspaces', 'list', '--workspace', id], cliCtx(f)).result.count; }
// The REAL post-archive state: register + `archive` (workspaces/<id>.json
// unlinked, registry row tombstoned, archived/<id>.json the only copy).
function realArchive(f) {
  fs.rmSync(path.join(ds(f), 'workspaces', 'b-a.json'));
  assert.strictEqual(dw.run(['register', 'b-a', '--worktree', f.wt.a, '--session', 'sess-a'], cliCtx(f)).result.ok, true);
  f.owner = liveOwner(f);
  assert.ok(f.owner, 'registered with an ownerKey');
  const a = dw.run(['archive', 'b-a'], cliCtx(f)).result;
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.ok(!fs.existsSync(path.join(ds(f), 'workspaces', 'b-a.json')), 'precondition: descriptor absent');
  assert.strictEqual(registryCount(f, 'b-a'), 0, 'precondition: registry tombstoned');
}
// Stamp app provenance onto the archived marker (the app archived it, anti-hall
// recorded that), keeping the post-archive storage state otherwise identical.
function stampAppSourced(f, at) {
  const p = markerPath(f, 'b-a');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p + '.tmp', JSON.stringify(Object.assign(m, { archivedBy: 'devswarm-app', archivedAt: at })));
  fs.renameSync(p + '.tmp', p);
}
function retiredFiles(f) { try { return fs.readdirSync(retiredDir(f)).filter((n) => n.endsWith('.json')); } catch (_) { return []; } }

test('sync retires a stale marker (app open): moved + stamped, not deleted, no conflict, descriptor untouched', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    writeJson(markerPath(f, 'b-a'), { id: 'b-a', worktreePath: f.wt.a, archivedBy: 'devswarm-app', archivedAt: now - 2 * HOUR });
    const descBefore = fs.readFileSync(path.join(ds(f), 'workspaces', 'b-a.json'), 'utf8');
    assert.strictEqual(isArchivedWorkspace(f.home, 'b-a', f.wt.a), true, 'precondition: marker drives archived');

    const dry = dw.syncAppState(f.home, { env: f.env, now, dryRun: true });
    assert.deepStrictEqual(dry.retiredMarkers, { retired: 0, pending: 1, errors: 0 });
    assert.ok(fs.existsSync(markerPath(f, 'b-a')), 'dry run writes nothing');

    const r = dw.syncAppState(f.home, { env: f.env, now });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.retiredMarkers.retired, 1, JSON.stringify(r.retiredMarkers));
    assert.deepStrictEqual(r.state.openButMarkedArchived, [], 'no longer a conflict');
    assert.ok(!fs.existsSync(markerPath(f, 'b-a')), 'marker left archived/');
    const files = retiredFiles(f);
    assert.deepStrictEqual(files, ['b-a.' + now + '.json']);
    const rec = JSON.parse(fs.readFileSync(path.join(retiredDir(f), files[0]), 'utf8'));
    assert.strictEqual(rec.id, 'b-a');
    assert.strictEqual(rec.archivedBy, 'devswarm-app', 'original content kept');
    assert.strictEqual(rec.retired.at, now);
    assert.strictEqual(rec.retired.by, 'devswarm-app-sync');
    assert.match(rec.retired.reason, /open in the DevSwarm app/);
    assert.strictEqual(isArchivedWorkspace(f.home, 'b-a', f.wt.a), false, 'retired marker no longer drives archived');
    assert.strictEqual(fs.readFileSync(path.join(ds(f), 'workspaces', 'b-a.json'), 'utf8'), descBefore, 'descriptor untouched');

    const again = dw.syncAppState(f.home, { env: f.env, now: now + 1000 });
    assert.strictEqual(again.retiredMarkers.retired, 0, 'idempotent');
    assert.strictEqual(retiredFiles(f).length, 1);
  } finally { rmFixture(f); }
});

test('hardlinked app-sourced marker: retired; the active descriptor bytes never change', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    const active = path.join(ds(f), 'workspaces', 'b-a.json');
    fs.mkdirSync(path.join(ds(f), 'archived'), { recursive: true });
    writeJson(active, { id: 'b-a', worktreePath: f.wt.a, sessionId: null, ownerKey: OWNER, archivedBy: 'devswarm-app', archivedAt: now });
    fs.linkSync(active, markerPath(f, 'b-a'));
    const bytes = fs.readFileSync(active, 'utf8');
    assert.strictEqual(dw.retireStaleArchivedMarkers(f.home, { env: f.env, now }).retired, 0, 'grace: one app read cannot flap it');
    const r = dw.retireStaleArchivedMarkers(f.home, { env: f.env, now: now + HOUR });
    assert.strictEqual(r.retired, 1, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(active, 'utf8'), bytes, 'active descriptor unchanged');
    const rec = JSON.parse(fs.readFileSync(path.join(retiredDir(f), retiredFiles(f)[0]), 'utf8'));
    assert.strictEqual(rec.retired.by, 'devswarm-app-sync');
    assert.strictEqual(rec.retired.restored, true);
  } finally { rmFixture(f); }
});

test('P1-A real post-archive state (descriptor absent, registry tombstoned) + app open: restored, unarchive-equivalent, idempotent', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    realArchive(f);
    stampAppSourced(f, now - 2 * HOUR);
    const r = dw.syncAppState(f.home, { env: f.env, now });
    assert.strictEqual(r.retiredMarkers.retired, 1, JSON.stringify(r.retiredMarkers));
    assert.deepStrictEqual(r.state.openButMarkedArchived, []);
    // Unarchive-equivalent: descriptor back in workspaces/, marker-only fields
    // dropped, ownership kept, registry row live, archived/ empty.
    const desc = JSON.parse(fs.readFileSync(path.join(ds(f), 'workspaces', 'b-a.json'), 'utf8'));
    assert.strictEqual(desc.worktreePath, f.wt.a);
    assert.strictEqual(desc.sessionId, 'sess-a');
    assert.strictEqual(desc.ownerKey, f.owner);
    assert.ok(!('archivedBy' in desc) && !('archivedAt' in desc), 'marker-only fields not carried into the live descriptor');
    assert.strictEqual(registryCount(f, 'b-a'), 1, 'registry row revived');
    assert.ok(!fs.existsSync(markerPath(f, 'b-a')));
    assert.strictEqual(isArchivedWorkspace(f.home, 'b-a', f.wt.a), false);
    const rec = JSON.parse(fs.readFileSync(path.join(retiredDir(f), retiredFiles(f)[0]), 'utf8'));
    assert.strictEqual(rec.retired.restored, true);
    assert.strictEqual(rec.archivedBy, 'devswarm-app', 'retired record keeps the marker bytes');
    // Idempotent: a second pass finds nothing and changes nothing.
    const again = dw.syncAppState(f.home, { env: f.env, now: now + 1000 });
    assert.strictEqual(again.retiredMarkers.retired, 0);
    assert.strictEqual(retiredFiles(f).length, 1);
    assert.strictEqual(registryCount(f, 'b-a'), 1);
    // And the workspace archives again normally (fully active state).
    assert.strictEqual(dw.run(['archive', 'b-a'], cliCtx(f)).result.ok, true);
  } finally { rmFixture(f); }
});

test('P1-A own `archive` verb marker + app open: never auto-restored at any age; stays unarchivable', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    realArchive(f);
    for (const t of [now, now + HOUR, now + 30 * 24 * HOUR]) {
      const r = dw.retireStaleArchivedMarkers(f.home, { env: f.env, now: t });
      assert.strictEqual(r.retired, 0, JSON.stringify(r));
      assert.strictEqual(r.pending, 0);
      assert.deepStrictEqual(r.localHeld, ['b-a']);
    }
    const s = dw.syncAppState(f.home, { env: f.env, now: now + 30 * 24 * HOUR });
    assert.deepStrictEqual(s.state.openButMarkedArchived.map((x) => x.id), ['b-a'], 'still reported as a conflict');
    assert.ok(fs.existsSync(markerPath(f, 'b-a')), 'marker (the only copy) kept');
    assert.deepStrictEqual(retiredFiles(f), []);
    assert.strictEqual(registryCount(f, 'b-a'), 0, 'owner archive intent kept');
    const u = dw.run(['unarchive', 'b-a'], cliCtx(f)).result;
    assert.strictEqual(u.ok, true, JSON.stringify(u));
    assert.strictEqual(registryCount(f, 'b-a'), 1);
  } finally { rmFixture(f); }
});

test('P1-A a failed restore step keeps the marker in archived/ (never orphaned); a later pass restores', { skip }, (t) => {
  const f = setup();
  try {
    const now = Date.now();
    realArchive(f);
    stampAppSourced(f, now - 2 * HOUR);
    const activePath = path.join(ds(f), 'workspaces', 'b-a.json');
    const origLink = fs.linkSync.bind(fs);
    t.mock.method(fs, 'linkSync', (from, to) => {
      if (String(to) === activePath) throw new Error('boom: simulated link failure');
      return origLink(from, to);
    });
    const r = dw.retireStaleArchivedMarkers(f.home, { env: f.env, now });
    t.mock.reset();
    assert.strictEqual(r.retired, 0, JSON.stringify(r));
    assert.strictEqual(r.left.length, 1);
    assert.match(r.left[0].reason, /restore-failed/);
    assert.ok(fs.existsSync(markerPath(f, 'b-a')), 'marker kept in archived/');
    assert.ok(!fs.existsSync(activePath), 'no half-restored descriptor');
    assert.deepStrictEqual(retiredFiles(f), []);
    assert.strictEqual(registryCount(f, 'b-a'), 0, 'registry not revived on a failed restore');


    const ok = dw.retireStaleArchivedMarkers(f.home, { env: f.env, now: now + 1000 });
    assert.strictEqual(ok.retired, 1, JSON.stringify(ok));
    assert.ok(fs.existsSync(activePath));
    assert.strictEqual(registryCount(f, 'b-a'), 1);
  } finally { rmFixture(f); }
});

test('left alone: app-archived builder, worktree mismatch (reused id), unknown to the app, fresh marker', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    const old = now - 2 * HOUR;
    const by = 'devswarm-app';
    writeJson(markerPath(f, 'b-arch'), { id: 'b-arch', worktreePath: f.wt.arch, archivedBy: by, archivedAt: old });  // app: isHidden=1, isActive=0
    writeJson(markerPath(f, 'b-b'), { id: 'b-b', worktreePath: '/elsewhere/other-wt', archivedBy: by, archivedAt: old }); // open, other worktree
    writeJson(markerPath(f, 'nope'), { id: 'nope', worktreePath: f.wt.a, archivedBy: by, archivedAt: old });            // no app row
    writeJson(markerPath(f, 'b-a'), { id: 'b-a', worktreePath: f.wt.a, archivedBy: by, archivedAt: now - 60e3 });       // inside grace
    const r = dw.retireStaleArchivedMarkers(f.home, { env: f.env, now });
    assert.strictEqual(r.retired, 0, JSON.stringify(r));
    assert.strictEqual(r.pending, 0);
    for (const id of ['b-arch', 'b-b', 'nope', 'b-a']) assert.ok(fs.existsSync(markerPath(f, id)), id + ' kept');
    assert.deepStrictEqual(retiredFiles(f), []);
  } finally { rmFixture(f); }
});

test('unreadable app DB: nothing retired (no evidence)', { skip }, () => {
  const f = setup();
  try {
    writeJson(markerPath(f, 'b-a'), { id: 'b-a', worktreePath: f.wt.a, archivedAt: Date.now() - 2 * HOUR });
    fs.writeFileSync(f.dbFile, 'not a sqlite database');
    const r = dw.retireStaleArchivedMarkers(f.home, { env: f.env });
    assert.strictEqual(r.appDb, false);
    assert.strictEqual(r.retired, 0);
    assert.ok(fs.existsSync(markerPath(f, 'b-a')));
  } finally { rmFixture(f); }
});

test('seeded bad state: doctor --repair migration retires existing stale markers; idempotent, stamped, no-delete', { skip }, () => {
  const f = setup();
  try {
    writeJson(markerPath(f, 'b-a'), { id: 'b-a', worktreePath: f.wt.a, ownerKey: OWNER, archivedBy: 'devswarm-app', archivedAt: Date.now() - 2 * HOUR });
    writeJson(markerPath(f, 'b-arch'), { id: 'b-arch', worktreePath: f.wt.arch, archivedBy: 'devswarm-app', archivedAt: Date.now() - 2 * HOUR });
    const rows = M.runMigrations({ home: f.home, env: f.env, version: '9.9.9', devswarm: dw });
    const row = rows.find((x) => x.id === 'retire-stale-archived-markers');
    assert.strictEqual(row.status, 'fixed', row.msg);
    assert.strictEqual(M.isApplied(M.readMarkers(f.home), 'retireStaleArchivedMarkers', '9.9.9'), true);
    assert.ok(!fs.existsSync(markerPath(f, 'b-a')));
    assert.ok(fs.existsSync(markerPath(f, 'b-arch')), 'a marker the app agrees with is kept');
    assert.strictEqual(retiredFiles(f).length, 1);
    const again = dw.retireStaleArchivedMarkers(f.home, { env: f.env });
    assert.strictEqual(again.retired, 0);
    assert.strictEqual(again.pending, 0);
  } finally { rmFixture(f); }
});

test('P1-A migration path: post-archive app-sourced marker restored; own-verb marker held; idempotent', { skip }, () => {
  const f = setup();
  try {
    realArchive(f);
    stampAppSourced(f, Date.now() - 2 * HOUR);
    // An own-verb marker for another open builder (b-b): must be held.
    writeJson(markerPath(f, 'b-b'), { id: 'b-b', worktreePath: f.wt.b, ownerKey: storeLib.hashFromWorkspaceId('b-b') });
    const rows = M.runMigrations({ home: f.home, env: f.env, version: '9.9.9', devswarm: dw });
    const row = rows.find((x) => x.id === 'retire-stale-archived-markers');
    assert.strictEqual(row.status, 'fixed', row.msg);
    assert.ok(fs.existsSync(path.join(ds(f), 'workspaces', 'b-a.json')), 'restored to workspaces/');
    assert.strictEqual(registryCount(f, 'b-a'), 1, 'registry revived');
    assert.ok(!fs.existsSync(markerPath(f, 'b-a')));
    assert.ok(fs.existsSync(markerPath(f, 'b-b')), 'own-verb marker held');
    const again = dw.retireStaleArchivedMarkers(f.home, { env: f.env });
    assert.strictEqual(again.retired, 0);
    assert.strictEqual(again.pending, 0);
    assert.strictEqual(retiredFiles(f).length, 1);
  } finally { rmFixture(f); }
});
