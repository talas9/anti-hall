'use strict';
// Coordinator-work docs stay in step with the shipped behaviour: the Bash
// edit-parity rule, the nudge-delivery citation, the known gaps, the on-disk
// state files, and the baseline share labels.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GUIDE = read('docs/GUIDE.md');
const CHANGELOG = read('CHANGELOG.md');
// The newest section (## Unreleased while unreleased, ## <version> once released), up to the next heading.
const top = CHANGELOG.indexOf('\n## ');
const unreleased = CHANGELOG.slice(top, CHANGELOG.indexOf('\n## ', top + 5));
const REPORT = read('plugins/anti-hall/scripts/dispatch-report.js');

const PARITY = 'Bash writes are judged like the Edit tool: a repo file the Edit tool may not write (including gitignored outputs like build/ or .env) is blocked; write under .anti-hall/ or the scratchpad, or delegate.';

test('GUIDE and CHANGELOG state the Bash edit-parity rule', () => {
  assert.ok(GUIDE.includes(PARITY), 'GUIDE');
  assert.ok(unreleased.includes(PARITY), 'CHANGELOG');
});

test('nudge delivery is cited as live-observed on CLI 2.1.238, not doc-confirmed', () => {
  for (const [name, text] of [['GUIDE', GUIDE], ['CHANGELOG', unreleased], ['dispatch-report', REPORT]]) {
    assert.match(text, /live-observed[^\n]*2\.1\.238[^\n]*not doc-confirmed/, name);
    assert.match(text, /re-verify after a CLI upgrade; blocks are the enforcement/, name);
    assert.doesNotMatch(text, /records a PostToolUse `additionalContext` gap|whether the PostToolUse note reaches the model is unverified|Nudge delivery and Codex coordinator detection are unverified/, name);
  }
});

test('known gaps list stdin scripts, wrapper forms, other writers, git checkout, quoted plugin paths', () => {
  for (const [name, text] of [['GUIDE', GUIDE], ['CHANGELOG', unreleased]]) {
    for (const s of ['python3 - <<EOF', 'bash -s <<<', 'time -p git', 'env -C d git', 'gh -R o/r pr merge', 'gh api -XDELETE',
      '>|', 'cp -rt', 'install', 'dd of=', 'truncate', 'ln -sf', 'git checkout .', 'git checkout <file>', "a plugin path containing `'`"]) {
      assert.ok(text.includes(s), name + ' lacks ' + s);
    }
  }
});

test('CONTRACT §4 lists the coordinator-work state files', () => {
  const c = read('docs/CONTRACT-1.0.md');
  const s4 = c.slice(c.indexOf('## 4. On-disk state'), c.indexOf('## 5.'));
  assert.match(s4, /coordinator-work-session-<id>\.json/);
  assert.match(s4, /coordinator-work-metrics\.json/);
  assert.match(s4, /coordinator-work-trips\.log/);
});

test('baseline output labels share as recorded (no enforcement) and attempted as with enforcement', () => {
  const lib = require(path.join(ROOT, 'plugins', 'anti-hall', 'scripts', 'coordinator-work-baseline.js'));
  assert.strictEqual(typeof lib.run, 'function');
  const src = read('plugins/anti-hall/scripts/coordinator-work-baseline.js');
  assert.match(src, /as recorded \(no enforcement\)/);
  assert.match(src, /with enforcement/);
  assert.match(REPORT, /as recorded \(no enforcement\)/);
  assert.match(read('docs/TASK-WORK.md'), /as recorded \(no enforcement\)[\s\S]*with enforcement/);
  const r = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'anti-hall', 'scripts', 'dispatch-report.js')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTIHALL_TEST_ISOLATION: '1' } });
  assert.match(r.stdout, /share = as recorded \(no enforcement\), attempted = with enforcement/);
});
