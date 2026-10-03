'use strict';
// `inbox tick --child` for an ARCHIVED child reports `watcherArmed: 'archived-skip'`
// (never the boolean `false`), so the cron prompt's "re-arm only if `false`" does
// nothing — the child's wake-watch deliberately stays silent while archived
// (companion/lib/devswarm-wake-watch.js isOwnChildArchived). unread/meshGap are
// still reported. Active child and Primary ticks are unchanged; the existing
// devswarm.archivedChildStop switch turns it off. Home is isolated via ctx.home.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require(path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-archived-skip-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-archived-skip-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});
function register(home, worktreeDir, id) {
  const flags = ['register', id, '--worktree', worktreeDir, '--session', 's-' + id,
    '--inbox', path.join(home, 'descriptor-inboxes', id + '.ndjson'), '--cursor', path.join(home, 'descriptor-cursors', id + '.cursor')];
  const r = cli.run(flags, ctx(home, { cwd: worktreeDir }));
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}
function cueRows(home) {
  try { return fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'rearm-cues.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
}

test('archived child: tick --child -> watcherArmed "archived-skip", never false; quiet line renders it', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'kid1');
    assert.strictEqual(cli.run(['inbox', 'tick', 'kid1', '--child'], ctx(home, { cwd: repo })).result.watcherArmed, false, 'sanity: active child reads false');
    const archived = cli.run(['archive', 'kid1'], ctx(home, { cwd: repo })).result;
    assert.equal(archived.ok, true, JSON.stringify(archived));
    const ticked = cli.run(['inbox', 'tick', 'kid1', '--child'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.watcherArmed, 'archived-skip');
    assert.strictEqual(cueRows(home).filter((r) => r.trigger === 'archived-skip').length, 1);
    const { inboxTickQuietLine } = require(path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm-lib/inbox-cmd.js'));
    assert.match(inboxTickQuietLine({ ok: true, id: 'kid1', unreadTotal: 2, known: true, meshGapWithheld: false, watcherArmed: 'archived-skip' }), /unread 2, known true, meshGap false, watcherArmed archived-skip$/);
  } finally { rm(home); rm(repo); }
});

test('archived child with devswarm.archivedChildStop=false -> unchanged (watcherArmed false)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('off');
  try {
    register(home, repo, 'kid2');
    cli.run(['archive', 'kid2'], ctx(home, { cwd: repo }));
    const ticked = cli.run(['inbox', 'tick', 'kid2', '--child'], ctx(home, { cwd: repo, env: { ANTIHALL_DEVSWARM_ARCHIVED_CHILD_STOP: 'false' } })).result;
    assert.strictEqual(ticked.watcherArmed, false);
  } finally { rm(home); rm(repo); }
});

test('twin state (archived marker + ACTIVE descriptor): tick --child is NOT archived-skip', () => {
  const home = tmpHome();
  const repo = makeGitRepo('twin');
  try {
    register(home, repo, 'kid3');
    const adir = path.join(home, '.anti-hall', 'devswarm', 'archived');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, 'kid3.json'), JSON.stringify({ id: 'kid3', worktreePath: repo, sessionId: 's-kid3' }));
    const ticked = cli.run(['inbox', 'tick', 'kid3', '--child'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.watcherArmed, false, 'a live child must keep the normal re-arm signal');
  } finally { rm(home); rm(repo); }
});

test('Primary tick is unaffected by an archived marker (no --child)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p');
  try {
    register(home, repo, 'primary1');
    const ticked = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo })).result;
    assert.notStrictEqual(ticked.watcherArmed, 'archived-skip');
  } finally { rm(home); rm(repo); }
});
