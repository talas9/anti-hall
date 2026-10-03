'use strict';
// D11-A (d35d2d4b241e): callerIdentityDetailed's `kind` (resolved/declared/
// unresolvable) was computed for every ownership decision but never reached
// the CLI's own JSON output on success — an operator debugging "why did this
// send/heartbeat/ack behave the way it did" had no way to see which identity
// leg was used without instrumenting the code. Additive `identity: {id, kind}`
// on `send`/`heartbeat` success and the two ownership-refusal objects
// (heartbeat --summary's meshBroadcast refusal; inbox ack's refusal), without
// changing any existing key.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-idobs-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-idobs-repo-' + tag + '-'));
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
function callerIdFor(home, repo) {
  return cli.run(['inbox', 'read-primary', 'probe-only'], mkCtx(home, repo)).result.callerIdentity;
}

test('D11-A: heartbeat SUCCESS JSON carries identity.kind === "resolved" from a real git worktree', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb-success');
  try {
    const P = callerIdFor(home, repo);
    register(home, repo, P, 'unclaimed:' + P);
    const r = cli.run(['heartbeat', P], mkCtx(home, repo)).result;
    assert.strictEqual(r.ok, true, 'heartbeat must succeed: ' + JSON.stringify(r));
    assert.ok(r.identity, 'identity must be present on success');
    assert.strictEqual(r.identity.id, P, 'identity.id matches the resolved caller');
    assert.strictEqual(r.identity.kind, 'resolved', 'a real git worktree resolves as "resolved"');
    // Existing keys untouched.
    assert.strictEqual(r.action, 'heartbeat');
    assert.ok(r.heartbeat, 'heartbeat field untouched');
  } finally { rm(repo); rm(home); }
});

test('D11-A: heartbeat --summary ownership refusal carries identity.kind alongside the existing callerIdentity string', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb-refusal');
  const foreignRepo = makeGitRepo('hb-refusal-foreign'); // a DIFFERENT worktree/mesh group, so ownEntry never resolves to foreignId
  try {
    const P = callerIdFor(home, repo);
    const foreignId = 'foreign-workspace-id';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, foreignRepo, foreignId, 'real-foreign-session');
    const r = cli.run(['heartbeat', foreignId, '--summary', 'doing stuff'], mkCtx(home, repo)).result;
    assert.ok(r.meshBroadcast, 'meshBroadcast must be present');
    assert.strictEqual(r.meshBroadcast.ok, false, 'the summary broadcast must be refused (caller does not own foreignId)');
    assert.strictEqual(typeof r.meshBroadcast.callerIdentity, 'string', 'existing callerIdentity key untouched');
    assert.ok(r.meshBroadcast.identity, 'identity must be additively present on the refusal');
    assert.strictEqual(r.meshBroadcast.identity.id, r.meshBroadcast.callerIdentity, 'identity.id matches the existing callerIdentity value');
    assert.strictEqual(r.meshBroadcast.identity.kind, 'resolved', 'a real git worktree resolves as "resolved"');
  } finally { rm(repo); rm(foreignRepo); rm(home); }
});

test('D11-A: send SUCCESS JSON carries identity.kind, additive to `from`', () => {
  const home = tmpHome();
  const repo = makeGitRepo('send-success');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const P = callerIdFor(home, repo);
    const child = 'child-row-idobs';
    register(home, repo, P, 'sess-primary-idobs');
    register(home, repo, child, 'sess-child-idobs');
    const r = cli.run(['send', '--to', child, '--message', 'hello'], mkCtx(home, repo)).result;
    assert.ok(r.ok, 'send must succeed: ' + JSON.stringify(r));
    assert.strictEqual(r.action, 'send');
    assert.ok(r.identity, 'identity must be additively present on send success');
    assert.strictEqual(r.identity.id, r.from, 'identity.id matches the existing `from` value');
    assert.strictEqual(r.identity.kind, 'resolved', 'a real git worktree resolves as "resolved"');
  } finally { rm(repo); rm(home); }
});

test('D11-A: inbox read-primary (ack-bearing) ownership refusal carries identity.kind alongside the existing callerIdentity string', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ack-refusal');
  // A SECOND worktree of the SAME repo/project (same repoKey, DIFFERENT
  // canonicalMeshId) — a genuinely different sibling mesh group within the
  // same store, so the ownership check refuses without hitting the separate
  // project-context-mismatch guard a different repoKey would trigger first.
  //
  // NOTE: the plain `inbox ack <id>` verb (scripts/devswarm.js ~:6768's
  // sub==='ack' branch) is a SEPARATE, already-tracked gap (task list item
  // "inbox ack on a non-owned row half-acks... ok:true", defect 66c7c4e9973e)
  // that does not route through the ownership check this test targets —
  // `read-primary` (ack:true, cmdInboxMessages) is the call site D11-A item 4
  // actually instruments, so that is what this test exercises.
  const foreignWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-idobs-wt-'));
  cp.spawnSync('git', ['worktree', 'add', '-q', foreignWorktree, '-b', 'ack-refusal-foreign-branch'], { cwd: repo });
  try {
    const P = callerIdFor(home, repo);
    const foreignId = 'foreign-ack-target';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, foreignWorktree, foreignId, 'real-foreign-session-ack');
    const r = cli.run(['inbox', 'read-primary', foreignId], mkCtx(home, repo)).result;
    assert.strictEqual(r.ok, false, 'read-primary (ack-bearing) of a foreign, non-owned workspace must be refused: ' + JSON.stringify(r));
    assert.strictEqual(typeof r.callerIdentity, 'string', 'existing callerIdentity key untouched');
    assert.ok(r.identity, 'identity must be additively present on the refusal');
    assert.strictEqual(r.identity.id, r.callerIdentity, 'identity.id matches the existing callerIdentity value');
    assert.strictEqual(r.identity.kind, 'resolved', 'a real git worktree resolves as "resolved"');
  } finally {
    cp.spawnSync('git', ['worktree', 'remove', '--force', foreignWorktree], { cwd: repo });
    rm(foreignWorktree); rm(repo); rm(home);
  }
});
