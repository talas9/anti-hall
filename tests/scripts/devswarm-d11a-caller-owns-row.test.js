'use strict';
// D11-A (P0 fix): callerOwnsRow's clause 3 ("sole row for the caller's own
// worktree") used to return true unconditionally once it found exactly one
// registry row sharing the caller's canonical worktree — with NO check that
// the row was actually the caller's OWN unclaimed placeholder. A lone
// CLAIMED foreign row sharing the caller's worktree (a genuinely different,
// already-registered session on the same checkout — plausible e.g. right
// after a repo is cloned into a second location, or a stale duplicate that
// legitimately survived a retire) satisfied "sole row on this worktree" just
// as well, letting a caller stamp its own sessionId onto a row it does not
// own (maybePromoteUnclaimed is gated on this exact function).
//
// Fix: clause 3 now additionally requires the sole row's own sessionId to be
// empty/`unclaimed:`-prefixed before granting ownership.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-cor-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-cor-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const mkCtx = (home, repo, over) => Object.assign({ home, backend: 'journal', env: {}, cwd: repo }, over || {});
function register(home, repo, id, sessionId) {
  const inboxPath = path.join(home, 'di', id + '.ndjson');
  const cursorPath = path.join(home, 'dc', id + '.cursor');
  const r = cli.run(['register', id, '--worktree', repo, '--session', sessionId,
    '--inbox', inboxPath, '--cursor', cursorPath], mkCtx(home, repo));
  assert.ok(r.result.ok, 'register ' + id + ': ' + JSON.stringify(r.result));
}

test('D11-A: callerOwnsRow clause 3 refuses a lone CLAIMED foreign row on the caller\'s own worktree', () => {
  const home = tmpHome();
  const repo = makeGitRepo('claimed');
  try {
    const foreignId = 'foreign-claimed-row';
    // The ONLY row registered on this worktree — but it is CLAIMED (a real,
    // non-synthetic sessionId), not an unclaimed placeholder. The caller
    // itself (whatever id `callerIdentity` resolves cwd/env to) has NO row
    // here at all.
    register(home, repo, foreignId, 'someone-elses-real-session');
    const ctx = mkCtx(home, repo);
    assert.strictEqual(cli.callerOwnsRow(home, foreignId, ctx), false,
      'a lone CLAIMED foreign row on the caller\'s own worktree must never be treated as owned');
  } finally { rm(repo); rm(home); }
});

test('D11-A: callerOwnsRow clause 3 still grants ownership of a lone UNCLAIMED row on the caller\'s own worktree (pre-existing behavior preserved)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('unclaimed');
  try {
    const unclaimedId = 'sole-unclaimed-row';
    register(home, repo, unclaimedId, 'unclaimed:' + unclaimedId);
    const ctx = mkCtx(home, repo);
    assert.strictEqual(cli.callerOwnsRow(home, unclaimedId, ctx), true,
      'a lone unclaimed placeholder row on the caller\'s own worktree must still be owned (clause 3 unchanged for its intended case)');
  } finally { rm(repo); rm(home); }
});
