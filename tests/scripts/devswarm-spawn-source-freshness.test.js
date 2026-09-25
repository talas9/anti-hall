'use strict';
// 0.108.5 field defect: `devswarm.js spawn` let hivecontrol branch the child
// from the Primary's LOCAL default branch while it sat 25 commits behind
// origin, so the child ran stale tooling (a deploy script missing a newer CI
// gate). spawn now fetches origin/<default> first and fast-forwards the local
// branch (or refuses) before `hivecontrol workspace create`.
//
// Fixtures: a bare origin + a Primary clone + a second "upstream" clone that
// pushes new commits. hivecontrol is FAKED through ctx.io.run: its `create`
// does what the real app does with the branch NAME it is given — `git worktree
// add -b <child> <path> <sourceBranch>` — so the child's base commit is real.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnsrc-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

// Fixture git runs under an isolated HOME (never the real one).
const GIT_ENV = Object.assign({}, process.env, {
  HOME: LOG_DIR, USERPROFILE: LOG_DIR,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
});
function git(cwd, args) {
  const r = cp.spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
function commit(dir, name) {
  fs.writeFileSync(path.join(dir, name), name);
  git(dir, ['add', name]);
  git(dir, ['commit', '-q', '-m', name]);
  return git(dir, ['rev-parse', 'HEAD']);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnsrc-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const origin = path.join(root, 'origin.git');
  cp.spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  const up = path.join(root, 'upstream');
  cp.spawnSync('git', ['init', '-q', '-b', 'main', up], { env: GIT_ENV });
  commit(up, 'base.txt');
  git(up, ['remote', 'add', 'origin', origin]);
  git(up, ['push', '-q', 'origin', 'main']);
  const primary = path.join(root, 'primary');
  cp.spawnSync('git', ['clone', '-q', origin, primary], { env: GIT_ENV });
  return { root, home, origin, up, primary };
}
// Fake hivecontrol: records calls; `create` branches from the source NAME.
function fakeHive(f) {
  const calls = [];
  const run = ({ args, cwd }) => {
    calls.push(args.slice());
    if (args[0] === 'workspace' && args[1] === 'create') {
      const rest = args.slice(2);
      const child = rest[0];
      const si = rest.indexOf('-s');
      const source = si >= 0 ? rest[si + 1] : 'main'; // env {} => hivecontrol DEFAULT_SOURCE 'main'
      const wt = path.join(f.root, 'wt-' + child.replace(/\W/g, '_'));
      const r = cp.spawnSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', child, wt, source], { encoding: 'utf8', env: GIT_ENV });
      if (r.status !== 0) return { ok: false, error: r.stderr };
      f.childWt = wt;
      return { ok: true, raw: '{}' };
    }
    return { ok: true, raw: '{}' };
  };
  return { calls, run };
}
function spawn(f, argv, hive) {
  return cli.run(['spawn'].concat(argv), { home: f.home, backend: 'journal', env: {}, cwd: f.primary, io: { run: hive.run } }).result;
}
const rm = (f) => { try { fs.rmSync(f.root, { recursive: true, force: true }); } catch (_) {} };
const createCalls = (h) => h.calls.filter((a) => a[1] === 'create');

test('local main behind origin: main is fast-forwarded and the child is based on the origin tip', () => {
  const f = fixture();
  try {
    commit(f.up, 'gate1.txt');
    const tip = commit(f.up, 'gate2.txt');
    git(f.up, ['push', '-q', 'origin', 'main']);
    const stale = git(f.primary, ['rev-parse', 'main']);
    assert.notStrictEqual(stale, tip);
    const h = fakeHive(f);
    const r = spawn(f, ['child-a'], h);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(git(f.childWt, ['rev-parse', 'HEAD']), tip, 'child starts from the origin tip, not the stale local main');
    assert.strictEqual(git(f.primary, ['rev-parse', 'main']), tip, 'local main now at the origin tip');
    assert.strictEqual(r.sourceCheck.status, 'fast-forwarded');
    assert.strictEqual(r.sourceCheck.behind, 2);
  } finally { rm(f); }
});

test('local main behind origin and NOT checked out: fast-forwarded via a guarded ref update', () => {
  const f = fixture();
  try {
    const tip = commit(f.up, 'gate.txt');
    git(f.up, ['push', '-q', 'origin', 'main']);
    git(f.primary, ['checkout', '-q', '-b', 'other']);
    const h = fakeHive(f);
    const r = spawn(f, ['child-b', '-s', 'main'], h);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.sourceCheck.status, 'fast-forwarded');
    assert.strictEqual(git(f.childWt, ['rev-parse', 'HEAD']), tip);
    assert.strictEqual(git(f.primary, ['rev-parse', '--abbrev-ref', 'HEAD']), 'other', 'current branch untouched');
  } finally { rm(f); }
});

