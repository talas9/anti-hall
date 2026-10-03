'use strict';
// command-guard Phase 4 (coordinator drift): script-file runs and inline
// interpreter code as WORK. scriptPathVerdict's ordered steps (scratch,
// managed, in-repo, outside), the binary/CLI/plugin exemptions, freshness,
// precise (blockable) and loose (count-only) inline code, the frozen anti-hall
// CLI list, the reworded scratchpad hint, git spawn counts and latency.
// Classification only: no row's command-guard exit changes (F1 enforces).
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'command-guard.js');
const cg = require(HOOK);
const allowLib = require('../../plugins/anti-hall/hooks/lib/command-allow.js');
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const H = process.env.HOME; // the isolated test HOME; fixture HOME files live here
const OLD = Date.now() / 1000 - 2 * 86400;
delete process.env.S;

function git(cwd, ...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}
function put(file, body, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode) fs.chmodSync(file, mode);
  return file;
}
const age = (file, secs) => fs.utimesSync(file, secs, secs);
const SH = '#!/bin/sh\necho x\n';
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);

const BASE = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-scratch-work-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const REPO = path.join(BASE, 'repo');
const X = path.join(BASE, 'x'); // scratch/tmp dir (not a git work tree)
const PLUG = path.join(BASE, 'plug'); // a copy of an anti-hall plugin root under tmp
const PROJ = path.join(H, 'proj'); // a non-git project (inside HOME, so not a tmp path)

// Repo: tracked scripts committed, then aged; .venv gitignored + fresh; untracked fresh notes-dir scripts.
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q');
const TRACKED = ['.claude/skills/x/scripts/run.py', '.claude/skills/x/run.sh', '.claude/tracked.sh', 'scripts/build.sh',
  'scripts/release.sh', 'scripts/lint.sh', 'gradlew', 'configure', 'bin/rails'];
for (const rel of TRACKED) put(path.join(REPO, rel), SH, 0o755);
put(path.join(REPO, '.gitignore'), '.venv/\n');
put(path.join(REPO, 'src/a.js'), 'a\n');
put(path.join(REPO, 'a.txt'), 'a\n');
const ALLOW_PATTERN = '^bash ' + path.join(X, 'trusted.sh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
put(path.join(REPO, '.anti-hall/command-allow.json'), JSON.stringify({ patterns: [ALLOW_PATTERN] }));
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'init');
for (const rel of TRACKED.concat(['.gitignore', 'src/a.js', 'a.txt'])) age(path.join(REPO, rel), OLD);
fs.utimesSync(path.join(REPO, 'scripts/lint.sh'), new Date(), new Date()); // tracked, clean, fresh mtime
put(path.join(REPO, '.venv/bin/pytest'), SH, 0o755);
for (const rel of ['.claude/push.sh', '.omc/x.sh', '.anti-hall/x.sh']) put(path.join(REPO, rel), SH, 0o755);

// Isolated HOME.
for (const rel of ['push.sh', 'bin/deploy.sh', '.claude/skills/x/run.sh', '.dotnet/tools/x', '.local/bin/x',
  'Library/x-old.sh', '.claude/plugins/foo/old.sh']) age(put(path.join(H, rel), SH, 0o755), OLD);
for (const rel of ['go/bin/golangci-lint', 'Library/Android/sdk/platform-tools/adb']) age(put(path.join(H, rel), ELF, 0o755), OLD);
for (const rel of ['.local/bin/p.sh', 'Library/x.sh', '.claude/plugins/foo/x.sh']) put(path.join(H, rel), SH, 0o755);
const HOURS = (n) => Date.now() / 1000 - n * 3600;
age(put(path.join(H, '.local/bin/h7.sh'), SH, 0o755), HOURS(7));
age(put(path.join(H, '.local/bin/h1.sh'), SH, 0o755), HOURS(1));
age(put(path.join(PROJ, 'configure'), SH, 0o755), OLD);
put(path.join(PROJ, 'x.sh'), SH, 0o755);

// Sibling (old), scratch (fresh), FIFO, plugin root copy.
age(put(path.join(BASE, 'sibling/scripts/check.sh'), SH, 0o755), OLD);
for (const rel of ['push-dev.sh', 'p.sh', '.venv/bin/p.sh', 'node_modules/.bin/p.sh', 'env.sh', 'trusted.sh']) put(path.join(X, rel), SH, 0o755);
childProcess.spawnSync('mkfifo', [path.join(X, 'fifo')]);
put(path.join(PLUG, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'anti-hall' }));
put(path.join(PLUG, 'scripts/devswarm.js'), '1\n');
put(path.join(PLUG, 'scripts/x.sh'), SH, 0o755);

