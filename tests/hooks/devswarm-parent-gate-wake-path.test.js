'use strict';
// devswarm-parent-gate.js — a Primary with live children and NO wake path (no
// live watcher AND no recent inbox tick) is blocked from stopping, bounded by
// the gate's own per-signature cap (devswarm.parentGateCap). Real spawned hook,
// isolated HOME, temp repo + child worktree.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { switchOff } = require('../helpers/settings-switch.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const installIngest = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const { resolveContext } = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
const { lockPathFor } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js'));

const HOOK = 'devswarm-parent-gate.js';
const CLAUDE_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_AI_AGENT: 'claude' };

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gwp-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function setup({ child = true } = {}) {
  const home = tmp('home');
  const repo = tmp('repo');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'i']);
  const top = resolveContext(repo, { home, missingPath: 'ancestor' }).worktreeRoot;
  const id = installIngest.primaryWorkspaceId(top);
  if (child) {
    const wt = tmp('child');
    fs.rmSync(wt, { recursive: true, force: true });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'c-' + path.basename(wt)]);
    // A fully caught-up child (empty inbox, cursor 0) so only the wake-path condition can block.
    const root = path.join(home, '.anti-hall', 'devswarm');
    const inboxPath = path.join(root, 'inbox', 'child1.ndjson');
    const cursorPath = path.join(root, 'cursor', 'child1.json');
    fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(inboxPath, '');
    fs.writeFileSync(cursorPath, '0');
    fs.writeFileSync(path.join(root, 'workspaces', 'child1.json'),
      JSON.stringify({ id: 'child1', worktreePath: wt, sessionId: 's-child1', inboxPath, cursorPath }));
  }
  return { home, repo, id, cleanup() { rm(home); rm(repo); } };
}
function stop(s, extra) {
  const o = extra || {};
  return testHook(HOOK, { hook_event_name: 'Stop', session_id: 'gsess', cwd: s.repo, stop_hook_active: false },
    { home: s.home, env: Object.assign({ ANTIHALL_INGEST_DRY_RUN: '1' }, CLAUDE_ENV, o.env || {}) });
}
function writeLock(s) {
  const p = lockPathFor(s.home, s.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), pid: process.pid }));
}
function writeTick(s, ageMin) {
  const dir = path.join(s.home, '.anti-hall', 'devswarm', 'wake-tick');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, s.id + '.json'), JSON.stringify({ ts: Date.now() - ageMin * 60000 }));
}
function blocked(r) { return !!(r.json && r.json.decision === 'block'); }

test('live child + no watcher + no tick -> blocks the Stop with the NO MAILBOX WAKE PATH text', () => {
  const s = setup();
  try {
    const r = stop(s);
    assert.ok(blocked(r), 'stdout=' + r.stdout + ' stderr=' + r.stderr);
    assert.ok(r.json.reason.startsWith('NO MAILBOX WAKE PATH:'), r.json.reason);
    assert.ok(r.json.reason.includes('inbox tick ' + s.id + ' --quiet'), r.json.reason);
  } finally { s.cleanup(); }
});

test('respects the per-signature cap: parentGateCap blocks, then quiet (never a hard loop)', () => {
  const s = setup();
  try {
    let n = 0;
    for (let i = 0; i < 8; i++) { if (blocked(stop(s))) n++; }
    assert.strictEqual(n, 3, 'default devswarm.parentGateCap is 3');
  } finally { s.cleanup(); }
});

test('stop_hook_active (already continuing because of a block) -> allowed', () => {
  const s = setup();
  try {
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: 'gsess', cwd: s.repo, stop_hook_active: true },
      { home: s.home, env: CLAUDE_ENV });
    assert.ok(!blocked(r));
  } finally { s.cleanup(); }
});

test('one path present (live watcher OR fresh tick) -> no block', () => {
  const s = setup();
  try {
    writeLock(s);
    assert.ok(!blocked(stop(s)), 'watcher live, tick absent');
  } finally { s.cleanup(); }
  const s2 = setup();
  try {
    writeTick(s2, 5);
    assert.ok(!blocked(stop(s2)), 'tick fresh, no watcher');
  } finally { s2.cleanup(); }
});

test('no live children -> never blocks, even with no watcher and no tick', () => {
  const s = setup({ child: false });
  try {
    assert.ok(!blocked(stop(s)));
  } finally { s.cleanup(); }
});

test('devswarm.parentGate off, a non-Claude agent, and a child session are all unaffected', () => {
  const s = setup();
  try {
    switchOff(s.home, 'devswarm', 'parentGate');
    assert.ok(!blocked(stop(s)), 'parentGate off');
    fs.rmSync(path.join(s.home, '.anti-hall', 'settings.json'));
    assert.ok(!blocked(stop(s, { env: { DEVSWARM_AI_AGENT: 'codex' } })), 'codex has no CronCreate/Monitor');
    assert.ok(!blocked(stop(s, { env: { DEVSWARM_SOURCE_BRANCH: 'main' } })), 'child session');
  } finally { s.cleanup(); }
});

test('the gap closing clears the budget: after a tick lands the state resets and a later gap blocks afresh', () => {
  const s = setup();
  try {
    assert.ok(blocked(stop(s)));
    writeTick(s, 5);
    assert.ok(!blocked(stop(s)), 'healthy pass');
    fs.rmSync(path.join(s.home, '.anti-hall', 'devswarm', 'wake-tick'), { recursive: true, force: true });
    assert.ok(blocked(stop(s)), 'fresh budget for a new gap');
  } finally { s.cleanup(); }
});
