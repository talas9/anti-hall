'use strict';
// command-guard.js — "allow plain push" (owner-approved 2026-09-26, "Allow
// plain push"). In the MAIN THREAD ONLY, lets `git add`/`git commit`/a plain
// `git push [remote] [ref]` — plus `&&`/`;` chains made up ONLY of those
// three — run inline instead of being delegated, even though a bare `git
// push` is classified heavy (HEAVY_PATTERNS). `ref` must be omitted, `HEAD`,
// or the CURRENT branch (resolved via `git symbolic-ref --short HEAD`),
// fail-closed if that cannot be resolved.
//
// git-guard.js's own independent force-push/AI-credit checks are a SEPARATE
// hook and run regardless — not under test here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

// A real git repo, checked out on `main`, with one commit so `git push`
// parses as a legitimate ref/branch situation (symbolic-ref resolves).
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowpush-repo-'));
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  cp.spawnSync('git', ['-C', dir, 'add', 'f.txt']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  // A configured `origin` (never contacted — the guard only lists remote
  // names; a push remote must be one of them).
  cp.spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git']);
  return dir;
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
    if (o.settings) {
      fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
      fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify(o.settings));
    }
    return testHook(HOOK, payload(command, { agentId: o.agentId, cwd: o.cwd }), {
      home: h.home, env: Object.assign({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, o.env || {}),
    });
  } finally {
    h.cleanup();
  }
}

// ---- Allowed shapes ----

