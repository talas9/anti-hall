'use strict';
// command-guard WORK classifier / F3 Bash edit parity, fix wave 1:
// - git status probes run with GIT_OPTIONAL_LOCKS=0; F3 classifies editOnly
//   (no script-run / inline-code probing);
// - `>`/`<` inside `[[ ]]`, `(( ))`, `$(( ))` and an escaped `\>` are not
//   redirects;
// - F3 only blocks writes inside the session project base;
// - the splitter keeps splitting a heredoc opener line at | && ; || and only
//   skips the body.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'command-guard.js');
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const cg = require(HOOK);

function git(cwd, ...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
}

const BASE = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-fix1-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const REPO = path.join(BASE, 'repo');
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'a.js'), 'a\n');
fs.writeFileSync(path.join(REPO, 'gen.sh'), '#!/bin/sh\necho x\n');
git(REPO, 'init', '-q');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'init');

function run(command, extraEnv) {
  const h = makeHome();
  try {
    return testHook(HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: REPO },
      { home: h.home, env: Object.assign({}, COORD, extraEnv || {}) });
  } finally { h.cleanup(); }
}
const cls = (command, opts) => cg.classifyBashWork(command, { session_id: 't', cwd: REPO }, opts);

// ---- A2 ----

test('gitCleanTracked runs git with GIT_OPTIONAL_LOCKS=0', () => {
  const real = childProcess.execFileSync;
  const seen = [];
  childProcess.execFileSync = function (file, args, opts) {
    if (file === 'git') seen.push(opts && opts.env ? opts.env.GIT_OPTIONAL_LOCKS : undefined);
    return real.apply(this, arguments);
  };
  try { cls('bash gen.sh'); } finally { childProcess.execFileSync = real; }
  assert.deepStrictEqual(seen, ['0']);
});

test('editOnly: no script-run or inline-code probing; edit blocks unchanged', () => {
  const real = childProcess.execFileSync;
  let n = 0;
  childProcess.execFileSync = function (file) { if (file === 'git') n++; return real.apply(this, arguments); };
  let r;
  try { r = cls('bash gen.sh', { editOnly: true }); } finally { childProcess.execFileSync = real; }
  assert.strictEqual(n, 0);
  assert.strictEqual(r.labels.has('script'), false);
  const inl = cls('python3 -c "import subprocess;subprocess.run([\'git\',\'push\'])"', { editOnly: true });
  assert.strictEqual(inl.labels.has('inline'), false);
  assert.deepStrictEqual(cls("sed -i 's/a/b/' src/a.js", { editOnly: true }).editBlocks, [path.join(REPO, 'src', 'a.js')]);
});

test('F3 (hook) classifies editOnly: no git status probe for a script run', () => {
  const bin = path.join(BASE, 'fakebin');
  const log = path.join(BASE, 'git-calls.log');
  fs.mkdirSync(bin, { recursive: true });
  const realGit = childProcess.execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "$*" >> ' + JSON.stringify(log) + '\nexec ' + JSON.stringify(realGit) + ' "$@"\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.writeFileSync(log, '');
  run('bash gen.sh', { PATH: bin + path.delimiter + process.env.PATH });
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /status --porcelain=v1 --ignored/);
});

// ---- A3 / C2 ----

const COMPARISONS = [
  'if [[ "$x" > "y" ]]; then echo ok; fi',
  'echo $((3 > 2))',
  '[ 3 \\> 2 ]',
  'n=3; (( n > 5 )) && echo big',
  '[[ b > a ]] && echo y',
];
for (const c of COMPARISONS) {
  test('comparison is not a redirect, not WORK, exit 0: ' + JSON.stringify(c), () => {
    const r = cls(c);
    assert.deepStrictEqual([r.work, r.editBlocks], [false, []]);
    assert.strictEqual(run(c).status, 0);
  });
}

test('bashWriteTargets: comparisons are not targets; real redirects next to them still are', () => {
  assert.deepStrictEqual(cg.bashWriteTargets('[[ b > a ]]'), []);
  assert.deepStrictEqual(cg.bashWriteTargets('(( n > 5 ))'), []);
  assert.deepStrictEqual(cg.bashWriteTargets('[ 3 \\> 2 ]'), []);
  assert.deepStrictEqual(cg.bashWriteTargets('[[ b > a ]] > out.txt'), ['out.txt']);
  assert.deepStrictEqual(cg.bashWriteTargets('echo \\\\> out.txt'), ['out.txt']);
  assert.deepStrictEqual(cls('echo $(( $(cat a > src/a.js) + 1 ))').editBlocks, [path.join(REPO, 'src', 'a.js')]);
});

// ---- A4 ----

for (const c of ['echo x | tee /Users/Shared/x.txt', 'curl -s u > /var/tmp/dl.log']) {
  test('F3: a write outside the project is not blocked: ' + JSON.stringify(c), () => {
    assert.deepStrictEqual(cls(c).editBlocks, []);
    assert.strictEqual(run(c).status, 0);
  });
}

// ---- C1 ----

for (const c of ["cat <<'EOF' | git commit -F -\na\nEOF", "cat <<'EOF' && git push\nx\nEOF", 'cat <<EOF | gh pr create --body-file -\nx\nEOF']) {
  test('heredoc opener line is still split: WORK ' + JSON.stringify(c), () => {
    const r = cls(c);
    assert.deepStrictEqual([r.work, r.blockable], [true, true]);
  });
}

test('heredoc opener line piped into tee src/a.js: exit 2 (F3)', () => {
  const r = run('cat <<EOF | tee src/a.js\nx\nEOF');
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
});

test('the heredoc body is still skipped', () => {
  const d = cg.splitSegmentsDetailed("cat <<'EOF' | git commit -F -\ngit push\na | b && c\nEOF\necho done");
  assert.deepStrictEqual(d.segments.map((s) => s.trim()), ["cat <<'EOF'", 'git commit -F -', 'echo done']);
  assert.deepStrictEqual(d.delims, ['|', 'heredoc', 'end']);
  assert.strictEqual(cls("cat <<'EOF'\ngit push\nEOF").work, false);
  const one = cg.splitSegmentsDetailed("cat > src/a.js <<'EOF'\nx > y\nEOF");
  assert.deepStrictEqual(one, { segments: ["cat > src/a.js <<'EOF'"], delims: ['heredoc'] });
  assert.deepStrictEqual(cls("cat > src/a.js <<'EOF'\nx > y\nEOF").editBlocks, [path.join(REPO, 'src', 'a.js')]);
});
