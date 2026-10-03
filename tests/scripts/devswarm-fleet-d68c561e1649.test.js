'use strict';
// Defect d68c561e1649 (P2): no read-only mesh read exists — any read of a
// broadcast seq at or below the cursor is permanently lost, because
// `mesh read` always advances the cursor.
//
// Root cause (file:line, HEAD 5631695): plugins/anti-hall/scripts/devswarm.js
// cmdMeshRead (~10659-10690) filters `storeSeq > cursor` and then
// UNCONDITIONALLY calls `s.advanceBroadcastCursor(cursorKey)` — there is no
// `--peek`/`--seq` mode anywhere in the function, so a message once read can
// never be re-inspected via this verb.
//
// Run against HEAD (RED) vs the patched copy (GREEN) via:
//   DEVSWARM_ANTIHALL_DIR=<path>/repo-orig             node --test d68c561e1649.test.js
//   DEVSWARM_ANTIHALL_DIR=<path>/repo-d68c561e1649     node --test d68c561e1649.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const antiHallDir = process.env.DEVSWARM_ANTIHALL_DIR
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(antiHallDir, 'scripts', 'devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-meshread-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-meshread-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

test('mesh read --peek re-inspects an already-consumed broadcast without advancing the cursor', () => {
  const home = tmpHome();
  const main = makeGitRepo('meshpeek');
  try {
    // Register so callerIdentity resolves to a real registry row.
    const reg = cli.run(['register-primary'], ctx(home, { cwd: main }));
    assert.strictEqual(reg.result.ok, true);

    const send1 = cli.run(['send', '--broadcast', '--message', 'broadcast-one'], ctx(home, { cwd: main }));
    assert.strictEqual(send1.result.ok, true);

    // First ordinary mesh read: sees + consumes broadcast-one, advances cursor.
    const firstRead = cli.run(['mesh', 'read'], ctx(home, { cwd: main }));
    assert.strictEqual(firstRead.result.ok, true);
    assert.ok(firstRead.result.broadcasts.some((b) => b.message === 'broadcast-one'),
      'first ordinary read must see broadcast-one');
    assert.ok(firstRead.result.newCursor > 0, 'ordinary read must advance the cursor');

    // THE BUG: broadcast-one is now at/below the cursor. A caller wanting to
    // re-inspect it (crash recovery, an audit, "what did I just read") has no
    // way to do so — an ordinary `mesh read` again only sees anything NEW.
    const peekRead = cli.run(['mesh', 'read', '--peek', '--seq', '0'], ctx(home, { cwd: main }));
    assert.strictEqual(peekRead.result.ok, true,
      '--peek --seq 0 must succeed (got: ' + JSON.stringify(peekRead.result) + ')');
    assert.ok(peekRead.result.broadcasts.some((b) => b.message === 'broadcast-one'),
      '--peek --seq 0 must be able to re-inspect the already-consumed broadcast '
      + '(got: ' + JSON.stringify(peekRead.result.broadcasts) + ')');
    assert.strictEqual(peekRead.result.acked, false, 'a peek must report acked:false');

    // The peek must be genuinely non-destructive: the caller's REAL cursor
    // (visible via an ordinary read finding nothing new) must be unchanged.
    const send2 = cli.run(['send', '--broadcast', '--message', 'broadcast-two'], ctx(home, { cwd: main }));
    assert.strictEqual(send2.result.ok, true);
    const secondRead = cli.run(['mesh', 'read'], ctx(home, { cwd: main }));
    assert.strictEqual(secondRead.result.ok, true);
    assert.deepStrictEqual(secondRead.result.broadcasts.map((b) => b.message), ['broadcast-two'],
      'the peek must not have advanced the real cursor — only the genuinely-new broadcast should show up next');
  } finally {
    rm(main); rm(home);
  }
});
