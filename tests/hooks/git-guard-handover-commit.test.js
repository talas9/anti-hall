'use strict';
// git-guard Rule 3 (guards.handoverCommitGuard): handovers are local session
// state and are never committed. `git commit` is blocked when the paths it
// would commit include a handover; `git add` never is. Every case runs against
// a throwaway fixture repo with an isolated HOME (never the real ~/.anti-hall).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'git-guard.js';
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-handover-githome-'));
const GIT_ENV = Object.assign({}, process.env, { HOME: GIT_HOME, USERPROFILE: GIT_HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
const BLOCKED = /includes a session handover/;

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A fixture repo with one commit; `files` are written (not staged).
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-handover-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-qm', 'init');
  for (const [rel, body] of Object.entries(files || {})) write(dir, rel, body);
  return dir;
}
function write(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body || 'x\n');
}
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } }

// Run the hook for `command` with payload cwd = `cwd`, in a fresh fake HOME.
function run(command, cwd, opts) {
  const h = makeHome();
  try {
    if (opts && opts.skip) h.writeSkip({ 'git-guard': Date.now() + 60000 });
    if (opts && opts.settings) h.writeState('settings.json', opts.settings);
    const payload = Object.assign(bashPayload(command), { cwd });
    return testHook(HOOK, payload, { home: h.home, env: (opts && opts.env) || {} });
  } finally { h.cleanup(); }
}

const HANDOVER_PATHS = [
  '.anti-hall/handovers/2026-10-02/s1/HANDOVER.md',
  '.anti-hall/handovers/2026-10-02/s1/PRECOMPACT-1.md',
  '.anti-hall/handovers/2026-10-02-flat-note.md',
  'HANDOVER.md',
  'HANDOVER-2.md',
  'CONTINUE-HERE.md',
  'session.continue-here.md',
  'pkg/.anti-hall/handovers/d/s/HANDOVER.md',
];
for (const rel of HANDOVER_PATHS) {
  test(`BLOCK: git commit with ${rel} staged`, () => {
    const dir = makeRepo({ [rel]: 'h\n' });
    try {
      git(dir, 'add', '-f', rel);
      const r = run('git commit -m "wip"', dir);
      assert.strictEqual(r.status, 2, `stderr: ${r.stderr}`);
      assert.match(r.stderr, BLOCKED);
      assert.match(r.stderr, /never committed/);
      assert.match(r.stderr, /git restore --staged/);
      assert.match(r.stderr, /skip git-guard/);
    } finally { rm(dir); }
  });
}

test('BLOCK: `git commit -am` when a TRACKED handover is modified (unstaged)', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'v1\n' });
  try {
    git(dir, 'add', 'HANDOVER.md');
    git(dir, 'commit', '-qm', 'old', '--no-verify');
    write(dir, 'HANDOVER.md', 'v2\n');
    for (const cmd of ['git commit -am "wip"', 'git commit -a -m "wip"', 'git commit --all -m "wip"', 'git commit -sa -m wip']) {
      const r = run(cmd, dir);
      assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, BLOCKED);
    }
  } finally { rm(dir); }
});

test('BLOCK: explicit pathspec that names the handover', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'v1\n' });
  try {
    git(dir, 'add', 'HANDOVER.md');
    const r = run('git commit -m "wip" HANDOVER.md', dir);
    assert.strictEqual(r.status, 2, `stderr: ${r.stderr}`);
  } finally { rm(dir); }
});

test('BLOCK: `cd <repo> && git commit` and `git -C <repo> commit` from another cwd', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'h\n' });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-handover-other-'));
  try {
    git(dir, 'add', 'HANDOVER.md');
    for (const cmd of [`cd ${dir} && git commit -m wip`, `git -C ${dir} commit -m wip`]) {
      const r = run(cmd, other);
      assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
    }
  } finally { rm(dir); rm(other); }
});

// ---- false positives: all of these must be ALLOWED ----

test('ALLOW: `git add` of a handover is never blocked', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'h\n' });
  try {
    for (const cmd of ['git add HANDOVER.md', 'git add -f .anti-hall/handovers', 'git add -A']) {
      assert.strictEqual(run(cmd, dir).status, 0, cmd);
    }
  } finally { rm(dir); }
});

test('ALLOW: a commit message / command that merely mentions handover', () => {
  const dir = makeRepo({ 'src/a.js': 'a\n' });
  try {
    git(dir, 'add', 'src/a.js');
    for (const cmd of ['git commit -m "docs: update the handover skill"', 'git commit -m "fix HANDOVER.md parsing"', 'echo handover HANDOVER.md CONTINUE-HERE.md']) {
      assert.strictEqual(run(cmd, dir).status, 0, cmd);
    }
  } finally { rm(dir); }
});

test('ALLOW: handover exists but is untracked/unstaged and the commit does not include it', () => {
  const dir = makeRepo({ 'src/a.js': 'a\n', 'HANDOVER.md': 'h\n', '.anti-hall/handovers/d/s/HANDOVER.md': 'h\n' });
  try {
    git(dir, 'add', 'src/a.js');
    assert.strictEqual(run('git commit -m "code"', dir).status, 0, 'plain commit');
    assert.strictEqual(run('git commit -am "code"', dir).status, 0, '-a only commits TRACKED changes; untracked handovers are not included');
  } finally { rm(dir); }
});

