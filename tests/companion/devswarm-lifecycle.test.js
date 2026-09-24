'use strict';
// v0.108.0 — companion/lib/devswarm-lifecycle.js
//   auto-archive: every precondition (a..g) false -> no archive; dry-run writes
//   nothing and spawns no archive; 2.5.2 -> dormant; mode on + 2.5.3 fake ->
//   archive spawned (rate-limited), logged, Primary told with an undo hint.
//   prune: dry run stores a nonce plan; deletion refuses without a valid,
//   fresh, exact plan, refuses an automated caller, re-verifies each row, logs,
//   tombstones. The hivecontrol binary is ALWAYS a PATH-injected fake.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const L = require(path.join(ROOT, 'companion', 'lib', 'devswarm-lifecycle.js'));
const caps = require(path.join(ROOT, 'companion', 'lib', 'devswarm-capabilities.js'));
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const { fakeHivecontrol, readCalls } = require('../helpers/fake-hivecontrol.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const FIX = path.join(__dirname, '..', 'fixtures', 'devswarm-capabilities');
const V252 = { version: '2.5.2', workspaceHelp: path.join(FIX, 'hivecontrol-2.5.2-workspace-help.txt') };
const V253 = {
  version: '2.5.3', workspaceHelp: path.join(FIX, 'hivecontrol-2.5.3-workspace-help.UNVERIFIED.txt'),
  verbHelp: {
    archive: path.join(FIX, 'hivecontrol-2.5.3-archive-help.UNVERIFIED.txt'),
    delete: path.join(FIX, 'hivecontrol-2.5.3-delete-help.UNVERIFIED.txt'),
  },
};
const MIN = 60000;
const NOW = Date.parse('2026-09-24T12:00:00Z');

function listTree(dir) {
  const out = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); }
  })(dir);
  return out.sort();
}

