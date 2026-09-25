'use strict';
// v0.108.3 — "retire marker, trust app": an anti-hall archived/<id>.json marker
// whose workspace the READABLE DevSwarm app DB shows open (isActive=1,
// isHidden=0) is retired — renamed into archived-retired/ with a `retired`
// record, never deleted — by the supervisor's app-DB sync (syncAppState) and by
// the 'retire-stale-archived-markers' migration (doctor --repair). Fixture app
// DB in tmpdir, isolated HOME; the real DB/store is never touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const M = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
const { isArchivedWorkspace } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-archived.js'));
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const HOUR = 3600e3;
const ds = (f) => path.join(f.home, '.anti-hall', 'devswarm');
const markerPath = (f, id) => path.join(ds(f), 'archived', id + '.json');
const retiredDir = (f) => path.join(ds(f), 'archived-retired');
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
function setup() {
  const f = buildAppDb();
  f.env = Object.assign({ HOME: f.home }, f.env);
  writeJson(path.join(ds(f), 'workspaces', 'b-a.json'), { id: 'b-a', worktreePath: f.wt.a, sessionId: null });
  return f;
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

test('hardlinked marker (local archive shape): retired; the active descriptor bytes never change', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    const active = path.join(ds(f), 'workspaces', 'b-a.json');
    fs.mkdirSync(path.join(ds(f), 'archived'), { recursive: true });
    fs.linkSync(active, markerPath(f, 'b-a'));
    const bytes = fs.readFileSync(active, 'utf8');
    // ctime of a fresh link is "now": inside the grace window, so nothing yet.
    assert.strictEqual(dw.retireStaleArchivedMarkers(f.home, { env: f.env, now }).retired, 0, 'grace protects a just-run archive');
    const r = dw.retireStaleArchivedMarkers(f.home, { env: f.env, now: now + HOUR });
    assert.strictEqual(r.retired, 1, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(active, 'utf8'), bytes, 'active descriptor unchanged');
    const rec = JSON.parse(fs.readFileSync(path.join(retiredDir(f), retiredFiles(f)[0]), 'utf8'));
    assert.strictEqual(rec.retired.by, 'devswarm-app-sync');
  } finally { rmFixture(f); }
});

test('left alone: app-archived builder, worktree mismatch (reused id), unknown to the app, fresh marker', { skip }, () => {
  const f = setup();
  try {
    const now = Date.now();
    const old = now - 2 * HOUR;
    writeJson(markerPath(f, 'b-arch'), { id: 'b-arch', worktreePath: f.wt.arch, archivedAt: old });  // app: isHidden=1, isActive=0
    writeJson(markerPath(f, 'b-b'), { id: 'b-b', worktreePath: '/elsewhere/other-wt', archivedAt: old }); // open, other worktree
    writeJson(markerPath(f, 'nope'), { id: 'nope', worktreePath: f.wt.a, archivedAt: old });            // no app row
    writeJson(markerPath(f, 'b-a'), { id: 'b-a', worktreePath: f.wt.a, archivedAt: now - 60e3 });       // inside grace
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
    writeJson(markerPath(f, 'b-a'), { id: 'b-a', worktreePath: f.wt.a, archivedAt: Date.now() - 2 * HOUR });
    writeJson(markerPath(f, 'b-arch'), { id: 'b-arch', worktreePath: f.wt.arch, archivedAt: Date.now() - 2 * HOUR });
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