// Trust the repo's command-allow file for the in-process classifier (HOME = H).
{
  const top = allowLib.repoToplevel(REPO);
  const f = allowLib.readAllowFile(top);
  if (f.state === 'ok') allowLib.recordTrust(H, top, f.hash);
}

const START = () => Date.now() - 3600000;
function cls(command, cwd, opts) {
  return cg.classifyBashWork(command, { session_id: 't', cwd: cwd || REPO }, opts === undefined ? { sessionStartTs: START() } : opts);
}
function hookExit(command, cwd) {
  return testHook(HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: cwd || REPO },
    { home: H, env: COORD }).status;
}

// [command, work, blockable, devExit, cwd?]. devExit = the exit of the dev (ccddffe5) hook on the same fixture.
const SCRIPT_ROWS = [
  // WORK, blockable
  [`${X}/push-dev.sh`, true, true, 0],
  [`sh ${X}/cl-merge.sh`, true, true, 0],
  [`bash ${X}/p.sh`, true, true, 0],
  [`node ${X}/a.js`, true, true, 2],
  [`python3 ${X}/a.py`, true, true, 2],
  [`ruby ${X}/a.rb`, true, true, 0],
  [`perl ${X}/a.pl`, true, true, 0],
  [`${X}/.venv/bin/p.sh`, true, true, 0],
  [`${X}/node_modules/.bin/p.sh`, true, true, 0],
  ['$S/fullsuite.sh', true, true, 0],
  ['${S}/x.sh', true, true, 0],
  ['sh .anti-hall/x.sh', true, true, 0],
  ['bash .claude/push.sh', true, true, 0],
  ['bash .omc/x.sh', true, true, 0],
  ['bash ~/push.sh', true, true, 0],
  ['~/bin/deploy.sh', true, true, 0],
  ['bash ~/.claude/skills/x/run.sh', true, true, 0],
  ['../sibling/scripts/check.sh', true, true, 0],
  ['~/.local/bin/p.sh', true, true, 0],
  ['bash ~/Library/x.sh', true, true, 0],
  ['bash ~/.claude/plugins/foo/x.sh', true, true, 0],
  ['./x.sh', true, true, 0, PROJ],
  // not WORK
  ['bash scripts/lint.sh', false, false, 0],
  ['.venv/bin/pytest -q', false, false, 2],
  ['bash ~/Library/x-old.sh', false, false, 0],
  ['bash ~/.claude/plugins/foo/old.sh', false, false, 0],
  ['python3 .claude/skills/x/scripts/run.py', false, false, 2],
  ['bash .claude/skills/x/run.sh', false, false, 0],
  ['"$PWD/gradlew"', false, false, 0],
  ['./gradlew build', false, false, 0],
  ['./configure', false, false, 0],
  ['bash scripts/build.sh', false, false, 0],
  ['./scripts/release.sh', false, false, 0],
  ['./bin/rails routes', false, false, 0],
  ['$HOME/.local/bin/x', false, false, 0],
  ['~/.dotnet/tools/x', false, false, 0],
  ['~/go/bin/golangci-lint run', false, false, 0],
  ['~/Library/Android/sdk/platform-tools/adb devices', false, false, 0],
  ['/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -version', false, false, 0],
  ['source .venv/bin/activate && pytest -q', false, false, 2],
  ['. ~/.nvm/nvm.sh && nvm use', false, false, 0],
  ['./node_modules/.bin/eslint .', false, false, 0],
  ['/usr/local/bin/foo', false, false, 0],
  ['/opt/homebrew/bin/foo', false, false, 0],
  [".venv/bin/python -c 'print(1)'", false, false, 0],
  [`source ${X}/env.sh`, false, false, 0],
  [`node ${H}/.anti-hall/bin/devswarm.js inbox tick x --quiet`, false, false, 0],
  [`node ${PLUG}/scripts/devswarm.js skip coordinator-work-guard`, false, false, 0],
  [`bash ${PLUG}/scripts/x.sh`, false, false, 0],
  [`bash -n ${X}/p.sh`, false, false, 0],
  [`bash ${X}/trusted.sh`, false, false, 0],
  [`${X}/missing-bin`, false, false, 0],
  [`${X}/fifo`, false, false, 0],
  ['./configure', false, false, 0, PROJ],
];

