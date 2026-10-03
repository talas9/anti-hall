'use strict';
// L30 field report: `devswarm.js archive <uuid>` printed appArchive.ok:true while the
// DevSwarm app still listed the workspace live. Root cause: attemptAppArchive judged success
// from hivecontrol's EXIT CODE alone (an exit-0 no-op / unparsed body counted as archived) and
// nothing re-read the app. Now: the app DB (else the archive response's archived:true) must
// confirm (`workspace list all` keeps archived rows, so it is NOT a signal); otherwise ok:false, verified:false, partial:true + the exact manual command.
// Also: `archive <branch|meshId>` for an already-archived/app-live workspace archives the app
// side only; roster/app-state/doctor/--repair surface and repair the mismatch.
// Every hivecontrol call goes through a FAKE binary on PATH; HOME is a tmp dir.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const capsLib = require('../../plugins/anti-hall/companion/lib/devswarm-capabilities.js');
const inbox = require('../../plugins/anti-hall/hooks/devswarm-parent-inbox.js');
const { fakeHivecontrol, readCalls } = require('../helpers/fake-hivecontrol.js');

const BACKEND = 'journal';
const FIX = path.join(__dirname, '..', 'fixtures', 'devswarm-capabilities');
const HELP_253 = path.join(FIX, 'hivecontrol-2.5.3-workspace-help.txt');
const ARCHIVE_253 = path.join(FIX, 'hivecontrol-2.5.3-archive-help.txt');
const ID_A = 'f9156882-caf7-4b8e-840f-badc1c105431';
const BRANCH = 'qa/ui-field-audit';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-apparchver-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-apparchver-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function writeDesc(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}
function seedReg(home, bucket, desc) {
  const s = storeLib.openStore({ home, hash: bucket, backend: BACKEND });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function seedOne(home, W, id) {
  const repoKey = repokey.repoKeyForWorktree(W);
  const top = inst.resolveWorktree(W);
  const desc = { id, worktreePath: top, sessionId: 'sess-' + id, ownerKey: repoKey, repoKey };
  seedReg(home, repoKey, desc); writeDesc(home, id, desc);
  return { repoKey, top };
}
function writeAppDb(home, rows, repoPath) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(home, 'fixture-devswarm-app.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, isActive INTEGER, isHidden INTEGER, builderType TEXT, worktreePath TEXT, label TEXT, branchName TEXT, repositoryId TEXT)');
  db.exec('CREATE TABLE repositories (id TEXT PRIMARY KEY, path TEXT, name TEXT, defaultBaseBranch TEXT)');
  db.prepare('INSERT INTO repositories (id, path, name, defaultBaseBranch) VALUES (?, ?, ?, ?)').run('repo-1', repoPath || home, 'repo', 'main');
  const st = db.prepare('INSERT INTO builders (id, isActive, isHidden, builderType, worktreePath, label, branchName, repositoryId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) st.run(r.id, r.isActive === undefined ? 1 : r.isActive, r.isHidden || 0, 'standard', r.worktreePath || null, r.label || null, r.branchName || null, 'repo-1');
  db.close();
  return dbPath;
}
function dbRow(dbPath, id) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Object.assign({}, db.prepare('SELECT isActive, isHidden FROM builders WHERE id = ?').get(id)); } finally { db.close(); }
}
const archiveCalls = (fake) => readCalls(fake.callsFile).filter((c) => c.argv[0] === 'workspace' && c.argv[1] === 'archive' && c.argv[2] !== '--help');
function setup(tag, hcOpts) {
  const home = tmpHome();
  const W = makeGitRepo(tag);
  const { repoKey, top } = seedOne(home, W, ID_A);
  const dbPath = writeAppDb(home, [{ id: ID_A, worktreePath: top, label: 'UI field audit', branchName: BRANCH }], top);
  const fake = fakeHivecontrol(path.join(home, 'bin'), Object.assign({ version: '2.5.3', workspaceHelp: HELP_253, verbHelp: { archive: ARCHIVE_253 } }, hcOpts || {}, hcOpts && hcOpts.effectDb === true ? { effectDb: dbPath } : {}));
  capsLib.resetCache();
  const ctx = { home, cwd: W, env: { HOME: home, PATH: fake.dir, ANTIHALL_DEVSWARM_APP_DB: dbPath }, backend: BACKEND };
  return { home, W, repoKey, top, dbPath, fake, ctx };
}