test('ALLOW: explicit pathspec that does not include the staged handover', () => {
  const dir = makeRepo({ 'src/a.js': 'a\n', 'HANDOVER.md': 'h\n' });
  try {
    git(dir, 'add', 'src/a.js', 'HANDOVER.md');
    assert.strictEqual(run('git commit -m "code" src/a.js', dir).status, 0);
  } finally { rm(dir); }
});

test('ALLOW: commit in a DIFFERENT, clean repo (cd / -C) while the cwd repo has a staged handover', () => {
  const dirty = makeRepo({ 'HANDOVER.md': 'h\n' });
  const clean = makeRepo({ 'src/a.js': 'a\n' });
  try {
    git(dirty, 'add', 'HANDOVER.md');
    git(clean, 'add', 'src/a.js');
    for (const cmd of [`cd ${clean} && git commit -m x`, `git -C ${clean} commit -m x`]) {
      assert.strictEqual(run(cmd, dirty).status, 0, cmd);
    }
  } finally { rm(dirty); rm(clean); }
});

test('ALLOW (fail open): not a repo, missing directory, --git-dir form', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-handover-plain-'));
  try {
    assert.strictEqual(run('git commit -m x', plain).status, 0, 'not a repo -> query fails -> allow');
    assert.strictEqual(run('git -C /nonexistent-gg-dir commit -m x', plain).status, 0, 'missing dir -> allow');
    assert.strictEqual(run('git --git-dir=/nonexistent/.git commit -m x', plain).status, 0, '--git-dir -> allow');
  } finally { rm(plain); }
});

test('ALLOW: the plugin\'s own handover skill / KB docs / tests (not named HANDOVER*.md) staged', () => {
  const files = [
    'plugins/anti-hall/skills/handover/SKILL.md',
    'plugins/anti-hall/codex/skills/anti-hall-handover/SKILL.md',
    'docs/KB-handover-research.md',
    'docs/KB-session-handover.md',
    'tests/hooks/handover-find.test.js',
    'tests/hooks/auto-handover-gate.test.js',
    'plugins/anti-hall/hooks/handover-resume.js',
  ];
  const dir = makeRepo(Object.fromEntries(files.map((f) => [f, 'x\n'])));
  try {
    git(dir, 'add', ...files);
    assert.strictEqual(run('git commit -m "docs"', dir).status, 0);
  } finally { rm(dir); }
});

test('SKIP: the documented skip.json git-guard override allows the commit', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'h\n' });
  try {
    git(dir, 'add', 'HANDOVER.md');
    assert.strictEqual(run('git commit -m wip', dir, { skip: true }).status, 0);
  } finally { rm(dir); }
});

test('SETTING: guards.handoverCommitGuard=false (settings.json) and ANTIHALL_HANDOVER_COMMIT_GUARD=0 turn the rule off', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'h\n' });
  try {
    git(dir, 'add', 'HANDOVER.md');
    assert.strictEqual(run('git commit -m wip', dir, { settings: { guards: { handoverCommitGuard: false } } }).status, 0);
    assert.strictEqual(run('git commit -m wip', dir, { env: { ANTIHALL_HANDOVER_COMMIT_GUARD: '0' } }).status, 0);
    assert.strictEqual(run('git commit -m wip', dir).status, 2, 'default ON');
  } finally { rm(dir); }
});

// ---- review round 1: narrowed path rule, remediation, mid-operation, budget, add -A ----

test('ALLOW: template / docs / source files named HANDOVER*.md below the repo root', () => {
  const files = ['docs/templates/HANDOVER.md', 'src/handover/HANDOVER.md', 'plugins/x/references/HANDOVER-TEMPLATE.md', 'notes/CONTINUE-HERE.md', 'a/b.continue-here.md'];
  const dir = makeRepo(Object.fromEntries(files.map((f) => [f, 'x\n'])));
  try {
    git(dir, 'add', ...files);
    assert.strictEqual(run('git commit -m "templates"', dir).status, 0);
    assert.strictEqual(run('git commit -am "templates"', dir).status, 0);
  } finally { rm(dir); }
});

test('ALLOW: `git rm --cached <handover>` then commit (removal of an already-tracked handover)', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'h\n', '.anti-hall/handovers/d/s/HANDOVER.md': 'h\n' });
  try {
    git(dir, 'add', '-f', 'HANDOVER.md', '.anti-hall/handovers/d/s/HANDOVER.md');
    git(dir, 'commit', '-qm', 'oops');
    git(dir, 'rm', '-q', '--cached', 'HANDOVER.md', '.anti-hall/handovers/d/s/HANDOVER.md');
    assert.strictEqual(run('git commit -m "untrack handovers"', dir).status, 0);
    assert.strictEqual(run('git commit -am "untrack handovers"', dir).status, 0);
  } finally { rm(dir); }
});

