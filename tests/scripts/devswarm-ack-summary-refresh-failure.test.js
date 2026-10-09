'use strict';
// A failed unread-summary refresh after an ack stays fail-open (the ack
// succeeds) but is now RECORDED in the bounded cursor-log with its op, path and
// error, instead of being swallowed (a stale cached unread count once made the
// parent-gate block falsely with no trace).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cursors = require(path.join(ROOT, 'scripts', 'devswarm-lib', 'cursors.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));

test('applyReadAckOps: a failing summary refresh does not fail the ack and is recorded in the cursor-log', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-sumfail-home-'));
  try {
    const repoKey = 'sumfailrepo';
    const s = storeLib.openStore({ home, hash: repoKey });
    try {
      // Force the refresh to fail: summaries/ is a FILE, so mkdir/write under it throws.
      const sumDir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
      fs.mkdirSync(path.dirname(sumDir), { recursive: true });
      fs.writeFileSync(sumDir, 'not a dir');

      const r = cursors.applyReadAckOps(s, home, 'w1', 'nonce1', [], { ctx: { home, env: {} }, repoKey, verb: 'ack-test' });
      assert.deepStrictEqual(r.failures, [], 'the ack itself reports no failure (fail-open)');

      const rows = cursors.readCursorLog(home, repoKey).filter((x) => x.op === 'summary-refresh');
      assert.equal(rows.length, 1, 'exactly one summary-refresh failure recorded: ' + JSON.stringify(rows));
      assert.equal(rows[0].ok, false);
      assert.ok(rows[0].err && rows[0].err.length > 0, 'error message recorded');
      assert.equal(rows[0].path, storeLib.summaryPathForHash(home, repoKey), 'names the summary path');
      assert.equal(typeof rows[0].ts, 'number');
    } finally { s.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('applyReadAckOps: a healthy summary refresh records nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-sumok-home-'));
  try {
    const s = storeLib.openStore({ home, hash: 'sumokrepo' });
    try {
      cursors.applyReadAckOps(s, home, 'w1', 'nonce1', [], { ctx: { home, env: {} }, repoKey: 'sumokrepo', verb: 'ack-test' });
      assert.deepStrictEqual(cursors.readCursorLog(home, 'sumokrepo').filter((x) => x.op === 'summary-refresh'), []);
    } finally { s.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