test('FIELD SHAPE: hivecontrol exits 0 but is a NO-OP on the id -> NOT reported ok; branch retried; partial + exact manual command; exit 2', () => {
  const t = setup('noop');
  try {
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.descriptorArchived, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.attempted, true);
    assert.strictEqual(r.result.appArchive.ok, false, 'exit 0 without an app-side effect must not read as success: ' + JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.verified, false);
    assert.strictEqual(r.result.appArchive.manualCommand, 'hivecontrol workspace archive ' + BRANCH);
    assert.strictEqual(r.result.partial, true);
    assert.match(r.result.manualStep, /hivecontrol workspace archive qa\/ui-field-audit/);
    assert.match(r.result.manualStep, /NOT verified/);
    assert.strictEqual(r.code, 2);
    assert.deepStrictEqual(archiveCalls(t.fake).map((c) => c.argv[2]), [ID_A, BRANCH], 'id first, then the branch name hivecontrol also accepts');
  } finally { rm(t.W); rm(t.home); }
});

test('exit 0 on the id is a no-op but the BRANCH call really archives -> verified ok via:branch', () => {
  const t = setup('branchonly', { effectDb: true, effectBranchOnly: true });
  try {
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.verified, true);
    assert.strictEqual(r.result.appArchive.via, 'branch');
    assert.ok(!r.result.partial);
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(dbRow(t.dbPath, ID_A), { isActive: 0, isHidden: 1 });
  } finally { rm(t.W); rm(t.home); }
});

test('an exit-0 ERROR BODY (archived:false) is a failure, not success', () => {
  const t = setup('body', { effectDb: true, archiveBody: JSON.stringify({ workspaceId: ID_A, archived: false, error: 'no such workspace' }) });
  try {
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, false, JSON.stringify(r.result));
    assert.match(r.result.appArchive.error, /archived:false/);
    assert.strictEqual(r.result.partial, true);
  } finally { rm(t.W); rm(t.home); }
});

test('real success: DB flips to archived and the real body is accepted -> ok:true, verified:true, via:id, no partial', () => {
  const t = setup('real', { effectDb: true, archiveBody: JSON.stringify({ workspaceId: ID_A, archived: true, alreadyArchived: false }) });
  try {
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.verified, true);
    assert.strictEqual(r.result.appArchive.via, 'id');
    assert.ok(!r.result.partial);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(archiveCalls(t.fake).length, 1);
  } finally { rm(t.W); rm(t.home); }
});

test('`workspace list all` keeps archived rows (live-measured): DB archived + still listed -> VERIFIED ok', () => {
  const t = setup('listlive', { effectDb: true, archiveBody: JSON.stringify({ archived: true, alreadyArchived: false }), listAll: [{ id: ID_A, branch: BRANCH, repositoryId: 'r1', worktreePath: '/x', label: 'l' }] });
  try {
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.verified, true);
  } finally { rm(t.W); rm(t.home); }
});

test('app DB is preferred over the response: archived:true body but the DB row still open -> NOT verified', () => {
  const t = setup('bodyonly', { archiveBody: JSON.stringify({ archived: true, alreadyArchived: false }) });
  try {
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, false, JSON.stringify(r.result));
    assert.match(r.result.appArchive.error, /app DB still lists/);
  } finally { rm(t.W); rm(t.home); }
});

test('(b) descriptor ALREADY archived, app live: `archive <branch>` archives the app side only, idempotent on repeat', () => {
  const t = setup('apponly', { effectDb: true });
  try {
    const first = cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    assert.strictEqual(archiveCalls(t.fake).length, 0, 'local-only archive spawned nothing');
    const r = cli.run(['archive', BRANCH], t.ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appOnly, true);
    assert.strictEqual(r.result.id, ID_A);
    assert.strictEqual(r.result.appArchive.ok, true);
    assert.strictEqual(r.result.appArchive.verified, true);
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(archiveCalls(t.fake).map((c) => c.argv[2]), [ID_A]);
    assert.deepStrictEqual(dbRow(t.dbPath, ID_A), { isActive: 0, isHidden: 1 });
    // repeat: nothing left to do, nothing spawned, still ok.
    const again = cli.run(['archive', BRANCH], t.ctx);
    assert.strictEqual(again.result.ok, true, JSON.stringify(again.result));
    assert.strictEqual(again.result.alreadyArchived, true);
    assert.strictEqual(archiveCalls(t.fake).length, 1);
  } finally { rm(t.W); rm(t.home); }
});

