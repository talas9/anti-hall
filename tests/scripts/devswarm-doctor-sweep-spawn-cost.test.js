'use strict';
// Mesh redesign Phase 2 / B2 (#11): doctor's three all-store sweeps
// (foldMeshDuplicatesAllStores, healOrphanPartitionsAllStores,
// foldArchivedRegistryRows) resolved every registry row through
// resolveCallerWorktree — 2 git spawns per canonicalMeshId /
// canonicalWorktreeRealPath call, no memo. That was 97% of a measured 722 s
// doctor run. B2 routes those resolvers through identity.resolveContext
// (pure fs). This test seeds a 50-row store whose worktrees were all DELETED
// (the field shape: long-gone child worktrees), runs the three sweeps in a
// child process under tests/harness/spawn-count-preload.js, and asserts:
//   - zero child-process spawns across all three sweeps (was O(rows));
//   - decision 5: deleted paths nested under a LIVE repo are never folded onto
//     that repo (legacy walked each one up to the enclosing toplevel, grouped
//     all 50 under its meshId and proposed a fold).
// Isolated HOME/USERPROFILE (tests never touch the real home).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEVSWARM = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const STORE = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');
const PRELOAD = path.join(REPO_ROOT, 'tests', 'harness', 'spawn-count-preload.js');
const ROWS = 50;
const BUCKET = 'proj-abc123';

function git(args, cwd) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
}

test('doctor all-store sweeps: 0 spawns on 50 deleted-worktree rows, and no fold onto the enclosing repo', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-b2-sweep-cost-')));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const log = path.join(root, 'spawns.ndjson');
  try {
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    const storeLib = require(STORE);
    const cli = require(DEVSWARM);
    const s = storeLib.openStore({ home, hash: BUCKET });
    try {
      for (let i = 0; i < ROWS; i++) {
        const id = 'ws-' + String(i).padStart(2, '0');
        const wt = path.join(repo, 'wt-' + i); // nested under a LIVE repo, then deleted
        fs.mkdirSync(wt);
        const desc = { id, worktreePath: wt, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null };
        s.upsertRegistry(desc);
        if (i < 10) { // archived workspaces (foldArchivedRegistryRows' input)
          const p = path.join(cli.archivedDir(home), id + '.json');
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify(desc));
        } else if (i < 20) { // live descriptors (healOrphanPartitions' family lookup)
          const p = cli.descriptorPath(home, id);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify(desc));
        }
        fs.rmdirSync(wt);
      }
    } finally { s.close(); }

    const script = [
      'const ds = require(' + JSON.stringify(DEVSWARM) + ');',
      'const home = ' + JSON.stringify(home) + ';',
      'const childEnv = process.env; // the child runs with HOME/USERPROFILE = the isolated tmp home (see spawn env below)',
      'const ctx = { cwd: ' + JSON.stringify(repo) + ', env: childEnv, dryRun: true };',
      'const cut = () => require("fs").existsSync(process.env.ANTIHALL_SPAWN_LOG) ? require("fs").readFileSync(process.env.ANTIHALL_SPAWN_LOG, "utf8").split("\\n").filter(Boolean).length : 0;',
      'const base = cut();',
      'const fold = ds.foldMeshDuplicatesAllStores(home, ctx);',
      'const heal = ds.healOrphanPartitionsAllStores(home, ctx);',
      'const arch = ds.foldArchivedRegistryRows(home, ctx);',
      'process.stdout.write(JSON.stringify({ spawns: cut() - base, fold, heal, arch }));',
    ].join('\n');
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_SPAWN_LOG: log, ANTIHALL_INGEST_DRY_RUN: '1' });
    const r = cp.spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], { cwd: repo, env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.spawns, 0, 'the three sweeps spawned ' + out.spawns + ' child processes over ' + ROWS + ' rows');
    // Decision 5: no row with a deleted worktree is grouped/folded onto the enclosing repo.
    const retired = (out.fold.results || []).reduce((n, x) => n + (x.retired || 0), 0);
    assert.strictEqual(retired, 0, 'deleted-worktree rows were folded: ' + JSON.stringify(out.fold));
    assert.strictEqual(out.fold.errors, 0);
    assert.strictEqual(out.arch.scanned, 10, 'foldArchivedRegistryRows must still scan every archived descriptor');
    // Only each archived id's OWN row retires; a deleted worktree proves no same-worktree sibling.
    const archivedIds = Array.from({ length: 10 }, (_, i) => 'ws-' + String(i).padStart(2, '0') + '@' + BUCKET);
    assert.deepStrictEqual(out.arch.retired.map(String).sort(), archivedIds);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
});
