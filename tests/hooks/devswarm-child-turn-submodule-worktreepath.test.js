'use strict';
// B3 P0 FIX: devswarm-child-turn.js's registerChildDescriptor persists
// `worktreePath` to disk, and that field is ALSO the session's literal
// on-disk location — companion/lib/target-session.js's findTarget matches
// candidates by `path.resolve(cwd) === path.resolve(worktreePath)`, and
// companion/lib/recovery.js resumes a killed/resumed session with
// `cwd: descriptor.worktreePath`. The Phase 2 mesh-redesign B3 batch first
// wired this to `ctx.worktreeRoot` (the KEY-bearing, superproject-folded
// root) by analogy with repoKey/meshId — but worktreePath is a LOCATION
// field, not a key field: a child running inside a git submodule would have
// persisted its SUPERPROJECT's path, never matching its own real cwd, so
// findTarget would always abstain and recovery.js would resume it in the
// wrong directory. Fixed: worktreePath persists `ctx.toplevel` (the literal
// git toplevel — same value the old findGitToplevel produced). Keys
// (repoKey/meshId) are unaffected: every reader re-derives them from
// worktreePath via repoKeyForWorktree/identity.resolveContext, which already
// folds a submodule onto its outermost superproject at READ time.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const targetSession = require('../../plugins/anti-hall/companion/lib/target-session.js');

const HOOK = 'devswarm-child-turn.js';

const GIT_AVAILABLE = (() => {
  try {
    const r = require('node:child_process').spawnSync('git', ['--version']);
    return !r.error && r.status === 0;
  } catch (_) { return false; }
})();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// mkSuperprojectWithSubmodule() -> { superRepo, submodulePath, home, root }.
// Same real `git submodule add` fixture shape as
// tests/hooks/devswarm-parent-gate-submodule-parity.test.js's own builder —
// `<superRepo>/modules/sub/.git` is a FILE ('gitdir: ...'), never a directory.
function mkSuperprojectWithSubmodule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-ct-submod-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-ct-submod-home-'));
  const subRepo = path.join(root, 'sub-origin');
  const superRepo = path.join(root, 'super');

  fs.mkdirSync(subRepo, { recursive: true });
  git(['init', '-q', '-b', 'main'], subRepo);
  git(['config', 'user.email', 'a@b.c'], subRepo);
  git(['config', 'user.name', 'a'], subRepo);
  fs.writeFileSync(path.join(subRepo, 'f.txt'), 'x');
  git(['add', '.'], subRepo);
  git(['commit', '-q', '-m', 'init'], subRepo);

  fs.mkdirSync(superRepo, { recursive: true });
  git(['init', '-q', '-b', 'main'], superRepo);
  git(['config', 'user.email', 'a@b.c'], superRepo);
  git(['config', 'user.name', 'a'], superRepo);
  fs.writeFileSync(path.join(superRepo, 'root.txt'), 'x');
  git(['add', '.'], superRepo);
  git(['commit', '-q', '-m', 'init'], superRepo);
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, 'modules/sub'], superRepo);
  git(['commit', '-q', '-m', 'add submodule'], superRepo);

  const submodulePath = path.join(superRepo, 'modules', 'sub');
  const st = fs.lstatSync(path.join(submodulePath, '.git'));
  assert.ok(st.isFile(), 'fixture sanity: submodule .git must be a FILE, not a directory');

  return { superRepo, submodulePath, home, root };
}

function workspaceDescPath(home, id) {
  return path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
}

function promptPayload(sessionId, cwd) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'go', cwd };
}

test('B3 P0: a child running inside a git submodule persists the LITERAL submodule toplevel as worktreePath (not the superproject)', (t) => {
  if (!GIT_AVAILABLE) { t.skip('git not available on PATH'); return; }
  const { superRepo, submodulePath, home, root } = mkSuperprojectWithSubmodule();
  try {
    const r = testHook(HOOK, promptPayload('sess-submod', submodulePath), {
      home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'submod-child' },
    });
    assert.strictEqual(r.status, 0, `hook must exit 0; stderr=${r.stderr}`);

    const descPath = workspaceDescPath(home, 'submod-child');
    assert.ok(fs.existsSync(descPath), 'descriptor file must be written');
    const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));

    assert.strictEqual(desc.worktreePath, fs.realpathSync(submodulePath),
      'worktreePath must be the LITERAL submodule toplevel (the session\'s real cwd), not the superproject');
    assert.notStrictEqual(desc.worktreePath, fs.realpathSync(superRepo),
      'worktreePath must NEVER be superproject-folded — that is a location field, not a key field');

    // THE DECISIVE ASSERTION: findTarget's confirm-gate matches candidates by
    // path.resolve(cwd) === path.resolve(worktreePath). A live process whose
    // REAL cwd is the submodule (exactly what a genuine child session's cwd
    // would be) must be found — proving recovery.js would resume it in the
    // right place, not silently abstain forever.
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const pid = 424242;
    const runners = {
      ps: () => `${pid} 1 claude -p --session-id ${sessionId}\n`,
      cwdOf: (p) => (p === pid ? fs.realpathSync(submodulePath) : null), // a real process reports its realpath'd cwd
      transcriptExists: () => true,
    };
    const target = targetSession.findTarget({
      worktreePath: desc.worktreePath, sessionId, home, runners, selfPid: 999999,
    });
    assert.strictEqual(target.ambiguous, undefined,
      `findTarget must confirm a match, not abstain; got=${JSON.stringify(target)}`);
    assert.strictEqual(target.pid, pid, 'findTarget must resolve the live submodule-cwd candidate');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});

// NEGATIVE CONTROL: had worktreePath stayed superproject-folded (the P0), the
// SAME findTarget call above would abstain — proven directly here by re-running
// the confirm-gate against the (wrong) superproject path, showing it fails to
// match the submodule cwd's live process.
test('B3 P0 NEGATIVE CONTROL: findTarget abstains when worktreePath is wrongly superproject-folded', (t) => {
  if (!GIT_AVAILABLE) { t.skip('git not available on PATH'); return; }
  const { superRepo, submodulePath, home, root } = mkSuperprojectWithSubmodule();
  try {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const pid = 424242;
    const runners = {
      ps: () => `${pid} 1 claude -p --session-id ${sessionId}\n`,
      cwdOf: (p) => (p === pid ? submodulePath : null),
      transcriptExists: () => true,
    };
    const target = targetSession.findTarget({
      worktreePath: path.resolve(superRepo), // the P0's wrong (superproject-folded) value
      sessionId, home, runners, selfPid: 999999,
    });
    assert.strictEqual(target.ambiguous, true, 'a superproject-folded worktreePath must fail to match the submodule cwd\'s live process');
    assert.strictEqual(target.reason, 'no-candidate');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});
