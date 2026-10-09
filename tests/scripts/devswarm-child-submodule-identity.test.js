'use strict';
// A DevSwarm child workspace gets its submodules as `git worktree add` worktrees of the MAIN
// checkout's submodule repos, so the submodule's common dir has core.worktree = the MAIN
// checkout's submodule dir. The identity resolver used to hop there and resolve a child's
// submodule cwd as the PRIMARY checkout (SkyCrew child report, 2026-10-09):
//   C  send --to-primary from the submodule cwd -> "cannot address the sender itself"
//   D  a child row registered against the Primary's path (register/pull refused by the guard)
//   E  --to-primary mail landing in that child instead of the Primary
// Real git fixture, tmp HOME, fixture app DB.

require('../helpers/isolate-home.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CLI = path.join(PLUGIN, 'scripts', 'devswarm.js');
const identity = require(path.join(PLUGIN, 'companion', 'lib', 'identity.js'));
const storeLib = require(path.join(PLUGIN, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(PLUGIN, 'companion', 'lib', 'devswarm-repokey.js'));
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const CHILD = 'c0ffee00-1111-4222-8333-444455556666';
const SIBLING = 'c0ffee00-9999-4222-8333-444455556666';
const GIT = ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@t'];
let tmp, home, main, child, childSub, fx, repoKey;

function git(cwd, args) {
  const r = spawnSync('git', GIT.concat(args), { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
}
function cli(cwd, args, env) {
  const e = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }, fx.env, env || {});
  delete e.DEVSWARM_BUILDER_ID;
  Object.assign(e, env || {});
  const r = spawnSync(process.execPath, [CLI].concat(args), { cwd, env: e, encoding: 'utf8', timeout: 60000 });
  const line = String(r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'))[0] || '{}';
  return JSON.parse(line);
}
function withStore(fn) { const s = storeLib.openStore({ home, hash: repoKey }); try { return fn(s); } finally { s.close(); } }

before(() => {
  if (!sqlite) return;
  fx = buildAppDb();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-childsub-')));
  home = fx.home; // the fixture's home carries the app DB env
  const lib = path.join(tmp, 'lib');
  main = path.join(tmp, 'main');
  fs.mkdirSync(lib); fs.mkdirSync(main);
  git(lib, ['init', '-q']); fs.writeFileSync(path.join(lib, 'a'), 'a'); git(lib, ['add', 'a']); git(lib, ['commit', '-qm', 'i']);
  git(main, ['init', '-q']); fs.writeFileSync(path.join(main, 'a'), 'a'); git(main, ['add', 'a']); git(main, ['commit', '-qm', 'i']);
  git(main, ['submodule', 'add', '-q', lib, 'sky']); git(main, ['commit', '-qm', 's']);
  child = path.join(tmp, 'child');
  git(main, ['worktree', 'add', '-q', child, '-b', 'kid']);
  // DevSwarm's local-submodules layout: the child's submodule is a worktree of the MAIN checkout's module repo.
  git(path.join(main, 'sky'), ['worktree', 'add', '-q', '-b', 'kid-sky', path.join(child, 'sky')]);
  childSub = path.join(child, 'sky');
  repoKey = repokey.repoKeyForWorktree(main);
  // app DB: the Primary builder sits on `main`, CHILD (standard) on the child worktree, SIBLING (standard) elsewhere
  const db = new sqlite.DatabaseSync(fx.dbFile);
  db.prepare('UPDATE builders SET worktreePath = ? WHERE id = ?').run(main, 'b-primary');
  const ins = db.prepare("INSERT INTO builders (id, repositoryId, sourceBranch, branchName, worktreePath, builderType, isActive, isHidden, label) VALUES (?, 'repo-1', 'main', ?, ?, 'standard', 1, 0, ?)");
  ins.run(CHILD, 'kid', child, 'kid');
  db.close();
});
after(() => { if (fx) rmFixture(fx); try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

test('fixture: the child submodule is a worktree of the MAIN checkout module repo (core.worktree names main)', { skip }, () => {
  assert.ok(fs.statSync(path.join(childSub, '.git')).isFile());
  assert.ok(fs.readFileSync(path.join(childSub, '.git'), 'utf8').includes(path.join(main, '.git', 'modules')));
});

test('C: a child submodule cwd resolves to the CHILD worktree, not the Primary checkout', { skip }, () => {
  identity.clearCache();
  const c = identity.resolveContext(childSub);
  const k = identity.resolveContext(child);
  const p = identity.resolveContext(main);
  assert.strictEqual(c.worktreeRoot, child);
  assert.strictEqual(c.meshId, k.meshId);
  assert.notStrictEqual(c.meshId, p.meshId);
  assert.strictEqual(c.superproject, child);
  assert.strictEqual(c.repoKey, p.repoKey);
  // the Primary's own submodule still keys to the Primary
  assert.strictEqual(identity.resolveContext(path.join(main, 'sky')).worktreeRoot, main);
});

test('C: send --to-primary from the child submodule cwd is not refused as self-addressing', { skip }, () => {
  const reg = cli(main, ['register-primary', '--session', 'sess-primary']);
  assert.strictEqual(reg.ok, true, JSON.stringify(reg));
  withStore((s) => s.upsertRegistry({ id: CHILD, worktreePath: child, sessionId: 'sess-child' }));
  const r = cli(childSub, ['send', '--to-primary', '--message', 'hi'], { DEVSWARM_BUILDER_ID: CHILD });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.from, CHILD);
  assert.strictEqual(r.to, identity.resolveContext(main).meshId);
});

test('D: a child row registered against the Primary path is repaired from the app record (idempotent, no delete)', { skip }, () => {
  const fold = require(path.join(PLUGIN, 'scripts', 'devswarm-lib', 'fold.js'));
  const core = require(path.join(PLUGIN, 'scripts', 'devswarm-lib', 'core.js'));
  // seed the OLD bad state: the child id mapped to the monorepo root, descriptor too
  withStore((s) => s.upsertRegistry({ id: CHILD, worktreePath: main, sessionId: 'sess-child', inboxPath: path.join(main, '.devswarm-temp', 'inbox.ndjson') }, { allowPathChange: true }));
  core.writeDescriptorAtomic(home, CHILD, { id: CHILD, worktreePath: main, sessionId: 'sess-child', inboxPath: path.join(main, '.devswarm-temp', 'inbox.ndjson'), ownerKey: repoKey, repoKey });
  const env = Object.assign({}, process.env, fx.env, { HOME: home });
  const ctx = { env };
  const before = withStore((s) => s.listRegistry().map((r) => r.id).sort());
  const dry = fold.repairRootMappedChildRows(home, repoKey, Object.assign({ dryRun: true }, ctx));
  assert.strictEqual(dry.pending, 1);
  assert.strictEqual(withStore((s) => s.listRegistry().find((r) => r.id === CHILD).worktreePath), main, 'dry run writes nothing');
  const r1 = fold.healRegistry(home, repoKey, ctx);
  assert.strictEqual(r1.rootMapped, 1, JSON.stringify(r1));
  const row = withStore((s) => s.listRegistry().find((r) => r.id === CHILD));
  assert.strictEqual(fs.realpathSync(row.worktreePath), child);
  assert.strictEqual(row.sessionId, 'sess-child');
  assert.strictEqual(row.inboxPath, path.join(child, '.devswarm-temp', 'inbox.ndjson'));
  assert.strictEqual(fs.realpathSync(core.readDescriptorFile(home, CHILD).worktreePath), child);
  assert.deepStrictEqual(withStore((s) => s.listRegistry().map((r) => r.id).sort()), before, 'no row deleted');
  const r2 = fold.healRegistry(home, repoKey, ctx);
  assert.strictEqual(r2.rootMapped, 0, 'idempotent');
  // the legitimate Primary rows are untouched: the Primary builder keeps the root path
  const prim = withStore((s) => s.listRegistry().filter((r) => /^primary-/.test(r.id)));
  assert.ok(prim.every((r) => fs.realpathSync(r.worktreePath) === main));
});

test('E: a child registered against the Primary path never receives --to-primary mail; the Primary does', { skip }, () => {
  const primaryId = identity.resolveContext(main).meshId;
  // sibling sends from its own (unrelated) worktree; the mis-registered CHILD row (live session, fresher) shares the Primary's path
  const sib = path.join(tmp, 'sib');
  git(main, ['worktree', 'add', '-q', sib, '-b', 'sib']);
  withStore((s) => {
    s.upsertRegistry({ id: SIBLING, worktreePath: sib, sessionId: 'sess-sib' });
    s.upsertRegistry({ id: CHILD, worktreePath: main, sessionId: 'sess-child' }, { allowPathChange: true });
  });
  const r = cli(sib, ['send', '--to-primary', '--message', 'phase report'], { DEVSWARM_BUILDER_ID: SIBLING });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.toId, primaryId, 'landed in the Primary partition: ' + JSON.stringify(r));
  const got = withStore((s) => ({ child: (s.listMessages(CHILD) || []).filter((m) => /phase report/.test(String(m.body || m.message || ''))).length }));
  assert.strictEqual(got.child, 0, 'the child partition got nothing');
});
