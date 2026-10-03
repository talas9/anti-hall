'use strict';
// An ARCHIVED child's wake-watch must stay silent (every stdout line is a wake
// event; an archived child has nothing to act on — field report: 32 turns of
// "no mail, workspace is archived" after archive). It stays alive (lock fresh,
// no re-arm loop) and resumes normal output once the descriptor is restored.
// Active children and Primaries are unaffected. Home is isolated via HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js');
const { isOwnChildArchived } = require(MODULE_PATH);

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-archived-')); }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-archived-repo-' + tag + '-'));
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function dsRoot(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function writeDescriptor(home, kind, id, wt) {
  const dir = path.join(dsRoot(home), kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, worktreePath: wt, sessionId: 's-' + id }));
}

// Runs the watcher for `ms`, returns { stdout, alive } then kills it.
function runFor(env, cwd, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MODULE_PATH], { env, cwd });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', () => {});
    setTimeout(() => {
      const alive = child.exitCode === null && child.signalCode === null;
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ stdout, alive });
    }, ms);
  });
}

function childEnv(home, id, extra) {
  return Object.assign({
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: id,
    ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '250',
  }, extra || {});
}

test('archived child (descriptor only under archived/) -> watcher prints NOTHING and stays alive', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('arch');
  try {
    writeDescriptor(home, 'archived', 'kid1', repo);
    const res = await runFor(childEnv(home, 'kid1'), repo, 3000);
    assert.strictEqual(res.stdout, '', 'an archived child watcher must emit no stdout line; got ' + JSON.stringify(res.stdout));
    assert.strictEqual(res.alive, true, 'it must stay alive (silent), not exit and invite a re-arm');
  } finally { rm(home); rm(repo); }
});

test('active child (descriptor under workspaces/) -> arms and emits as before', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('active');
  try {
    writeDescriptor(home, 'workspaces', 'kid2', repo);
    const res = await runFor(childEnv(home, 'kid2'), repo, 3000);
    assert.match(res.stdout, /\[wake-watch\] armed: watching child kid2/);
  } finally { rm(home); rm(repo); }
});

test('restored child (marker removed) -> emits as before', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('restored');
  try {
    writeDescriptor(home, 'archived', 'kid3', repo);
    assert.strictEqual(isOwnChildArchived({ role: 'child', id: 'kid3', home, cwd: repo }, { HOME: home }), true);
    fs.unlinkSync(path.join(dsRoot(home), 'archived', 'kid3.json'));
    writeDescriptor(home, 'workspaces', 'kid3', repo);
    assert.strictEqual(isOwnChildArchived({ role: 'child', id: 'kid3', home, cwd: repo }, { HOME: home }), false);
    const res = await runFor(childEnv(home, 'kid3'), repo, 3000);
    assert.match(res.stdout, /\[wake-watch\] armed: watching child kid3/);
  } finally { rm(home); rm(repo); }
});

test('devswarm.archivedChildStop=false -> an archived child watcher behaves as before (arms)', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('off');
  try {
    writeDescriptor(home, 'archived', 'kid4', repo);
    const res = await runFor(childEnv(home, 'kid4', { ANTIHALL_DEVSWARM_ARCHIVED_CHILD_STOP: 'false' }), repo, 3000);
    assert.match(res.stdout, /\[wake-watch\] armed: watching child kid4/);
  } finally { rm(home); rm(repo); }
});

test('Primary is unaffected: isOwnChildArchived is false for a primary identity even with an archived marker', () => {
  const home = tmpHome();
  const repo = makeGitRepo('primary');
  try {
    writeDescriptor(home, 'archived', 'primary-abc12345', repo);
    assert.strictEqual(isOwnChildArchived({ role: 'primary', id: 'primary-abc12345', home, cwd: repo }, { HOME: home }), false);
  } finally { rm(home); rm(repo); }
});