test('allow-plain-push: bare `git push` on the current branch (main) is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: `git push origin` (remote only) is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: `git push origin main` (ref == current branch) is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin main', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: `git push origin HEAD` is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin HEAD', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: add + commit + push chain (&&) is allowed', () => {
  const repo = makeGitRepo();
  try {
    const cmd = 'git add . && git commit -m "wip" && git push origin main';
    const res = run(cmd, { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: add + commit + push chain (;) is allowed', () => {
  const repo = makeGitRepo();
  try {
    const cmd = 'git add .; git commit -m "wip"; git push';
    const res = run(cmd, { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Every blocked flag ----

const BLOCKED_PUSH_VARIANTS = [
  'git push --force origin main',
  'git push -f origin main',
  'git push --force-with-lease origin main',
  'git push --force-if-includes origin main',
  'git push --mirror origin',
  'git push --delete origin main',
  'git push -d origin main',
  'git push --all origin',
  'git push --tags origin',
  'git push origin +main',
  'git push origin main:other-branch',
  'git push origin :main',
];

for (const cmd of BLOCKED_PUSH_VARIANTS) {
  test('allow-plain-push: BLOCKED variant `' + cmd + '` never qualifies for the carve-out (stays exactly as blocked as before)', () => {
    const repo = makeGitRepo();
    try {
      const res = run(cmd, { cwd: repo });
      assert.strictEqual(res.status, 2, 'expected still-blocked: ' + res.stdout);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('allow-plain-push: a push to another (non-current) branch is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin some-other-branch', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: on branch `feat`, `git push origin main` (not the current branch) is blocked', () => {
  const repo = makeGitRepo();
  try {
    cp.spawnSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feat']);
    const res = run('git push origin main', { cwd: repo });
    assert.strictEqual(res.status, 2, 'ref must match the CURRENT branch (feat), not main: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: a chain with a non-git command (npm test) is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git add . && git commit -m x && npm test && git push', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: a chain with a pipe is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push | tee /tmp/out', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: a chain with a redirect is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push > /tmp/out.log', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: a chain with a subshell/command substitution is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git commit -m "$(cat secret)" && git push', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: detached HEAD (unresolvable current branch) fails CLOSED for a ref push', () => {
  const repo = makeGitRepo();
  try {
    const sha = cp.spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    cp.spawnSync('git', ['-C', repo, 'checkout', '-q', sha]); // detach HEAD
    const res = run('git push origin main', { cwd: repo });
    assert.strictEqual(res.status, 2, 'a ref push must fail closed when the current branch cannot be resolved: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push: bare `git push` (no ref given at all) still allowed even in detached HEAD (nothing to validate)', () => {
  const repo = makeGitRepo();
  try {
    const sha = cp.spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    cp.spawnSync('git', ['-C', repo, 'checkout', '-q', sha]); // detach HEAD
    const res = run('git push', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Subagent context unchanged ----

test('allow-plain-push: SUBAGENT context is unaffected (a subagent already passes through command-guard regardless)', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push --force origin main', { cwd: repo, agentId: 'sub-1' });
    assert.notStrictEqual(res.status, 2, 'a subagent must never be blocked by command-guard at all: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Kill-switch ----

test('allow-plain-push: kill-switch guards.allowPlainPush=false disables the carve-out entirely', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin main', { cwd: repo, settings: { guards: { allowPlainPush: false } } });
    assert.strictEqual(res.status, 2, 'kill-switch off must block a plain push exactly like before this feature existed: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Widened shapes (field repro, 2026-09-26): a peer on hooks reported this
// EXACT command blocked as "heavy-pattern" in their main thread, even though
// it should qualify for the carve-out:
//   cd <repo> && git add a b && git commit -q -m "fix: x" && git push -q
//   origin main && git log --oneline -1
// Root cause (three independent gaps, all now closed):
//   (a) -q/--quiet on push was not recognized by PLAIN_PUSH_SEGMENT_RE.
//   (b) a leading `cd <path>` segment was not recognized at all.
//   (c) a trailing read-only segment (git log/status/show) was not
//       recognized at all.
// ---------------------------------------------------------------------------

test('allow-plain-push (widened): the exact peer repro command is now allowed', () => {
  const repo = makeGitRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a'), '1\n');
    fs.writeFileSync(path.join(repo, 'b'), '2\n');
    const cmd = 'cd ' + repo + ' && git add a b && git commit -q -m "fix: x" && git push -q origin main && git log --oneline -1';
    const res = run(cmd, { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): `-q` on a bare push is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push -q origin main', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): `--quiet` (long form) on push is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push --quiet origin main', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): a leading `cd <repo toplevel>` is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('cd ' + repo + ' && git push origin main', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): a leading `cd <subdirectory of the repo>` is allowed, branch/remote resolved from that dir', () => {
  const repo = makeGitRepo();
  try {
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    const res = run('cd ' + sub + ' && git push origin main', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): trailing `git log --oneline -1` after a push is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin main && git log --oneline -1', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): trailing `git status --short` after a push is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin main && git status --short', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): trailing `git show --stat HEAD` after a push is allowed', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin main && git show --stat HEAD', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Negative: leading cd to another repo ----

test('allow-plain-push (widened): a leading cd to a DIFFERENT repo is blocked (fails closed)', () => {
  const repoA = makeGitRepo();
  const repoB = makeGitRepo();
  try {
    const res = run('cd ' + repoB + ' && git push origin main', { cwd: repoA });
    assert.strictEqual(res.status, 2, 'cd must not escape the payload cwd repo: ' + res.stdout);
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

// ---- Negative: leading cd with command substitution ----

test('allow-plain-push (widened): a leading cd with $() substitution is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('cd $(echo ' + repo + ') && git push origin main', { cwd: repo });
    assert.strictEqual(res.status, 2, 'a $() in the cd argument must never be trusted: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Negative: trailing segment not in the allowed list ----

test('allow-plain-push (widened): a trailing segment outside the allow-list (npm test) is blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push origin main && npm test', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Negative: -q combined with --force (either order) ----

test('allow-plain-push (widened): `-q` combined with `--force` is still blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push -q --force origin main', { cwd: repo });
    assert.strictEqual(res.status, 2, 'the quiet slot must not smuggle --force past the carve-out: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): `--force` before `-q` is still blocked', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git push --force -q origin main', { cwd: repo });
    assert.strictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Negative: a read-only trailing shape used BEFORE the push ----

test('allow-plain-push (widened): `git log` appearing BEFORE the push does not qualify (order matters)', () => {
  const repo = makeGitRepo();
  try {
    const res = run('git log --oneline && git push origin main', { cwd: repo });
    assert.strictEqual(res.status, 2, 'log/status/show only ever qualify AFTER a push: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Negative: git worktree (linked worktree, .git is a FILE) ----

// ---------------------------------------------------------------------------
// P1 field repro (security probe, 2026-09-26): `cd realsub && git add z &&
// git commit -m x && git push origin subbr` qualified whenever `realsub`
// merely lived under the outer repo's directory tree, even when `realsub`
// was a git SUBMODULE or any other independently-`git init`'d nested repo —
// its own .git, own remote, own branch. Branch/remote resolution then ran
// against the WRONG repository. resolvedLeadingCdTarget now requires the cd
// target to share the payload cwd's git-common-dir (the real .git store —
// worktrees of one repo share it, a submodule/nested repo never does).
// ---------------------------------------------------------------------------

function initNestedRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  cp.spawnSync('git', ['init', '-q', '-b', branch, dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
}

test('allow-plain-push (widened): cd into an UNTRACKED NESTED repo (own .git/remote/branch) is blocked', () => {
  const repo = makeGitRepo();
  try {
    const nested = path.join(repo, 'realsub');
    initNestedRepo(nested, 'subbr');
    fs.writeFileSync(path.join(nested, 'z'), '1\n');
    cp.spawnSync('git', ['-C', nested, 'commit', '--allow-empty', '-q', '-m', 'init']);
    cp.spawnSync('git', ['-C', nested, 'remote', 'add', 'origin', 'https://example.invalid/inner.git']);
    const cmd = 'cd realsub && git add z && git commit -m x && git push origin subbr';
    const res = run(cmd, { cwd: repo });
    assert.strictEqual(res.status, 2, 'a nested repo must never resolve branch/remote as if it were the outer repo: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): cd into a real git SUBMODULE is blocked', () => {
  const repo = makeGitRepo();
  const subUpstream = fs.mkdtempSync(path.join(os.tmpdir(), 'allowpush-subup-'));
  try {
    initNestedRepo(subUpstream, 'main');
    fs.writeFileSync(path.join(subUpstream, 's'), '1\n');
    cp.spawnSync('git', ['-C', subUpstream, 'add', 's']);
    cp.spawnSync('git', ['-C', subUpstream, 'commit', '-q', '-m', 'init']);
    const sm = cp.spawnSync('git', ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subUpstream, 'realsub'], { encoding: 'utf8' });
    assert.strictEqual(sm.status, 0, 'submodule add must succeed for this test to be meaningful: ' + sm.stderr);
    const subDir = path.join(repo, 'realsub');
    cp.spawnSync('git', ['-C', subDir, 'checkout', '-q', '-b', 'subbr']);
    cp.spawnSync('git', ['-C', subDir, 'remote', 'set-url', 'origin', 'https://example.invalid/inner2.git']);
    const cmd = 'cd realsub && git add s && git commit -m x && git push origin subbr';
    const res = run(cmd, { cwd: repo });
    assert.strictEqual(res.status, 2, 'a submodule must never resolve branch/remote as if it were the outer repo: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(subUpstream, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): cd into a plain SUBDIRECTORY of the same repo is still allowed', () => {
  const repo = makeGitRepo();
  try {
    fs.mkdirSync(path.join(repo, 'plainsub'));
    const res = run('cd plainsub && git push origin main', { cwd: repo });
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): cd into a LINKED WORKTREE of the same repo (shared git-common-dir) is allowed', () => {
  const repo = makeGitRepo();
  const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'allowpush-wt2-'));
  try {
    const wtDir = path.join(wtParent, 'wt');
    const add = cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-b', 'wtbranch', wtDir], { encoding: 'utf8' });
    assert.strictEqual(add.status, 0, 'worktree add must succeed for this test to be meaningful: ' + add.stderr);
    const cmd = 'cd ' + wtDir + ' && git push origin wtbranch';
    const res = run(cmd, { cwd: repo });
    assert.notStrictEqual(res.status, 2, 'a linked worktree of the SAME repo shares git-common-dir and must still qualify: ' + res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(wtParent, { recursive: true, force: true });
  }
});

test('allow-plain-push (widened): a linked git worktree (.git is a file) still resolves branch/remote correctly', () => {
  const repo = makeGitRepo();
  const wtDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'allowpush-wt-')), 'wt');
  try {
    cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-b', 'wtbranch', wtDir]);
    assert.ok(fs.statSync(path.join(wtDir, '.git')).isFile(), 'linked worktree .git must be a file, not a dir');
    const res = run('git push origin wtbranch', { cwd: wtDir });
    // Whether allowed or blocked depends only on remote/ref resolution
    // succeeding from the worktree dir — it must not CRASH or hang, and a
    // legitimate same-branch push from a worktree must not be blocked.
    assert.notStrictEqual(res.status, 2, res.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(path.dirname(wtDir), { recursive: true, force: true });
  }
});
