'use strict';
// devswarm.tickRosterEvery (default 0 = off): every Nth `inbox tick --quiet` of a
// Primary appends the compact roster table AFTER the unchanged first line, only when
// unread is 0 and a live child is proven. The JSON form of tick never changes.
// --quiet is the cron-prompt rendering of tick (one line); the roster is part of that
// human rendering only, so no --quiet (JSON) and --child ticks never carry it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require(path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-roster-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-roster-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function makeChildWorktree(repoDir, tag) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-tick-roster-child-' + tag + '-'));
  fs.rmSync(wt, { recursive: true, force: true });
  const r = cp.spawnSync('git', ['-C', repoDir, 'worktree', 'add', '-q', wt, '-b', 'child-' + tag]);
  assert.strictEqual(r.status, 0, 'git worktree add failed: ' + r.stderr);
  return wt;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});
function register(home, worktreeDir, id) {
  const flags = ['register', id, '--worktree', worktreeDir, '--session', 's-' + id,
    '--inbox', path.join(home, 'descriptor-inboxes', id + '.ndjson'), '--cursor', path.join(home, 'descriptor-cursors', id + '.cursor')];
  const r = cli.run(flags, ctx(home, { cwd: worktreeDir }));
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}
const FIRST = 'tick primary1: unread 0, known true, meshGap false, watcherArmed false';
const EVERY2 = { ANTIHALL_DEVSWARM_TICK_ROSTER_EVERY: '2' };
// Run `inbox tick --quiet` the way main() renders it.
function quiet(home, cwd, env, extra) {
  const r = cli.run(['inbox', 'tick', 'primary1', '--quiet'].concat(extra || []), ctx(home, { cwd, env })).result;
  return { r, text: cli.inboxTickQuietLine(r) };
}

test('every 2nd quiet tick appends the roster after the unchanged first line; other ticks are one line', () => {
  const home = tmpHome(); const repo = makeGitRepo('a'); const child = makeChildWorktree(repo, 'a');
  try {
    register(home, repo, 'primary1'); register(home, child, 'child1');
    const t1 = quiet(home, repo, EVERY2);
    assert.strictEqual(t1.text, FIRST);
    const t2 = quiet(home, repo, EVERY2);
    const lines = t2.text.split('\n');
    assert.strictEqual(lines[0], FIRST, 'first line byte-identical');
    assert.ok(lines.length > 2, t2.text);
    assert.match(t2.text, /\| workspace \| status \| finish \| unread \| last \|/);
    assert.match(t2.text, /child1/);
    assert.strictEqual(quiet(home, repo, EVERY2).text, FIRST);
    assert.ok(quiet(home, repo, EVERY2).text.includes('| workspace |'), '4th tick');
  } finally { rm(home); rm(repo); rm(child); }
});

test('a non-quiet (JSON) tick between quiet ticks does not reset the roster counter', () => {
  const home = tmpHome(); const repo = makeGitRepo('s'); const child = makeChildWorktree(repo, 's');
  try {
    register(home, repo, 'primary1'); register(home, child, 'child1');
    assert.strictEqual(quiet(home, repo, EVERY2).text, FIRST); // quiet tick 1
    cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo, env: EVERY2 })); // JSON tick rewrites the marker
    assert.ok(quiet(home, repo, EVERY2).text.includes('| workspace |'), 'quiet tick 2 still lands on the Nth tick');
  } finally { rm(home); rm(repo); rm(child); }
});

test('setting 0 (default): never appended', () => {
  const home = tmpHome(); const repo = makeGitRepo('b'); const child = makeChildWorktree(repo, 'b');
  try {
    register(home, repo, 'primary1'); register(home, child, 'child1');
    for (let i = 0; i < 4; i++) assert.strictEqual(quiet(home, repo, {}).text, FIRST);
    for (let i = 0; i < 4; i++) assert.strictEqual(quiet(home, repo, { ANTIHALL_DEVSWARM_TICK_ROSTER_EVERY: '0' }).text, FIRST);
  } finally { rm(home); rm(repo); rm(child); }
});

test('no live child (only the Primary, or only an archived child): never appended', () => {
  const home = tmpHome(); const repo = makeGitRepo('c'); const child = makeChildWorktree(repo, 'c');
  try {
    register(home, repo, 'primary1');
    for (let i = 0; i < 4; i++) assert.strictEqual(quiet(home, repo, EVERY2).text.split('\n')[0].startsWith('tick primary1:'), true);
    for (let i = 0; i < 4; i++) assert.ok(!quiet(home, repo, EVERY2).text.includes('| workspace |'));
    register(home, child, 'child1');
    assert.equal(cli.run(['archive', 'child1'], ctx(home, { cwd: child })).result.ok, true);
    for (let i = 0; i < 4; i++) assert.ok(!quiet(home, repo, EVERY2).text.includes('| workspace |'));
  } finally { rm(home); rm(repo); rm(child); }
});

test('JSON form (no --quiet) is never changed; --child ticks never carry the roster', () => {
  const home = tmpHome(); const repo = makeGitRepo('d'); const child = makeChildWorktree(repo, 'd');
  try {
    register(home, repo, 'primary1'); register(home, child, 'child1');
    for (let i = 0; i < 4; i++) {
      const r = cli.run(['inbox', 'tick', 'primary1'], ctx(home, { cwd: repo, env: EVERY2 })).result;
      assert.ok(!('rosterText' in r) && !JSON.stringify(r).includes('rosterText'));
      assert.strictEqual(r.seq, undefined);
    }
    for (let i = 0; i < 4; i++) {
      const r = cli.run(['inbox', 'tick', 'child1', '--child', '--quiet'], ctx(home, { cwd: child, env: EVERY2 })).result;
      assert.ok(!cli.inboxTickQuietLine(r).includes('| workspace |'));
    }
  } finally { rm(home); rm(repo); rm(child); }
});

test('unread > 0 on the Nth tick: no roster', () => {
  const home = tmpHome(); const repo = makeGitRepo('e'); const child = makeChildWorktree(repo, 'e');
  try {
    register(home, repo, 'primary1'); register(home, child, 'child1');
    const s = cli.run(['send', '--to', 'primary1', '--message', 'hello'], ctx(home, { cwd: child })).result;
    assert.equal(s.ok, true, JSON.stringify(s));
    quiet(home, repo, EVERY2);
    const t2 = quiet(home, repo, EVERY2);
    assert.match(t2.text.split('\n')[0], /^tick primary1: unread [1-9]/, t2.text);
    assert.strictEqual(t2.text.split('\n').length, 1, t2.text);
  } finally { rm(home); rm(repo); rm(child); }
});

test('schema parity for devswarm.tickRosterEvery (settings file + env only, no /config row)', () => {
  const plugin = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const e = require(path.join(plugin, 'hooks', 'lib', 'settings-schema.js')).findSetting('devswarm', 'tickRosterEvery');
  assert.ok(e);
  assert.deepStrictEqual([e.default, e.env, e.min], [0, 'ANTIHALL_DEVSWARM_TICK_ROSTER_EVERY', 0]);
});