test('CLOSED builder (isActive=0, isHidden=0) + descriptor already archived: `archive <branch>` archives the app side, verified (no stale row left)', () => {
  const t = setup('closedapponly', { effectDb: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(t.dbPath); db.prepare('UPDATE builders SET isActive = 0, isHidden = 0 WHERE id = ?').run(ID_A); db.close();
    assert.strictEqual(cli.cmdArchive(ID_A, t.ctx, { appArchive: false }).ok, true);
    const r = cli.run(['archive', BRANCH], t.ctx);
    assert.strictEqual(r.result.appOnly, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.verified, true, JSON.stringify(r.result));
    assert.deepStrictEqual(archiveCalls(t.fake).map((c) => c.argv[2]), [ID_A]);
    assert.deepStrictEqual(dbRow(t.dbPath, ID_A), { isActive: 0, isHidden: 1 });
  } finally { rm(t.W); rm(t.home); }
});

test('CLOSED builders: an AMBIGUOUS prefix matching two closed workspaces archives nothing', () => {
  const t = setup('closedambig', { effectDb: true });
  try {
    const ID_B = ID_A.slice(0, 8) + '-2222-4000-8000-abcdef999999';
    seedOne(t.home, t.W, ID_B);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(t.dbPath);
    db.prepare('UPDATE builders SET isActive = 0 WHERE id = ?').run(ID_A);
    db.prepare("INSERT INTO builders (id, isActive, isHidden, builderType, worktreePath, label, branchName, repositoryId) VALUES (?, 0, 0, 'standard', ?, 'b', 'qa/other', 'repo-1')").run(ID_B, t.top);
    db.close();
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false }); cli.cmdArchive(ID_B, t.ctx, { appArchive: false });
    const r = cli.run(['archive', ID_A.slice(0, 8)], t.ctx);
    assert.strictEqual(r.result.ok, false, JSON.stringify(r.result));
    assert.match(r.result.error, /ambiguous/);
    assert.strictEqual(archiveCalls(t.fake).length, 0);
  } finally { rm(t.W); rm(t.home); }
});

const ID_Y = 'a1b2c3d4-9999-4000-8000-abcdef000001';
function addBuilder(t, row) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(t.dbPath);
  db.prepare("INSERT INTO builders (id, isActive, isHidden, builderType, worktreePath, label, branchName, repositoryId) VALUES (?, ?, 0, 'standard', ?, 'y', ?, 'repo-1')").run(row.id, row.isActive, row.worktreePath || null, row.branchName || null);
  db.close();
}
function setBuilder(t, id, sql) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(t.dbPath); db.prepare('UPDATE builders SET ' + sql + ' WHERE id = ?').run(id); db.close();
}

test('P1: closed X + OPEN Y sharing the branch, id call is a no-op -> hivecontrol NEVER receives the branch; Y stays open; manualStep kept with the ID command', () => {
  const t = setup('sharedbranch', { effectDb: true, effectBranchOnly: true });
  try {
    setBuilder(t, ID_A, 'isActive = 0');
    addBuilder(t, { id: ID_Y, isActive: 1, branchName: BRANCH });
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, false, JSON.stringify(r.result));
    assert.match(r.result.appArchive.error, /branch name is shared by 2 builders/);
    assert.deepStrictEqual(archiveCalls(t.fake).map((c) => c.argv[2]), [ID_A], 'no call may carry the branch name');
    assert.deepStrictEqual(dbRow(t.dbPath, ID_Y), { isActive: 1, isHidden: 0 });
    assert.strictEqual(r.result.appArchive.manualCommand, 'hivecontrol workspace archive ' + ID_A);
    assert.match(r.result.manualStep, /NOT verified/);
  } finally { rm(t.W); rm(t.home); }
});

