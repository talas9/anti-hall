'use strict';
// devswarm-git-truth — REPORT-ONLY git ground-truth checks (unpushed-commit
// count / missing-upstream, best-effort merged-into-default-branch). Exercised
// against REAL temp git repos (a bare "remote" + a clone-equivalent local repo
// with an explicit `origin` remote) so the actual `git` binary proves the
// behavior, not a mock.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const gitTruth = require('../../plugins/anti-hall/companion/lib/devswarm-git-truth.js');

function git(dir, args) {
  const r = cp.spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + r.stderr);
  }
  return r.stdout;
}

function makeBareRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-remote-'));
  cp.spawnSync('git', ['init', '-q', '--bare', dir]);
  return dir;
}

// makeRepoWithUpstream() -> a local repo with one commit, pushed to a fresh
// bare remote under `origin`, with the current branch tracking `origin/main`
// and `refs/remotes/origin/HEAD` explicitly set (git clone does this
// automatically; a manual init+push does not, so defaultBranchRef needs it
// set explicitly here).
function makeRepoWithUpstream() {
  const remote = makeBareRemote();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'a@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'f.txt'), '1');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'c1']);
  git(dir, ['remote', 'add', 'origin', remote]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  git(dir, ['remote', 'set-head', 'origin', 'main']);
  return { dir, remote };
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// ---- gitPushState ----

test('gitPushState: upstream configured, in sync -> noUpstream:false, unpushed:0', () => {
  const { dir, remote } = makeRepoWithUpstream();
  try {
    const st = gitTruth.gitPushState(dir);
    assert.deepEqual(st, { noUpstream: false, unpushed: 0 });
  } finally { rm(dir); rm(remote); }
});

test('gitPushState: upstream configured, N commits ahead -> noUpstream:false, unpushed:N', () => {
  const { dir, remote } = makeRepoWithUpstream();
  try {
    fs.writeFileSync(path.join(dir, 'g.txt'), '2');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c2']);
    fs.writeFileSync(path.join(dir, 'h.txt'), '3');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c3']);
    const st = gitTruth.gitPushState(dir);
    assert.deepEqual(st, { noUpstream: false, unpushed: 2 });
  } finally { rm(dir); rm(remote); }
});

// Field case this whole feature exists to catch: real unpushed commits AND no
// upstream at all — the two facts must NOT collapse into "0 unpushed".
test('gitPushState: no upstream configured -> noUpstream:true, unpushed:null (NEVER 0)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-noup-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'f.txt'), '1');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const st = gitTruth.gitPushState(dir);
    assert.deepEqual(st, { noUpstream: true, unpushed: null });
    assert.notStrictEqual(st.unpushed, 0, 'must never report 0 unpushed for a no-upstream repo');
  } finally { rm(dir); }
});

// A non-git directory is a PROBE FAILURE (git never resolved a repo to tell us
// anything about upstream state) -> null, not a fabricated noUpstream:true.
// Distinct from the "no upstream configured" case above, where git DID run
// and definitively reported no @{u} ref.
test('gitPushState: non-git directory -> probe failure -> null (never fabricated noUpstream:true)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-nongit-'));
  try {
    const st = gitTruth.gitPushState(dir);
    assert.strictEqual(st, null);
  } finally { rm(dir); }
});

test('gitPushState: missing/empty worktreePath -> null, never throws', () => {
  assert.strictEqual(gitTruth.gitPushState(''), null);
  assert.strictEqual(gitTruth.gitPushState(null), null);
});

// Regression for the fabrication bug: a killed/timed-out probe (r.signal set,
// git never got to run) must be treated as "unknown", not misread as a
// definitive "no upstream" on a branch that may well have one. Simulated via
// an unreachable/garbage git binary path so spawnSync sets r.error (ENOENT) —
// the same code path a timeout hits via r.signal.
test('gitPushState: probe never completes (spawn error) -> null, never noUpstream:true', () => {
  const { dir, remote } = makeRepoWithUpstream();
  const realPath = process.env.PATH;
  try {
    // Break PATH resolution for the `git` binary so spawnSync reports r.error.
    process.env.PATH = '';
    const st = gitTruth.gitPushState(dir);
    assert.strictEqual(st, null, 'a probe failure must never be reported as a definitive noUpstream:true fact');
  } finally { process.env.PATH = realPath; rm(dir); rm(remote); }
});

// ---- gitMergedInto ----

test('gitMergedInto: HEAD is an ancestor of the resolved default branch -> true', () => {
  const { dir, remote } = makeRepoWithUpstream();
  try {
    assert.strictEqual(gitTruth.gitMergedInto(dir), true);
  } finally { rm(dir); rm(remote); }
});

test('gitMergedInto: HEAD has an unmerged local commit ahead of the default branch -> false (real negative, not proof of "not merged")', () => {
  const { dir, remote } = makeRepoWithUpstream();
  try {
    fs.writeFileSync(path.join(dir, 'g.txt'), '2');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c2']);
    assert.strictEqual(gitTruth.gitMergedInto(dir), false);
  } finally { rm(dir); rm(remote); }
});

test('gitMergedInto: no resolvable default branch (no origin/HEAD set) -> null, never fabricated', () => {
  const remote = makeBareRemote();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-nohead-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'f.txt'), '1');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    git(dir, ['remote', 'add', 'origin', remote]);
    git(dir, ['push', '-q', '-u', 'origin', 'main']);
    // deliberately NOT running `git remote set-head` -> refs/remotes/origin/HEAD absent
    assert.strictEqual(gitTruth.gitMergedInto(dir), null);
  } finally { rm(dir); rm(remote); }
});

test('gitMergedInto: non-git directory -> null, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-nongit2-'));
  try {
    assert.strictEqual(gitTruth.gitMergedInto(dir), null);
  } finally { rm(dir); }
});

test('gitMergedInto: missing worktreePath -> null', () => {
  assert.strictEqual(gitTruth.gitMergedInto(''), null);
  assert.strictEqual(gitTruth.gitMergedInto(null), null);
});
