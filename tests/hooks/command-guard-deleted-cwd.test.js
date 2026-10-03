'use strict';
// B3 P1 FIX (Codex review): companion/lib/identity.js resolveContext returns
// toplevel/worktreeRoot NULL for a cwd that does not exist on disk (kind
// 'deleted') — the B3 batch first called it with NO missingPath option, so
// the stash-protection guard (hasProtectedStashesMarker, command-guard.js
// ~587) silently stopped enforcing the block the instant the PreToolUse
// payload's `cwd` was a directory that had just been removed (a worktree
// cleanup, a `rm -rf` mid-session, etc) — exactly the case the OLD
// findGitToplevel (a pure fs walk-up) never had a problem with, since it
// just kept walking to the nearest existing ancestor regardless.
//
// Fix: every B3 hook site now passes `missingPath: 'ancestor'`, which
// resolves from the nearest EXISTING ancestor directory instead of returning
// null — restoring the exact old findGitToplevel behavior for this case.
//
// THE DECISIVE TEST: a git repo ARMED with the protected-stashes marker,
// where the PreToolUse payload's `cwd` names a SUBDIRECTORY of that repo
// that has been DELETED (the repo itself still exists) — `git stash` must
// still be blocked.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-guard-deleted-cwd-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}
function markRepo(repo) {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.anti-hall', 'protected-stashes'), 'wip@{0}\n');
}

function payload(command, cwd) {
  return {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
    session_id: 't', cwd,
  };
}

test('git-stash-guard: ARMED repo still blocks when payload.cwd is a DELETED subdirectory of it', () => {
  const repo = makeGitRepo();
  const h = makeHome();
  try {
    markRepo(repo);
    const deletedSub = path.join(repo, 'src', 'gone');
    fs.mkdirSync(deletedSub, { recursive: true });
    fs.rmSync(deletedSub, { recursive: true, force: true });
    assert.ok(!fs.existsSync(deletedSub), 'fixture sanity: the subdirectory must genuinely not exist');

    const r = testHook(HOOK, payload('git stash push', deletedSub), { home: h.home, env: {} });
    assert.strictEqual(r.status, 2, `a deleted-but-ancestor-armed cwd must still block: ${r.stdout}`);
    const reason = (r.json && r.json.reason) || '';
    assert.match(reason, /GIT STASH GUARD/, 'reason must name the guard');
  } finally {
    h.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('NEGATIVE CONTROL: an UNARMED repo with a deleted cwd subdirectory still does not block', () => {
  const repo = makeGitRepo();
  const h = makeHome();
  try {
    const deletedSub = path.join(repo, 'src', 'gone');
    fs.mkdirSync(deletedSub, { recursive: true });
    fs.rmSync(deletedSub, { recursive: true, force: true });

    const r = testHook(HOOK, payload('git stash push', deletedSub), { home: h.home, env: {} });
    assert.notStrictEqual(r.status, 2, 'an unarmed repo must never block, deleted cwd or not: ' + r.stdout);
  } finally {
    h.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
