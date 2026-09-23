'use strict';
// identity-equivalence — mesh redesign Phase 2 / B0.
// (a) companion/lib/identity.js resolveContext (spawn-free path) == git's own answer
//     (`rev-parse --show-toplevel`, `--show-superproject-working-tree` looped to the
//     outermost superproject, `--git-common-dir`) for every fixture shape.
// (b) KEY STABILITY: for every non-submodule shape, identity.repoKey/meshId are
//     byte-identical to TODAY's shipped functions (devswarm-repokey.js
//     repoKeyForWorktree, devswarm.js canonicalMeshId) called in-process.
// (c) submodule shapes: identity keys to the OUTERMOST superproject (decisions 1+2);
//     the legacy (possibly wrong) key is recorded in the assertion message.
// Isolation: HOME/USERPROFILE point at the fixture home BEFORE any production
// module loads; ANTIHALL_INGEST_DRY_RUN=1; GIT_* location vars scrubbed.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { buildIdentityFixtures } = require('../helpers/git-fixtures.js');

const fx = buildIdentityFixtures();
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete process.env[k];
process.env.HOME = fx.home;
process.env.USERPROFILE = fx.home;
process.env.ANTIHALL_INGEST_DRY_RUN = '1';

const LIB = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib');
const identity = require(path.join(LIB, 'identity.js'));
const repokey = require(path.join(LIB, 'devswarm-repokey.js'));
const inst = require(path.join(LIB, '..', 'install-devswarm-ingest.js'));
const devswarm = require(path.join(LIB, '..', '..', 'scripts', 'devswarm.js'));

after(() => fx.cleanup());

