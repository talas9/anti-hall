'use strict';
// Coordinator-drift Phase 5: scripts/coordinator-work-baseline.js replays a
// transcript's main-thread Bash calls through the classifier and the F1 window
// and prints the would-be numbers. Built from the sanitised replay fixture.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'anti-hall', 'scripts', 'coordinator-work-baseline.js');
const FIXTURE = require(path.join(ROOT, 'tests', 'fixtures', 'coordinator-drift-replay.json'));
const H = process.env.HOME;
delete process.env.S;

const BASE = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cw-baseline-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const REPO = path.join(BASE, 'repo');
const SCRATCH = path.join(BASE, 'scratch');
const SCRIPTS = ['push-dev.sh', 'ruleset.sh', 'push-and-rules.sh', 'topics.sh', 'fullsuite.sh', 'cl-merge.sh', 'og.sh'];

function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function git(...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
}
fs.mkdirSync(REPO, { recursive: true });
git('init', '-q');
for (const rel of ['.github/workflows/test.yml', 'CHANGELOG.md', 'RELEASING.md', 'tests/hooks/limit-conserve.test.js']) put(path.join(REPO, rel), 'x\n');
git('add', '-A');
git('commit', '-qm', 'init');
function makeScripts() {
  for (const s of SCRIPTS) { put(path.join(SCRATCH, s), '#!/bin/sh\necho x\n'); fs.chmodSync(path.join(SCRATCH, s), 0o755); }
}
makeScripts();
put(path.join(H, '.anti-hall', 'bin', 'devswarm.js'), '// launcher\n');

const sub = (s) => s.split('@SCRATCH_ROOT@').join(BASE).split('@SCRATCH@').join(SCRATCH).split('@REPO@').join(REPO).split('@HOME@').join(H);
const lines = [];
for (const r of FIXTURE) {
  const id = 'toolu_' + r.n;
  const input = r.tool === 'Bash' ? { command: sub(r.command) } : {};
  lines.push({ type: 'assistant', isSidechain: false, timestamp: r.ts, cwd: REPO, message: { content: [{ type: 'tool_use', id, name: r.tool, input }] } });
  lines.push({ type: 'user', isSidechain: false, timestamp: r.ts, cwd: REPO, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !r.posted, content: 'x' }] } });
}
// A sidechain (subagent) git push between rows: must be ignored.
lines.splice(10, 0, { type: 'assistant', isSidechain: true, timestamp: FIXTURE[5].ts, cwd: REPO, message: { content: [{ type: 'tool_use', id: 'toolu_side', name: 'Bash', input: { command: 'git push' } }] } });
const TRANSCRIPT = path.join(BASE, 't.jsonl');
fs.writeFileSync(TRANSCRIPT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

function run(args) {
  return childProcess.spawnSync(process.execPath, [SCRIPT, ...args], { cwd: BASE, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: H, ANTIHALL_TEST_HOME_ISOLATED: H } });
}

test('baseline --json over the replay transcript', () => {
  const r = run([TRANSCRIPT, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.calls, 89);
  assert.strictEqual(j.work, 28);
  assert.ok(Math.abs(j.share - 0.315) < 0.001, 'share ' + j.share);
  assert.ok(Math.abs(j.attemptedShare - 0.344) < 0.001, 'attempted ' + j.attemptedShare);
  assert.strictEqual(j.wouldNudge, 3);
  assert.strictEqual(j.wouldBlock, 16);
  assert.deepStrictEqual(Object.keys(j).sort(), ['attemptedShare', 'calls', 'share', 'work', 'wouldBlock', 'wouldNudge']);
});

test('baseline: scratch scripts deleted -> work 21', () => {
  for (const s of SCRIPTS) fs.rmSync(path.join(SCRATCH, s), { force: true });
  try {
    const r = run([TRANSCRIPT, '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).work, 21);
  } finally {
    makeScripts();
  }
});

test('baseline: plain output names the numbers', () => {
  const r = run([TRANSCRIPT]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /calls/);
  assert.match(r.stdout, /89/);
});

test('baseline: a missing file exits 1', () => {
  const r = run([path.join(BASE, 'nope.jsonl'), '--json']);
  assert.strictEqual(r.status, 1);
});
