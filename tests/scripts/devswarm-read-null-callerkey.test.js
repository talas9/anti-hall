'use strict';
// #20 (mesh redesign Phase 2 / B2): resolveWorkspaceStoreForRead refused with
// project-context-mismatch whenever the CALLER's repoKey differed from the
// workspace's registered one — including when the caller key was NULL because
// resolution failed (legacy: a git spawn timing out under load). A read from
// inside the workspace's OWN worktree then hard-failed.
// Fix: a null caller key + a cwd whose real path lies inside the registered
// worktree reads under the registered key. A caller key that resolves to a
// DIFFERENT project, or a null key outside the worktree, still refuses.
// The resolver failure is injected by wrapping identity.resolveContext (the one
// resolver every key path goes through) so paths under the registered worktree
// resolve to nothing, exactly as a failed git lookup did.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const identity = require('../../plugins/anti-hall/companion/lib/identity.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(root, tag) {
  const dir = path.join(root, tag);
  fs.mkdirSync(dir);
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// failResolutionUnder(dir) -> restore(). Every identity resolution of a path
// under `dir` returns an unresolved context (null keys), keeping cwdReal.
function failResolutionUnder(dir) {
  const orig = identity.resolveContext;
  identity.resolveContext = (p, o) => {
    const c = orig(p, o);
    if (!c.cwdReal || !(c.cwdReal === dir || c.cwdReal.startsWith(dir + path.sep))) return c;
    return Object.freeze(Object.assign({}, c, {
      kind: 'non-git', toplevel: null, superproject: null, worktreeRoot: null, commonDir: null,
      mainWorktree: null, repoKey: null, meshId: null, primaryMeshId: null,
    }));
  };
  return () => { identity.resolveContext = orig; };
}

test('#20: null caller key from inside the registered worktree reads; a different project or an outside cwd still refuses', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-b2-read20-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repoA = makeGitRepo(root, 'A'); // a different project
  const repoB = makeGitRepo(root, 'B'); // where the workspace is registered
  const subB = path.join(repoB, 'src', 'deep');
  fs.mkdirSync(subB, { recursive: true });
  const nonGit = path.join(root, 'nongit');
  fs.mkdirSync(nonGit);
  let restore = null;
  try {
    const reg = cli.run(['register', 'child-20', '--worktree', repoB, '--session', 's-20',
      '--inbox', path.join(home, 'di.ndjson'), '--cursor', path.join(home, 'dc.cursor')], ctx(home, { cwd: repoB }));
    assert.equal(reg.result.ok, true, JSON.stringify(reg.result));
    assert.ok(reg.result.descriptor.repoKey, 'precondition: the registered repoKey is persisted');
    const sent = cli.run(['send', '--to', 'child-20', '--message', 'unread for #20'], ctx(home, { cwd: repoB }));
    assert.equal(sent.result.ok, true, JSON.stringify(sent.result));

    restore = failResolutionUnder(repoB);

    const inside = cli.run(['inbox', 'count', 'child-20'], ctx(home, { cwd: subB })).result;
    assert.equal(inside.known, true, 'a null caller key inside the registered worktree must not refuse: ' + JSON.stringify(inside));
    assert.equal(inside.unreadStore, 1, 'the read must open the REGISTERED partition');

    const foreign = cli.run(['inbox', 'count', 'child-20'], ctx(home, { cwd: repoA })).result;
    assert.equal(foreign.known, false);
    assert.equal(foreign.storeUnavailableDetail.reason, 'project-context-mismatch', 'a different, resolved project still refuses');

    const outside = cli.run(['inbox', 'count', 'child-20'], ctx(home, { cwd: nonGit })).result;
    assert.equal(outside.known, false);
    assert.equal(outside.storeUnavailableDetail.reason, 'project-context-mismatch', 'a null key OUTSIDE the worktree still refuses');
  } finally {
    if (restore) restore();
    rm(root);
  }
});
