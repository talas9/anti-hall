'use strict';
// git-guard: git/shell aliases (guards.gitAliasResolve) and reused commit
// messages (guards.gitReusedMessageCheck) - hooks/lib/git-alias-scan.js.
// Every case runs against a real fixture repo whose git config holds the
// aliases, with an isolated HOME (empty global config) and no system config.
// Dangerous strings are assembled from pieces so this file is not itself a
// force push / credit trailer to any scanner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'git-guard.js';
const HOOK_ABS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', HOOK);
const PUSH = 'pu' + 'sh';
const FORCE = '--' + 'force';
const CR = 'Co-' + 'Authored-By: Claude Sonnet 5 <noreply@' + 'anthropic.com>';
const ENV = { GIT_CONFIG_NOSYSTEM: '1' };

const h = makeHome();
const gitEnv = { PATH: process.env.PATH, HOME: h.home, GIT_CONFIG_NOSYSTEM: '1' };
function mkRepo(headCredited) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-alias-'));
  const g = (...a) => {
    const r = spawnSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('commit', '-q', '--allow-empty', '-m', 'credited\n\n' + CR);
  const credited = g('rev-parse', 'HEAD');
  if (!headCredited) g('commit', '-q', '--allow-empty', '-m', 'clean');
  return { repo, g, credited };
}
const A = mkRepo(false); // HEAD clean, aliases configured
const B = mkRepo(true); // HEAD carries the trailer
A.g('config', 'alias.pf', PUSH + ' ' + FORCE);
A.g('config', 'alias.pp', PUSH);
A.g('config', 'alias.ci', 'commit');
A.g('config', 'alias.ci2', 'ci');
A.g('config', 'alias.sh1', '!git ' + PUSH + ' ' + FORCE + ' origin main');
A.g('config', 'alias.loop1', 'loop2');
A.g('config', 'alias.loop2', 'loop1');
A.g('config', 'alias.st', 'status');
A.g('config', 'alias.lg', 'log --oneline');
A.g('config', 'alias.status', PUSH + ' ' + FORCE); // shadows a builtin: git ignores it
fs.writeFileSync(path.join(A.repo, 'tmpl.txt'), 'subject\n\n' + CR + '\n');

