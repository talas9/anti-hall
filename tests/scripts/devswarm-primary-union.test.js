'use strict';
// defect dca4d2e16926: `inbox peek-primary`/`inbox read-primary` (cmdInboxMessages,
// scripts/devswarm.js) used to read the STORE partition ONLY, while `inbox
// count/read/ack` already union it with the NDJSON descriptor inbox
// (devswarmUnread.unionUnread, companion/lib/devswarm-unread.js) — see that
// sub's own header comment in scripts/devswarm.js. That let `inbox count`
// report real unread mail a Primary's OWN read path could never see (field
// case: count 457 vs peek-primary 57). These tests exercise the fix: both
// primary read verbs now see the SAME union `inbox count` sees, order is
// deterministic, ack advances the RIGHT cursor per channel, and a message
// present in both channels is delivered exactly once.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-primary-union-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function fakeCwd(home) { return path.join(home, 'not-a-git-repo'); }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {}, cwd: fakeCwd(home) }, over || {});

// Self-ack ownership: caller identity (env.DEVSWARM_BUILDER_ID) must equal the
// target id (bug #2 cross-workspace ack hazard check) — mirrors the existing
// read-primary/peek-primary tests in devswarm-cli.test.js and
// devswarm-heartbeat-log-and-peek.test.js.
function selfCtx(home, id, over) {
  return ctx(home, Object.assign({ env: { DEVSWARM_BUILDER_ID: id } }, over || {}));
}

function register(home, id, inbox, cursor) {
  const r = cli.run(['register', id, '--worktree', '/wt/' + id, '--session', 'sess-' + id,
    '--inbox', inbox, '--cursor', cursor], ctx(home));
  assert.equal(r.result.ok, true, 'register must succeed: ' + JSON.stringify(r.result));
}

function seedStore(home, id, rows) {
  // rows: [{body, hash}]
  const s = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
  try { rows.forEach((row) => s.appendMessage({ workspaceId: id, body: row.body, hash: row.hash })); }
  finally { s.close(); }
}

function writeNdjson(inboxPath, entries) {
  // entries: [{_h, message, fromBranch, createdAt}]
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.writeFileSync(inboxPath, lines);
}

// ---- 1 + 2: read-primary/peek-primary see BOTH channels, matching `inbox count` --

test('read-primary sees mail from BOTH channels; total matches `inbox count` (the exact field-reported mismatch)', () => {
  const home = tmpHome();
  const id = 'w-both';
  try {
    const inbox = path.join(home, id + '-inbox.ndjson');
    const cursor = path.join(home, id + '-cursor.json');
    register(home, id, inbox, cursor);
    writeNdjson(inbox, [
      { _h: 'ndjson-1', message: 'ndjson one', fromBranch: 'childA', createdAt: 1000 },
      { _h: 'ndjson-2', message: 'ndjson two', fromBranch: 'childB', createdAt: 3000 },
    ]);
    seedStore(home, id, [
      { body: 'store one', hash: 'store-1' },
      { body: 'store two', hash: 'store-2' },
    ]);

    const count = cli.run(['inbox', 'count', id], selfCtx(home, id));
    assert.equal(count.result.ok, true, JSON.stringify(count.result));
    assert.equal(count.result.unreadTotal, 4, 'sanity: count sees all 4 across both channels');

    const rp = cli.run(['inbox', 'read-primary', id], selfCtx(home, id));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.action, 'read-primary');
    assert.equal(rp.result.count, 4, 'read-primary must see all 4 messages, not just the store\'s 2');
    assert.equal(rp.result.total, count.result.unreadTotal, 'read-primary total must match `inbox count` unreadTotal — the regression this defect describes');

    const bodies = rp.result.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['ndjson one', 'ndjson two', 'store one', 'store two']);
  } finally { rm(home); }
});

test('peek-primary preview count agrees with `inbox count`, and never advances either cursor', () => {
  const home = tmpHome();
  const id = 'w-peek';
  try {
    const inbox = path.join(home, id + '-inbox.ndjson');
    const cursor = path.join(home, id + '-cursor.json');
    register(home, id, inbox, cursor);
    writeNdjson(inbox, [{ _h: 'p-1', message: 'peek me', fromBranch: 'childA', createdAt: 1000 }]);
    seedStore(home, id, [{ body: 'store peek', hash: 'p-store-1' }]);

    const count = cli.run(['inbox', 'count', id], selfCtx(home, id));
    const peek1 = cli.run(['inbox', 'peek-primary', id], selfCtx(home, id));
    assert.equal(peek1.result.ok, true, JSON.stringify(peek1.result));
    assert.equal(peek1.result.count, count.result.unreadTotal, 'peek-primary preview count must agree with `inbox count`');
    assert.equal(peek1.result.total, count.result.unreadTotal);

    const ndjsonCursorBefore = fs.readFileSync(cursor, 'utf8');
    const peek2 = cli.run(['inbox', 'peek-primary', id], selfCtx(home, id));
    assert.deepEqual(peek2.result.messages, peek1.result.messages, 'a second peek sees the same unread set');
    assert.equal(fs.readFileSync(cursor, 'utf8'), ndjsonCursorBefore, 'peek-primary must never advance the NDJSON cursor file');
  } finally { rm(home); }
});

// ---- 3: ack advances the RIGHT cursor per channel ---------------------------

