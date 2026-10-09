'use strict';
require('../helpers/isolate-home.js');
// command-guard.js (issue #55): small, bounded remote commands in the main thread are not "raw output floods".
//  FIX tests fail on the pre-fix hook; GUARD tests pass before and after.
//  - `gh secret set X < file && gh secret list`, `gh label create` (one plain line) are light; `gh secret delete` stays heavy.
//  - `git pull` / `git fetch` in a git checkout OUTSIDE the session's tree (git -C <dir> or a leading cd <dir>), chained only with
//    light segments, is light; a pull in the session repo, a push, a chained test run or a -c option stays heavy.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

let h; let proj; let clone;
function gitDir(d) {
  fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}
before(() => {
  h = makeHome();
  proj = path.join(h.home, 'proj');
  clone = path.join(h.home, 'clones', 'wt-y');
  gitDir(proj);
  gitDir(clone);
});
after(() => { h.cleanup(); });

function status(command) {
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: proj };
  return testHook('command-guard.js', payload, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }).status;
}

test('FIX: one-line gh secret set (stdin from a file) chained with gh secret list is light', () => {
  assert.strictEqual(status('gh secret set API_TOKEN < /srv/secret.txt && gh secret list'), 0);
});
test('GUARD: gh secret delete stays heavy', () => {
  assert.strictEqual(status('gh secret delete API_TOKEN'), 2);
});

const SYNC_FIX = () => [
  'git -C ' + clone + ' pull --rebase',
  'cd ' + clone + ' && git pull --rebase && sed -n 1,30p README.md',
  'cd ~/clones/wt-y && git fetch origin && git pull --rebase 2>&1 | tail -3',
  'git -C ' + clone + ' pull --rebase && gh api repos/o/r/pulls/3 | head -30',
];
test('FIX: git pull/fetch in a clone outside the session tree, chained with light reads, is light', () => {
  const wrong = SYNC_FIX().filter((c) => status(c) !== 0);
  assert.deepStrictEqual(wrong, []);
});
test('GUARD: pull in the session repo, a push, a chained test run, a -c option or a missing dir stays heavy', () => {
  const cmds = [
    'git pull --rebase',
    'cd ' + proj + ' && git pull',
    'git -C ' + clone + ' push',
    'cd ' + clone + ' && git pull && npm test',
    'git -C ' + clone + ' -c core.sshCommand=x pull',
    'git -C ' + path.join(h.home, 'missing') + ' pull',
    'git -C ' + clone + ' pull\nnpm test',
  ];
  const wrong = cmds.filter((c) => status(c) !== 2);
  assert.deepStrictEqual(wrong, []);
});
