'use strict';
// Field defect: `spawn <branch> -s main` returned ok:true while a submodule worktree create had failed with
// `fatal: invalid reference: <sha>` (the pinned sha was pushed to the submodule's origin after the local
// module clone last fetched). Two causes: (1) nothing fetched the missing commit before create ran its
// `git worktree add`; (2) the failure never reached `warnings` because parseSubmoduleWorktreeFailures dropped
// any fatal line that did not itself say "worktree". Local bare repos only, no network.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-submissing-log-'));
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
function commitFile(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', body]);
}

// subOrigin + parentOrigin (bare). `dev` = the local checkout (clone of parentOrigin, submodule initialised).
// Then another clone pushes a NEW submodule commit and bumps the pin; `dev` pulls the parent only — so dev's
// pin names a commit its local module clone has never fetched.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-submissing-'));
  const mk = (n) => { const d = path.join(root, n); cp.spawnSync('git', ['init', '-q', '-b', 'main', d], { env: GIT_ENV }); return d; };
  const subSeed = mk('sub-seed'); commitFile(subSeed, 's.txt', 's1');
  const subOrigin = path.join(root, 'sub-origin.git');
  cp.spawnSync('git', ['clone', '-q', '--bare', subSeed, subOrigin], { env: GIT_ENV });
  const parentSeed = mk('parent-seed'); commitFile(parentSeed, 'p.txt', 'p1');
  git(parentSeed, ['submodule', 'add', '-q', subOrigin, 'sub']);
  git(parentSeed, ['commit', '-q', '-m', 'add sub']);
  const parentOrigin = path.join(root, 'parent-origin.git');
  cp.spawnSync('git', ['clone', '-q', '--bare', parentSeed, parentOrigin], { env: GIT_ENV });
  const dev = path.join(root, 'dev');
  cp.spawnSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', '--recurse-submodules', parentOrigin, dev], { env: GIT_ENV });
  const upd = path.join(root, 'upd');
  cp.spawnSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', '--recurse-submodules', parentOrigin, upd], { env: GIT_ENV });
  git(path.join(upd, 'sub'), ['checkout', '-q', '-B', 'main']);
  commitFile(path.join(upd, 'sub'), 's.txt', 's2');
  git(path.join(upd, 'sub'), ['push', '-q', 'origin', 'main']);
  git(upd, ['add', 'sub']);
  git(upd, ['commit', '-q', '-m', 'bump sub']);
  git(upd, ['push', '-q', 'origin', 'HEAD:main']);
  git(dev, ['pull', '-q', '--no-recurse-submodules', 'origin', 'main']);
  const sha = git(dev, ['rev-parse', 'HEAD:sub']);
  const mod = path.join(dev, '.git', 'modules', 'sub');
  return { root, dev, mod, sha, home: path.join(root, 'home') };
}
const rm = (f) => { try { fs.rmSync(f.root, { recursive: true, force: true }); } catch (_) {} };

// Mimics DevSwarm `workspace create`: superproject worktree, then `git worktree add -b` in the module clone.
// Reports git's REAL stderr, in the echoed-command + fatal shape the field report showed.
function fakeCreate(f) {
  return ({ args, cwd }) => {
    if (!(args[0] === 'workspace' && args[1] === 'create')) return { ok: true, raw: '{}' };
    const branch = args[2];
    const wt = path.join(f.root, 'wt-' + branch.replace(/\W/g, '_'));
    git(cwd, ['worktree', 'add', '-q', '-b', branch, wt, 'main']);
    const sha = git(cwd, ['rev-parse', 'HEAD:sub']);
    const cmd = ['worktree', 'add', '-b', branch, path.join(wt, 'sub'), sha];
    const r = gitRaw(f.mod, cmd);
    const stderr = r.status === 0 ? '' : 'git ' + cmd.join(' ') + '\n' + r.stderr;
    return { ok: true, raw: JSON.stringify({ path: wt }), stderr };
  };
}
function spawn(f, branch) {
  fs.mkdirSync(path.join(f.home, '.anti-hall'), { recursive: true });
  const env = Object.assign({}, process.env, { HOME: f.home, USERPROFILE: f.home, DEVSWARM_AI_AGENT: 'claude', ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0' });
  return cli.run(['spawn', branch, '-s', 'main'], { home: f.home, backend: 'journal', env, cwd: f.dev, io: { run: fakeCreate(f) } }).result;
}

test('REPRO: the pinned sha is absent from the local module clone but present on its origin', () => {
  const f = fixture();
  try {
    assert.notStrictEqual(gitRaw(f.mod, ['cat-file', '-e', f.sha + '^{commit}']).status, 0, 'precondition: sha missing locally');
    const stderr = fakeCreate(f)({ args: ['workspace', 'create', 'probe'], cwd: f.dev }).stderr;
    assert.match(stderr, /fatal: invalid reference: /);
    // the parser must now see it, with the submodule path (it carries neither "worktree" nor the path itself)
    const parsed = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr }, f.dev);
    assert.strictEqual(parsed.length, 1, JSON.stringify(parsed));
    assert.match(parsed[0].path, /wt-probe\/sub$/);
    assert.match(parsed[0].error, /invalid reference/);
  } finally { rm(f); }
});

test('spawn fetches the missing submodule commit BEFORE create, so the submodule worktree is created', () => {
  const f = fixture();
  try {
    const r = spawn(f, 'fix/a');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.submoduleFailures, undefined, JSON.stringify(r.submoduleFailures));
    assert.deepStrictEqual(r.submodulePreflight && r.submodulePreflight.fetched, [{ path: 'sub', sha: f.sha }]);
    assert.ok(fs.existsSync(path.join(r.worktreePath, 'sub', '.git')), 'submodule worktree exists');
    assert.strictEqual(git(path.join(r.worktreePath, 'sub'), ['rev-parse', 'HEAD']), f.sha);
  } finally { rm(f); }
});

test('submodule step failure (commit unfetchable) appears in warnings; ok stays true and the warning says why', () => {
  const f = fixture();
  try {
    git(f.mod, ['remote', 'set-url', 'origin', path.join(f.root, 'does-not-exist.git')]);
    const r = spawn(f, 'fix/b');
    assert.strictEqual(r.ok, true, 'parent worktree exists, ok stays true');
    assert.ok(fs.existsSync(r.worktreePath));
    assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 1, JSON.stringify(r));
    const text = r.warnings.join('\n');
    assert.match(text, /submodule/i);
    assert.match(text, /invalid reference|could not be fetched/);
    assert.match(text, /parent worktree was created and is usable|missing from the local submodule clone/);
    assert.ok(r.submoduleFailures && r.submoduleFailures.length === 1, JSON.stringify(r.submoduleFailures));
    assert.ok(!fs.existsSync(path.join(r.worktreePath, 'sub', '.git')));
   
  } finally { rm(f); }
});

test('repair path: a create that failed on a missing commit is re-added once the commit is fetchable', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-r');
    const stderr = fakeCreate(f)({ args: ['workspace', 'create', 'fix/r'], cwd: f.dev }).stderr; // fails: sha missing
    assert.match(stderr, /invalid reference/);
    const failures = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr }, f.dev);
    const out = cli.repairSubmoduleWorktrees(failures, stderr, 'fix/r', f.dev);
    assert.strictEqual(out.remaining.length, 0, JSON.stringify(out));
    assert.strictEqual(out.repaired.length, 1);
    assert.strictEqual(git(path.join(f.root, 'wt-fix_r', 'sub'), ['rev-parse', 'HEAD']), f.sha);
    void wt;
  } finally { rm(f); }
});