// fixture: app DB with a Primary + children; per-child fact overrides.
function fixture(fake, children, opts) {
  const o = opts || {};
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lifecycle-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const bin = fakeHivecontrol(path.join(base, 'bin'), fake);
  const dbFile = path.join(base, 'devswarm.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, sourceBranch TEXT, worktreePath TEXT,'
    + ' builderType TEXT, isActive INTEGER, isHidden INTEGER, lastSelectedAt TEXT, label TEXT, pullRequestId TEXT)');
  db.exec('CREATE TABLE pull_requests (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, state TEXT, targetBranch TEXT)');
  const ins = db.prepare('INSERT INTO builders VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const primaryWt = path.join(base, 'primary'); fs.mkdirSync(primaryWt);
  ins.run('p-1', 'r1', 'main', null, primaryWt, 'primary', 1, 0, null, 'Primary', null);
  const facts = {};
  for (const c of children) {
    const wt = path.join(base, 'wt-' + c.id); fs.mkdirSync(wt);
    ins.run(c.id, 'r1', 'feat/' + c.id, 'main', wt, c.builderType || 'standard', c.archived ? 0 : 1, c.archived ? 1 : 0,
      c.lastSelectedAt === undefined ? null : c.lastSelectedAt, 'Task ' + c.id, null);
    if (c.pr) db.prepare('INSERT INTO pull_requests VALUES (?,?,?,?,?)').run('pr-' + c.id, 'r1', 'feat/' + c.id, c.pr, 'main');
    facts[wt] = Object.assign({ id: c.id, ancestor: true, porcelain: '', done: true, unread: 0, unreadFrom: 0, activity: NOW - 60 * MIN }, c);
  }
  db.close();
  const env = { HOME: home, PATH: bin.dir, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  const byId = {};
  for (const wt of Object.keys(facts)) { facts[wt].wt = wt; byId[facts[wt].id] = facts[wt]; } // shared objects: a test may mutate a fact later
  const notified = [];
  const deps = {
    descriptors: () => Object.values(byId).map((f) => ({ id: f.id, worktreePath: f.wt, sessionId: 's-' + f.id })),
    repoKey: () => 'proj-abc123',
    summary: () => ({ workspaces: Object.fromEntries(Object.values(byId).map((f) => [f.id, { id: f.id, archive_ready: f.done, unread: f.unread, broadcastUnread: 0, cursor: 0 }])) }),
    unreadFrom: (h, k, ids) => ids.reduce((n, id) => n + ((byId[id] && byId[id].unreadFrom) || 0), 0),
    activityTs: (d) => byId[d.id].activity,
    git: (cwd, args) => {
      const f = facts[cwd];
      if (!f) return { ok: false, status: 128, out: '' };
      if (args[0] === 'status') return f.porcelain === null ? { ok: false, status: 128, out: '' } : { ok: true, status: 0, out: f.porcelain };
      if (args[0] === 'rev-parse') return { ok: true, status: 0, out: 'abc\n' };
      if (args[0] === 'merge-base') return { ok: f.ancestor, status: f.ancestor ? 0 : 1, out: '' };
      return { ok: false, status: 1, out: '' };
    },
    notifyPrimary: (home2, cand, text) => { notified.push({ id: cand.id, text }); return 'ok'; },
  };
  if (o.noAppDb) env.ANTIHALL_DEVSWARM_APP_DB = 'off';
  caps.resetCache();
  return { base, home, env, bin, deps, notified, byId };
}

function opts(fx, extra) {
  return Object.assign({ home: fx.home, env: fx.env, now: NOW, deps: fx.deps }, extra || {});
}
const ON = { mode: 'on', idleMin: 30, maxPerSweep: 3 };
const DRY = { mode: 'dry-run', idleMin: 30, maxPerSweep: 3 };

test('baseline: a proven-done child is eligible; Primary never is', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(plan.toArchive, ['c1']);
  assert.strictEqual(plan.candidates.find((c) => c.id === 'c1').eligible, true);
  assert.strictEqual(plan.candidates.some((c) => c.id === 'p-1'), false, 'Primary has no descriptor here');
});

const PRECONDITIONS = [
  ['a done gate unset', { done: false }, 'a-done'],
  ['b not merged (git) and no PR', { ancestor: false }, 'b-merged'],
  ['b not merged: PR closed', { ancestor: false, pr: 'closed' }, 'b-merged'],
  ['c uncommitted changes', { porcelain: ' M src/x.js\n' }, 'c-clean'],
  ['c git status unreadable', { porcelain: null }, 'c-clean'],
  ['d unread to the child', { unread: 2 }, 'd-unread'],
  ['d unread from the child', { unreadFrom: 1 }, 'd-unread'],
  ['e builderType primary', { builderType: 'primary' }, 'e-primary'],
  ['f viewed 3 min ago', { lastSelectedAt: new Date(NOW - 3 * MIN).toISOString() }, 'f-viewed'],
  ['g active 5 min ago', { activity: NOW - 5 * MIN }, 'g-idle'],
  ['g no activity signal', { activity: null }, 'g-idle'],
];
for (const [name, over, gate] of PRECONDITIONS) {
  test('precondition false -> no archive: ' + name, { skip }, () => {
    const fx = fixture(V253, [Object.assign({ id: 'c1' }, over)]);
    const r = L.autoArchiveSweep(opts(fx, { settings: ON }));
    assert.deepStrictEqual(r.archived, []);
    assert.deepStrictEqual(r.wouldArchive, []);
    const plan = L.planAutoArchive(opts(fx, { settings: ON }));
    assert.ok(plan.candidates[0].blockers.some((b) => b.gate === gate), JSON.stringify(plan.candidates[0].blockers));
    assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help'));
  });
}

test('merged via PR state=merged when git ancestry says no (squash merge)', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', ancestor: false, pr: 'merged' }]);
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(plan.toArchive, ['c1']);
  assert.strictEqual(plan.candidates[0].facts.merged.via, 'pr');
});

test('dry-run writes NOTHING and spawns no archive (even with 2.5.3 available)', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }]);
  L.planAutoArchive(opts(fx, { settings: DRY })); // warm the capability probe cache
  const before = listTree(fx.home);
  const r = L.autoArchiveSweep(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(r.wouldArchive, ['c1']);
  assert.deepStrictEqual(r.archived, []);
  assert.deepStrictEqual(listTree(fx.home), before);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help'));
  assert.deepStrictEqual(fx.notified, []);
});

test('mode on + DevSwarm 2.5.2: dormant, reports, archives nothing', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: ON }));
  assert.match(r.dormant, /requires DevSwarm >= 2\.5\.3/);
  assert.deepStrictEqual(r.wouldArchive, ['c1']);
  assert.deepStrictEqual(r.archived, []);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive'));
});