test('P1: closed X with a UNIQUE branch, id call a no-op -> branch fallback runs and verifies', () => {
  const t = setup('uniquebranch', { effectDb: true, effectBranchOnly: true });
  try {
    setBuilder(t, ID_A, 'isActive = 0');
    const r = cli.run(['archive', ID_A], t.ctx);
    assert.strictEqual(r.result.appArchive.verified, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.via, 'branch');
    assert.deepStrictEqual(archiveCalls(t.fake).map((c) => c.argv[2]), [ID_A, BRANCH]);
  } finally { rm(t.W); rm(t.home); }
});

test('P1: an undefined / empty / blank ref never reaches hivecontrol', () => {
  const t = setup('emptyref', { effectDb: true });
  try {
    for (const bad of [undefined, null, '', '   ']) {
      const r = cli.hcArchiveCall(bad, { env: t.ctx.env, cwd: t.W, timeout: 5000 });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /empty ref/);
    }
    assert.strictEqual(archiveCalls(t.fake).length, 0);
  } finally { rm(t.W); rm(t.home); }
});

test('P1: a call that also archives ANOTHER builder on the same worktree is reported loudly as appArchive.sideEffect + warnings (not undone)', () => {
  const t = setup('sideeffect');
  try {
    setBuilder(t, ID_A, 'isActive = 0');
    addBuilder(t, { id: ID_Y, isActive: 1, worktreePath: t.top, branchName: 'qa/other' });
    const bin = path.join(t.home, 'bin-se');
    fs.mkdirSync(bin, { recursive: true });
    const src = '#!' + process.execPath + '\n'
      + "const fs=require('fs');const a=process.argv.slice(2);\n"
      + "if(a[0]==='--version'){console.log('2.5.3');process.exit(0);}\n"
      + "if(a[0]==='workspace'&&a[1]==='--help'){process.stdout.write(fs.readFileSync(" + JSON.stringify(HELP_253) + ",'utf8'));process.exit(0);}\n"
      + "if(a[0]==='workspace'&&a[2]==='--help'){process.stdout.write(fs.readFileSync(" + JSON.stringify(ARCHIVE_253) + ",'utf8'));process.exit(0);}\n"
      + "if(a[0]==='workspace'&&a[1]==='archive'){const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(" + JSON.stringify(t.dbPath) + ");d.prepare('UPDATE builders SET isActive=0,isHidden=1').run();d.close();console.log(JSON.stringify({archived:true}));process.exit(0);}\n"
      + 'process.exit(2);\n';
    fs.writeFileSync(path.join(bin, 'hivecontrol'), src, { mode: 0o755 });
    capsLib.resetCache();
    const ctx = { home: t.home, cwd: t.W, env: { HOME: t.home, PATH: bin, ANTIHALL_DEVSWARM_APP_DB: t.dbPath }, backend: BACKEND };
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.appArchive.ok, true, JSON.stringify(r.result));
    assert.ok(r.result.appArchive.sideEffect, JSON.stringify(r.result.appArchive));
    assert.deepStrictEqual(r.result.appArchive.sideEffect.changed, [{ id: ID_Y, before: 'open', after: 'archived' }]);
    assert.match(r.result.warnings.join('\n'), /APP SIDE EFFECT/);
  } finally { rm(t.W); rm(t.home); }
});

test('P2: tombstone id has NO app row but a re-spawned LIVE builder holds the worktree -> no repair candidate, no hivecontrol call', () => {
  const t = setup('norowid', { effectDb: true });
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(t.dbPath); db.prepare('DELETE FROM builders WHERE id = ?').run(ID_A); db.close();
    addBuilder(t, { id: ID_Y, isActive: 1, worktreePath: t.top, branchName: BRANCH });
    const found = cli.localArchivedAppLive(t.home, { env: t.ctx.env, repoKey: t.repoKey });
    assert.deepStrictEqual(found.rows, []);
    const rep = cli.appLiveArchivedRows(t.home, { repair: true, cwd: t.W, env: t.ctx.env });
    assert.strictEqual(rep.archived, 0);
    assert.strictEqual(archiveCalls(t.fake).length, 0);
    assert.deepStrictEqual(dbRow(t.dbPath, ID_Y), { isActive: 1, isHidden: 0 });
  } finally { rm(t.W); rm(t.home); }
});

