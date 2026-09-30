'use strict';
// git-guard round-4 review fixes: the launcherBackstop substring precheck must
// not skip (a) `$`-obfuscated `.anti-hall` spellings or (b) a cwd that is
// already inside `.anti-hall` (pathless writes). Block => exit 2; allow => 0.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

// `hrel` = cwd relative to the fake HOME (created on demand).
function run(command, hrel) {
  const h = makeHome();
  try {
    const payload = bashPayload(command);
    if (hrel !== undefined) {
      payload.cwd = path.join(h.home, hrel);
      fs.mkdirSync(payload.cwd, { recursive: true });
    }
    return testHook('git-guard.js', payload, { home: h.home });
  } finally {
    h.cleanup();
  }
}

function expect(cmd, status, hrel) {
  const r = run(cmd, hrel);
  assert.strictEqual(r.status, status,
    `expected exit ${status} for: ${JSON.stringify(cmd)} (cwd ~/${hrel || ''})\nstderr: ${r.stderr}`);
}

const A = '~/.anti';
const AH = '.anti-hall';
const BIN = '.anti-hall/bin';

// `$`-obfuscated spelling with the path never written literally.
const DOLLAR_BLOCK = [
  `cd ${A}$'-'hall; echo 'echo x > bin/y' | bash`,
  `cd ${A}$'-'hall/bin && ssh h 'echo x > y'`,
  `cd ${A}$''-hall/bin; git config alias.x '!echo x > y'`,
  `cd ${A}-$'h'all/bin; bash -c "$(echo 'echo x > y')"`,
];
for (const cmd of DOLLAR_BLOCK) {
  test(`BLOCK (precheck strips $): ${JSON.stringify(cmd)}`, () => expect(cmd, 2));
}

// cwd already inside `.anti-hall`: the command never names the directory.
const CWD_BLOCK = [
  ['echo x > y', BIN],
  ['echo x > bin/y', AH],
  ['cp /tmp/a devswarm.js', BIN],
  ["bash -c 'echo x > y'", BIN],
  ["eval 'echo x > y'", BIN],
  ["bash <<'E'\necho x > y\nE", BIN],
  ["echo 'echo x > y' | bash", BIN],
  ['cd bin && echo x > y', AH],
  ["bash -c 'cd bin; echo x > y'", AH],
  ['cd .. && echo x > bin/y', AH + '/tmp'],
  ['bash -c "cd ..; echo x > bin/y"', AH + '/tmp'],
  ['cd ~/.an"ti-h"all; echo x > bin/y', ''],
  ["echo 'echo x > bin/y' | sh", AH],
  ["git config alias.x '!echo x > y'", BIN],
  ["ssh h 'echo x > y'", BIN],
  ['bash -c "$(echo \'echo x > y\')"', BIN],
];
for (const [cmd, hrel] of CWD_BLOCK) {
  test(`BLOCK (cwd inside .anti-hall, no skip): ${JSON.stringify(cmd)} @ ~/${hrel}`, () => expect(cmd, 2, hrel));
}

test('ALLOW (control): a non-writing command inside ~/.anti-hall/bin', () => expect('ls', 0, BIN));
test('ALLOW (control): an ordinary write with no .anti-hall anywhere', () => expect('echo x > /tmp/ah-r4-ok.txt', 0));
