'use strict';
// Field report fix (mirrors #39's idle-skip): while LIMIT CONSERVATION is
// active (hooks/limit-conserve.js isConserving().active), re-arming a lapsed
// Monitor wake-watch is exactly the non-urgent background work that mode
// already tells the agent to defer — the cron prompt's "re-arm if
// watcherArmed false" instruction directly contradicted it. `inbox tick`
// now reports `watcherArmed: 'limit-skip'` (never the boolean `false`) while
// conservation is active, and records a `rearm-cues.jsonl` line with trigger
// 'limit-skip' (see doctor's "wake-watch limit-skips: N" line).
//
// isConserving() reads process.env directly (no injectable env param), so
// these tests mutate process.env.ANTIHALL_LIMIT_CONSERVE and restore it.
//
// Covers: limit conservation active + a live child (idle-skip does NOT fire)
// -> limit-skip; limit conservation inactive -> unchanged; idle-skip takes
// priority over limit-skip when both conditions hold (0 live children).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-limit-skip-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-limit-skip-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function makeChildWorktree(repoDir, tag) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-limit-skip-child-' + tag + '-'));
  fs.rmSync(wt, { recursive: true, force: true });
  const r = cp.spawnSync('git', ['-C', repoDir, 'worktree', 'add', '-q', wt, '-b', 'child-' + tag]);
  assert.strictEqual(r.status, 0, 'git worktree add failed: ' + r.stderr);
  return wt;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, worktreeDir, id, over) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const flags = ['register', id, '--worktree', worktreeDir, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath];
  const r = cli.run(flags, Object.assign(ctx(home, { cwd: worktreeDir }), over || {}));
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}

function rearmCuesFile(home) { return path.join(home, '.anti-hall', 'devswarm', 'rearm-cues.jsonl'); }
function rearmCueRows(home) {
  try { return fs.readFileSync(rearmCuesFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
}

function withLimitConserve(mode, fn) {
  const prev = process.env.ANTIHALL_LIMIT_CONSERVE;
  process.env.ANTIHALL_LIMIT_CONSERVE = mode;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.ANTIHALL_LIMIT_CONSERVE;
    else process.env.ANTIHALL_LIMIT_CONSERVE = prev;
  }
}

test('limit-skip: conservation active + a live child -> watcherArmed reads "limit-skip", rearm-cue trigger limit-skip', () => {
  const home = tmpHome();
  const repo = makeGitRepo('active-live');
  const child = makeChildWorktree(repo, 'active-live');
  try {
    register(home, repo, 'primary1');
    register(home, child, 'child1');
    withLimitConserve('on', () => {
      const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
      assert.strictEqual(ticked.watcherArmed, 'limit-skip');
    });
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'primary1');
    assert.strictEqual(rows[0].trigger, 'limit-skip');
  } finally { rm(home); rm(repo); }
});

test('limit-skip: conservation inactive -> unchanged (watcherArmed:false, "tick" re-arm cue)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('inactive');
  const child = makeChildWorktree(repo, 'inactive');
  try {
    register(home, repo, 'primary1');
    register(home, child, 'child1');
    withLimitConserve('off', () => {
      const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
      assert.strictEqual(ticked.watcherArmed, false);
    });
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].trigger, 'tick');
  } finally { rm(home); rm(repo); }
});

test('limit-skip: idle-skip takes priority over limit-skip when both conditions hold (0 live children)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('both');
  try {
    register(home, repo, 'primary1');
    withLimitConserve('on', () => {
      const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
      assert.strictEqual(ticked.watcherArmed, 'idle-skip', 'idle-skip must win — 0 live children needs no watcher regardless of conservation');
    });
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].trigger, 'idle-skip');
  } finally { rm(home); rm(repo); }
});

test('limit-skip: a --child caller ALSO gets limit-skip (unlike idle-skip, not gated on isChildFlag — deferring its own watcher re-arm is still non-urgent work)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('child-caller');
  try {
    register(home, repo, 'child1');
    withLimitConserve('on', () => {
      const ticked = cli.run(['inbox', 'tick', 'child1', '--child'], ctx(home, { cwd: repo })).result;
      assert.strictEqual(ticked.watcherArmed, 'limit-skip');
    });
  } finally { rm(home); rm(repo); }
});
