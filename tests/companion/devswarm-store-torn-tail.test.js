'use strict';
// #26 — torn final row in the journal messages.ndjson. A crash mid-append
// leaves a partial last line with no '\n'; the NEXT append used to be glued
// onto it, so the reader skipped BOTH (the torn bytes and the good new row).
// Crash-point regression: construct the torn tail directly, append through the
// real store API, and assert the new row parses and is counted while the torn
// row stays skipped (it was already lost at crash time — no salvage).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-torn-tail-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}

test('#26 journal: append after a torn final row lands whole (torn row stays skipped)', () => {
  const home = tmpHome();
  try {
    const env = { ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' };
    const s = store.openStore({ home, workspaceId: 'w1', backend: 'journal', env });
    try {
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'first', hash: 'h1' }), { inserted: true });
      const file = path.join(store.journalDir(home, 'w1'), 'messages.ndjson');
      assert.ok(fs.existsSync(file), 'precondition: journal messages file at ' + file);
      // Crash point: a second row was being written when the process died.
      fs.appendFileSync(file, '{"workspaceId":"w1","body":"torn-at-cra');
      assert.ok(!fs.readFileSync(file, 'utf8').endsWith('\n'), 'precondition: torn tail has no newline');

      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'after-crash', hash: 'h3' }), { inserted: true });
      const bodies = s.listMessages('w1').map((r) => r.body);
      assert.deepEqual(bodies, ['first', 'after-crash'], 'the post-crash row must parse; the torn row stays skipped');
      assert.strictEqual(s.messageCount('w1'), 2);
      assert.strictEqual(s.tornLineCount('messages'), 1, 'exactly the torn crash row is skipped');
      // A healthy tail gets no extra blank line.
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'next', hash: 'h4' }), { inserted: true });
      assert.ok(!/\n\n/.test(fs.readFileSync(file, 'utf8')), 'no blank line is added after a healthy tail');
    } finally { s.close(); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
