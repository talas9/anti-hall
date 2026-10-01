'use strict';
// command-guard.js — a shell loop/conditional whose BODY is only anti-hall's
// own devswarm.js verbs (plus bounded filters) is judged per body segment, so
// the `do`/`then` keyword glued to the first body command no longer defeats
// the start-anchored devswarm light exception. Any heavy body segment still
// blocks. Also pins: read-only `ls | grep -c` chained to a light devswarm
// segment stays allowed; an env-assignment prefix on `git push` stays blocked
// (env can carry exec vectors, e.g. GIT_SSH_COMMAND) while the bare push form
// is the approved allow-plain-push shape.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
const DS = 'node ~/.anti-hall/bin/devswarm.js';

function run(command, cwd) {
  const h = makeHome();
  try {
    return testHook(HOOK, {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 't', cwd: cwd || process.cwd(),
    }, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  } finally { h.cleanup(); }
}
const blocked = (c, cwd) => run(c, cwd).status === 2;

test('devswarm loop: for/do body of only devswarm.js sends + bounded grep is allowed', () => {
  const c = `M=/tmp/x/msg.md; for t in primary-3577eb29 primary-3c744cd7; do ${DS} send --to $t --message-file $M 2>&1 | grep -oE '"verified":[a-z]*'; done`;
  assert.strictEqual(blocked(c), false);
});

test('devswarm loop: if/then body with a devswarm.js verb is allowed', () => {
  assert.strictEqual(blocked(`if ${DS} roster; then ${DS} inbox tick a --quiet; fi`), false);
});

test('devswarm loop: a heavy body command still blocks', () => {
  assert.ok(blocked('for t in a b; do npm test; done'));
  assert.ok(blocked(`for t in a b; do ${DS} send --to $t --message-file /tmp/m; npm test; done`));
  assert.ok(blocked('for t in a b; do node build.js; done'));
});

test('devswarm loop: heavy command in condition / else / while still blocks', () => {
  assert.ok(blocked('if npm test; then echo ok; fi'));
  assert.ok(blocked(`if ${DS} roster; then echo a; else npm run build; fi`));
  assert.ok(blocked('while npm test; do echo x; done'));
});

test('devswarm loop: a leading `!` negation does not hide the heavy verb', () => {
  assert.ok(blocked('while ! npm test; do :; done'));
  assert.ok(blocked('until ! npm install; do :; done'));
  assert.ok(blocked('if ! npm run build; then echo failed; fi'));
  assert.ok(blocked('if true; then ! npm test; fi'));
  assert.strictEqual(blocked(`while ! ${DS} roster; do :; done`), false); // light verb stays light
});

test('devswarm loop: heavy command substitution in the loop list or args still blocks', () => {
  assert.ok(blocked(`for t in $(npm test); do ${DS} send --to $t; done`));
  assert.ok(blocked(`for t in a; do ${DS} send --to $(npm test); done`));
});

test('light devswarm segment chained to read-only ls | grep -c stays allowed', () => {
  assert.strictEqual(blocked(`timeout 20 ${DS} inbox tick primary-0a1b2c3d --quiet; ls -la ~/.claude/projects/ | grep -c deadbeef`), false);
});

test('devswarm.js exemption: file name must end exactly at devswarm.js', () => {
  for (const ok of ['node ~/.anti-hall/bin/devswarm.js roster', 'node ~/.anti-hall/bin/devswarm.js',
    'node $HOME/.anti-hall/bin/devswarm.js roster', 'node plugins/anti-hall/scripts/devswarm.js roster',
    'node /x/cache/anti-hall/0.1.0/scripts/devswarm.js send --to a']) {
    assert.strictEqual(blocked(ok), false, ok);
  }
  // (.jsx / .js2 are not heavy-classified at all — the generic node pattern needs .js/.mjs/.cjs —
  // so only the `.js.<suffix>` look-alikes and foreign launcher dirs are assertable here.)
  for (const bad of ['node ~/.anti-hall/bin/devswarm.js.evil x', 'node scripts/devswarm.js.evil x',
    'node ~/.anti-hall/bin/devswarm.js.bak x', 'node ~/evil/.anti-hall/bin/devswarm.js x']) {
    assert.ok(blocked(bad), bad);
  }
});

// ---- bounded verification: cd prefix, venv interpreter, JS test runners ----

function makeProject() {
  const dir = fs.mkdtempSync(path.join('/tmp', 'dsloop-proj-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'export.py'), 'print(1)\n');
  fs.symlinkSync(process.execPath, path.join(dir, 'venv', 'bin', 'python'));
  fs.mkdirSync(path.join(dir, 'sub'));
  return dir;
}

test('cd <dir> && <script --check> | tail resolves the script against the cd target', () => {
  const proj = makeProject();
  const elsewhere = fs.mkdtempSync(path.join('/tmp', 'dsloop-else-'));
  try {
    assert.strictEqual(blocked(`cd ${proj} && python3 tools/export.py --check 2>&1 | tail -15`, elsewhere), false);
    // No cd: the same relative script does not exist under the payload cwd.
    assert.ok(blocked('python3 tools/export.py --check 2>&1 | tail -15', elsewhere));
    // An unresolvable cd (expansion) makes relative script paths unknowable.
    assert.ok(blocked('cd $HOME/x && python3 tools/export.py --check 2>&1 | tail -15', proj));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('path-qualified venv interpreter + script --check | tail is allowed; look-alikes are not', () => {
  const proj = makeProject();
  try {
    assert.strictEqual(blocked(`cd ${proj}/sub && ../venv/bin/python ../tools/export.py --check 2>&1 | tail -15`, proj), false);
    assert.strictEqual(blocked('venv/bin/python tools/export.py --check | tail -5', proj), false);
    assert.ok(blocked('nonexistent/bin/python tools/export.py --check | tail -5', proj)); // interpreter must exist
    assert.ok(blocked('venv/bin/python tools/export.py --check', proj)); // unbounded output
    assert.ok(blocked('venv/bin/python tools/export.py --check | tail -5; npm test', proj));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('vitest/jest on 1-2 EXISTING explicit test files piped to tail allowed; suites/flags/globs/patterns blocked', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vitest-')));
  try {
    fs.mkdirSync(path.join(proj, 'src'));
    for (const f of ['src/a.test.ts', 'src/b.test.ts', 'src/a.spec.js', 'a.test.ts']) fs.writeFileSync(path.join(proj, f), '\n');
    fs.writeFileSync(path.join(proj, '.test.ts'), '\n'); // even an existing file named `.test.ts` has no stem
    const b = (c) => blocked(c, proj);
    assert.strictEqual(b('npx vitest run src/a.test.ts src/b.test.ts | tail -5'), false);
    assert.strictEqual(b('npx jest src/a.spec.js | tail -5'), false);
    assert.strictEqual(b('vitest run a.test.ts | tail -5'), false);
    assert.ok(b('npx vitest run'));
    assert.ok(b('npx vitest run | tail -5'));
    assert.ok(b('npx vitest run src/a.test.ts src/b.test.ts src/c.test.ts | tail -5'));
    assert.ok(b('npx vitest run src/ | tail -5'));
    assert.ok(b('npx vitest run src/*.test.ts | tail -5'));
    assert.ok(b('npx vitest run --coverage a.test.ts | tail -5'));
    assert.ok(b('npx vitest a.test.ts | tail -5')); // watch mode
    assert.ok(b('npx vitest run a.test.ts')); // unbounded output
    // A bare `.test.ts` / `.spec.ts` is a runner filter pattern, not a file.
    assert.ok(b('npx vitest run .test.ts | tail -5'));
    assert.ok(b('npx jest .test.js | tail -5'));
    assert.ok(b('npx jest .spec.tsx .test.js | tail -5'));
    // Nonexistent file: may expand to a pattern match over many files.
    assert.ok(b('npx vitest run missing.test.ts | tail -5'));
    // A directory named like a test file is not a regular file.
    fs.mkdirSync(path.join(proj, 'dir.test.ts'));
    assert.ok(b('npx vitest run dir.test.ts | tail -5'));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('a scratchpad python script piped to tail stays blocked in the foreground (message says so)', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'dsloop-scr-'));
  try {
    fs.writeFileSync(path.join(dir, 's.py'), 'print(1)\n');
    const res = run(`python3 ${dir}/s.py 2>&1 | tail -3`, dir);
    assert.strictEqual(res.status, 2);
    assert.match(res.stdout, /STILL blocked in the foreground/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock-wrapped npm build stays blocked (builds are heavy by design)', () => {
  assert.ok(blocked("timeout 540 bash -c 'until mkdir /tmp/x.lock; do sleep 1; done; npm run build; rmdir /tmp/x.lock'"));
});

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsloop-repo-'));
  const g = (...a) => cp.spawnSync('git', ['-C', dir, ...a]);
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'f'), 'x'); g('add', 'f'); g('commit', '-q', '-m', 'i');
  g('remote', 'add', 'origin', 'https://example.invalid/r.git');
  return dir;
}

test('git push <HEAD sha>:refs/heads/<current branch> allowed; foreign sha or branch blocked', () => {
  const repo = makeRepo();
  try {
    cp.spawnSync('git', ['-C', repo, 'checkout', '-q', '-b', 'ws/child-1']);
    const head = cp.spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(blocked(`git push origin ${head}:refs/heads/ws/child-1`, repo), false);
    assert.strictEqual(blocked(`git push origin ${head.slice(0, 8)}:ws/child-1`, repo), false);
    assert.ok(blocked(`git push origin ${head}:refs/heads/other`, repo)); // foreign destination
    assert.ok(blocked(`git push origin ${head}:main`, repo));
    assert.ok(blocked(`git push origin ${'0'.repeat(40)}:ws/child-1`, repo)); // not HEAD's sha
    assert.ok(blocked(`git push origin ${head.slice(0, 6)}:ws/child-1`, repo)); // too short
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('git push: bare form + bounded filter allowed; env-assignment prefix stays blocked', () => {
  const repo = makeRepo();
  try {
    assert.strictEqual(blocked('git push origin main 2>&1 | tail -2', repo), false);
    assert.ok(blocked('SKYCREW_TRIVIAL_PUSH=1 git push origin main 2>&1 | tail -2', repo));
    assert.ok(blocked('GIT_SSH_COMMAND="sh -c x" git push origin main', repo));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('cd <dir> && for-loop of devswarm.js sends piped to `head -c N` is allowed; heavy verbs in the loop stay blocked', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'dsloop-cdhead-'));
  try {
    const abs = `node ${path.join(os.homedir(), '.anti-hall', 'bin', 'devswarm.js')}`;
    assert.strictEqual(blocked(`cd ${dir} && for t in primary-6181f376 primary-0c66ac80; do ${abs} send --to $t --message-file /tmp/x.md | head -c 50; done`, dir), false);
    assert.strictEqual(blocked(`cd ${dir} && for t in a b; do ${DS} send --to $t --message-file /tmp/x.md | head -50; done`, dir), false);
    assert.ok(blocked(`cd ${dir} && for t in a; do npm test | head -c 50; done`, dir));
    assert.ok(blocked(`cd ${dir} && for t in a; do ${DS} send --to $t --message-file /tmp/x.md; npm run build | head -c 5; done`, dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