test('(b) the mesh id (primary-<hash>) and an id prefix resolve the same app-only archive; an unknown name archives nothing', () => {
  const t = setup('apponly2', { effectDb: true });
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    const none = cli.run(['archive', 'qa/does-not-exist'], t.ctx);
    assert.strictEqual(none.result.ok, false, JSON.stringify(none.result));
    assert.strictEqual(archiveCalls(t.fake).length, 0);
    const meshId = 'primary-' + require('node:crypto').createHash('sha1').update('x').digest('hex').slice(0, 8);
    assert.strictEqual(cli.run(['archive', meshId], t.ctx).result.ok, false, 'a mesh id that does not map to the worktree resolves nothing');
    const byPrefix = cli.run(['archive', ID_A.slice(0, 8)], t.ctx);
    assert.strictEqual(byPrefix.result.appArchive.ok, true, JSON.stringify(byPrefix.result));
  } finally { rm(t.W); rm(t.home); }
});

test('(b) app-only archive that fails verification reports partial + the exact command, exit 2', () => {
  const t = setup('apponly3', {});
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    const r = cli.run(['archive', BRANCH], t.ctx);
    assert.strictEqual(r.result.appArchive.ok, false, JSON.stringify(r.result));
    assert.strictEqual(r.result.partial, true);
    assert.match(r.result.manualStep, /hivecontrol workspace archive qa\/ui-field-audit/);
    assert.strictEqual(r.code, 2);
  } finally { rm(t.W); rm(t.home); }
});

test('(c)+(d) roster: appStillLive names the exact command, rows carry appArchived true|false|null', () => {
  const t = setup('roster', { effectDb: true });
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    const roster = cli.run(['roster'], t.ctx).result;
    assert.ok(roster.appStillLive, JSON.stringify(roster));
    assert.strictEqual(roster.appStillLive.count, 1);
    assert.match(roster.appStillLive.message, /^app still shows 1 workspace\(s\) you archived — run: hivecontrol workspace archive qa\/ui-field-audit/);
    const row = roster.workspaces.find((w) => w.id === ID_A);
    assert.ok(row, 'the archived row stays VISIBLE');
    assert.strictEqual(row.appArchived, false, 'app still has it live');
    assert.ok(row.hints.includes('app-live'));
    // after the app side is archived: appArchived true, no appStillLive
    cli.run(['archive', BRANCH], t.ctx);
    const after = cli.run(['roster'], t.ctx).result;
    assert.strictEqual(after.appStillLive, undefined);
    assert.strictEqual(after.workspaces.find((w) => w.id === ID_A).appArchived, true);
    // no app DB -> unknown (null)
    const noDb = cli.run(['roster'], Object.assign({}, t.ctx, { env: Object.assign({}, t.ctx.env, { ANTIHALL_DEVSWARM_APP_DB: 'off' }) })).result;
    assert.strictEqual(noDb.workspaces.find((w) => w.id === ID_A).appArchived, null);
  } finally { rm(t.W); rm(t.home); }
});

test('(c) app-state openButMarkedArchived carries localArchive + the exact cmd; parent-inbox note is deduped per session', () => {
  const t = setup('appstate', {});
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    cli.syncAppState(t.home, { env: t.ctx.env, now: Date.now() });
    const st = JSON.parse(fs.readFileSync(cli.appStatePath(t.home), 'utf8'));
    const e = st.openButMarkedArchived.find((x) => x.id === ID_A);
    assert.ok(e, JSON.stringify(st.openButMarkedArchived));
    assert.strictEqual(e.localArchive, true);
    assert.strictEqual(e.cmd, 'hivecontrol workspace archive ' + BRANCH);
    const n1 = inbox.appLiveArchivedNote(t.home, 'sess-1', st.openButMarkedArchived, Date.now());
    assert.match(n1, /app still shows 1 workspace\(s\) you archived — run: hivecontrol workspace archive qa\/ui-field-audit/);
    assert.strictEqual(inbox.appLiveArchivedNote(t.home, 'sess-1', st.openButMarkedArchived, Date.now()), null, 'one-time per session+set');
    assert.ok(inbox.appLiveArchivedNote(t.home, 'sess-2', st.openButMarkedArchived, Date.now()), 'a new session is told again');
    assert.strictEqual(inbox.appLiveArchivedNote(t.home, 'sess-3', [{ id: 'x', localArchive: false, cmd: null }], Date.now()), null, 'app-sourced stale markers are not this note');
  } finally { rm(t.W); rm(t.home); }
});