test('mode on + 2.5.3 fake: archives (rate-limited), logs, tells the Primary with an undo hint', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }, { id: 'c2' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: Object.assign({}, ON, { maxPerSweep: 1 }) }));
  assert.strictEqual(r.archived.length, 1);
  const calls = readCalls(fx.bin.callsFile).filter((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].argv, ['workspace', 'archive', r.archived[0]]);
  const log = fs.readFileSync(path.join(fx.home, '.anti-hall', 'logs', 'devswarm-auto-archive.ndjson'), 'utf8').trim().split('\n');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(JSON.parse(log[0]).ok, true);
  assert.strictEqual(fx.notified.length, 1);
  assert.match(fx.notified[0].text, /auto-archived .*undo: unarchive/);
  // nag replacement: the sweep owns both done rows; only in mode "on".
  fs.writeFileSync(path.join(fx.home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'on' } } }));
  assert.strictEqual(L.autoArchiveOwns(fx.home, 'c2', { now: NOW, env: fx.env }), true);
  fs.writeFileSync(path.join(fx.home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'dry-run' } } }));
  assert.strictEqual(L.autoArchiveOwns(fx.home, 'c2', { now: NOW, env: fx.env }), false);
});

test('mode off: nothing planned, nothing spawned', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: { mode: 'off', idleMin: 30, maxPerSweep: 3 } }));
  assert.deepStrictEqual(r, { mode: 'off', archived: [] });
  assert.deepStrictEqual(readCalls(fx.bin.callsFile), []);
});

test('settings: default ON; dry-run/off selectable; junk falls back to on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lc-set-'));
  assert.deepStrictEqual(L.readSettings(home), { mode: 'on', idleMin: 30, maxPerSweep: 3 });
  fs.mkdirSync(path.join(home, '.anti-hall'));
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'on', idleMin: 45, maxPerSweep: 99 } } }));
  assert.deepStrictEqual(L.readSettings(home), { mode: 'on', idleMin: 45, maxPerSweep: 20 });
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'yes', idleMin: 1 } } }));
  // v0.108.0 unified settings: out-of-range numbers CLAMP to the schema bound
  // (idleMin min 5), junk enums fall back to the default.
  assert.deepStrictEqual(L.readSettings(home), { mode: 'on', idleMin: 5, maxPerSweep: 3 });
  // the flat form `settings.js set` writes is read too
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { 'autoArchive.mode': 'dry-run', 'autoArchive.idleMin': 60 } }));
  assert.deepStrictEqual(L.readSettings(home), { mode: 'dry-run', idleMin: 60, maxPerSweep: 3 });
  // env beats the file
  assert.strictEqual(L.readSettings(home, null, { ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE: 'off' }).mode, 'off');
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'dry-run' } } }));
  assert.strictEqual(L.readSettings(home).mode, 'dry-run');
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'off' } } }));
  assert.strictEqual(L.readSettings(home).mode, 'off');
});

// ---------------- prune ----------------
const DAY = 86400000;
function pruneFixture(fake, children) {
  const fx = fixture(fake, children.map((c) => Object.assign({ archived: true }, c)));
  const dir = path.join(fx.home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  for (const c of children) fs.writeFileSync(path.join(dir, c.id + '.json'), '{}');
  return fx;
}
const LATER = Date.now() + 40 * DAY; // markers were written "now"; plan 40 days later

test('prune dry run: evidence per row, nonce plan stored, nothing deleted', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }, { id: 'a2', porcelain: '?? tmp\n' }]);
  const r = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  assert.strictEqual(r.ok, true);
  assert.match(r.nonce, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(r.eligibleIds, ['a1']);
  const a1 = r.rows.find((x) => x.id === 'a1');
  for (const k of ['archivedSince', 'ageDays', 'merged', 'uncommitted', 'unread', 'worktreeBytes']) assert.ok(k in a1, k);
  assert.ok(a1.ageDays >= 39);
  assert.deepStrictEqual(r.rows.find((x) => x.id === 'a2').blockers, ['uncommitted-changes']);
  assert.ok(fs.existsSync(path.join(fx.home, '.anti-hall', 'devswarm', 'prune-plans', r.nonce + '.json')));
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help'));
  const young = L.planPrune(opts(fx, { now: Date.now(), olderThanDays: 30 }));
  assert.deepStrictEqual(young.eligibleIds, []);
});

test('prune refuses without a valid plan nonce / exact ids / fresh plan', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }, { id: 'a3' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  const ex = (x) => L.executePrune(opts(fx, Object.assign({ now: LATER }, x)));
  assert.match(ex({ ids: ['a1', 'a3'] }).error, /requires --plan/);
  assert.match(ex({ ids: ['a1', 'a3'], nonce: '0000000000000000' }).error, /unknown plan/);
  assert.match(ex({ ids: ['a1'], nonce: plan.nonce }).error, /exactly match/);
  assert.match(ex({ ids: ['a1', 'a3', 'x'], nonce: plan.nonce }).error, /exactly match/);
  assert.match(L.executePrune(opts(fx, { now: LATER + 16 * MIN, ids: ['a1', 'a3'], nonce: plan.nonce })).error, /expired/);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help'));
});

