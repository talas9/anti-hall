'use strict';
// v0.108.0 — the supervisor's DevSwarm app-DB sync (syncAppState / app-sync) and
// the read-only `app-state` verb, against a fixture app DB in tmpdir.
//   (1) one run: app-archived + deleted-in-app descriptors get archived markers
//       (archivedBy devswarm-app / devswarm-app-deleted); the names cache
//       follows the app's full title; app-state.json is written with the
//       session map, drift and schema report — never bodies or brief text;
//       nothing is ever deleted (file-list snapshot only grows)
//   (2) dry run writes nothing; a second real run marks nothing new
//   (3) message-gap cross-check: matched by timestamp, archived targets and
//       pre-ingest history excluded, in-flight rows skipped, per-branch buckets
//   (4) `app-state --json` is read-only and reports drift/conflicts
//   (5) supervisor appDbSyncIfDue: runs the sync, env kill switch, never throws
//   (6) no app DB -> app-state.json records ok:false, nothing else happens
//   (7) roster: app title, sidebar-rank order, `app` fields; no app DB -> unchanged

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const sup = require(path.join(ROOT, 'companion', 'devswarm-supervisor.js'));
const names = require(path.join(ROOT, 'companion', 'lib', 'devswarm-names.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const { projectDirFor } = require(path.join(ROOT, 'companion', 'lib', 'target-session.js'));
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const DEAD_UUID = '0badc0de-0000-4000-8000-000000000001';
const dsDir = (f) => path.join(f.home, '.anti-hall', 'devswarm');
function writeDesc(f, id, wt) {
  const d = path.join(dsDir(f), 'workspaces');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ id, worktreePath: wt, sessionId: null }));
}
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); }
  })(dir);
  return out.sort();
}
function setup() {
  const f = buildAppDb();
  writeDesc(f, 'b-arch', f.wt.arch);
  writeDesc(f, 'b-a', f.wt.a);
  const goneWt = path.join(f.base, 'wt-gone');
  writeDesc(f, DEAD_UUID, goneWt);
  names.writeName(f.home, 'b-a', 'Alpha task with a long full…', Date.now());
  return f;
}

test('(1)(2) sync: markers (archived + deleted-in-app), names refresh, app-state.json; dry run + idempotent; never deletes', { skip }, () => {
  const f = setup();
  try {
    const before = listFiles(f.home);
    const descBytes = fs.readFileSync(path.join(dsDir(f), 'workspaces', 'b-a.json'), 'utf8');
    const dry = dw.syncAppState(f.home, { env: f.env, dryRun: true });
    assert.strictEqual(dry.ok, true);
    assert.deepStrictEqual(listFiles(f.home), before, 'dry run writes nothing');

    const r = dw.syncAppState(f.home, { env: f.env });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.archived.marked, 2, JSON.stringify(r.archived));
    assert.strictEqual(r.archived.deletedInApp, 1);
    const marker = (id) => JSON.parse(fs.readFileSync(path.join(dsDir(f), 'archived', id + '.json'), 'utf8'));
    assert.strictEqual(marker('b-arch').archivedBy, 'devswarm-app');
    assert.strictEqual(marker(DEAD_UUID).archivedBy, 'devswarm-app-deleted');
    assert.strictEqual(names.readName(f.home, 'b-a'), 'Alpha task with a long full title that is well past sixty characters in length');
    assert.strictEqual(fs.readFileSync(path.join(dsDir(f), 'workspaces', 'b-a.json'), 'utf8'), descBytes, 'descriptor untouched');
    const after = listFiles(f.home);
    for (const p of before) assert.ok(after.includes(p), 'nothing deleted: ' + p);

    const raw = fs.readFileSync(dw.appStatePath(f.home), 'utf8');
    assert.ok(!raw.includes('SECRET'), 'no bodies / brief text in app-state.json');
    const st = JSON.parse(raw);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.appVersion, 'DevSwarm@9.9.9');
    assert.deepStrictEqual(st.missing, []);
    assert.strictEqual(st.sessions['sess-a'].builderId, 'b-a');
    assert.strictEqual(st.sessions['sess-a'].corroborated, false, 'no transcript -> unverified');
    assert.deepStrictEqual(st.unknownToAntiHall.map((u) => u.id), ['b-b'], 'open in the app, no descriptor');
    assert.deepStrictEqual(st.active.filter((a) => a.repositoryId === 'repo-1').map((a) => a.id), ['b-primary', 'b-b', 'b-a'], 'sidebar rank order');
    assert.strictEqual(st.active.find((a) => a.id === 'b-a').finish, 'PR #12 merged, checks failed');
    assert.strictEqual(st.active.find((a) => a.id === 'b-b').brief, 'not-delivered');

    const again = dw.syncAppState(f.home, { env: f.env });
    assert.strictEqual(again.archived.marked, 0, 'second run marks nothing new');

    // transcript corroboration flips the session map entry to verified
    const d = projectDirFor(f.wt.a, f.home);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'sess-a.jsonl'), JSON.stringify({ cwd: f.wt.a }) + '\n');
    dw.syncAppState(f.home, { env: f.env });
    assert.strictEqual(JSON.parse(fs.readFileSync(dw.appStatePath(f.home), 'utf8')).sessions['sess-a'].corroborated, true);
  } finally { rmFixture(f); }
});

