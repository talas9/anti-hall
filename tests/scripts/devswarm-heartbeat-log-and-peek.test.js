'use strict';
// spec item 1b (A1-INSTRUMENT) + item 5b/D (peek-primary) — exercised
// in-process via run(argv, ctx), mirroring devswarm-cli.test.js's harness.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function seedStore(home, id, bodies) {
  // inbox messages/read-primary/peek-primary all read from the STORE, not the
  // descriptor's durable NDJSON (mirrors devswarm-cli.test.js's own seedStore).
  const s = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
  try { bodies.forEach((b, i) => s.appendMessage({ workspaceId: id, body: b, hash: id + '-h' + i })); }
  finally { s.close(); }
}

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-hb-log-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function fakeCwd(home) { return path.join(home, 'not-a-git-repo'); }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {}, cwd: fakeCwd(home) }, over || {});
function callersLogPath(home) {
  // heartbeat-callers.log is a sibling of heartbeatsDir() (both under devswarmRoot).
  return path.join(path.dirname(cli.heartbeatsDir(home)), 'heartbeat-callers.log');
}
function register(home, id) {
  const r = cli.run(['register', id, '--worktree', '/wt/' + id, '--session', 'sess-' + id,
    '--inbox', path.join(home, id + '-inbox.ndjson'), '--cursor', path.join(home, id + '-cursor.json')], ctx(home));
  assert.equal(r.result.ok, true, 'register must succeed: ' + JSON.stringify(r.result));
}

// ============================================================================
// A1-INSTRUMENT — spec item 1b
// ============================================================================

test('heartbeat-callers.log: a heartbeat WITHOUT --session appends one capped NDJSON line', () => {
  const home = tmpHome();
  try {
    register(home, 'w1');
    assert.equal(fs.existsSync(callersLogPath(home)), false, 'must not exist before any --session-less heartbeat');
    const r = cli.run(['heartbeat', 'w1'], ctx(home)); // no --session
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(callersLogPath(home)), true, 'must be created by a --session-less heartbeat');
    const lines = fs.readFileSync(callersLogPath(home), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.id, 'w1');
    assert.equal(typeof row.pid, 'number');
    assert.ok(Number.isFinite(row.ts));
  } finally { rm(home); }
});

test('heartbeat-callers.log: a heartbeat WITH --session does NOT append anything', () => {
  const home = tmpHome();
  try {
    register(home, 'w2');
    const r = cli.run(['heartbeat', 'w2', '--session', 'sess-w2'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(callersLogPath(home)), false, 'a --session-carrying heartbeat must never write the attribution log');
  } finally { rm(home); }
});

test('heartbeat-callers.log: capped at ~200 lines — a re-run past the cap trims the oldest, never grows unbounded', () => {
  const home = tmpHome();
  try {
    register(home, 'w3');
    for (let i = 0; i < 205; i++) {
      const r = cli.run(['heartbeat', 'w3'], ctx(home));
      assert.equal(r.code, 0);
    }
    const lines = fs.readFileSync(callersLogPath(home), 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 200, 'must be capped at ~200 lines, got ' + lines.length);
  } finally { rm(home); }
});

// ============================================================================
// inbox peek-primary — spec item 5b / D
// ============================================================================

test('inbox peek-primary: unread-only view, matches read-primary content, but NEVER advances the cursor', () => {
  const home = tmpHome();
  // Self-ack ownership (mirrors devswarm-cli.test.js's read-primary tests):
  // caller identity must equal id 'w4'. cwd is the fake, non-existent worktree
  // itself — it resolves to no real git worktree, so the declared
  // DEVSWARM_BUILDER_ID is a trusted declaration, not a spoof.
  const selfCtx = ctx(home, { env: { DEVSWARM_BUILDER_ID: 'w4' } });
  try {
    const inbox = path.join(home, 'w4-inbox.ndjson');
    const cursor = path.join(home, 'w4-cursor.json');
    cli.run(['register', 'w4', '--worktree', '/wt/w4', '--session', 'sess-w4',
      '--inbox', inbox, '--cursor', cursor], selfCtx);
    // messages/read-primary/peek-primary all resolve to the store's own
    // partition for id 'w4' since cwd is non-git (repoKey null) — this file
    // is about the peek/ack mechanics, not mesh rekeying (see devswarm-cli.
    // test.js's own header note on this exact convention).
    seedStore(home, 'w4', ['hello']);

    const before = cli.run(['inbox', 'peek-primary', 'w4'], selfCtx);
    assert.equal(before.code, 0, JSON.stringify(before.result));
    assert.equal(before.result.action, 'peek-primary');
    assert.equal(before.result.unread, true);

    // Peeking again must show the SAME unread state (cursor untouched).
    const again = cli.run(['inbox', 'peek-primary', 'w4'], selfCtx);
    assert.equal(again.result.cursor, before.result.cursor, 'peek-primary must never advance the cursor');
    assert.deepEqual(again.result.messages, before.result.messages, 'a second peek must see the SAME unread messages');

    // NOW read-primary actually acks — the cursor advances.
    const acked = cli.run(['inbox', 'read-primary', 'w4'], selfCtx);
    assert.equal(acked.code, 0, JSON.stringify(acked.result));
    assert.notStrictEqual(acked.result.cursor, before.result.cursor, 'read-primary must advance the cursor, unlike peek-primary');

    // A peek AFTER the ack must see nothing new unread.
    const after = cli.run(['inbox', 'peek-primary', 'w4'], selfCtx);
    assert.equal(after.result.count, 0, 'after read-primary drained it, a fresh peek must see zero unread');
  } finally { rm(home); }
});

test('inbox peek-primary: unknown-subcommand error now advertises peek-primary alongside read-primary', () => {
  const home = tmpHome();
  try {
    register(home, 'w5');
    const r = cli.run(['inbox', 'bogus-sub', 'w5'], ctx(home));
    assert.equal(r.code, 2);
    assert.match(r.result.error, /peek-primary/);
  } finally { rm(home); }
});
