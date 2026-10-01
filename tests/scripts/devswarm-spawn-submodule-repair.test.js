'use strict';
// Field defect (SkyCrew, 3rd occurrence): `spawn` returned submoduleFailures
// `git worktree add -b <branch> <wt>/skyflutter <sha>` -> "already exists".
// Root cause (DevSwarm app source + log): the background `worktreeInclude` copy
// (`skyflutter/.env`) mkdirs + fills <wt>/skyflutter before the submodule
// `worktree add` runs, so git sees a NON-EMPTY path. These tests reproduce that
// ordering with real git + real submodules and pin the loss-free repair.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-subrepair-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

const GIT_ENV = Object.assign({}, process.env, {
  HOME: LOG_DIR, USERPROFILE: LOG_DIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
});
function gitRaw(cwd, args) { return cp.spawnSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always'].concat(args), { encoding: 'utf8', env: GIT_ENV }); }
function git(cwd, args) {
  const r = gitRaw(cwd, args);
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
function mkRepo(dir, file) {
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir], { env: GIT_ENV });
  fs.writeFileSync(path.join(dir, file), file);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

// Superproject with 2 submodules; skyflutter is configured like SkyCrew's
// (`branch = develop` in .gitmodules, a non-default tracking branch).
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-subrepair-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const parent = path.join(root, 'parent');
  mkRepo(parent, 'README');
  for (const name of ['skyflutter', 'skydart']) {
    const up = path.join(root, 'up-' + name);
    mkRepo(up, name + '.txt');
    if (name === 'skyflutter') { git(up, ['checkout', '-q', '-b', 'develop']); }
    git(parent, ['submodule', 'add', '-q'].concat(name === 'skyflutter' ? ['-b', 'develop'] : [], [up, name]));
  }
  git(parent, ['commit', '-q', '-m', 'add submodules']);
  const sha = git(parent, ['rev-parse', 'HEAD:skyflutter']);
  return { root, home, parent, sha };
}
const rm = (f) => { try { fs.rmSync(f.root, { recursive: true, force: true }); } catch (_) {} };

// Mimics DevSwarm `workspace create`: superproject worktree, background include
// copy (skyflutter/.env), then `worktree add -b` per submodule. Returns the REAL
// stderr git/the app would have produced.
function appCreate(f, wt, branch, { copyEnv = true } = {}) {
  git(f.parent, ['worktree', 'add', '-q', '-b', branch, wt]);
  if (copyEnv) {
    fs.mkdirSync(path.join(wt, 'skyflutter'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'skyflutter', '.env'), 'SECRET=1\n');
  }
  let stderr = '';
  for (const name of ['skyflutter', 'skydart']) {
    const sub = path.join(f.parent, '.git', 'modules', name);
    const sha = git(f.parent, ['rev-parse', 'HEAD:' + name]);
    const cmd = ['worktree', 'add', '-b', branch, path.join(wt, name), sha];
    const r = gitRaw(sub, cmd);
    if (r.status !== 0) stderr += 'git ' + cmd.join(' ') + '\n' + r.stderr;
  }
  return stderr;
}

test('REPRO: pre-copied .env makes the submodule path non-empty -> git says already exists (and the other submodule succeeds)', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-a');
    const stderr = appCreate(f, wt, 'fix/a');
    assert.match(stderr, /fatal: '.*wt-a\/skyflutter' already exists/);
    assert.ok(fs.existsSync(path.join(wt, 'skydart', '.git')), 'sibling submodule worktree was created');
    assert.ok(!fs.existsSync(path.join(wt, 'skyflutter', '.git')));
    const parsed = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr }, f.parent);
    assert.strictEqual(parsed.length, 1);
  } finally { rm(f); }
});

