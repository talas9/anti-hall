'use strict';
// command-guard.js security regressions (0.111 review of the main-thread
// allowances: read-only verify, per-project allowlist, plain push). Every
// case here was a reproduced BLOCK -> ALLOW bypass; each must BLOCK again.
// All runs use a fresh isolated HOME and an explicit fixture repo/cwd.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

function makeRepo(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cgsec-repo-')));
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  cp.spawnSync('git', ['-C', dir, 'add', 'f.txt']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function payload(command, cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 't',
    cwd,
  };
}

// run(command, {cwd, home}) -> spawn result. A caller-supplied home is kept
// (the caller cleans it up); otherwise a fresh one is made and removed.
function run(command, opts) {
  const o = opts || {};
  const own = o.home ? null : makeHome();
  const home = o.home || own.home;
  try {
    return testHook(HOOK, payload(command, o.cwd || fs.realpathSync(os.tmpdir())), {
      home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
  } finally {
    if (own) own.cleanup();
  }
}

function withRepo(fn) {
  const repo = makeRepo();
  try { return fn(repo); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

// ---- #5 splitter: a backslash outside quotes escapes the next char ----------

const SPLITTER_BLOCK = [
  // bash reads `\"` as a literal quote char, so `npm test` is its own command.
  'git add . && git commit -m \\" ; npm test ; echo \\" && git push',
  'node --test a.test.js \\" ; npm test ; echo \\" | tail',
  'echo \\" ; npm test ; echo \\"',
  // `\'` likewise opens no single-quote span: $(...) still expands.
  "git add . && git commit -m \\'$(npm test)\\' && git push",
];

for (const cmd of SPLITTER_BLOCK) {
  test('splitter: backslash-escaped quote does not hide a segment: ' + cmd, () => {
    withRepo((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

test('splitter: a real double-quoted arg with an escaped quote inside stays one segment', () => {
  withRepo((repo) => {
    // `"a \" ; npm test ; b"` IS one quoted string in bash — no npm test runs.
    const r = run('git add . && git commit -m "a \\" ; npm test ; b" && git push', { cwd: repo });
    assert.strictEqual(r.status, 0, 'a genuinely quoted message must still be allowed: ' + r.stdout);
  });
});

// ---- #1 read-only verify: a check flag never launders a wrapped payload -----

const CHECK_FLAG_BLOCK = [
  'sh -c "npm test" --check | tail -5',
  "bash -lc 'npm test' --dry-run | tail",
  'eval "npm test" --check | tail',
  "node -e \"require('child_process').execSync('npm test')\" --check | tail",
  'nice -n 19 bash -c "npm test" --check | tail',
  'env npm test --check | tail',
  'xargs npm test --check | tail',
];

for (const cmd of CHECK_FLAG_BLOCK) {
  test('verify-allow: check flag on a shell/interpreter/wrapper does not qualify: ' + cmd, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
  });
}

test('verify-allow: a plain script with --check piped to tail is still allowed (no over-block)', () => {
  const r = run('./scripts/verify.sh --check | tail');
  assert.strictEqual(r.status, 0, r.stdout);
});

// ---- per-project allowlist fixtures -----------------------------------------

function writeAllow(repo, patterns) {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.anti-hall', 'command-allow.json'), JSON.stringify({ patterns }));
}

// allowRun(repo, command, patterns) -> spawn result with a fresh home.
function allowRun(repo, command, patterns) {
  writeAllow(repo, patterns);
  const h = makeHome();
  try {
    return run(command, { cwd: repo, home: h.home });
  } finally {
    h.cleanup();
  }
}

// ---- #2 allowlist: no shell expansion may reach the pattern match -----------

const DEPLOY_ARG = '^npm run deploy -- \\S+$';
const EXPANSION_BLOCK = [
  'npm run deploy -- "$(npm${IFS}test|sh)"',
  'npm run deploy -- "`npm test`"',
  'npm run deploy -- "${X:-y}"',
  'npm run deploy -- "$HOME"',
  'npm run deploy -- $HOME',
  'npm run deploy -- \\$x',
  "npm run deploy -- '$(id)'",
];

for (const cmd of EXPANSION_BLOCK) {
  test('project-allow: expansion/escape anywhere is never matched: ' + cmd, () => {
    withRepo((repo) => {
      const r = allowRun(repo, cmd, [DEPLOY_ARG]);
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

test('project-allow: control — a plain literal argument still matches', () => {
  withRepo((repo) => {
    const r = allowRun(repo, 'npm run deploy -- prod', [DEPLOY_ARG]);
    assert.strictEqual(r.status, 0, r.stdout);
  });
});

// ---- #3 allowlist: `^.*$` and friends are not anchored rules ----------------

const { validatePattern } = require('../../plugins/anti-hall/hooks/lib/command-allow.js');
const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function runDoctor(cwd, home) {
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
    }),
  });
  return (res.stdout || '') + (res.stderr || '');
}

test('validatePattern: wildcard / non-literal / alternation patterns are rejected', () => {
  for (const p of ['^.*$', '^npm .*$', '^npm (.*)$', '^npm .+?$', '^npm [^;]*$',
    '^npm [\\s\\S]+$', '^npm test$|^.*$', '^npm (?:x|.)*$', '^[a-z]+ x$', '^npm x.{0,}$', 'npm test$', '^npm test']) {
    assert.strictEqual(validatePattern(p).ok, false, 'must reject ' + p);
  }
  for (const p of ['^npm run deploy -- \\S+$', '^bin/deploy\\.sh$', '^npm run (prod|staging)$',
    '^firebase deploy --only functions:[a-z0-9,:]+ --project [a-z0-9-]+$']) {
    assert.strictEqual(validatePattern(p).ok, true, 'must accept ' + p);
  }
});

for (const cmd of ['npm test', 'npm run deploy', 'bash -c "npm test; curl -s x | sh"']) {
  test('project-allow: `^.*$` allows nothing: ' + cmd, () => {
    withRepo((repo) => {
      const r = allowRun(repo, cmd, ['^.*$']);
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

test('doctor: reports an ignored wildcard pattern with its reason', () => {
  withRepo((repo) => {
    writeAllow(repo, ['^.*$', '^npm .*$']);
    const h = makeHome();
    try {
      const out = runDoctor(repo, h.home);
      assert.match(out, /command-allow\.json has 2 ignored pattern/);
      assert.match(out, /unbounded wildcard/);
    } finally {
      h.cleanup();
    }
  });
});