test('supervisor/automated caller can never delete (lib throws; CLI refuses)', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  const env = Object.assign({}, fx.env, { ANTIHALL_CALLER: 'supervisor' });
  assert.throws(() => L.executePrune(opts(fx, { env, now: LATER, ids: ['a1'], nonce: plan.nonce })), /refused: caller "supervisor"/);
  const r = dw.run(['prune-archived', '--confirm-ids', 'a1', '--plan', plan.nonce], { home: fx.home, env });
  assert.strictEqual(r.code, 2);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help'));
});

test('prune on DevSwarm 2.5.2: plan is dormant, deletion refused', { skip }, () => {
  const fx = pruneFixture(V252, [{ id: 'a1' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  assert.match(plan.dormant, /requires DevSwarm >= 2\.5\.3/);
  const r = L.executePrune(opts(fx, { now: LATER, ids: ['a1'], nonce: plan.nonce }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.dormant, true);
});

test('approved prune: re-verifies, deletes via hivecontrol, logs, tombstones, plan single-use', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }, { id: 'a3' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  assert.deepStrictEqual(plan.eligibleIds, ['a1', 'a3']);
  fx.byId.a3.porcelain = ' M dirty\n'; // became dirty after the dry run
  const archivedDesc = [];
  const r = L.executePrune(opts(fx, { now: LATER, ids: ['a3', 'a1'], nonce: plan.nonce, archiveDescriptor: (id) => { archivedDesc.push(id); return { ok: true }; } }));
  assert.strictEqual(r.ok, false, 'one row refused');
  assert.deepStrictEqual(r.results.find((x) => x.id === 'a3'), { id: 'a3', ok: false, refused: 'uncommitted-changes' });
  assert.strictEqual(r.results.find((x) => x.id === 'a1').ok, true);
  const dels = readCalls(fx.bin.callsFile).filter((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help');
  assert.deepStrictEqual(dels.map((c) => c.argv), [['workspace', 'delete', 'a1', '--yes']]);
  const log = fs.readFileSync(path.join(fx.home, '.anti-hall', 'logs', 'devswarm-prune.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(log.map((x) => [x.id, x.ok]), [['a1', true], ['a3', false]]);
  assert.ok(fs.existsSync(path.join(fx.home, '.anti-hall', 'devswarm', 'pruned', 'a1.json')));
  assert.match(L.executePrune(opts(fx, { now: LATER, ids: ['a1', 'a3'], nonce: plan.nonce })).error, /already used/);
});

test('notifyPrimary lands ONE line in the Primary partition through the partition door (real store)', { skip }, () => {
  const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
  const identity = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lc-notify-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  const g = require('node:child_process').spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0, g.stderr);
  const idc = identity.resolveContext(repo);
  const env = { HOME: home };
  const s = store.openStore({ home, hash: idc.repoKey, env });
  s.upsertRegistry({ id: idc.primaryMeshId, worktreePath: repo, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
  s.close();
  const cand = { id: 'c1', worktreePath: repo, repoKey: idc.repoKey };
  assert.strictEqual(L.notifyPrimary(home, cand, 'auto-archived "x" (c1). ' + L.UNDO_HINT + '.', { env }), 'ok');
  assert.strictEqual(L.notifyPrimary(home, cand, 'auto-archived "x" (c1). again', { env }), 'ok'); // same hash: deduped
  const s2 = store.openStore({ home, hash: idc.repoKey, env, readOnly: true });
  const rows = s2.listMessages(idc.primaryMeshId);
  s2.close();
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0].body, /undo: unarchive/);
});

test('DEFAULT (no settings file) + 2.5.3 fake: archives and reports with an undo hint', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx)); // no `settings` override -> reads the (absent) file -> default
  assert.strictEqual(r.mode, 'on');
  assert.deepStrictEqual(r.archived, ['c1']);
  assert.strictEqual(fx.notified.length, 1);
  assert.match(fx.notified[0].text, /undo: unarchive/);
});

test('DEFAULT (no settings file) + 2.5.2: dormant, nothing archived', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx));
  assert.strictEqual(r.mode, 'on');
  assert.match(r.dormant, /requires DevSwarm >= 2\.5\.3/);
  assert.deepStrictEqual(r.archived, []);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive'));
});
