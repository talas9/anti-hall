'use strict';
// git-guard: the block message names the command that actually carries the
// AI self-credit. The commit rule and the gh rule both scan the WHOLE raw
// command, so a clean `git commit` chained with a `gh pr create --body` that
// holds the robot footer used to say the COMMIT carried the trailer (field,
// 2026-10-07). The verdict (block) never changes; only the named offender does.
// Every case goes through the real hook entry with an isolated HOME. Credit
// strings are assembled from pieces so this file never trips the guard itself.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const home = makeHome();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gg-attr-'));
after(() => { fs.rmSync(work, { recursive: true, force: true }); home.cleanup(); });

const FOOTER = '\u{1F916} Generated with [Claude' + ' Code](https://claude.com/claude-code)';
const TRAILER = 'Co-Authored' + '-By: Claude <noreply@anthropic.com>';

function run(cmd) {
  const payload = bashPayload(cmd);
  payload.cwd = work;
  return testHook('git-guard.js', payload, { home: home.home, env: {} });
}

test('clean commit chained with a gh body that holds the footer: names the gh command, not the commit', () => {
  const r = run(`git commit -m 'fix: clean' && gh pr create --title t --body 'body\n\n${FOOTER}'`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /`gh pr create`/);
  assert.match(r.stderr, /not in the commit message/);
  assert.doesNotMatch(r.stderr, /creates a commit \(git commit\) and carries/);
});

test('clean gh body chained with a commit that holds the trailer: names the git commit, not the gh body', () => {
  const r = run(`gh pr create --title t --body 'clean body' && git commit -m 'fix: x\n\n${TRAILER}'`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /`git commit`/);
  assert.match(r.stderr, /not in the gh body or title/);
});

test('credit in the commit own message keeps the plain commit message', () => {
  const r = run(`git commit -m 'fix: x\n\n${TRAILER}'`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /commit message with an AI\/assistant self-credit/);
  assert.doesNotMatch(r.stderr, /is chained with/);
});

test('credit reaching git through a pipe keeps the plain whole-command message', () => {
  const r = run(`echo '${TRAILER}' | git commit -F -`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /is chained with/);
});

test('credit in the gh body alone keeps the plain gh message', () => {
  const r = run(`gh pr create --title t --body 'body\n\n${FOOTER}'`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /gh pr\/issue\/release body or title carries/);
  assert.doesNotMatch(r.stderr, /is chained with/);
});

test('both the commit and the gh body carry credit: still blocked, plain wording for the commit', () => {
  const r = run(`git commit -m 'fix: x\n\n${TRAILER}' && gh pr create --title t --body '${FOOTER}'`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /is chained with/);
});

test('clean chain is still allowed', () => {
  const r = run(`git commit -m 'fix: clean' && gh pr create --title t --body 'a clean body'`);
  assert.strictEqual(r.status, 0, r.stderr);
});
