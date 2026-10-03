'use strict';
// git-stash-guard (command-guard.js PreToolUse Bash branch).
//
// Regression test for defect b08b26566b92: git-guard/command-guard did not
// block `git stash` at all — neither in SUBAGENT context (where a worker
// stashing WIP can silently discard/reorder the coordinator's own
// uncommitted changes) nor in coordinator context against a repo carrying
// protected WIP stashes. Field report: two Sonnet workers ran
// `git stash push` despite an explicit NO-git-stash brief; only a
// `.git/index.lock` race stopped them, never any guard.
//
// R2 Critic (3 P1s against the first version, all fixed here):
//   1. Flag-only forms of `push` (`-u`/`--include-untracked`, `-k`/
//      `--keep-index`, `-m X`, `-p`, `-q`, `-a`) used to bypass — the old
//      regex only captured the token immediately after `stash` and only
//      recognized a KNOWN subcommand word there.
//   2. `git -C <path> stash` / `git --git-dir=X stash` used to bypass — the
//      old `\bgit\s+stash\b` regex assumed zero-distance adjacency, which
//      git's own global options break.
//   3. False positives: `grep -rn "git stash drop" docs/` and
//      `git commit -m "...git stash pop..."` used to BLOCK in subagent
//      context — the old detector ran against a quote-flattened string.
//   Policy (R2 Critic P1 #3, second half): the guard used to block SUBAGENT
//   context unconditionally with no opt-in — wrong for a public plugin. Both
//   subagent AND coordinator context now require the guard to be ARMED:
//   `.anti-hall/protected-stashes` at the git toplevel, OR
//   `ANTIHALL_STASH_GUARD=1`.
//
// `git stash list`/`show`/`branch` are never matched. The guard's own skip
// name (`git-stash-guard`) is in skip-guard.js's DESTRUCTIVE set, so a
// blanket `{"all": <expiry>}` skip must NOT silence it — only an explicit
// `{"git-stash-guard": <expiry>}` does.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-guard-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}
function markRepo(repo) {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.anti-hall', 'protected-stashes'), 'wip@{0}\n');
}

function payload(command, { agentId, cwd } = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 't',
    cwd: cwd || process.cwd(),
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

function run(command, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    if (o.skip) h.writeSkip(o.skip);
    return testHook(HOOK, payload(command, { agentId: o.agentId, cwd: o.cwd }), {
      home: h.home, env: o.env || {},
    });
  } finally {
    h.cleanup();
  }
}

// --- Not armed at all: nothing blocks, subagent or coordinator ---

