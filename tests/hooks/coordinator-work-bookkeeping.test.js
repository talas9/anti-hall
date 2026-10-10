'use strict';
// DevSwarm mailbox/bookkeeping calls (heartbeat, inbox pull/ack/read, send, ...) only talk to the
// mesh store: they must not fill the main-thread WORK window (SkyCrew child report, 2026-10-09:
// the "N state-changing calls" nudge counted `inbox pull`/`ack` and `heartbeat`). Real work in the
// same command still counts.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'coordinator-work-guard.js');
const lib = require(path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'coordinator-work.js'));

const L = '/home/u/.anti-hall/bin/devswarm.js';
const PULL = 'node ' + L + ' inbox ' + 'pu' + 'll';
const ACK = 'node ' + L + ' inbox ' + 'ac' + 'k c0ffee --seq 2';
const HB = 'node ' + L + ' heartbeat --summary "phase 1 done" --progress 40';

test('isDevswarmBookkeeping: bookkeeping shapes are recognised', () => {
  for (const c of [
    PULL, ACK, HB,
    'node "' + L + '" inbox ' + 'pu' + 'll 2>&1 | tail -5',
    L + ' heartbeat --summary x',
    'ah-engine mesh inbox ' + 'pu' + 'll',
    'ah-engine devswarm heartbeat --summary x',
    PULL + ' && ' + HB,
    'node /p/anti-hall/scripts/devswarm.js send --to-primary --message hi',
  ]) assert.strictEqual(lib.isDevswarmBookkeeping(c), true, c);
});

test('isDevswarmBookkeeping: anything with real work or an unknown shape is not bookkeeping', () => {
  for (const c of [
    PULL + ' && git commit -qm x',
    PULL + ' ; rm -rf build',
    'node ./devswarm.js inbox ' + 'pu' + 'll',
    'node ' + L + ' spawn feat -p brief',
    PULL + ' > notes/out.txt',
    'node ' + L + ' send --to-primary --message "$(cat f)"',
    'node ' + L + ' send --message-stdin <<EOF\nx\nEOF',
    'git status',
    '',
  ]) assert.strictEqual(lib.isDevswarmBookkeeping(c), false, JSON.stringify(c));
});

function post(home, command, sid) {
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, session_id: sid, cwd: process.cwd(), tool_response: { stdout: '' } };
  return childProcess.spawnSync(process.execPath, [HOOK, '--post'], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
  });
}

test('hook: eight bookkeeping calls never nudge or fill the window; real work still does', () => {
  const { home } = makeHome();
  const outs = [];
  // the shapes the classifier counted as WORK before: a quoted launcher path and a direct exec of the launcher
  const QUOTED = 'node "' + L + '" inbox ' + 'pu' + 'll';
  const DIRECT = '~/.anti-hall/bin/devswarm.js heartbeat --summary x';
  for (let i = 0; i < 4; i++) { outs.push(post(home, QUOTED, 's1').stdout, post(home, DIRECT, 's1').stdout); }
  assert.strictEqual(outs.join(''), '', 'no COORDINATOR DRIFT note from bookkeeping');
  const st = JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'coordinator-work-session-s1.json'), 'utf8'));
  assert.strictEqual(st.work, 0, 'no WORK recorded: ' + JSON.stringify(st));
  // the same session still nudges on real work (4th WORK call)
  const w = [1, 2, 3, 4].map(() => post(home, 'git commit -qm x', 's1').stdout);
  assert.match(w[3], /state-changing calls/);
});
