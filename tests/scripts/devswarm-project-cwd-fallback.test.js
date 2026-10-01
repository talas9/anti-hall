'use strict';
// A Primary usually has no DEVSWARM_BUILDER_ID. When its cwd is not a git
// worktree (e.g. the session scratchpad), projectCwdFor falls back to
// CLAUDE_PROJECT_DIR — fail-closed: absolute, exists, resolves to a worktree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-pcwd-log-'));

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-pcwd-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeRepo() {
  const dir = tmp('repo');
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function setup() {
  const home = tmp('home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const scratch = tmp('scratch'); // not a git worktree
  return { home, scratch };
}
const run = (argv, home, cwd, env) => cli.run(argv, { home, backend: 'journal', cwd, env });
const SEND = ['send', '--to', 'primary-deadbeef', '--message', 'hi'];

test('Primary with scratch cwd + CLAUDE_PROJECT_DIR=<repo>: mesh read and send resolve the project', () => {
  const { home, scratch } = setup(); const repo = makeRepo();
  try {
    const r = run(['mesh', 'read', '--peek'], home, scratch, { CLAUDE_PROJECT_DIR: repo });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    const s = run(SEND, home, scratch, { CLAUDE_PROJECT_DIR: repo });
    assert.notEqual(s.result.reason, 'no-project', JSON.stringify(s.result));
  } finally { rm(home); rm(scratch); rm(repo); }
});

test('scratch cwd without CLAUDE_PROJECT_DIR still returns no-project', () => {
  const { home, scratch } = setup();
  try {
    assert.equal(run(SEND, home, scratch, {}).result.reason, 'no-project');
    assert.equal(run(['mesh', 'read', '--peek'], home, scratch, {}).result.reason, 'no-project');
  } finally { rm(home); rm(scratch); }
});

test('CLAUDE_PROJECT_DIR pointing at a non-worktree (or a relative/missing path) still returns no-project', () => {
  const { home, scratch } = setup(); const other = tmp('other');
  try {
    for (const bad of [other, 'relative/path', path.join(other, 'missing')]) {
      assert.equal(run(SEND, home, scratch, { CLAUDE_PROJECT_DIR: bad }).result.reason, 'no-project', bad);
      assert.equal(run(['mesh', 'read', '--peek'], home, scratch, { CLAUDE_PROJECT_DIR: bad }).result.reason, 'no-project', bad);
    }
  } finally { rm(home); rm(scratch); rm(other); }
});

test('a cwd that IS a worktree wins over CLAUDE_PROJECT_DIR (ground truth first)', () => {
  const { home, scratch } = setup(); const repoA = makeRepo(); const repoB = makeRepo();
  try {
    const a = run(['mesh', 'read', '--peek'], home, repoA, { CLAUDE_PROJECT_DIR: repoB });
    assert.equal(a.result.ok, true, JSON.stringify(a.result));
    assert.equal(a.result.from, run(['mesh', 'read', '--peek'], home, repoA, {}).result.from);
  } finally { rm(home); rm(scratch); rm(repoA); rm(repoB); }
});
