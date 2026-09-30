'use strict';
// #39 (devswarm.wakeWatchIdleSkip, default true): a Primary with 0 LIVE
// (non-archived) child workspaces gains nothing from an armed wake-watch
// Monitor — nothing will ever message it. `inbox tick` reports
// `watcherArmed: 'idle-skip'` (never the boolean `false`) in that case, so
// the cron prompt's "re-arm if watcherArmed false" rule does not fire, and
// records a `rearm-cues.jsonl` line with trigger 'idle-skip' (see doctor's
// "wake-watch idle-skips: N" line, hooks/doctor.js).
//
// Covers the required matrix: 0 live children -> idle-skip; 1 live child ->
// unchanged; setting off -> unchanged; archived-only children count as 0
// live; a `--child` caller never idle-skips (it covers its own mail, never a
// roster).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-idle-skip-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-idle-skip-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// A REAL linked worktree of `repoDir` — the only shape whose repoKeyForWorktree
// resolves to the SAME value as the main worktree's (shared --git-common-dir),
// which is what hasLiveChild() scopes "a child OF THIS project" on.
function makeChildWorktree(repoDir, tag) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-idle-skip-child-' + tag + '-'));
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

test('#39: 0 live children -> watcherArmed reads "idle-skip", one rearm-cue line (trigger idle-skip)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('zero');
  try {
    register(home, repo, 'primary1');
    const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.watcherArmed, 'idle-skip');
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'primary1');
    assert.strictEqual(rows[0].trigger, 'idle-skip');
  } finally { rm(home); rm(repo); }
});

test('#39: 1 LIVE child -> unchanged (watcherArmed:false, "tick" re-arm cue, not idle-skip)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('one-live');
  const child = makeChildWorktree(repo, 'one-live');
  try {
    register(home, repo, 'primary1');
    register(home, child, 'child1');
    const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.watcherArmed, false);
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].trigger, 'tick');
  } finally { rm(home); rm(repo); }
});

test('#39: devswarm.wakeWatchIdleSkip=false -> unchanged even with 0 live children', () => {
  const home = tmpHome();
  const repo = makeGitRepo('setting-off');
  try {
    register(home, repo, 'primary1');
    const env = { ANTIHALL_DEVSWARM_WAKE_WATCH_IDLE_SKIP: 'false' };
    const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo, env })).result;
    assert.strictEqual(ticked.watcherArmed, false);
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].trigger, 'tick');
  } finally { rm(home); rm(repo); }
});

test('#39: an archived-only child counts as 0 live -> idle-skip fires', () => {
  const home = tmpHome();
  const repo = makeGitRepo('archived-only');
  const child = makeChildWorktree(repo, 'archived-only');
  try {
    register(home, repo, 'primary1');
    register(home, child, 'child1');
    // Sanity: with the live (unarchived) child present, idle-skip must NOT fire.
    const before = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(before.watcherArmed, false, 'sanity: a live child must arm normally before archiving');

    const archived = cli.run(['archive', 'child1'], ctx(home, { cwd: child })).result;
    assert.equal(archived.ok, true, 'archive failed: ' + JSON.stringify(archived));

    const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.watcherArmed, 'idle-skip', 'an archived-only child must count as 0 live children');
  } finally { rm(home); rm(repo); }
});

test('#39: a --child caller never idle-skips (its watcher covers its own mail, not a roster)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('child-caller');
  try {
    register(home, repo, 'child1');
    const ticked = cli.run(['inbox', 'tick', 'child1', '--child'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.watcherArmed, false, '--child must keep the plain boolean, never "idle-skip"');
    const rows = rearmCueRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].trigger, 'tick');
  } finally { rm(home); rm(repo); }
});
