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