function git(args, cwd) {
  const r = cp.spawnSync('git', args, { cwd: fs.existsSync(cwd) ? cwd : fx.root, env: fx.env, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : null;
}
function truth(cwd) {
  if (!fs.existsSync(cwd)) return { toplevel: null, superproject: null, worktreeRoot: null, commonDir: null };
  const top = git(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd);
  if (!top) return { toplevel: null, superproject: null, worktreeRoot: null, commonDir: null };
  const toplevel = fs.realpathSync(top);
  const sup1 = git(['-C', toplevel, 'rev-parse', '--show-superproject-working-tree'], toplevel);
  let root = toplevel;
  for (let i = 0; i < 32; i++) {
    const s = git(['-C', root, 'rev-parse', '--show-superproject-working-tree'], root);
    if (!s) break;
    root = fs.realpathSync(s);
  }
  const cd = git(['-C', root, 'rev-parse', '--git-common-dir'], root);
  return {
    toplevel, superproject: sup1 ? fs.realpathSync(sup1) : null, worktreeRoot: root,
    commonDir: cd ? fs.realpathSync(path.resolve(root, cd)) : null,
  };
}

const SPAWN_ALLOWED = new Set(['main/vend/raw', 'main/emb', 'main/untracked']);
const SUBMODULE_KINDS = new Set(['submodule-in-main', 'submodule-in-linked-worktree']);

function countingSpawn() {
  const s = { n: 0, fn: (cmd, args, opts) => { s.n += 1; return cp.spawnSync(cmd, args, opts); } };
  return s;
}

for (const [name, cwd] of Object.entries(fx.cwds)) {
  test(`(a) spawn-free == git truth: ${name}`, () => {
    const spy = countingSpawn();
    const ctx = identity.resolveContext(cwd, { memo: false, spawn: spy.fn });
    const t = truth(cwd);
    assert.strictEqual(ctx.kind, fx.expectKind[name], `kind for ${name}`);
    assert.strictEqual(ctx.toplevel, t.toplevel, `toplevel for ${name}`);
    assert.strictEqual(ctx.superproject, t.superproject, `superproject for ${name}`);
    assert.strictEqual(ctx.worktreeRoot, t.worktreeRoot, `worktreeRoot for ${name}`);
    assert.strictEqual(ctx.commonDir, t.commonDir, `commonDir for ${name}`);
    assert.strictEqual(ctx.mainWorktree, t.commonDir ? path.dirname(t.commonDir) : null, `mainWorktree for ${name}`);
    assert.strictEqual(spy.n, SPAWN_ALLOWED.has(name) ? 1 : 0, `spawn budget for ${name}`);
    assert.strictEqual(ctx.spawned, spy.n, `spawned field for ${name}`);
    assert.ok(Object.isFrozen(ctx));
  });
}

test('(b) KEY STABILITY vs shipped repokey/devswarm functions (non-submodule shapes)', () => {
  const rows = [];
  for (const [name, cwd] of Object.entries(fx.cwds)) {
    const ctx = identity.resolveContext(cwd, { memo: false });
    if (SUBMODULE_KINDS.has(ctx.kind)) continue;
    const legacyRepoKey = repokey.repoKeyForWorktree(cwd);
    const legacyMeshId = devswarm.canonicalMeshId(cwd);
    rows.push(name);
    assert.strictEqual(ctx.repoKey, legacyRepoKey, `repoKey drift for ${name}`);
    if (ctx.kind === 'main' || ctx.kind === 'linked-worktree') {
      assert.strictEqual(ctx.meshId, legacyMeshId, `meshId drift for ${name}`);
      assert.strictEqual(ctx.primaryMeshId, inst.primaryWorkspaceId(inst.resolveMainWorktree(cwd)), `primaryMeshId for ${name}`);
    } else if (name === 'main/src/gone') {
      // Decision 5: a deleted path never folds onto its enclosing repo. Legacy
      // canonicalMeshId walks up (findGitToplevel has no existence check).
      assert.strictEqual(ctx.meshId, null);
      assert.strictEqual(legacyMeshId, identity.resolveContext(fx.main).meshId,
        'documented legacy behavior: deleted subdir walks up to the enclosing repo meshId');
    } else {
      // non-git / deleted-with-no-enclosing-repo: identity gives null; the legacy
      // value is the caller-level raw-path fallback, reproduced by the caller.
      assert.strictEqual(ctx.meshId, null);
      assert.strictEqual(inst.primaryWorkspaceId(cwd), legacyMeshId, `caller fallback for ${name}`);
    }
  }
  assert.deepStrictEqual(rows.sort(), ['gone', 'main', 'main/src/deep', 'main/src/gone', 'main/untracked', 'mainlink/src', 'nongit/x', 'wt']);
});

test('(b) formula helpers are byte-identical to the shipped formatters', () => {
  for (const p of [fx.main, fx.wt, fs.realpathSync(fx.root), '/x/y z/Ünïcode']) {
    assert.strictEqual(identity.meshIdForRealPath(inst.worktreeRealPath(p)), inst.primaryWorkspaceId(p));
  }
  const cd = fs.realpathSync(path.join(fx.main, '.git'));
  assert.strictEqual(identity.repoKeyForCommonDir(cd), repokey.repoKeyForWorktree(fx.main));
});

test('(c) submodule shapes key to the OUTERMOST superproject (legacy value documented)', () => {
  const mainCtx = identity.resolveContext(fx.main, { memo: false });
  const wtCtx = identity.resolveContext(fx.wt, { memo: false });
  for (const [name, cwd] of Object.entries(fx.cwds)) {
    const ctx = identity.resolveContext(cwd, { memo: false });
    if (!SUBMODULE_KINDS.has(ctx.kind)) continue;
    const rootCtx = name.startsWith('wt/') ? wtCtx : mainCtx;
    const legacyRepoKey = repokey.repoKeyForWorktree(cwd);
    const legacyMeshId = devswarm.canonicalMeshId(cwd);
    const note = `${name}: identity must use the superproject key; legacy repoKey=${legacyRepoKey} `
      + `(${legacyRepoKey === rootCtx.repoKey ? 'same' : 'WRONG'}), legacy meshId=${legacyMeshId} `
      + `(${legacyMeshId === rootCtx.meshId ? 'same' : 'WRONG'})`;
    assert.strictEqual(ctx.worktreeRoot, rootCtx.worktreeRoot, note);
    assert.strictEqual(ctx.repoKey, rootCtx.repoKey, note);
    assert.strictEqual(ctx.meshId, rootCtx.meshId, note);
    // The superproject root itself is non-submodule, so it is legacy-stable:
    assert.strictEqual(rootCtx.repoKey, repokey.repoKeyForWorktree(rootCtx.worktreeRoot), note);
    assert.strictEqual(rootCtx.meshId, devswarm.canonicalMeshId(rootCtx.worktreeRoot), note);
  }
  // Known-defect evidence (the legacy values these rows flip away from):
  assert.notStrictEqual(repokey.repoKeyForWorktree(fx.cwds['wt/libs/sub']), wtCtx.repoKey, 'D1 still present in legacy');
  assert.notStrictEqual(devswarm.canonicalMeshId(fx.cwds['main/libs/sub/inner']), mainCtx.meshId, 'D6 still present in legacy');
  assert.notStrictEqual(repokey.repoKeyForWorktree(fx.cwds['main/vend/raw']), mainCtx.repoKey, 'D7 still present in legacy');
});

test('memo: realpath-keyed hit, clearCache, deleted never cached, removed .git invalidates', () => {
  identity.clearCache();
  const a = identity.resolveContext(fx.cwds['mainlink/src']);
  const b = identity.resolveContext(path.join(fx.main, 'src'));
  assert.strictEqual(a, b, 'symlinked and physical spelling share one memo entry');
  identity.clearCache();
  const c = identity.resolveContext(fx.cwds['mainlink/src']);
  assert.notStrictEqual(a, c);
  assert.deepStrictEqual({ ...a }, { ...c });

  const ghost = path.join(fx.root, 'later');
  assert.strictEqual(identity.resolveContext(ghost).kind, 'deleted');
  fs.mkdirSync(ghost);
  assert.strictEqual(identity.resolveContext(ghost).kind, 'non-git', 'deleted result was not cached');

  const tmpRepo = path.join(fx.root, 'tmprepo');
  fs.mkdirSync(tmpRepo);
  fx.git(['init', '-q', tmpRepo], tmpRepo);
  const d = identity.resolveContext(tmpRepo);
  assert.strictEqual(d.kind, 'main');
  fs.rmSync(path.join(tmpRepo, '.git'), { recursive: true, force: true });
  assert.strictEqual(identity.resolveContext(tmpRepo).kind, 'non-git', 'stale memo entry dropped');
});

test('cwd inside a gitdir and a broken .git file are non-git (git-equivalent)', () => {
  const inGitdir = path.join(fx.main, '.git', 'refs');
  assert.strictEqual(identity.resolveContext(inGitdir, { memo: false }).kind, 'non-git');
  assert.strictEqual(git(['-C', inGitdir, 'rev-parse', '--show-toplevel'], inGitdir), null);
  const broken = path.join(fx.root, 'nongit', 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ' + path.join(fx.root, 'no-such-gitdir') + '\n');
  assert.strictEqual(identity.resolveContext(broken, { memo: false }).kind, 'non-git');
  assert.strictEqual(git(['-C', broken, 'rev-parse', '--show-toplevel'], broken), null);
});

test('sessionWorktreeCoherent: live match true, live mismatch false, no live record null', () => {
  const home = path.join(fx.root, 'swc-home');
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  // process.pid is alive and started before this file's mtime.
  fs.writeFileSync(path.join(dir, process.pid + '.json'),
    JSON.stringify({ pid: process.pid, sessionId: 'S-live', cwd: fx.cwds['wt/libs/sub'] }));
  fs.writeFileSync(path.join(dir, '99998.json'), JSON.stringify({ pid: 99998, sessionId: 'S-dead', cwd: fx.wt }));
  const deadKill = (pid) => { if (pid === 99998) { const e = new Error('no'); e.code = 'ESRCH'; throw e; } };

  assert.strictEqual(identity.sessionWorktreeCoherent('S-live', fx.wt, { home, kill: deadKill }).coherent, true);
  assert.strictEqual(identity.sessionWorktreeCoherent('S-live', path.join(fx.wt, 'libs'), { home, kill: deadKill }).coherent, true);
  const mis = identity.sessionWorktreeCoherent('S-live', fx.main, { home, kill: deadKill });
  assert.strictEqual(mis.coherent, false);
  assert.strictEqual(mis.evidence.live.length, 1);
  assert.strictEqual(identity.sessionWorktreeCoherent('S-dead', fx.wt, { home, kill: deadKill }).coherent, null);
  assert.strictEqual(identity.sessionWorktreeCoherent('S-none', fx.wt, { home, kill: deadKill }).coherent, null);
  assert.strictEqual(identity.sessionWorktreeCoherent('S-live', fx.wt, {}).coherent, null, 'no home -> unknown');
});