test('git-stash-guard: an UNARMED repo (no marker, no env) never blocks, subagent or coordinator', () => {
  const repo = makeGitRepo();
  try {
    const rSub = run('git stash push', { agentId: 'sub-1', cwd: repo });
    assert.notStrictEqual(rSub.status, 2, 'unarmed repo must not block a subagent: ' + rSub.stdout);
    const rCoord = run('git stash push', { cwd: repo });
    assert.notStrictEqual(rCoord.status, 2, 'unarmed repo must not block the coordinator: ' + rCoord.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Armed via marker: both contexts block a mutating stash ---

const MUTATING_COMMANDS = [
  'git stash',
  'git stash push',
  'git stash push -m "wip"',
  'git stash pop',
  'git stash drop',
  'git stash clear',
  'git stash apply',
  'git stash save "wip"',
  'cd /tmp && git stash',
  'git stash push -m "wip" && git status',
  'bash -c "git stash"',
];

for (const cmd of MUTATING_COMMANDS) {
  test(`git-stash-guard: ARMED (marker) blocks in SUBAGENT context: ${cmd}`, () => {
    const repo = makeGitRepo();
    try {
      markRepo(repo);
      const r = run(cmd, { agentId: 'sub-1', cwd: repo });
      assert.strictEqual(r.status, 2, `expected block for subagent: ${cmd}\nstdout: ${r.stdout}`);
      const reason = (r.json && r.json.reason) || '';
      assert.match(reason, /GIT STASH GUARD/, 'reason must name the guard');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('git-stash-guard: ARMED (marker) blocks `git stash push` in COORDINATOR context too', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git stash push', { cwd: repo }); // no agentId -> coordinator
    assert.strictEqual(r.status, 2, 'a marked repo must block the coordinator too: ' + r.stdout);
    const reason = (r.json && r.json.reason) || '';
    assert.match(reason, /GIT STASH GUARD/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: `git stash list` is never blocked, even armed', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r1 = run('git stash list', { agentId: 'sub-1', cwd: repo });
    assert.notStrictEqual(r1.status, 2, 'git stash list must not be blocked for a subagent');
    const r2 = run('git stash list', { cwd: repo });
    assert.notStrictEqual(r2.status, 2, 'git stash list must not be blocked for the coordinator');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: a subdirectory cwd still finds the toplevel marker', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const r = run('git stash push', { cwd: sub });
    assert.strictEqual(r.status, 2, 'a subdirectory cwd must still resolve to the git toplevel marker: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Armed via ANTIHALL_STASH_GUARD=1 env var (no marker file needed) ---

test('git-stash-guard: ANTIHALL_STASH_GUARD=1 arms the guard with no marker file, subagent context', () => {
  const repo = makeGitRepo();
  try {
    const r = run('git stash push', { agentId: 'sub-1', cwd: repo, env: { ANTIHALL_STASH_GUARD: '1' } });
    assert.strictEqual(r.status, 2, 'env-armed guard must block a subagent: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: ANTIHALL_STASH_GUARD=1 arms the guard with no marker file, coordinator context', () => {
  const repo = makeGitRepo();
  try {
    const r = run('git stash push', { cwd: repo, env: { ANTIHALL_STASH_GUARD: '1' } });
    assert.strictEqual(r.status, 2, 'env-armed guard must block the coordinator: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- R2 Critic P1 #1: flag-only forms of `push` ---

const PUSH_FLAG_FORMS = [
  'git stash -u',
  'git stash --include-untracked',
  'git stash -k',
  'git stash --keep-index',
  'git stash -m "wip"',
  'git stash -p',
  'git stash -q',
  'git stash -a',
  'git stash -u -m "wip"',
];
for (const cmd of PUSH_FLAG_FORMS) {
  test(`git-stash-guard: flag-only push form is caught (armed, subagent): ${cmd}`, () => {
    const repo = makeGitRepo();
    try {
      markRepo(repo);
      const r = run(cmd, { agentId: 'sub-1', cwd: repo });
      assert.strictEqual(r.status, 2, `expected block for flag-only push form: ${cmd}\nstdout: ${r.stdout}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

// --- R2 Critic P1 #2: git global options between `git` and `stash` ---

test('git-stash-guard: `git -C <path> stash` is caught (armed, subagent)', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git -C ' + repo + ' stash', { agentId: 'sub-1', cwd: repo });
    assert.strictEqual(r.status, 2, 'git -C <path> stash must be caught: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: `git --git-dir=X stash` is caught (armed, subagent)', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git --git-dir=' + path.join(repo, '.git') + ' stash', { agentId: 'sub-1', cwd: repo });
    assert.strictEqual(r.status, 2, 'git --git-dir=X stash must be caught: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: `git --git-dir X stash` (two-token form) is caught (armed, subagent)', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git --git-dir ' + path.join(repo, '.git') + ' stash', { agentId: 'sub-1', cwd: repo });
    assert.strictEqual(r.status, 2, 'git --git-dir X stash must be caught: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- R2 Critic P1 #3: false positives (must NOT block, even when armed) ---

test('git-stash-guard: `grep -rn "git stash drop" docs/` is NOT blocked, even armed + subagent', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'KB.md'), 'never run git stash drop here\n');
    const r = run('grep -rn "git stash drop" docs/', { agentId: 'sub-1', cwd: repo });
    assert.notStrictEqual(r.status, 2, 'a grep whose pattern merely mentions git stash must not block: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: `git commit -m "...git stash pop..."` is NOT blocked, even armed + subagent', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git commit -m "explain why we do not git stash pop here"', { agentId: 'sub-1', cwd: repo });
    assert.notStrictEqual(r.status, 2, 'a commit message merely mentioning git stash must not block: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Skip mechanism ---

test('git-stash-guard: a blanket {"all": ...} skip does NOT silence this guard (DESTRUCTIVE set)', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git stash push', {
      agentId: 'sub-1', cwd: repo, skip: { all: Date.now() + 60000 },
    });
    assert.strictEqual(r.status, 2, 'a blanket "all" skip must not silence git-stash-guard: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git-stash-guard: an EXPLICIT {"git-stash-guard": ...} skip DOES silence this guard', () => {
  const repo = makeGitRepo();
  try {
    markRepo(repo);
    const r = run('git stash push', {
      agentId: 'sub-1', cwd: repo, skip: { 'git-stash-guard': Date.now() + 60000 },
    });
    assert.notStrictEqual(r.status, 2, 'an explicit named skip must silence the guard: ' + r.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