test('offline (fetch fails): warns and continues from local main', () => {
  const f = fixture();
  try {
    git(f.primary, ['remote', 'set-url', 'origin', path.join(f.root, 'gone.git')]);
    const local = git(f.primary, ['rev-parse', 'main']);
    const h = fakeHive(f);
    const r = spawn(f, ['child-c'], h);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.sourceCheck.status, 'fetch-failed');
    assert.match(r.sourceCheck.warning, /could not fetch origin\/main/);
    assert.strictEqual(createCalls(h).length, 1);
    assert.strictEqual(git(f.childWt, ['rev-parse', 'HEAD']), local);
  } finally { rm(f); }
});

test('diverged local main: refused without --from-local, hivecontrol never called, nothing rewritten', () => {
  const f = fixture();
  try {
    commit(f.up, 'upstream.txt');
    git(f.up, ['push', '-q', 'origin', 'main']);
    const localOnly = commit(f.primary, 'local.txt');
    const h = fakeHive(f);
    const r = spawn(f, ['child-d'], h);
    assert.strictEqual(createCalls(h).length, 0, 'hivecontrol create must not run');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.sourceCheck.status, 'refused');
    assert.match(r.error, /local main is 1 commit behind origin\/main; spawning from it would give the child outdated tools/);
    assert.match(r.error, /--from-local/);
    assert.strictEqual(git(f.primary, ['rev-parse', 'main']), localOnly, 'local main untouched');
  } finally { rm(f); }
});

test('behind but checked out with local changes: refused, working tree untouched', () => {
  const f = fixture();
  try {
    commit(f.up, 'upstream.txt');
    git(f.up, ['push', '-q', 'origin', 'main']);
    const before = git(f.primary, ['rev-parse', 'main']);
    fs.writeFileSync(path.join(f.primary, 'base.txt'), 'edited');
    const h = fakeHive(f);
    const r = spawn(f, ['child-e'], h);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /with local changes/);
    assert.strictEqual(createCalls(h).length, 0);
    assert.strictEqual(git(f.primary, ['rev-parse', 'main']), before);
    assert.strictEqual(fs.readFileSync(path.join(f.primary, 'base.txt'), 'utf8'), 'edited');
  } finally { rm(f); }
});

test('explicit --from-local: spawns from local main anyway, flag not forwarded to hivecontrol', () => {
  const f = fixture();
  try {
    commit(f.up, 'upstream.txt');
    git(f.up, ['push', '-q', 'origin', 'main']);
    const localOnly = commit(f.primary, 'local.txt');
    const h = fakeHive(f);
    const r = spawn(f, ['child-f', '--from-local', '-p', 'brief'], h);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.sourceCheck.status, 'from-local');
    assert.deepStrictEqual(createCalls(h)[0], ['workspace', 'create', 'child-f', '-p', 'brief']);
    assert.strictEqual(git(f.childWt, ['rev-parse', 'HEAD']), localOnly);
  } finally { rm(f); }
});

test('local main up to date: no change, spawn proceeds', () => {
  const f = fixture();
  try {
    const local = git(f.primary, ['rev-parse', 'main']);
    const reflogBefore = git(f.primary, ['reflog', 'show', '--format=%H', 'main']);
    const h = fakeHive(f);
    const r = spawn(f, ['child-g'], h);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.sourceCheck.status, 'up-to-date');
    assert.strictEqual(git(f.primary, ['rev-parse', 'main']), local);
    assert.strictEqual(git(f.primary, ['reflog', 'show', '--format=%H', 'main']), reflogBefore, 'main ref not rewritten');
    assert.strictEqual(git(f.childWt, ['rev-parse', 'HEAD']), local);
  } finally { rm(f); }
});

test('setting devswarm.spawnFromOrigin=false skips the check (child from local main)', () => {
  const f = fixture();
  try {
    commit(f.up, 'upstream.txt');
    git(f.up, ['push', '-q', 'origin', 'main']);
    const local = git(f.primary, ['rev-parse', 'main']);
    fs.writeFileSync(path.join(f.home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { spawnFromOrigin: false } }));
    const h = fakeHive(f);
    const r = spawn(f, ['child-h'], h);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.sourceCheck.status, 'skipped');
    assert.strictEqual(git(f.childWt, ['rev-parse', 'HEAD']), local);
  } finally { rm(f); }
});