test('(3) doctor: detection is READ-ONLY; --repair runs the VERIFIED app archive (seeded mismatch, mocked hivecontrol)', () => {
  const t = setup('repair', { effectDb: true });
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    const detect = cli.appLiveArchivedRows(t.home, { cwd: t.W, env: t.ctx.env });
    assert.strictEqual(detect.rows.length, 1);
    assert.strictEqual(detect.rows[0].cmd, 'hivecontrol workspace archive ' + BRANCH);
    assert.strictEqual(archiveCalls(t.fake).length, 0, 'detection never spawns');
    assert.deepStrictEqual(dbRow(t.dbPath, ID_A), { isActive: 1, isHidden: 0 });
    // doctor-repair dry-run: reports, spawns nothing
    const dr = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
    const dry = dr.runRepairs({ cwd: t.W, env: t.ctx.env, home: t.home, dryRun: true }).find((x) => x.id === 'app-live-archived');
    assert.match(dry.msg, /would run: hivecontrol workspace archive qa\/ui-field-audit/);
    assert.strictEqual(archiveCalls(t.fake).length, 0);
    const rep = dr.runRepairs({ cwd: t.W, env: t.ctx.env, home: t.home, dryRun: false }).find((x) => x.id === 'app-live-archived');
    assert.strictEqual(rep.status, 'fixed', JSON.stringify(rep));
    assert.deepStrictEqual(dbRow(t.dbPath, ID_A), { isActive: 0, isHidden: 1 });
    // idempotent
    const again = dr.runRepairs({ cwd: t.W, env: t.ctx.env, home: t.home, dryRun: false }).find((x) => x.id === 'app-live-archived');
    assert.strictEqual(again.status, 'skipped');
    assert.strictEqual(archiveCalls(t.fake).length, 1);
  } finally { rm(t.W); rm(t.home); }
});

test('(3) doctor --repair with a no-op hivecontrol reports FAILED with the manual command, never "fixed"', () => {
  const t = setup('repairfail', {});
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    const dr = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
    const rep = dr.runRepairs({ cwd: t.W, env: t.ctx.env, home: t.home, dryRun: false }).find((x) => x.id === 'app-live-archived');
    assert.strictEqual(rep.status, 'failed', JSON.stringify(rep));
    assert.match(rep.msg, /hivecontrol workspace archive qa\/ui-field-audit/);
  } finally { rm(t.W); rm(t.home); }
});

test('(3) doctor-devswarm appDbChecks names the app-live archived workspace + command from app-state', () => {
  const t = setup('doctorwarn', {});
  try {
    cli.cmdArchive(ID_A, t.ctx, { appArchive: false });
    cli.syncAppState(t.home, { env: t.ctx.env, now: Date.now() });
    const dd = require('../../plugins/anti-hall/companion/lib/doctor-devswarm.js');
    const fn = dd.appDbChecks || dd.appDbCheck;
    assert.strictEqual(typeof fn, 'function', 'exports: ' + Object.keys(dd).join(','));
    const rows = fn({ home: t.home, env: t.ctx.env, cwd: t.W, now: Date.now(), fsi: fs });
    const hit = (Array.isArray(rows) ? rows : []).find((x) => /you archived in anti-hall/.test(x.message));
    assert.ok(hit, JSON.stringify(rows));
    assert.match(hit.message, /hivecontrol workspace archive qa\/ui-field-audit/);
  } finally { rm(t.W); rm(t.home); }
});