test('repair: non-empty path -> moved aside, worktree added at the pinned sha, .env preserved, nothing deleted', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-b');
    const stderr = appCreate(f, wt, 'fix/b');
    const failures = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr }, f.parent);
    const out = cli.repairSubmoduleWorktrees(failures, stderr, 'fix/b', f.parent);
    assert.strictEqual(out.remaining.length, 0, JSON.stringify(out));
    assert.strictEqual(out.repaired.length, 1);
    assert.strictEqual(out.repaired[0].sha, f.sha);
    const p = path.join(wt, 'skyflutter');
    assert.ok(fs.existsSync(path.join(p, '.git')));
    assert.strictEqual(fs.readFileSync(path.join(p, '.env'), 'utf8'), 'SECRET=1\n');
    assert.strictEqual(git(p, ['rev-parse', 'HEAD']), f.sha);
    assert.strictEqual(git(p, ['rev-parse', '--abbrev-ref', 'HEAD']), 'fix/b');
    assert.deepStrictEqual(fs.readdirSync(wt).filter((e) => e.includes('.pre-wt-')), [], 'aside dir cleaned up');
  } finally { rm(f); }
});

test('repair: empty placeholder dir -> rmdir only, worktree added', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-c');
    const stderr = appCreate(f, wt, 'fix/c', { copyEnv: false }); // git fails nothing: placeholder is empty
    assert.strictEqual(stderr, '');
    // Re-run as the failing shape: empty dir present, worktree absent.
    git(path.join(f.parent, '.git', 'modules', 'skyflutter'), ['worktree', 'remove', '--force', path.join(wt, 'skyflutter')]);
    fs.mkdirSync(path.join(wt, 'skyflutter'));
    const out = cli.repairSubmoduleWorktrees([{ path: path.join(wt, 'skyflutter'), error: 'already exists' }], 'git worktree add -b fix/c ' + path.join(wt, 'skyflutter') + ' ' + f.sha, 'fix/c', f.parent);
    assert.strictEqual(out.remaining.length, 0, JSON.stringify(out));
    assert.ok(fs.existsSync(path.join(wt, 'skyflutter', '.git')));
    assert.strictEqual(out.repaired[0].reusedBranch, true, 'branch created by the first add is reused (no -b)');
  } finally { rm(f); }
});

test('repair: path missing + branch already exists (the reported post-failure state) -> add without -b', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-d');
    const stderr = appCreate(f, wt, 'fix/d');
    const sub = path.join(f.parent, '.git', 'modules', 'skyflutter');
    assert.strictEqual(git(sub, ['rev-parse', '--verify', 'refs/heads/fix/d']), f.sha, 'the FAILED -b add still created the branch (root-cause evidence)');
    fs.rmSync(path.join(wt, 'skyflutter'), { recursive: true, force: true }); // test fixture cleanup only
    const out = cli.repairSubmoduleWorktrees(cli.parseSubmoduleWorktreeFailures({ raw: '', stderr }, f.parent), stderr, 'fix/d', f.parent);
    assert.strictEqual(out.remaining.length, 0, JSON.stringify(out));
    assert.strictEqual(out.repaired[0].reusedBranch, true);
    assert.strictEqual(git(path.join(wt, 'skyflutter'), ['rev-parse', '--abbrev-ref', 'HEAD']), 'fix/d');
  } finally { rm(f); }
});

test('repair: stale registration for the exact path (dir gone) is pruned and the add succeeds', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-e');
    appCreate(f, wt, 'fix/e', { copyEnv: false });
    const p = path.join(wt, 'skyflutter');
    const sub = path.join(f.parent, '.git', 'modules', 'skyflutter');
    assert.ok(git(sub, ['worktree', 'list', '--porcelain']).includes('wt-e/skyflutter'));
    fs.rmSync(p, { recursive: true, force: true }); // dir deleted, registration stale
    const out = cli.repairSubmoduleWorktrees([{ path: p, error: 'already exists' }], '', 'fix/e', f.parent);
    assert.strictEqual(out.remaining.length, 0, JSON.stringify(out));
    assert.ok(fs.existsSync(path.join(p, '.git')));
  } finally { rm(f); }
});

