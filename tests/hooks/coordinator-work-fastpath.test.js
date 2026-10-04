'use strict';
// lib/coordinator-work.js provablyNotWork: the pre-filter that lets
// coordinator-work-guard skip loading command-guard.js for plain read-only
// commands. Differential: whenever the pre-filter says "not work", the real
// classifyBashWork must agree (work false, blockable false). The corpus is every
// string literal in the guard's own test files plus adversarial near-misses.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'plugins', 'anti-hall', 'hooks');
const { provablyNotWork } = require(path.join(HOOKS, 'lib', 'coordinator-work.js'));
const { classifyBashWork } = require(path.join(HOOKS, 'command-guard.js'));

const REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fast-')));
process.on('exit', () => { try { fs.rmSync(REPO, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
childProcess.spawnSync('git', ['init', '-q'], { cwd: REPO });
fs.writeFileSync(path.join(REPO, 'a.txt'), 'a\n');
fs.writeFileSync(path.join(REPO, 'run.sh'), '#!/bin/sh\necho x\n', { mode: 0o755 });

const ACCEPT = [
  'git status', 'git status --short', 'git log --oneline -5', 'git diff HEAD -- a.txt', 'git show HEAD:a.txt',
  'ls -la', 'ls -la src/ && git status', 'cat a.txt | head -20', 'pwd; ls', 'grep -rn foo src | wc -l',
  'rg -n foo', 'git rev-parse --show-toplevel', 'git ls-files | wc -l', 'git blame a.txt', 'git describe --tags',
  'tail -n 50 a.txt || true', 'git status\ngit log --oneline',
];
const REJECT = [
  'git commit -qm x', 'git push', 'git branch -D x', 'ls > out.txt', 'cat a.txt >> b.txt', 'echo hi', './run.sh', 'bash run.sh',
  'node -e "1"', 'ls $(pwd)', 'ls `pwd`', 'git -C x status', 'git diff --output=o.txt', 'git diff -o x', 'sed -i s/a/b/ a.txt',
  'FOO=1 ls', 'ls; rm -rf x', 'ls &', 'cat a.txt | bash', 'git status && git add .', 'tee out.txt', 'ls "a b"', 'ls *.txt', 'cat <(ls)',
  'git log --format=%h > o', '', '   ', 'gh pr merge 1',
];

test('provablyNotWork accepts the read-only vocabulary and rejects everything else', () => {
  for (const c of ACCEPT) assert.strictEqual(provablyNotWork(c), true, 'accept: ' + c);
  for (const c of REJECT) assert.strictEqual(provablyNotWork(c), false, 'reject: ' + c);
  assert.strictEqual(provablyNotWork(undefined), false);
  assert.strictEqual(provablyNotWork('ls ' + 'a'.repeat(5000)), false);
});

function corpus() {
  const out = new Set([...ACCEPT, ...REJECT]);
  for (const f of ['coordinator-work-guard.test.js', 'coordinator-work-replay.test.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.add(m[1] || m[2] || m[3] || '');
  }
  const verbs = ['ls', 'cat', 'head', 'tail', 'pwd', 'wc', 'grep', 'rg', 'which', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'id', 'uname', 'true', 'false'];
  const args = ['', '-l', 'a.txt', '-n 5 a.txt', '.', 'run.sh', './run.sh', '../x', '-rn foo .', '--help', 'a.txt run.sh'];
  for (const v of verbs) for (const a of args) { out.add((v + ' ' + a).trim()); out.add(('git status && ' + v + ' ' + a).trim()); out.add((v + ' ' + a + ' | wc -l').trim()); }
  for (const s of ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe']) for (const a of ['', '-n 3', 'HEAD', '--stat', 'a.txt', '-- a.txt', 'run.sh']) out.add(('git ' + s + ' ' + a).trim());
  return [...out];
}

test('differential: every command the pre-filter accepts is non-work to classifyBashWork', () => {
  let accepted = 0;
  const all = corpus();
  assert.ok(all.length > 300, 'corpus size ' + all.length);
  const payload = { session_id: 's', cwd: REPO };
  for (const c of all) {
    if (!provablyNotWork(c)) continue;
    accepted++;
    const r = classifyBashWork(c, payload, { sessionStartTs: Date.now() - 1000 });
    assert.strictEqual(r.work, false, 'work for accepted command: ' + JSON.stringify(c));
    assert.strictEqual(r.blockable, false, 'blockable for accepted command: ' + JSON.stringify(c));
  }
  assert.ok(accepted > 150, 'pre-filter accepted ' + accepted + ' corpus commands');
});