const INLINE_ROWS = [
  // precise: WORK, blockable
  [`python3 -c "import subprocess;subprocess.run(['git','push'])"`, true, true, 0],
  [`python3 -c "import os;os.system('gh pr merge 1')"`, true, true, 0],
  [`python3 -c "open('src/a.py','w').write('x')"`, true, true, 0],
  [`python3 -c "open('src/x.py','r+').write('x')"`, true, true, 0],
  [`node -e 'require("fs").writeFileSync("CHANGELOG.md","x")'`, true, true, 2],
  [`ruby -e 'File.write("a.rb","x")'`, true, true, 0],
  [`perl -e 'system("git commit -am x")'`, true, true, 0],
  // loose: WORK, count-only
  [`python3 -c "import os;os.system('echo x > a.txt')"`, true, false, 0],
  [`node -e 'const f=process.argv[1];require("fs").writeFileSync(f,"x")'`, true, false, 2],
  [`python3 -c "open('/Users/x/out.txt','w')"`, true, false, 0],
  // not WORK
  [`python3 -c "open('src/x.py', encoding='ascii').read()"`, false, false, 0],
  [`python3 -c "open('src/x.py').read()"`, false, false, 0],
  [`python3 -c 'print("a" if x > 3 else "b")'`, false, false, 0],
  [`node -e 'console.log("count > 5")'`, false, false, 0],
  [`python3 -c "import subprocess;subprocess.run(['git','branch','--show-current'])"`, false, false, 0],
  [`node -e 'require("child_process").execSync("git tag -l")'`, false, false, 0],
  [`node -e 'require("child_process").execSync("git stash list")'`, false, false, 0],
  [`node -e 'require("fs").writeFileSync("/tmp/x","y")'`, false, false, 2],
  [`python3 -c "print('git commit')"`, false, false, 0],
  [`node -e 'console.log("x > 1")'`, false, false, 0],
  [`node -e 'log("usage: gh pr create")'`, false, false, 0],
  [`python3 -c 'print(1)'`, false, false, 0],
  [`node -e '1'`, false, false, 0],
];

test('exports: frozen ANTI_HALL_CLI_PATTERNS (3 RegExps) and scriptPathVerdict', () => {
  assert.ok(Array.isArray(cg.ANTI_HALL_CLI_PATTERNS) && Object.isFrozen(cg.ANTI_HALL_CLI_PATTERNS));
  assert.strictEqual(cg.ANTI_HALL_CLI_PATTERNS.length, 3);
  assert.ok(cg.ANTI_HALL_CLI_PATTERNS.every((re) => re instanceof RegExp));
  assert.strictEqual(typeof cg.scriptPathVerdict, 'function');
});

for (const [command, work, blockable, , cwd] of SCRIPT_ROWS) {
  test(`script ${work ? 'WORK' : 'not WORK'}: ${command}${cwd ? ' (non-git cwd)' : ''}`, () => {
    const r = cls(command, cwd);
    assert.strictEqual(r.work, work, JSON.stringify([...r.labels]));
    assert.strictEqual(r.blockable, blockable);
    if (work) assert.ok(r.labels.has('script'), JSON.stringify([...r.labels]));
  });
}

for (const [command, work, blockable] of INLINE_ROWS) {
  test(`inline ${work ? (blockable ? 'precise' : 'loose') : 'not WORK'}: ${command}`, () => {
    const r = cls(command);
    assert.strictEqual(r.work, work, JSON.stringify([...r.labels]));
    assert.strictEqual(r.blockable, blockable);
    if (work) assert.ok(r.labels.has('inline'), JSON.stringify([...r.labels]));
  });
}

test('every row: the command-guard exit equals its dev exit', () => {
  const diffs = [];
  for (const [command, , , devExit, cwd] of SCRIPT_ROWS.concat(INLINE_ROWS)) {
    const got = hookExit(command, cwd);
    if (got !== devExit) diffs.push(`${command}: ${got} (dev ${devExit})`);
  }
  assert.deepStrictEqual(diffs, []);
});

test('a script run chained with a git commit stays WORK when the script part is trusted', () => {
  assert.strictEqual(cls(`bash ${X}/trusted.sh`).work, false);
  const r = cls(`bash ${X}/p.sh && git commit -qm x`);
  assert.ok(r.work && r.blockable && r.labels.has('script') && r.labels.has('git'));
});

test('scriptPathVerdict: pure rows with an injected root', () => {
  const v = (real, info) => cg.scriptPathVerdict(real, Object.assign({
    root: null, home: '/home/u', fresh: false, isScratchOrTmp: false, notesTarget: () => false, gitClean: () => false,
  }, info));
  assert.deepStrictEqual(v('/opt/app/.anti-hall/x.sh', { root: '/opt/app' }), { work: true, step: 'scratch' });
  assert.deepStrictEqual(v('/opt/app/tools/x.sh', { root: '/opt/app', notesTarget: () => true }), { work: true, step: 'in-repo' });
  assert.deepStrictEqual(v('/opt/app/tools/x.sh', { root: '/opt/app' }), { work: false, step: 'in-repo' });
  assert.deepStrictEqual(v('/opt/homebrew/bin/x', { root: '/opt/app' }), { work: false, step: 'managed' });
  assert.deepStrictEqual(v('/usr/local/bin/x', { root: null }), { work: false, step: 'managed' });
  assert.deepStrictEqual(v('/tmp/x/.venv/bin/p.sh', { isScratchOrTmp: true }), { work: true, step: 'scratch' });
  // in-repo, fresh: decided by git status alone; outside personal dirs: by freshness
  assert.deepStrictEqual(v('/opt/app/tools/x.sh', { root: '/opt/app', fresh: true, gitClean: () => true }), { work: false, step: 'in-repo' });
  assert.deepStrictEqual(v('/home/u/.local/bin/x', { fresh: true }), { work: true, step: 'outside' });
  assert.deepStrictEqual(v('/home/u/.local/bin/x', {}), { work: false, step: 'outside' });
  assert.deepStrictEqual(v('/home/u/push.sh', {}), { work: true, step: 'outside' });
  assert.deepStrictEqual(v('/home/u/.cargo/bin/x', { fresh: true }), { work: false, step: 'managed' });
});