test('(1b) a live builder is never tombstoned: a UUID descriptor on an ACTIVE builder worktree stays unmarked', { skip }, () => {
  const f = setup();
  try {
    writeDesc(f, '0badc0de-0000-4000-8000-000000000002', f.wt.b); // unknown id, but b-b is open on that worktree
    const r = dw.syncAppState(f.home, { env: f.env });
    assert.ok(!fs.existsSync(path.join(dsDir(f), 'archived', '0badc0de-0000-4000-8000-000000000002.json')), JSON.stringify(r.archived));
  } finally { rmFixture(f); }
});

test('(3) message gaps: timestamp match, archived targets + pre-ingest excluded, in-flight skipped', { skip }, () => {
  const f = setup();
  try {
    cp.spawnSync('git', ['init', '-q', f.repoPath]);
    const db = new sqlite.DatabaseSync(f.dbFile);
    const iso = (ms) => new Date(ms).toISOString();
    const ins = db.prepare('INSERT INTO workspace_messages (id, repositoryId, fromBranch, toBranch, message, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run('m5', 'repo-1', 'feat/a', 'feat/old', 'SECRET-BODY-m5', 'unread', iso(f.now - 3600e3)); // archived target
    ins.run('m0', 'repo-1', 'feat/a', 'main', 'SECRET-BODY-m0', 'unread', iso(f.now - 5 * 3600e3)); // before ingest began
    db.close();
    const key = repokey.repoKeyForWorktreeFast(f.repoPath);
    assert.ok(key, 'fixture repo resolves a repoKey');
    const sp = storeLib.sqlitePathForHash(f.home, key);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    const s = new sqlite.DatabaseSync(sp);
    s.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, UNIQUE(hash))');
    s.prepare('INSERT INTO messages (workspace_id, ts, hash, body) VALUES (?, ?, ?, ?)').run('w', f.now - 3 * 3600e3, 'native:m1', 'x'); // m1 ingested
    s.close();
    const r = dw.syncAppState(f.home, { env: f.env, gapCooldownMs: 0 });
    const repo = r.state.gaps.repos.find((x) => x.repositoryId === 'repo-1');
    assert.strictEqual(repo.repoKey, key);
    assert.strictEqual(repo.app, 5, 'm4 (in flight) is outside the window');
    assert.strictEqual(repo.matched, 1);
    assert.strictEqual(repo.archivedTarget, 1);
    assert.strictEqual(repo.preIngest, 1);
    assert.strictEqual(repo.gap, 2);
    assert.deepStrictEqual(Object.keys(repo.byBranch).sort(), ['feat/b', 'main']);
    assert.strictEqual(repo.byBranch.main.lt1d, 1);
    assert.strictEqual(r.gapTotal, 2);
    assert.ok(!JSON.stringify(r.state).includes('SECRET'));
  } finally { rmFixture(f); }
});

test('(4) app-state --json: read-only, reports the open-but-archived conflict', { skip }, () => {
  const f = setup();
  try {
    const ad = path.join(dsDir(f), 'archived');
    fs.mkdirSync(ad, { recursive: true });
    fs.writeFileSync(path.join(ad, 'b-a.json'), JSON.stringify({ id: 'b-a', worktreePath: f.wt.a }));
    const before = listFiles(f.home);
    const r = dw.run(['app-state', '--json'], { home: f.home, env: f.env, cwd: f.base });
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(listFiles(f.home), before, 'app-state writes nothing');
    assert.deepStrictEqual(r.result.openButMarkedArchived.map((u) => u.id), ['b-a']);
    // P1 fix: each openButMarkedArchived entry carries repositoryId so a
    // reader (parent-inbox hook, doctor) can scope it to its own repo instead
    // of nagging every repo the app knows about.
    assert.strictEqual(r.result.openButMarkedArchived[0].repositoryId, 'repo-1');
    assert.strictEqual(r.result.wouldMark, 2);
    assert.strictEqual(r.result.text, undefined, '--json carries no text rendering');
    const h = dw.run(['app-state'], { home: f.home, env: f.env, cwd: f.base });
    assert.ok(/open in the app but archived in anti-hall/.test(h.result.text), h.result.text);
  } finally { rmFixture(f); }
});