function run(command, cwd, env) {
  return testHook(HOOK, Object.assign(bashPayload(command), { cwd }), { home: h.home, env: Object.assign({}, ENV, env || {}) });
}
const VIA_ALIAS = /^⛔ anti-hall · git-guard: via git alias `/;
const FORCE_RE = /force push[^\n]* is blocked/;
const CREDIT_RE = /self-credit/;

// ---------------------------------------------------------------- alias use
const BLOCK_USE = [
  ['force push through a config alias', 'git pf origin main', FORCE_RE],
  ['call-site -f through a plain push alias', 'git pp -f origin main', FORCE_RE],
  ['credit through a commit alias', 'git ci -m "x\n\n' + CR + '"', CREDIT_RE],
  ['credit through an alias chain', 'git ci2 -m "x\n\n' + CR + '"', CREDIT_RE],
  ['!shell alias body', 'git sh1', FORCE_RE],
  ['alias name in another case (config names are case-insensitive)', 'git PF origin main', FORCE_RE],
  ['inside bash -c', 'bash -c "git pf origin main"', FORCE_RE],
  ['inside eval', 'eval git pf origin main', FORCE_RE],
  ['behind sudo', 'sudo git pf origin main', FORCE_RE],
];
for (const [name, cmd, re] of BLOCK_USE) {
  test('ALIAS BLOCK: ' + name, () => {
    const r = run(cmd, A.repo);
    assert.strictEqual(r.status, 2, cmd + '\n' + r.stderr);
    assert.match(r.stderr, VIA_ALIAS);
    assert.match(r.stderr, re);
  });
}

test('ALIAS BLOCK: repo chosen by -C and by a leading cd, from another cwd', () => {
  assert.strictEqual(run('git -C ' + A.repo + ' pf origin main', os.tmpdir()).status, 2);
  assert.strictEqual(run('cd ' + A.repo + ' && git pf origin main', os.tmpdir()).status, 2);
});

test('ALIAS BLOCK: Codex-shaped payload', () => {
  const payload = Object.assign(bashPayload('git pf origin main'), {
    cwd: A.repo, turn_id: 'turn-1', model: 'gpt-5.5', permission_mode: 'default', tool_use_id: 'call_1',
  });
  const r = testHook(HOOK, payload, { home: h.home, env: ENV });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, VIA_ALIAS);
});

const ALLOW_USE = [
  ['benign alias', 'git st'],
  ['benign alias with args', 'git lg -5'],
  ['clean message through a commit alias', 'git ci -m "fix: thing"'],
  ['alias loop (git refuses to run it)', 'git loop1'],
  ['builtin shadowed by an alias is the builtin', 'git status'],
  ['unknown subcommand, no alias', 'git nosuchthing'],
];
for (const [name, cmd] of ALLOW_USE) {
  test('ALIAS ALLOW: ' + name, () => {
    const r = run(cmd, A.repo);
    assert.strictEqual(r.status, 0, cmd + '\n' + r.stderr);
  });
}

// --------------------------------------------------------- alias definition
const BLOCK_DEF = [
  ['git config alias with a credited commit', 'git config alias.c "commit -m \'x\n\n' + CR + '\'"', /defining git alias `c`/],
  ['git config --global alias with a force push', 'git config --global alias.q "' + PUSH + ' ' + FORCE + '"', /force push/],
  ['git -c alias with a credited commit', 'git -c alias.z="commit -m \'x\n\n' + CR + '\'" z', /self-credit/],
  ['GIT_CONFIG_VALUE_<n> with a credited commit', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.z GIT_CONFIG_VALUE_0="commit -m \'x\n\n' + CR + '\'" git z', /GIT_CONFIG_VALUE_0/],
  ['shell alias with a credited commit', "alias gc='git commit -m \"x\n\n" + CR + "\"'", /defining shell alias `gc`/],
  ['shell alias with a force push', "alias gp='git " + PUSH + ' ' + FORCE + "'", /force push/],
  ['shell function with a credited commit', 'f(){ git commit -m "x\n\n' + CR + '"; }; f', CREDIT_RE],
];
for (const [name, cmd, re] of BLOCK_DEF) {
  test('DEFINE BLOCK: ' + name, () => {
    const r = run(cmd, A.repo);
    assert.strictEqual(r.status, 2, cmd + '\n' + r.stderr);
    assert.match(r.stderr, re);
  });
}

const ALLOW_DEF = [
  ['git config alias for log', 'git config alias.lg2 "log --oneline --graph"'],
  ['git config alias for a clean commit', 'git config alias.wip "commit -m wip"'],
  ['shell alias for ls', "alias ll='ls -la'"],
  ['git config read of an alias', 'git config --get alias.pf'],
  ['listing aliases', 'git config --get-regexp alias'],
];
for (const [name, cmd] of ALLOW_DEF) {
  test('DEFINE ALLOW: ' + name, () => {
    const r = run(cmd, A.repo);
    assert.strictEqual(r.status, 0, cmd + '\n' + r.stderr);
  });
}

// ------------------------------- calls to wrappers defined in the same command
const BLOCK_WRAP = [
  ['function forwarding "$@" to git', 'g(){ git "$@"; }; g ' + PUSH + ' ' + FORCE + ' origin main'],
  ['`function` keyword, $* forwarding', 'function g { command git $*; }\ng ' + PUSH + ' -f origin main'],
  ['wrapper calling another wrapper', 'g(){ h "$@"; }; h(){ git "$@"; }; g ' + PUSH + ' ' + FORCE + ' origin main'],
  ['shell alias used through eval', 'alias g=git; eval g ' + PUSH + ' ' + FORCE + ' origin main'],
  ['shell alias with expand_aliases on a new line', 'shopt -s expand_aliases\nalias g=git\ng ' + PUSH + ' ' + FORCE + ' origin main'],
  ['credited commit through a forwarding function', 'gc(){ git commit "$@"; }; gc -m "x\n\n' + CR + '"'],
  ['wrapper written to a file then sourced', "printf 'g(){ git \"$@\"; }' > w.sh; . ./w.sh; g " + PUSH + ' ' + FORCE + ' origin main'],
];
for (const [name, cmd] of BLOCK_WRAP) {
  test('WRAPPER BLOCK: ' + name, () => {
    const r = run(cmd, os.tmpdir());
    assert.strictEqual(r.status, 2, cmd + '\n' + r.stderr);
  });
}
const ALLOW_WRAP = [
  ['forwarding function, benign call', 'g(){ git "$@"; }; g status'],
  ['forwarding function, plain push', 'g(){ git "$@"; }; g ' + PUSH + ' origin main'],
  ['recursive function (depth-bounded)', 'g(){ g "$@"; }; g x'],
  ['unrelated function', 'f(){ echo hi; }; f a b'],
  ['unrelated alias', 'alias ll="ls -la"; eval ll'],
];
for (const [name, cmd] of ALLOW_WRAP) {
  test('WRAPPER ALLOW: ' + name, () => {
    const r = run(cmd, os.tmpdir());
    assert.strictEqual(r.status, 0, cmd + '\n' + r.stderr);
  });
}

// ----------------------------------------------------- reused commit messages
const REUSED = /message is taken from [\s\S]* self-credit trailer is blocked/;
const BLOCK_REUSE = [
  ['--amend --no-edit on a credited HEAD', B, 'git commit --amend --no-edit'],
  ['--amend (editor path, no editor set) on a credited HEAD', B, 'git commit --amend'],
  ['--amend with a no-op GIT_EDITOR on a credited HEAD', B, 'GIT_EDITOR=true git commit --amend'],
  ['-C <credited rev>', A, 'git commit -C ' + A.credited],
  ['--reuse-message=<credited rev>', A, 'git commit --reuse-message=' + A.credited],
  ['-c <credited rev> with no editor set', A, 'git commit -c ' + A.credited],
  ['bundled -aC <credited rev>', A, 'git commit -aC ' + A.credited],
  ['-t <credited template>', A, 'git commit -t tmpl.txt'],
  ['-C through a commit alias', A, 'git ci -C ' + A.credited],
  ['abbreviated --reuse=<credited rev>', A, 'git commit --reuse=' + A.credited],
  ['abbreviated --amen --no-e on a credited HEAD', B, 'git commit --amen --no-e'],
];
for (const [name, R, cmd] of BLOCK_REUSE) {
  test('REUSE BLOCK: ' + name, () => {
    const r = run(cmd, R.repo);
    assert.strictEqual(r.status, 2, cmd + '\n' + r.stderr);
    assert.match(r.stderr, REUSED);
  });
}

test('REUSE: an option-shaped -C value is never handed to git log (no file written)', () => {
  const out = path.join(A.repo, 'injected-' + process.pid + '.txt');
  assert.strictEqual(run('git commit -C --output=' + out, A.repo).status, 0);
  assert.strictEqual(fs.existsSync(out), false);
});

test('REUSE BLOCK: commit.template from git config', () => {
  const R = mkRepo(false);
  try {
    fs.writeFileSync(path.join(R.repo, 'cfg-tmpl.txt'), 'subject\n\n' + CR + '\n');
    R.g('config', 'commit.template', 'cfg-tmpl.txt');
    const r = run('git commit', R.repo);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /the commit template/);
    assert.strictEqual(run('git commit -m "fix: x"', R.repo).status, 0, 'an explicit -m does not use the template');
  } finally {
    fs.rmSync(R.repo, { recursive: true, force: true });
  }
});

const ALLOW_REUSE = [
  ['--amend -m <clean> on a credited HEAD (the fix path)', B, 'git commit --amend -m "fix: clean"'],
  ['--amend -F <file> on a credited HEAD', B, 'git commit --amend -F /dev/null'],
  ['-c <credited rev> with a real editor override (the audit checks the result)', A, 'GIT_EDITOR="sed -i /Co-Authored-By/d" git commit -c ' + A.credited],
  ['--amend with a real editor override on a credited HEAD', B, 'GIT_EDITOR="sed -i /Co-Authored-By/d" git commit --amend'],
  ['--amend --no-edit on a clean HEAD', A, 'git commit --amend --no-edit'],
  ['-C <clean rev>', A, 'git commit -C HEAD'],
  ['plain commit, no template', A, 'git commit'],
  ['-S<keyid> cluster is not read as -c', A, 'git commit -Sabc123 -m x'],
];
for (const [name, R, cmd] of ALLOW_REUSE) {
  test('REUSE ALLOW: ' + name, () => {
    const r = run(cmd, R.repo);
    assert.strictEqual(r.status, 0, cmd + '\n' + r.stderr);
  });
}

// ------------------------------------------------------------------ settings
test('SETTINGS: guards.gitAliasResolve off -> alias use and definition pass through', () => {
  assert.strictEqual(run('git pf origin main', A.repo, { ANTIHALL_GIT_ALIAS_RESOLVE: 'false' }).status, 0);
  assert.strictEqual(run("alias gc='git commit -m \"x\n\n" + CR + "\"'", A.repo, { ANTIHALL_GIT_ALIAS_RESOLVE: 'false' }).status, 0);
});

test('SETTINGS: guards.gitReusedMessageCheck off -> reused credited message passes through', () => {
  assert.strictEqual(run('git commit -C ' + A.credited, A.repo, { ANTIHALL_GIT_REUSED_MESSAGE_CHECK: 'false' }).status, 0);
});

// ------------------------------------------------------- PostToolUse audit
function audit(command, cwd) {
  const r = spawnSync(process.execPath, [HOOK_ABS, '--audit'], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    env: { PATH: process.env.PATH, HOME: h.home, GIT_CONFIG_NOSYSTEM: '1', ANTIHALL_TEST_ISOLATION: '1' },
    encoding: 'utf8',
  });
  return r.stdout;
}

test('AUDIT: an editor that writes the trailer is flagged after `git commit` (and after an aliased commit)', () => {
  const R = mkRepo(false);
  try {
    const editor = path.join(R.repo, 'ed.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nprintf \'subject\\n\\n%s\\n\' "' + CR + '" > "$1"\n', { mode: 0o755 });
    R.g('config', 'core.editor', editor);
    R.g('config', 'alias.cm', 'commit');
    // PreToolUse cannot see what the editor will write: it allows.
    assert.strictEqual(run('git commit --allow-empty', R.repo).status, 0);
    R.g('commit', '-q', '--allow-empty');
    assert.match(audit('git commit --allow-empty', R.repo), /git-guard \(audit\)/);
    assert.match(audit('git cm --allow-empty', R.repo), /git-guard \(audit\)/, 'the audit follows aliases');
    assert.strictEqual(audit('git st', R.repo), '', 'a non-commit alias is not audited');
  } finally {
    fs.rmSync(R.repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- lib units
test('commitSources parses the message-source options', () => {
  const { commitSources } = require('../../plugins/anti-hall/hooks/lib/git-alias-scan.js');
  const t = (s) => s.split(' ').map((x) => ({ text: x }));
  assert.deepStrictEqual(
    [commitSources(t('-am x')).message, commitSources(t('-aC abc')).reuse, commitSources(t('--reedit-message=abc')).reedit,
      commitSources(t('--amend --no-edit')).noEdit, commitSources(t('-t f')).template, commitSources(t('-- -C x')).reuse],
    [true, 'abc', true, true, 'f', null]);
});

test.after(() => {
  for (const R of [A, B]) fs.rmSync(R.repo, { recursive: true, force: true });
  h.cleanup();
});