test('freshness default is now - 6 h when no opts are passed', () => {
  assert.strictEqual(cls('bash ~/.local/bin/x', REPO, {}).work, false);
  assert.strictEqual(cls('bash ~/.local/bin/h7.sh', REPO, {}).work, false);
  assert.strictEqual(cls('bash ~/.local/bin/h1.sh', REPO, {}).work, true);
});

test('git spawn counts (execFileSync stub)', (t) => {
  const real = childProcess.execFileSync;
  let n = 0;
  childProcess.execFileSync = function (file, ...rest) { if (file === 'git') n++; return real.call(this, file, ...rest); };
  const rows = [['./gradlew build', 0], ['bash .claude/skills/x/run.sh', 1], ['bash scripts/lint.sh', 1],
    ['.venv/bin/pytest -q', 0], [`${X}/.venv/bin/p.sh`, 0], ['./configure', 0, PROJ]];
  const got = [];
  try {
    for (const [command, , cwd] of rows) { n = 0; cls(command, cwd); got.push(n); }
  } finally { childProcess.execFileSync = real; }
  rows.forEach(([command, want, cwd], i) => t.diagnostic(`spawns ${got[i]} (want ${want}): ${command}${cwd ? ' [non-git]' : ''}`));
  assert.deepStrictEqual(got, rows.map((r) => r[1]));
});

test('latency: classifyBashWork p95 < 150 ms on a 5,000-char command', (t) => {
  const tail = 'sed -i s/a/b/ src/a.js && bash .claude/tracked.sh';
  const chunk = 'git status && echo x >> /tmp/l.log && sed -n 1p a.txt && ';
  let command = '';
  while (command.length + chunk.length + tail.length <= 5000) command += chunk;
  command += 'echo ' + 'y'.repeat(Math.max(0, 5000 - command.length - tail.length - 9)) + ' && ' + tail;
  assert.ok(command.length >= 4990 && command.length <= 5010, String(command.length));
  const r = cls(command);
  assert.ok(r.work && r.labels.has('repo-write') && !r.labels.has('script'), JSON.stringify([...r.labels]));
  const times = [];
  for (let i = 0; i < 21; i++) {
    const s = process.hrtime.bigint();
    cg.classifyBashWork(command, { session_id: 't', cwd: REPO }, { sessionStartTs: START() });
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const sorted = times.slice(1).sort((a, b) => a - b);
  t.diagnostic(`p95 ${sorted[18].toFixed(1)} ms (len ${command.length})`);
  assert.ok(sorted[18] < 150, `p95 ${sorted[18]} ms`);
});

test('hint: read-only output capture; state changes and test runs go to a subagent', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build' }, session_id: 't', cwd: REPO },
      { home: h.home, env: COORD });
    assert.strictEqual(r.status, 2);
    assert.ok(r.json.reason.startsWith('To capture READ-ONLY output yourself: write the command to a scratchpad script and run it with run_in_background (then read its output); each script run is counted as main-thread work. State changes (commit, push, patch apply, gh mutations, repo edits) and test runs go to a subagent.'), r.json.reason.slice(0, 300));
    assert.ok(!/coordinator work window/i.test(r.json.reason));
  } finally { h.cleanup(); }
});

// Last: mutates a tracked file, then restores it.
test('an edited tracked script is WORK, even after its mtime is set back', () => {
  const f = path.join(REPO, '.claude/skills/x/run.sh');
  fs.appendFileSync(f, 'echo edited\n');
  try {
    assert.strictEqual(cls('bash .claude/skills/x/run.sh').work, true);
    age(f, OLD);
    const r = cls('bash .claude/skills/x/run.sh');
    assert.ok(r.work && r.blockable && r.labels.has('script'));
  } finally { git(REPO, 'checkout', '--', '.claude/skills/x/run.sh'); }
});