test('repair: fails closed -- live checkout, non-submodule path, relative path and other error shapes are left in remaining and untouched', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-f');
    appCreate(f, wt, 'fix/f', { copyEnv: false });
    const live = path.join(wt, 'skydart');
    fs.writeFileSync(path.join(live, 'keep.txt'), 'x');
    const input = [
      { path: live, error: 'already exists' },                       // live worktree: never touched
      { path: path.join(f.root, 'elsewhere', 'other'), error: 'already exists' }, // not a submodule path
      { path: 'skyflutter', error: 'already exists' },               // relative
      { path: path.join(wt, 'skyflutter'), error: 'some other fatal' },
    ];
    const out = cli.repairSubmoduleWorktrees(input, '', 'fix/f', f.parent);
    assert.strictEqual(out.repaired.length, 0);
    assert.strictEqual(out.remaining.length, 4);
    assert.ok(fs.existsSync(path.join(live, 'keep.txt')));
  } finally { rm(f); }
});

test('repair: a failed add restores the moved-aside dir (no data loss)', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-g');
    appCreate(f, wt, 'fix/g');
    const p = path.join(wt, 'skyflutter');
    // Branch checked out in ANOTHER live worktree -> repair must refuse and restore.
    const other = path.join(f.root, 'other-wt');
    const sub = path.join(f.parent, '.git', 'modules', 'skyflutter');
    git(sub, ['worktree', 'add', '-q', other, 'fix/g']); // branch was created by the failed -b add
    const out = cli.repairSubmoduleWorktrees([{ path: p, error: 'already exists' }], '', 'fix/g', f.parent);
    assert.strictEqual(out.repaired.length, 0);
    assert.strictEqual(out.remaining.length, 1);
    assert.match(out.remaining[0].repairError, /checked out in another worktree/);
    assert.strictEqual(fs.readFileSync(path.join(p, '.env'), 'utf8'), 'SECRET=1\n', 'original dir + .env restored');
  } finally { rm(f); }
});

test('cmdSpawn end-to-end: repairs the reproduced failure, reports submoduleRepaired + the pinned-commit hint, no failure left', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-spawn');
    const run = ({ args }) => {
      if (args[0] === 'workspace' && args[1] === 'create') {
        const stderr = appCreate(f, wt, 'fix/spawn');
        return { ok: true, raw: JSON.stringify({ path: wt }), stderr };
      }
      return { ok: true, raw: '{}' };
    };
    const r = cli.run(['spawn', 'fix/spawn'], { home: f.home, backend: 'journal', env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '999999' }, cwd: f.parent, io: { run } }).result;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.submoduleFailures, undefined, JSON.stringify(r.submoduleFailures));
    assert.strictEqual(r.submoduleRepaired.length, 1);
    assert.ok(r.submoduleHint.includes(f.sha) && /not the submodule's default branch/.test(r.submoduleHint), r.submoduleHint);
    assert.ok(fs.existsSync(path.join(wt, 'skyflutter', '.git')));
  } finally { rm(f); }
});

test('repair: include-copied file colliding with a TRACKED file is never overwritten -- kept aside and reported in conflicts', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-h');
    git(f.parent, ['worktree', 'add', '-q', '-b', 'fix/h', wt]);
    const p = path.join(wt, 'skyflutter');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'skyflutter.txt'), 'COPIED-OVER'); // same path as a tracked file
    fs.writeFileSync(path.join(p, '.env'), 'SECRET=1\n');
    const out = cli.repairSubmoduleWorktrees([{ path: p, error: 'already exists' }], '', 'fix/h', f.parent);
    assert.strictEqual(out.remaining.length, 0, JSON.stringify(out));
    assert.strictEqual(fs.readFileSync(path.join(p, 'skyflutter.txt'), 'utf8'), 'skyflutter.txt', 'tracked content intact');
    assert.strictEqual(fs.readFileSync(path.join(p, '.env'), 'utf8'), 'SECRET=1\n');
    const c = out.repaired[0].conflicts;
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].file, 'skyflutter.txt');
    assert.strictEqual(fs.readFileSync(c[0].kept, 'utf8'), 'COPIED-OVER', 'copy kept aside');
    assert.strictEqual(path.dirname(path.dirname(c[0].kept)), wt, 'aside lives in the workspace dir, not /tmp');
    assert.match(path.basename(path.dirname(c[0].kept)), /\.pre-wt-/);
  } finally { rm(f); }
});