test('read-primary ack advances BOTH the NDJSON descriptor cursor and the store-side primary cursor, and only those', () => {
  const home = tmpHome();
  const id = 'w-ack';
  try {
    const inbox = path.join(home, id + '-inbox.ndjson');
    const ndjsonCursorPath = path.join(home, id + '-cursor.json');
    register(home, id, inbox, ndjsonCursorPath);
    writeNdjson(inbox, [
      { _h: 'ack-nd-1', message: 'ack ndjson one', createdAt: 1000 },
      { _h: 'ack-nd-2', message: 'ack ndjson two', createdAt: 2000 },
    ]);
    seedStore(home, id, [{ body: 'ack store one', hash: 'ack-store-1' }]);

    assert.equal(fs.readFileSync(ndjsonCursorPath, 'utf8').trim(), '0', 'NDJSON cursor starts at 0 (cursor init on register)');

    const rp = cli.run(['inbox', 'read-primary', id], selfCtx(home, id));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 3);

    // NDJSON descriptor cursor (desc.cursorPath) advanced to the full NDJSON total (2).
    assert.equal(fs.readFileSync(ndjsonCursorPath, 'utf8').trim(), '2', 'NDJSON cursor must advance to the NDJSON channel\'s own total');
    // Store-side primary cursor (cursors/<id>.json, a DIFFERENT file) advanced to the store total (1).
    const storeCursorPath = cli.primaryCursorPath(home, id);
    assert.notEqual(storeCursorPath, ndjsonCursorPath, 'these must be two distinct cursor files');
    assert.equal(fs.readFileSync(storeCursorPath, 'utf8').trim(), '1', 'store-side primary cursor must advance to the store channel\'s own total');

    // A second read-primary sees nothing new (both cursors fully consumed).
    const rp2 = cli.run(['inbox', 'read-primary', id], selfCtx(home, id));
    assert.equal(rp2.result.count, 0, 'both channels fully acked — nothing left unread');
  } finally { rm(home); }
});

test('peek-primary (no ack) leaves both cursor files completely untouched', () => {
  const home = tmpHome();
  const id = 'w-noack';
  try {
    const inbox = path.join(home, id + '-inbox.ndjson');
    const ndjsonCursorPath = path.join(home, id + '-cursor.json');
    register(home, id, inbox, ndjsonCursorPath);
    writeNdjson(inbox, [{ _h: 'noack-1', message: 'do not consume me', createdAt: 1000 }]);
    seedStore(home, id, [{ body: 'do not consume me either', hash: 'noack-store-1' }]);

    cli.run(['inbox', 'peek-primary', id], selfCtx(home, id));

    assert.equal(fs.readFileSync(ndjsonCursorPath, 'utf8').trim(), '0', 'peek-primary must never advance the NDJSON cursor');
    const storeCursorPath = cli.primaryCursorPath(home, id);
    assert.equal(fs.existsSync(storeCursorPath), false, 'peek-primary must never create/advance the store-side primary cursor file (never acked yet)');
  } finally { rm(home); }
});

// ---- 4: a message present in both channels is delivered exactly once ------

test('a message present in BOTH channels (same content hash) is delivered ONCE via read-primary, not twice', () => {
  const home = tmpHome();
  const id = 'w-dedup';
  try {
    const inbox = path.join(home, id + '-inbox.ndjson');
    const cursor = path.join(home, id + '-cursor.json');
    register(home, id, inbox, cursor);
    // Same content hash on both sides — simulates a native-drained message
    // that also has its store-parity twin (see devswarm-unread.js header).
    writeNdjson(inbox, [{ _h: 'dup-hash-1', message: 'native drained', createdAt: 1000 }]);
    seedStore(home, id, [
      { body: 'native drained', hash: 'dup-hash-1' }, // duplicate — must be excluded
      { body: 'unique store message', hash: 'unique-store-1' },
    ]);

    const rp = cli.run(['inbox', 'read-primary', id], selfCtx(home, id));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 2, 'the duplicate-hash message must be counted once (1 dedup\'d + 1 unique), not 3');
    const hashes = rp.result.messages.map((m) => m.hash).sort();
    assert.deepEqual(hashes, ['dup-hash-1', 'unique-store-1']);
    const nativeDrainedCount = rp.result.messages.filter((m) => m.body === 'native drained').length;
    assert.equal(nativeDrainedCount, 1, 'the duplicated message must appear exactly once in the merged messages array');
  } finally { rm(home); }
});

// ---- 5: single-channel setups are unaffected (no regression) --------------

test('read-primary: store-only setup (no descriptor) still works exactly as before', () => {
  const home = tmpHome();
  const id = 'w-store-only';
  try {
    seedStore(home, id, [{ body: 'solo store msg', hash: 'solo-1' }]);
    const rp = cli.run(['inbox', 'read-primary', id], selfCtx(home, id));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1);
    assert.equal(rp.result.messages[0].body, 'solo store msg');
    assert.equal(rp.result.messages[0].origin, undefined, 'store-only path must be byte-identical to pre-fix output (no union applied, no origin tag)');
  } finally { rm(home); }
});

test('read-primary: NDJSON-only setup (descriptor exists, empty store partition) still works', () => {
  const home = tmpHome();
  const id = 'w-ndjson-only';
  try {
    const inbox = path.join(home, id + '-inbox.ndjson');
    const cursor = path.join(home, id + '-cursor.json');
    register(home, id, inbox, cursor);
    writeNdjson(inbox, [{ _h: 'solo-nd-1', message: 'solo ndjson msg', createdAt: 500 }]);

    const rp = cli.run(['inbox', 'read-primary', id], selfCtx(home, id));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1);
    assert.equal(rp.result.messages[0].body, 'solo ndjson msg');
    assert.equal(fs.readFileSync(cursor, 'utf8').trim(), '1', 'NDJSON cursor must still advance on ack in the NDJSON-only case');
  } finally { rm(home); }
});
