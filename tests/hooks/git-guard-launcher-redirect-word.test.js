'use strict';
// git-guard launcher-dir scan: a `>` redirect's target is the FIRST shell word,
// not the rest of the line. A glued token (odd quote in a heredoc body) used to
// make `>/dev/null && node <launcher> ...` read the executed launcher path as a
// write target (field repro: workspace `devswarm.js send ... >/dev/null && node
// ...devswarm.js inbox ack-primary ...` after a heredoc message containing `I'll`).
// Every real write form must stay blocked.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const L = '~/.anti-hall/bin';

function status(command) {
  const h = makeHome();
  try {
    return testHook('git-guard.js', bashPayload(command), { home: h.home }).status;
  } finally {
    h.cleanup();
  }
}

const ALLOW = [
  // Recorded shape: odd quote in the heredoc body desyncs the tokenizer; the
  // later lines only EXECUTE the launcher (>/dev/null is the sole redirect).
  `S=/tmp/x; cat > $S/msg.txt <<'EOF'\nI'll build it -> done\nEOF\nnode ${L}/devswarm.js send --to p --message-file $S/msg.txt >/dev/null && node "${L}/devswarm.js" inbox ack-primary 1 --receipt r >/dev/null && echo ok`,
  `echo hi >/dev/null && node ${L}/devswarm.js roster`,
  `echo hi > /tmp/out.txt && node ${L}/devswarm.js roster`,
  `echo hi > $f && node ${L}/devswarm.js roster`,
];
for (const cmd of ALLOW) {
  test(`ALLOW (launcher only executed): ${JSON.stringify(cmd).slice(0, 90)}`, () => {
    assert.strictEqual(status(cmd), 0);
  });
}

const BLOCK = [
  `echo x > ${L}/y`,
  `echo x >   ${L}/y`,
  `echo x >${L}/y`,
  `echo a=>${L}/y`,
  `echo x > "${L}/y"`,
  `echo x >a >${L}/y`,
  `echo x >/dev/null && echo y > ${L}/z`,
  `echo x >/dev/null; cp x ${L}/y`,
  `echo x > $f && echo y > ${L}/z`,
  // glued-token variant of the recorded shape, but with a REAL write on a later line
  `cat > /tmp/m <<'EOF'\nI'll go\nEOF\necho x >/dev/null && echo y > ${L}/z`,
  `node -e 'console.log("a > ${L}/x")'`,
];
for (const cmd of BLOCK) {
  test(`BLOCK (real launcher write): ${JSON.stringify(cmd).slice(0, 90)}`, () => {
    assert.strictEqual(status(cmd), 2);
  });
}