test('(5) supervisor appDbSyncIfDue: runs the sync, env kill switch, never throws', { skip }, () => {
  const f = setup();
  try {
    const r = sup.appDbSyncIfDue({ home: f.home, env: f.env });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.appDb, true);
    assert.strictEqual(r.archived.marked, 2);
    assert.ok(Number.isFinite(r.elapsedMs));
    assert.deepStrictEqual(sup.appDbSyncIfDue({ home: f.home, env: Object.assign({ ANTIHALL_DEVSWARM_APP_SYNC: '0' }, f.env) }), { ran: false, reason: 'app-sync-disabled' });
    assert.deepStrictEqual(sup.appDbSyncIfDue({ home: f.home, env: Object.assign({ ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }, f.env) }), { ran: false, reason: 'disabled' });
    const boom = sup.appDbSyncIfDue({ home: f.home, env: f.env, deps: { devswarm: { syncAppState: () => { throw new Error('x'); } } } });
    assert.strictEqual(boom.ran, false);
    assert.strictEqual(boom.error, 'x');
  } finally { rmFixture(f); }
});

test('(6) no app DB -> app-state.json ok:false, no markers', { skip }, () => {
  const f = setup();
  try {
    const r = dw.syncAppState(f.home, { env: { ANTIHALL_DEVSWARM_APP_DB: 'off' } });
    assert.strictEqual(r.appDb, false);
    assert.strictEqual(JSON.parse(fs.readFileSync(dw.appStatePath(f.home), 'utf8')).ok, false);
    assert.ok(!fs.existsSync(path.join(dsDir(f), 'archived')), 'no markers without evidence');
  } finally { rmFixture(f); }
});

test('(7) roster: app title, sidebar-rank order, app fields; no app DB -> unchanged', { skip }, () => {
  const f = setup();
  try {
    cp.spawnSync('git', ['init', '-q', f.repoPath]);
    cp.spawnSync('git', ['-C', f.repoPath, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const key = repokey.repoKeyForWorktree(f.repoPath);
    const s = storeLib.openStore({ home: f.home, hash: key });
    try {
      s.upsertRegistry({ id: 'b-a', worktreePath: f.wt.a, sessionId: null });
      s.upsertRegistry({ id: 'b-b', worktreePath: f.wt.b, sessionId: null });
    } finally { s.close(); }
    const ids = (r) => r.result.workspaces.filter((w) => w.id === 'b-a' || w.id === 'b-b').map((w) => w.id);
    const r = dw.run(['roster'], { home: f.home, env: f.env, cwd: f.repoPath });
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.deepStrictEqual(ids(r), ['b-b', 'b-a'], 'sidebar rank 1 before 2');
    const a = r.result.workspaces.find((w) => w.id === 'b-a');
    assert.strictEqual(a.wsName, 'Alpha task with a long full title that is well past sixty characters in length');
    assert.deepStrictEqual(a.app, { rank: 2, pinned: true, focused: false, finish: 'PR #12 merged, checks failed', brief: null, builderType: 'standard' });
    assert.strictEqual(r.result.workspaces.find((w) => w.id === 'b-b').app.brief, 'not-delivered');
    const off = dw.run(['roster'], { home: f.home, env: { ANTIHALL_DEVSWARM_APP_DB: 'off' }, cwd: f.repoPath });
    assert.ok(off.result.workspaces.every((w) => w.app === undefined), 'no app DB -> no app fields');
  } finally { rmFixture(f); }
});

// 0.108.4: setting devswarm.appSync=false in settings.json (resolved against
// the home the supervisor's env implies) skips the sync like the env switch.
test('(5b) supervisor appDbSyncIfDue: devswarm.appSync=false in settings.json skips the sync', { skip }, () => {
  const { writeSettings } = require('../helpers/settings-switch.js');
  const f = setup();
  try {
    const env = Object.assign({}, f.env, { HOME: f.home, USERPROFILE: f.home });
    writeSettings(f.home, { devswarm: { appSync: false } });
    assert.deepStrictEqual(sup.appDbSyncIfDue({ home: f.home, env }), { ran: false, reason: 'app-sync-disabled' });
  } finally { rmFixture(f); }
});
