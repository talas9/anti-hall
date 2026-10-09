'use strict';
// scripts/ah-run.sh: the skills' launcher runs the engine verb and falls back to the verb's Node script
// when the engine is absent (or exits 70/75); any other engine exit is the answer.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const RUN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'ah-run.sh');
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'ah-run-')));
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

function fakeEngine(exitCode) {
  const bin = path.join(HOME, '.anti-hall', 'ah-engine', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ah-engine'), `#!/bin/sh\necho "engine $*"\nexit ${exitCode}\n`, { mode: 0o755 });
}
function run(args) {
  return cp.spawnSync('sh', [RUN, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:' + path.dirname(process.execPath), HOME } });
}

test('engine absent: the Node script answers', () => {
  const r = run(['harvest', '--dir', HOME]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/engine/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /markers/i);
});
test('engine answers: its output and exit code pass through', () => {
  fakeEngine(3);
  const r = run(['defect', 'list']);
  assert.strictEqual(r.status, 3);
  assert.match(r.stdout, /^engine defect list/);
});
test('engine exit 75 and 70 fall back to Node', () => {
  for (const code of [75, 70]) {
    fakeEngine(code);
    const r = run(['harvest', '--dir', HOME]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /engine harvest/);
    assert.match(r.stdout, /anti-hall debt markers|markers/i);
  }
});
test('an unknown verb is refused', () => {
  assert.strictEqual(run(['nope']).status, 64);
});
test('jev-report is a known verb: the engine answers, exit 75 falls back to the Node report', () => {
  fakeEngine(0);
  const answered = run(['jev-report', '--weekly']);
  assert.strictEqual(answered.status, 0);
  assert.match(answered.stdout, /^engine jev-report --weekly/);
  fakeEngine(75);
  const fell = run(['jev-report', '--weekly', '--home', HOME]);
  assert.strictEqual(fell.status, 0, fell.stderr);
  assert.match(fell.stdout, /engine jev-report/);
  assert.match(fell.stdout, /jev weekly scorecard/);
});
