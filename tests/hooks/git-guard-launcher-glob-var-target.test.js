'use strict';
// git-guard launcher-dir scan: a redirect target built from a glob (`?*[`) or a
// same-command `$NAME` assignment is resolved before the launcher-dir check.
// An UNASSIGNED variable target (`> $S/out.txt`, the common field shape) stays
// allowed.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const A = '.anti-' + 'hall';
const L = '~/' + A + '/bin';
const R = 'node ' + L + '/devswarm.js';

function status(command) {
  const h = makeHome();
  try {
    return testHook('git-guard.js', bashPayload(command), { home: h.home }).status;
  } finally {
    h.cleanup();
  }
}

const BLOCK = [
  `echo y > ~/${A}/b?n/devswarm.js && ${R} send`,
  `echo y >~/${A}/b*/devswarm.js;${R}`,
  `printf y > ~/${A}/b[i]n/devswarm.js ; ${R}`,
  `echo y > ~/${A}/*/d*.js && ${R}`,
  `echo y > $HOME/${A}/b?n/devswarm.js`,
  `echo y > \${HOME}/${A}/b*/x`,
  `cat /tmp/evil > ~/${A}/b?n/devswarm.js && ${R}`,
  `H=${L}/devswarm.js; echo y > $H && ${R}`,
  `H=~/${A}/bin/devswarm.js; X=$H; echo y > $X && ${R}`,
  `D=~/${A}; echo y > $D/bin/x`,
  `export D=$HOME/${A}/bin; echo y > \${D}/devswarm.js`,
  `local D="${L}"; echo y >> $D/devswarm.js`,
  `D=~/${A}/b?n; echo y > $D/devswarm.js`,
];
for (const cmd of BLOCK) {
  test(`BLOCK: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
    assert.strictEqual(status(cmd), 2);
  });
}

const ALLOW = [
  `echo y > $S/out.txt`,
  `${R} send --to p --message x > $S/x`,
  `echo y > $S/out.txt && ${R} send`,
  `S=/tmp/scratch; echo y > $S/out.txt && ${R} send`,
  `echo y > /tmp/b?n/x`,
  `echo y > ~/${A}/notes/*.txt`,
  `echo y > ~/${A}/b*`,
  `echo y > ~/other/b?n/devswarm.js`,
];
for (const cmd of ALLOW) {
  test(`ALLOW: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
    assert.strictEqual(status(cmd), 0);
  });
}
