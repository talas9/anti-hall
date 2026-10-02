'use strict';
// `devswarm.js spawn <new> --source <branch>`: a one-line warning (output only)
// when --source is a non-default branch that already has a workspace in the
// DevSwarm app (active or archived). Silent for the default branch, for a source
// with no workspace, and when the lookup throws.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnnote-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const { sourceWorkspaceNote } = require('../../plugins/anti-hall/scripts/devswarm-lib/spawn.js');

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
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnnote-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const origin = path.join(root, 'origin.git');
  cp.spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  const up = path.join(root, 'upstream');
  cp.spawnSync('git', ['init', '-q', '-b', 'main', up], { env: GIT_ENV });
  fs.writeFileSync(path.join(up, 'base.txt'), 'base');
  git(up, ['add', 'base.txt']);
  git(up, ['commit', '-q', '-m', 'base']);
  git(up, ['remote', 'add', 'origin', origin]);
  git(up, ['push', '-q', 'origin', 'main']);
  const primary = path.join(root, 'primary');
  cp.spawnSync('git', ['clone', '-q', origin, primary], { env: GIT_ENV });
  return { root, home, primary };
}
const rm = (f) => { try { fs.rmSync(f.root, { recursive: true, force: true }); } catch (_) {} };

// A fake app-DB snapshot: one repository rooted at `primary`, plus the given builders.
function snapshotFor(f, builders) {
  const repoPath = fs.realpathSync(f.primary);
  return () => ({ ok: true, repositories: [{ id: 'r1', path: repoPath, name: 'repo' }], workspaces: builders });
}
const NOTE = (b) => 'note: --source ' + b + ' already has a workspace; the DevSwarm app may show the new workspace nested under it.';

test('warns when --source is a non-default branch that already has a workspace (active)', () => {
  const f = fixture();
  try {
    const io = { appSnapshot: snapshotFor(f, [{ id: 'b1', repositoryId: 'r1', branchName: 'feat-x', archived: false }]) };
    assert.strictEqual(sourceWorkspaceNote(['child', '--source', 'feat-x'], { home: f.home, env: {}, cwd: f.primary, io }), NOTE('feat-x'));
  } finally { rm(f); }
});

test('warns for an ARCHIVED workspace on the source branch too, and for the -s / --source= spellings', () => {
  const f = fixture();
  try {
    const io = { appSnapshot: snapshotFor(f, [{ id: 'b1', repositoryId: 'r1', branchName: 'feat-x', archived: true }]) };
    const ctx = { home: f.home, env: {}, cwd: f.primary, io };
    assert.strictEqual(sourceWorkspaceNote(['child', '-s', 'feat-x'], ctx), NOTE('feat-x'));
    assert.strictEqual(sourceWorkspaceNote(['child', '--source=feat-x'], ctx), NOTE('feat-x'));
  } finally { rm(f); }
});

test('silent for the repository default branch, even when a workspace exists on it', () => {
  const f = fixture();
  try {
    const io = { appSnapshot: snapshotFor(f, [{ id: 'b1', repositoryId: 'r1', branchName: 'main', archived: false }]) };
    assert.strictEqual(sourceWorkspaceNote(['child', '--source', 'main'], { home: f.home, env: {}, cwd: f.primary, io }), null);
  } finally { rm(f); }
});

test('silent for a source branch with no workspace (and for a same-named branch in another repository)', () => {
  const f = fixture();
  try {
    const io = { appSnapshot: snapshotFor(f, [
      { id: 'b1', repositoryId: 'r1', branchName: 'other', archived: false },
      { id: 'b2', repositoryId: 'r2', branchName: 'feat-x', archived: false },
    ]) };
    assert.strictEqual(sourceWorkspaceNote(['child', '--source', 'feat-x'], { home: f.home, env: {}, cwd: f.primary, io }), null);
  } finally { rm(f); }
});

test('silent when no --source is given', () => {
  const f = fixture();
  try {
    const io = { appSnapshot: snapshotFor(f, [{ id: 'b1', repositoryId: 'r1', branchName: 'feat-x', archived: false }]) };
    assert.strictEqual(sourceWorkspaceNote(['child'], { home: f.home, env: {}, cwd: f.primary, io }), null);
  } finally { rm(f); }
});

test('silent when the lookup throws or returns nothing', () => {
  const f = fixture();
  try {
    const boom = { appSnapshot: () => { throw new Error('app db unreadable'); } };
    assert.strictEqual(sourceWorkspaceNote(['child', '--source', 'feat-x'], { home: f.home, env: {}, cwd: f.primary, io: boom }), null);
    const none = { appSnapshot: () => null };
    assert.strictEqual(sourceWorkspaceNote(['child', '--source', 'feat-x'], { home: f.home, env: {}, cwd: f.primary, io: none }), null);
  } finally { rm(f); }
});

function fakeCreate(f) {
  return ({ args, cwd }) => {
    if (args[0] === 'workspace' && args[1] === 'create') {
      const child = args[2];
      const wt = path.join(f.root, 'wt-' + child.replace(/\W/g, '_'));
      const r = cp.spawnSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', child, wt, 'main'], { encoding: 'utf8', env: GIT_ENV });
      if (r.status !== 0) return { ok: false, error: r.stderr };
      return { ok: true, raw: JSON.stringify({ path: wt }), stderr: '' };
    }
    return { ok: true, raw: '{}' };
  };
}

test('cmdSpawn: the note rides in the result `warnings` and does not change ok/created', () => {
  const f = fixture();
  try {
    const io = { run: fakeCreate(f), appSnapshot: snapshotFor(f, [{ id: 'b1', repositoryId: 'r1', branchName: 'feat-x', archived: false }]) };
    const r = cli.run(['spawn', 'child-n', '--source', 'feat-x'], { home: f.home, backend: 'journal', env: {}, cwd: f.primary, io }).result;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.created, true);
    assert.deepStrictEqual(r.warnings, [NOTE('feat-x')]);
  } finally { rm(f); }
});

test('cmdSpawn: no warnings field when the source has no workspace', () => {
  const f = fixture();
  try {
    const io = { run: fakeCreate(f), appSnapshot: snapshotFor(f, []) };
    const r = cli.run(['spawn', 'child-m', '--source', 'feat-x'], { home: f.home, backend: 'journal', env: {}, cwd: f.primary, io }).result;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.warnings, undefined);
  } finally { rm(f); }
});
