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

// ---- 0.112 read-only verify: interpreter + existing script FILE + check flag --

function withScripts(fn) {
  return withRepo((repo) => {
    fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tools', 'gen_contract.py'), 'print("ok")\n');
    fs.writeFileSync(path.join(repo, 'tools', 'gen.js'), 'console.log("ok")\n');
    return fn(repo);
  });
}

const SCRIPT_CHECK_ALLOW = [
  'python3 tools/gen_contract.py --check | tail -5',
  'node tools/gen.js --check | tail -5',
  'python3 tools/gen_contract.py --dry-run | head -20',
];
for (const cmd of SCRIPT_CHECK_ALLOW) {
  test('verify-allow (script): an existing script + check flag piped to a sink is allowed: ' + cmd, () => {
    withScripts((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 0, 'expected ALLOW for ' + cmd + '\n' + r.stdout);
    });
  });
}

const SCRIPT_CHECK_BLOCK = [
  // the listed regressions that reach the carve-out
  "node -e \"require('child_process').execSync('npm test')\" --check | tail",
  'python3 tools/gen_contract.py --check; npm test',
  'python3 tools/gen_contract.py --check | tail; npm test',
  'python3 tools/gen_contract.py --check && npm test | tail',
  // inline-code / stdin forms riding on a real script
  'python3 tools/gen_contract.py -c "import os" --check | tail',
  'python3 tools/gen_contract.py -m x --check | tail',
  // (a side-effect-free -e payload is already non-heavy in the base classifier)
  "node tools/gen.js -e \"require('child_process').execSync('npm test')\" --check | tail",
  "node tools/gen.js --eval \"require('fs').writeFileSync('x','y')\" --check | tail",
  'node tools/gen.js -p "1" --check | tail',
  'node tools/gen.js --require ./x.js --check | tail',
  'python3 tools/gen_contract.py --check < /etc/passwd | tail',
  'python3 tools/gen_contract.py --check <<EOF | tail\nimport os\nEOF',
  // the script arg must be an existing regular file
  'python3 tools/missing.py --check | tail',
  'node tools/missing.js --check | tail',
  // expansion / heavy remaining args / unbounded / writes
  'python3 tools/gen_contract.py --check $(npm test) | tail',
  'python3 tools/gen_contract.py --check `npm test` | tail',
  'python3 tools/gen_contract.py --check <(npm test) | tail',
  'python3 tools/gen_contract.py --check npm run build | tail',
  'python3 tools/gen_contract.py --check',
  'python3 tools/gen_contract.py --check > /etc/out | tail',
  'python3 tools/gen_contract.py --check | tee /etc/out',
  'python3 tools/gen_contract.py | tail -5',
  // env-assignment prefixes and wrappers stay refused
  'NODE_OPTIONS=--require=./evil.js node tools/gen.js --check | tail',
  'PYTHONSTARTUP=x python3 tools/gen_contract.py --check | tail',
  'env python3 tools/gen_contract.py --check | tail',
  'nice python3 tools/gen_contract.py --check | tail',
  'sh -c "python3 tools/gen_contract.py --check" | tail',
  "bash -lc 'python3 tools/gen_contract.py' --check | tail",
  'eval python3 tools/gen_contract.py --check | tail',
  'exec python3 tools/gen_contract.py --check | tail',
  'xargs python3 tools/gen_contract.py --check | tail',
];
for (const cmd of SCRIPT_CHECK_BLOCK) {
  test('verify-allow (script): stays BLOCK: ' + JSON.stringify(cmd), () => {
    withScripts((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

// F1: the script form must never flip a safety switch or trust an allowlist.
const PLUGIN_SETTINGS_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'settings.js');
const F1_BLOCK = [
  'node ' + PLUGIN_SETTINGS_JS + ' set safety.editGuard false --confirmed --check | tail -5',
  'node ' + PLUGIN_SETTINGS_JS + ' trust-edit-allow . --confirmed --dry-run | tail',
  'node ' + PLUGIN_SETTINGS_JS + ' trust-command-allow . --confirmed --list | tail',
  // no --confirmed at all: still an anti-hall script (settings `show`/`get` are
  // separately allowlisted as read-only, so use a mutating verb here)
  'node ' + PLUGIN_SETTINGS_JS + ' set guards.modelRouting off --check | tail',
  'node tools/gen.js trust-edit-allow . --confirmed --dry-run | tail -5',
  'node tools/gen.js --check --confirmed=yes | tail -5',
];
for (const cmd of F1_BLOCK) {
  test('verify-allow (script): an anti-hall script or --confirmed never qualifies: ' + JSON.stringify(cmd), () => {
    withScripts((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

test('verify-allow (script): a script inside ANOTHER anti-hall checkout (found by its plugin.json) never qualifies', () => {
  withScripts((repo) => {
    const other = path.join(repo, 'vendor', 'ah');
    fs.mkdirSync(path.join(other, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(other, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'anti-hall' }));
    fs.writeFileSync(path.join(other, 'scripts', 'tool.js'), 'x\n');
    const r = run('node vendor/ah/scripts/tool.js --check | tail -5', { cwd: repo });
    assert.strictEqual(r.status, 2, r.stdout);
    // control: a different plugin's manifest does not count
    fs.writeFileSync(path.join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'other' }));
    assert.strictEqual(run('node vendor/ah/scripts/tool.js --check | tail -5', { cwd: repo }).status, 0);
  });
});

test('verify-allow (script): guards.allowReadOnlyVerifyScripts=false turns the script form off', () => {
  withScripts((repo) => {
    const h = makeHome();
    try {
      const r = testHook(HOOK, payload('python3 tools/gen_contract.py --check | tail -5', repo), {
        home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli', ANTIHALL_ALLOW_READ_ONLY_VERIFY_SCRIPTS: 'false' },
      });
      assert.strictEqual(r.status, 2, r.stdout);
    } finally { h.cleanup(); }
  });
});

// ---- F3: every check pipeline must end in a bounded sink; no comments ------

const F3_BLOCK = [
  // (a bare `./script --check` or `node --test x` is not heavy at all, so it never
  //  reaches this carve-out; these cases all classify heavy first)
  'python3 tools/gen_contract.py --check #| tail -5',
  'python3 tools/gen_contract.py --check # tail',
  'python3 tools/gen_contract.py --check ; # | tail -5',
  'python3 tools/gen_contract.py --check && python3 tools/gen_contract.py --check | tail -5',
  'node tools/gen.js --check | tail -5 && node tools/gen.js --check',
  'python3 tools/gen_contract.py --check | tail -5 &',
  'git clone --depth 1 https://example.invalid/r.git /tmp/cgsec-a | tail ; git clone --depth 1 https://example.invalid/r.git /tmp/cgsec-b',
  'cd tools && node gen.js --check | tail -5', // script resolves against the payload cwd, not the cd target
];
for (const cmd of F3_BLOCK) {
  test('verify-allow: an unbounded check pipeline or a comment disqualifies: ' + JSON.stringify(cmd), () => {
    withScripts((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

const F3_ALLOW = [
  'python3 tools/gen_contract.py --check | tail -5 && node tools/gen.js --check | head -3',
  'python3 tools/gen_contract.py --check "#not-a-comment" | tail -5',
];
for (const cmd of F3_ALLOW) {
  test('verify-allow: control — every check pipeline bounded is still allowed: ' + JSON.stringify(cmd), () => {
    withScripts((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 0, 'expected ALLOW for ' + cmd + '\n' + r.stdout);
    });
  });
}

// ---- per-project allowlist fixtures -----------------------------------------

function writeAllow(repo, patterns) {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.anti-hall', 'command-allow.json'), JSON.stringify({ patterns }));
}

const allowLib = require('../../plugins/anti-hall/hooks/lib/command-allow.js');
function trustAllow(home, repo) {
  const f = allowLib.readAllowFile(repo);
  allowLib.recordTrust(home, repo, f.hash);
}

// allowRun(repo, command, patterns) -> spawn result with a fresh home in
// which the written allowlist is TRUSTED (so the other gates are what's tested).
function allowRun(repo, command, patterns) {
  writeAllow(repo, patterns);
  const h = makeHome();
  trustAllow(h.home, repo);
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
  // A bare `HOME: undefined` here does NOT isolate anything — os.homedir()
  // falls back through the platform passwd db to the REAL user home when
  // HOME is unset. Every current call site passes its own isolated `home`,
  // but the default must still be a safe, disposable temp dir — never the
  // real machine home — so a future call site that omits `home` can't leak
  // into the real store (see tests/hooks/doctor-default-home-isolation.test.js).
  const fallbackHome = home || fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: fallbackHome, USERPROFILE: fallbackHome, DEVSWARM_REPO_ID: undefined,
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
  for (const p of ['^npm run deploy -- \\S+$', '^npm run deploy -- [^ ]+$', '^bin/deploy\\.sh$', '^npm run (prod|staging)$',
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

// ---- #4 trust: a working-tree allowlist cannot self-authorize ---------------

const SETTINGS_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'settings.js');
const TRUSTED_ARG = 'npm run deploy -- prod';

function settingsCli(args, home, cwd) {
  return cp.spawnSync(process.execPath, [SETTINGS_JS].concat(args), {
    cwd, encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
  });
}

test('trust: an untrusted (never-trusted) allowlist applies nothing', () => {
  withRepo((repo) => {
    writeAllow(repo, [DEPLOY_ARG]);
    const h = makeHome();
    try {
      const r = run(TRUSTED_ARG, { cwd: repo, home: h.home });
      assert.strictEqual(r.status, 2, 'an untrusted working-tree allowlist must not allow: ' + r.stdout);
    } finally {
      h.cleanup();
    }
  });
});

test('trust: editing a trusted allowlist makes it untrusted (hash mismatch)', () => {
  withRepo((repo) => {
    writeAllow(repo, ['^npm run deploy -- staging$']);
    const h = makeHome();
    try {
      trustAllow(h.home, repo);
      writeAllow(repo, [DEPLOY_ARG]); // content changed after trust
      const r = run(TRUSTED_ARG, { cwd: repo, home: h.home });
      assert.strictEqual(r.status, 2, 'an edited allowlist must be untrusted: ' + r.stdout);
    } finally {
      h.cleanup();
    }
  });
});

test('trust: a symlinked allowlist file is refused even when its target hash is trusted', () => {
  withRepo((repo) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cgsec-outside-'));
    const h = makeHome();
    try {
      writeAllow(repo, [DEPLOY_ARG]);
      trustAllow(h.home, repo);
      const real = path.join(outside, 'allow.json');
      fs.copyFileSync(path.join(repo, '.anti-hall', 'command-allow.json'), real);
      fs.rmSync(path.join(repo, '.anti-hall', 'command-allow.json'));
      fs.symlinkSync(real, path.join(repo, '.anti-hall', 'command-allow.json'));
      const r = run(TRUSTED_ARG, { cwd: repo, home: h.home });
      assert.strictEqual(r.status, 2, 'a symlinked allowlist must be refused: ' + r.stdout);
    } finally {
      h.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('trust CLI: without --confirmed prints patterns and records nothing; with it the allowlist applies', () => {
  withRepo((repo) => {
    writeAllow(repo, [DEPLOY_ARG, '^.*$']);
    const h = makeHome();
    try {
      const dry = settingsCli(['trust-command-allow', repo], h.home, repo);
      assert.strictEqual(dry.status, 1);
      assert.match(dry.stdout, /npm run deploy/);
      assert.match(dry.stdout, /ignored: must begin with a literal command word/);
      assert.ok(!fs.existsSync(allowLib.trustFilePath(h.home)), 'nothing recorded without --confirmed');
      assert.strictEqual(run(TRUSTED_ARG, { cwd: repo, home: h.home }).status, 2);

      const yes = settingsCli(['trust-command-allow', repo, '--confirmed', '--json'], h.home, repo);
      assert.strictEqual(yes.status, 0, yes.stderr);
      const out = JSON.parse(yes.stdout);
      assert.strictEqual(out.ok, true);
      const rec = JSON.parse(fs.readFileSync(allowLib.trustFilePath(h.home), 'utf8'));
      assert.strictEqual(rec[fs.realpathSync(repo)], out.sha256);
      assert.strictEqual(run(TRUSTED_ARG, { cwd: repo, home: h.home }).status, 0, 'trusted allowlist applies');
    } finally {
      h.cleanup();
    }
  });
});

test('doctor: reports an untrusted allowlist with the trust command', () => {
  withRepo((repo) => {
    writeAllow(repo, [DEPLOY_ARG]);
    const h = makeHome();
    try {
      const out = runDoctor(repo, h.home);
      assert.match(out, /command-allow\.json is NOT trusted/);
      assert.match(out, /trust-command-allow/);
    } finally {
      h.cleanup();
    }
  });
});

// ---- #6 plain push: the remote must be a configured remote name ------------

for (const cmd of ['git push ../other-repo main', 'git push remote.example.com/evil main', 'git push /tmp/x', 'git push nosuchremote main']) {
  test('plain-push: non-remote destination does not qualify: ' + cmd, () => {
    withRepo((repo) => {
      cp.spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git']);
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

test('plain-push: a named remote in a repo with NO remotes fails closed', () => {
  withRepo((repo) => {
    const r = run('git push origin main', { cwd: repo });
    assert.strictEqual(r.status, 2, r.stdout);
  });
});

test('plain-push: control — the configured remote still qualifies', () => {
  withRepo((repo) => {
    cp.spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    const r = run('git push origin main', { cwd: repo });
    assert.strictEqual(r.status, 0, r.stdout);
  });
});

// ---- #7 audit log: no symlink follow, secrets redacted ---------------------

const DEPLOY_ANY = '^npm run deploy -- [^ ]+ --token [^ ]+$';

test('audit log: secret values in the logged command are redacted', () => {
  withRepo((repo) => {
    writeAllow(repo, [DEPLOY_ANY]);
    const h = makeHome();
    try {
      trustAllow(h.home, repo);
      const secret = 'ghp_' + 'A'.repeat(36);
      const r = run('npm run deploy -- prod --token ' + secret, { cwd: repo, home: h.home });
      assert.strictEqual(r.status, 0, r.stdout);
      const log = fs.readFileSync(path.join(h.home, '.anti-hall', 'logs', 'command-allow.ndjson'), 'utf8');
      assert.ok(!log.includes(secret), 'secret must not be logged: ' + log);
      assert.match(JSON.parse(log.trim()).command, /^npm run deploy -- prod --token \[REDACTED/);
    } finally {
      h.cleanup();
    }
  });
});

test('audit log: a symlinked log file is never written through', () => {
  withRepo((repo) => {
    writeAllow(repo, [DEPLOY_ARG]);
    const h = makeHome();
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgsec-victim-'));
    try {
      trustAllow(h.home, repo);
      const victim = path.join(victimDir, 'victim.txt');
      fs.writeFileSync(victim, 'original\n');
      fs.mkdirSync(path.join(h.home, '.anti-hall', 'logs'), { recursive: true });
      fs.symlinkSync(victim, path.join(h.home, '.anti-hall', 'logs', 'command-allow.ndjson'));
      const r = run(TRUSTED_ARG, { cwd: repo, home: h.home });
      assert.strictEqual(r.status, 0, 'the allowed command still runs (audit is fail-open): ' + r.stdout);
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original\n', 'symlink target must be untouched');
    } finally {
      h.cleanup();
      fs.rmSync(victimDir, { recursive: true, force: true });
    }
  });
});

test('audit log: a symlinked logs dir is never written through', () => {
  withRepo((repo) => {
    writeAllow(repo, [DEPLOY_ARG]);
    const h = makeHome();
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgsec-victimdir-'));
    try {
      trustAllow(h.home, repo);
      fs.symlinkSync(victimDir, path.join(h.home, '.anti-hall', 'logs'));
      const r = run(TRUSTED_ARG, { cwd: repo, home: h.home });
      assert.strictEqual(r.status, 0, r.stdout);
      assert.deepStrictEqual(fs.readdirSync(victimDir), [], 'nothing written into the symlinked dir');
    } finally {
      h.cleanup();
      fs.rmSync(victimDir, { recursive: true, force: true });
    }
  });
});

// ---- #8 redirect targets are resolved before the scratchpad/tmp test --------
// ---- #9 clone: only --depth 1 https into scratchpad/os.tmpdir() -------------

// '/tmp' (not os.tmpdir()): the hook child runs with an isolated env that may
// not carry TMPDIR, and /tmp is a tmp root on every supported platform.
const TMPD = fs.realpathSync('/tmp');

// A heavy primary (`git clone`, HEAVY_PATTERNS) is what makes the carve-out
// reachable; a `node --test` line is not heavy and is allowed regardless.
const CLONE_OK = `git clone --depth 1 https://example.com/r.git ${TMPD}/cgsec-c`;
const PATH_BLOCK = [
  CLONE_OK + ' | tail > /Users/x/scratchpad/../../../etc/zz',
  CLONE_OK + ` | tail > ${TMPD}/../../../etc/zz`,
  CLONE_OK + ' | tail > /opt/scratchpad/x',
  'git clone /Users/me/big /tmp/scratchpad/x | tail',
  `git clone ${TMPD}/src ${TMPD}/dst | tail`,
  'git clone --depth 1 https://example.com/r.git /Users/x/scratchpad/../../etc/r | tail',
  'git clone --depth 1 https://example.com/r.git /opt/scratchpad/r | tail',
  `git clone --depth 1 ssh://example.com/r.git ${TMPD}/r | tail`,
  `git clone --depth 1 https://example.com/r.git ${TMPD}/../../r | tail`,
];

for (const cmd of PATH_BLOCK) {
  test('verify-allow: path escape / non-https clone does not qualify: ' + cmd, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
  });
}

test('verify-allow: a symlinked component under tmp that points outside is rejected', () => {
  const dir = fs.mkdtempSync(path.join(TMPD, 'cgsec-link-'));
  try {
    // A link inside tmp pointing at a real non-tmp dir (nothing is written:
    // the guard only classifies the command).
    fs.symlinkSync('/usr', path.join(dir, 'escape'));
    const r = run(CLONE_OK + ` | tail > ${dir}/escape/zz.log`);
    assert.strictEqual(r.status, 2, 'redirect through a symlink out of tmp must BLOCK: ' + r.stdout);
    const r2 = run(`git clone --depth 1 https://example.com/r.git ${dir}/escape/clone | tail`);
    assert.strictEqual(r2.status, 2, 'clone through a symlink out of tmp must BLOCK: ' + r2.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-allow: control — https --depth 1 clone into os.tmpdir() still qualifies', () => {
  const r = run(`git clone --depth 1 https://example.com/r.git ${TMPD}/cgsec-clone-ok | tail -1`);
  assert.strictEqual(r.status, 0, r.stdout);
});

test('verify-allow: control — clone into the session scratchpad qualifies', () => {
  const cwd = fs.realpathSync(os.tmpdir());
  const uid = process.getuid();
  const sp = path.join('/tmp', 'claude-' + uid, cwd.replace(/\//g, '-'), 't', 'scratchpad');
  const r = run(`git clone --depth 1 https://example.com/r.git ${sp}/x | tail -1`, { cwd });
  assert.strictEqual(r.status, 0, r.stdout);
});