test('BLOCK message names restore --staged (new) and rm --cached (already tracked)', () => {
  const dir = makeRepo({ 'HANDOVER.md': 'h\n' });
  try {
    git(dir, 'add', 'HANDOVER.md');
    const r = run('git commit -m wip', dir);
    assert.match(r.stderr, /git restore --staged <path>/);
    assert.match(r.stderr, /git rm --cached <path>/);
  } finally { rm(dir); }
});

test('ALLOW: concluding a real `git merge --no-commit` whose incoming history carries a handover', () => {
  const dir = makeRepo({ 'src/a.js': 'a\n' });
  try {
    git(dir, 'checkout', '-q', '-b', 'feat');
    write(dir, 'HANDOVER.md', 'h\n');
    git(dir, 'add', 'HANDOVER.md');
    git(dir, 'commit', '-qm', 'feat has a handover');
    git(dir, 'checkout', '-q', '-');
    write(dir, 'other.txt', 'o\n');
    git(dir, 'add', 'other.txt');
    git(dir, 'commit', '-qm', 'diverge');
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'feat');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')), 'precondition: merge in progress');
    assert.strictEqual(run('git commit -m "merge feat"', dir).status, 0);
  } finally { rm(dir); }
});

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge/', 'rebase-apply/']) {
  test(`ALLOW: ${marker} present in the git dir (operation in progress) even with a staged handover`, () => {
    const dir = makeRepo({ 'HANDOVER.md': 'h\n' });
    try {
      git(dir, 'add', 'HANDOVER.md');
      assert.strictEqual(run('git commit -m x', dir).status, 2, 'precondition: blocked without the marker');
      const p = path.join(dir, '.git', marker);
      if (marker.endsWith('/')) fs.mkdirSync(p); else fs.writeFileSync(p, 'x\n');
      assert.strictEqual(run('git commit -m x', dir).status, 0);
    } finally { rm(dir); }
  });
}

test('ADVISORY (not silent): the ninth distinct repo exhausts the query budget -> allowed, with a skipped-commit notice', () => {
  const dirs = [];
  try {
    for (let i = 0; i < 9; i++) dirs.push(makeRepo({}));
    const cmd = dirs.map((d) => `git -C ${d} commit -m x`).join(' ; ');
    const r = run(cmd, dirs[0]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /handover-commit check was skipped for 1 commit\(s\)/);
  } finally { dirs.forEach(rm); }
});

test('BLOCK: `git add -A && git commit` / `git add HANDOVER.md && git commit` with an un-ignored handover', () => {
  const dir = makeRepo({ 'src/a.js': 'a\n', 'HANDOVER.md': 'h\n' });
  try {
    for (const cmd of ['git add -A && git commit -m x', 'git add . && git commit -m x', 'git add -u . ; git add HANDOVER.md && git commit -m x', 'git add HANDOVER.md && git commit -m x']) {
      const r = run(cmd, dir);
      assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, /includes a session handover/);
    }
  } finally { rm(dir); }
});

test('ALLOW: `git add -A && git commit` when .anti-hall/ is git-ignored, or the add does not cover the handover', () => {
  const ignored = makeRepo({ '.gitignore': '.anti-hall/\n', 'src/a.js': 'a\n', '.anti-hall/handovers/d/s/HANDOVER.md': 'h\n' });
  const other = makeRepo({ 'src/a.js': 'a\n', 'HANDOVER.md': 'h\n' });
  try {
    assert.strictEqual(run('git add -A && git commit -m x', ignored).status, 0, 'ignored .anti-hall/');
    assert.strictEqual(run('git add src && git commit -m x', other).status, 0, 'add of src/ does not pick up the root handover');
    assert.strictEqual(run('git add src/a.js && git commit -m x', other).status, 0);
  } finally { rm(ignored); rm(other); }
});

test('isHandoverPath: root-only basename rule + any-depth .anti-hall/handovers/ (unit)', () => {
  const { isHandoverPath } = require('../../plugins/anti-hall/hooks/lib/handover-find.js');
  for (const p of ['HANDOVER.md', 'HANDOVER-3.md', './HANDOVER.md', 'CONTINUE-HERE.md', 'y.continue-here.md', '.anti-hall/handovers/d/s/HANDOVER.md', 'a/.anti-hall/handovers/x.md']) {
    assert.ok(isHandoverPath(p), p);
  }
  for (const p of ['a/b/HANDOVER-3.md', 'x/CONTINUE-HERE.md', 'x/y.continue-here.md', 'docs/templates/HANDOVER.md', 'src/handover/HANDOVER.md',
    'plugins/anti-hall/skills/handover/SKILL.md', 'docs/KB-session-handover.md', 'docs/KB-handover-research.md',
    'tests/hooks/handover-find.test.js', 'handover.md', 'HANDOVER.md.bak', 'MYHANDOVER.md', 'CONTINUE-HERE.md.js', '.anti-hall/history/x.md']) {
    assert.ok(!isHandoverPath(p), p);
  }
});
