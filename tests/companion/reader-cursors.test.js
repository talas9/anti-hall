'use strict';
// companion/lib/reader-cursors.js — mesh redesign Phase 3 (one reader_cursors
// table per store). Unit coverage for the decided rules, on BOTH backends:
//   - max-only writes; the ack and the floor update in ONE transaction;
//   - headless reads the stored floor only; headless ack moves F only when no
//     live declared reader pins it;
//   - process-only liveness (session file never evidence; uncertain = live);
//   - countFor: a read error is UNKNOWN, never 0;
//   - one-time import: idempotent, no delete, fail-open, floor = HEAD's own
//     effective floor, live harnesses seeded;
//   - journal lock fails CLOSED (no ack written);
//   - dual-write is upward-only and never touches #inst/#nd/#base.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const unread = require(path.join(ROOT, 'companion', 'lib', 'devswarm-unread.js'));
const inboxCursor = require(path.join(ROOT, 'companion', 'lib', 'devswarm-inbox-cursor.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

const HASH = 'rc-unit-abcdef';
const BACKENDS = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? ['sqlite', 'journal'] : ['journal'];
const NO_PS = new Map(); // a SUCCESSFUL but empty snapshot is never used below unless intended

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-unit-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function open(home, backend, extra) { return storeLib.openStore(Object.assign({ home, hash: HASH, backend }, extra || {})); }
function seedMsgs(s, id, n) { for (let i = 0; i < n; i++) s.appendMessage({ workspaceId: id, hash: id + '-' + i, body: 'b' + i, ts: i + 1 }); }
function rowsOf(s, id) { return s.readerCursorRows(id).map((r) => [r.ns, r.reader, r.value, r.retiredLine]).sort((a, b) => String(a).localeCompare(String(b))); }
function floor(s, id, ns) { const r = s.readerCursorRows(id).find((x) => x.ns === (ns || 'store') && x.reader === rc.FLOOR); return r ? r.value : null; }
const cursorsDir = (home) => path.join(liveness.devswarmRoot(home), 'cursors');

for (const backend of BACKENDS) {
  test(`[${backend}] readerKey: only the h:<pid>:<startMs> grammar is a declared reader; everything else is headless`, () => {
    assert.strictEqual(rc.readerKey('h:12:34'), 'h:12:34');
    for (const v of [null, undefined, '', 'anc:1:2', 'self:1:2', 'oneshot-0:1', 'real-reader-stable', 'h:1', 'h:a:b', '#floor']) {
      assert.strictEqual(rc.readerKey(v), null, String(v));
    }
  });

  test(`[${backend}] max-only: no API lowers any row (put, ack, raise)`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 5);
        rc.declare(s, { partition: 'w', reader: 'h:1:1', home, procTable: NO_PS });
        rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:1:1', target: 4, home, procTable: NO_PS });
        rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:1:1', target: 2, home, procTable: NO_PS });
        s.readerCursorTxn((tx) => tx.put({ partition: 'w', ns: 'store', reader: 'h:1:1', value: 0, updatedAt: 1 }));
        s.readerCursorTxn((tx) => tx.put({ partition: 'w', ns: 'store', reader: rc.FLOOR, value: 0, updatedAt: 1 }));
        rc.raiseAllLossFree(s, { partition: 'w', ns: 'store', value: 1, home });
        const own = s.readerCursorRows('w').find((r) => r.ns === 'store' && r.reader === 'h:1:1');
        assert.strictEqual(own.value, 4);
        assert.strictEqual(floor(s, 'w'), 4);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] ack + floor in ONE txn: a declared reader's ack raises F only to MIN(live declared)`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 5);
        rc.declare(s, { partition: 'w', reader: 'h:1:1', home, procTable: NO_PS });
        rc.declare(s, { partition: 'w', reader: 'h:2:2', home, procTable: NO_PS });
        const a = rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:1:1', target: 5, home, procTable: NO_PS });
        assert.deepStrictEqual([a.ok, a.own, a.floor], [true, 5, 0], 'the lagging live reader pins the floor');
        const b = rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:2:2', target: 3, home, procTable: NO_PS });
        assert.deepStrictEqual([b.own, b.floor], [3, 3]);
        assert.strictEqual(rc.countFor(s, { partition: 'w', reader: 'h:1:1', home }).unread, 0);
        assert.strictEqual(rc.countFor(s, { partition: 'w', reader: 'h:2:2', home }).unread, 2);
        assert.strictEqual(rc.countFor(s, { partition: 'w', reader: null, home }).unread, 2, 'headless / summary = the floor view');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] headless: reads F only; its ack moves F to its target ONLY when no live declared reader pins it`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 4);
        // An older build's own-position ack pushed the SHARED pair ahead.
        s.setCursor('w', 4);
        inboxCursor.ackTo(path.join(cursorsDir(home), 'w.json'), 4);
        rc.importLegacy(s, { partition: 'w', home, procTable: NO_PS }); // floor 4 (HEAD's own seed rule: no #base -> shared)
        rc.declare(s, { partition: 'w2', reader: 'h:1:1', home, procTable: NO_PS });
        seedMsgs(s, 'w2', 3);
        // w2: floor 0, a live declared reader at 0; the shared pair pushed to 3.
        s.setCursor('w2', 3);
        assert.strictEqual(rc.countFor(s, { partition: 'w2', reader: null, home }).unread, 3, 'headless never reads max(F, shared)');
        const h = rc.ackFor(s, { partition: 'w2', ns: 'store', reader: null, target: 3, home, procTable: NO_PS });
        assert.strictEqual(h.floor, 0, 'a live declared reader pins F: the headless ack cannot skip it');
        const own = rc.ackFor(s, { partition: 'w2', ns: 'store', reader: 'h:1:1', target: 2, home, procTable: NO_PS });
        assert.strictEqual(own.floor, 2);
        // No declared reader at all: the headless ack moves F to its own target.
        seedMsgs(s, 'w3', 2);
        assert.strictEqual(rc.ackFor(s, { partition: 'w3', ns: 'store', reader: null, target: 2, home, procTable: NO_PS }).floor, 2);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] liveness: excluded from the MIN only on PROOF of an ended process; the session file is never evidence`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 5);
        const old = Date.now() - 10 * 60 * 1000;
        const LIVE = 'h:' + process.pid + ':' + Date.now();
        const DEAD = 'h:4000001:' + old;
        const REUSED = 'h:4000002:' + old;
        const UNSURE = 'h:4000003:' + old;
        for (const r of [LIVE, DEAD, REUSED, UNSURE]) rc.declare(s, { partition: 'w', reader: r, home, now: old, procTable: NO_PS });
        // A STALE session file for the DEAD reader must not keep it alive.
        fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
        fs.writeFileSync(path.join(home, '.claude', 'sessions', '4000001.json'), JSON.stringify({ pid: 4000001, startedAt: old }));
        const table = new Map([[process.pid, Date.now() - 60000], [4000002, old + 5000], [4000003, NaN]]);
        const kill = (pid) => { if (pid === 4000001) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return true; };
        const retired = rc.retireEnded(s, { partition: 'w', procTable: table, kill, now: Date.now() });
        assert.deepStrictEqual(retired.filter((x) => x.startsWith('store:')).sort(), ['store:' + DEAD, 'store:' + REUSED].sort());
        // ps failed -> nothing is provable -> nothing retired.
        rc.declare(s, { partition: 'w9', reader: DEAD, home, procTable: NO_PS });
        assert.deepStrictEqual(rc.retireEnded(s, { partition: 'w9', procTable: null, kill, now: Date.now() }), []);
        // EPERM / within the pid-reuse margin / unknown start => live.
        const eperm = (pid) => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
        assert.strictEqual(rc.provablyEnded('h:4000004:' + old, new Map(), eperm), false);
        assert.strictEqual(rc.provablyEnded('h:4000005:' + old, new Map([[4000005, old + 999]]), kill), false);
        assert.strictEqual(rc.provablyEnded('h:4000005:0', new Map([[4000005, old]]), kill), false);
        assert.strictEqual(rc.provablyEnded('h:4000005:1700000000', new Map([[4000005, old]]), kill), false, 'a seconds-valued start is not evidence');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] retirement: the floor passes a PROVABLY ended reader only on the next ack; a retired reader still reads its own row`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 5);
        const old = Date.now() - 10 * 60 * 1000;
        const DEAD = 'h:4100001:' + old;
        rc.declare(s, { partition: 'w', reader: DEAD, home, now: old, procTable: NO_PS });
        rc.declare(s, { partition: 'w', reader: 'h:1:1', home, now: old, procTable: NO_PS });
        const kill = () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; };
        const table = new Map([[1, 0]]);
        const a = rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:1:1', target: 5, home, procTable: table, kill });
        assert.ok(a.retired.includes('store:' + DEAD), 'the >60s-old dead pin is retired in the ack');
        assert.strictEqual(a.floor, 5);
        assert.strictEqual(rc.countFor(s, { partition: 'w', reader: DEAD, home }).unread, 5, 'the retired row is still its own read base — no loss');
        // A later ack by the (supposedly dead) reader self-heals the retirement.
        rc.ackFor(s, { partition: 'w', ns: 'store', reader: DEAD, target: 1, home, procTable: NO_PS });
        const row = s.readerCursorRows('w').find((r) => r.ns === 'store' && r.reader === DEAD);
        assert.strictEqual(row.retiredLine, null);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] countFor: a read error is UNKNOWN, never 0`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 3);
        const orig = s.readerCursorRows;
        s.readerCursorRows = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
        const u1 = rc.countFor(s, { partition: 'w', home });
        assert.strictEqual(u1.unknown, true);
        assert.strictEqual(u1.unread, null, 'never a number on a read error');
        s.readerCursorRows = orig;
        const origList = s.listMessages;
        s.listMessages = () => { throw new Error('SQLITE_CORRUPT'); };
        const u2 = rc.countFor(s, { partition: 'w', home });
        assert.strictEqual(u2.unknown, true, 'the pre-existing unionUnread error->0 path now surfaces as unknown');
        assert.strictEqual(u2.reason, 'store-read-error');
        s.listMessages = origList;
        assert.strictEqual(rc.countFor(s, { partition: 'w', home }).unread, 3, 'and a healthy read is a real count');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] import: floor = HEAD's own effective floor; mapped reader = max(baseline, #inst); live unmapped harness seeded at F; idempotent; no legacy file touched`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 10);
        s.setCursor('w', 9); // shared pair pushed far ahead (an old build's own ack)
        const dir = cursorsDir(home);
        fs.mkdirSync(dir, { recursive: true });
        const mapped = 'h:' + process.pid + ':1700000000000';
        const short = require('node:crypto').createHash('sha1').update('anc:' + process.pid + ':1700000000000').digest('hex').slice(0, 6);
        fs.writeFileSync(path.join(dir, 'w#base.json'), '2');
        fs.writeFileSync(path.join(dir, 'w#inst-' + short + '.json'), '7');
        fs.writeFileSync(path.join(dir, 'w#inst-aaaaaa.json'), '4'); // unmappable (dead/self) reader
        fs.writeFileSync(path.join(dir, 'w#nd-' + short + '.json'), '1');
        const sess = path.join(home, '.claude', 'sessions');
        fs.mkdirSync(sess, { recursive: true });
        fs.writeFileSync(path.join(sess, process.pid + '.json'), JSON.stringify({ pid: process.pid, startedAt: 1700000000000 }));
        fs.writeFileSync(path.join(sess, process.ppid + '.json'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
        const snap = () => fs.readdirSync(dir).sort().map((n) => n + '=' + fs.readFileSync(path.join(dir, n), 'utf8'));
        const before = snap();
        // Live set comes from the PROCESS table (both pids present, starts <= S).
        const table = new Map([[process.pid, 1600000000000], [process.ppid, 1600000000000]]);
        const dry = rc.importLegacy(s, { partition: 'w', home, procTable: table, dryRun: true });
        assert.strictEqual(dry.wouldImport, true);
        assert.deepStrictEqual(s.readerCursorRows('w'), [], 'dry run writes nothing');
        const r1 = rc.importLegacy(s, { partition: 'w', home, procTable: table });
        assert.strictEqual(r1.imported, true);
        assert.strictEqual(floor(s, 'w'), 4, 'floor = max(#base 2, MIN(#inst 7, 4)) — never max\'ed with the shared pair (9)');
        const rows = s.readerCursorRows('w');
        const get = (ns, r) => (rows.find((x) => x.ns === ns && x.reader === r) || {}).value;
        assert.strictEqual(get('store', mapped), 7, 'mapped reader = max(baseline, its own #inst)');
        assert.strictEqual(get('nd', mapped), 1, 'mapped nd reader = its own #nd');
        const unmappedLive = 'h:' + process.ppid + ':' + JSON.parse(fs.readFileSync(path.join(sess, process.ppid + '.json'), 'utf8')).startedAt;
        assert.strictEqual(get('store', unmappedLive), 4, 'a live harness with no mapped file is seeded at F_import');
        const once = JSON.stringify(rowsOf(s, 'w'));
        const r2 = rc.importLegacy(s, { partition: 'w', home, procTable: table });
        assert.strictEqual(r2.imported, false);
        assert.strictEqual(JSON.stringify(rowsOf(s, 'w')), once, 'idempotent');
        const after = snap().filter((x) => !x.startsWith('w.json='));
        assert.deepStrictEqual(after, before.filter((x) => !x.startsWith('w.json=')), 'no #base/#inst/#nd file created, modified or deleted');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test(`[${backend}] dual-write: upward only, never above F, and #inst/#nd/#base untouched`, () => {
    const home = tmpHome();
    try {
      const s = open(home, backend);
      try {
        seedMsgs(s, 'w', 6);
        const cp2 = path.join(home, 'desc.cursor');
        fs.writeFileSync(cp2, '1');
        rc.declare(s, { partition: 'w', reader: 'h:1:1', home, cursorPath: cp2, procTable: NO_PS });
        rc.declare(s, { partition: 'w', reader: 'h:2:2', home, cursorPath: cp2, procTable: NO_PS });
        rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:1:1', target: 6, home, procTable: NO_PS });
        rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:2:2', target: 3, home, procTable: NO_PS });
        assert.strictEqual(s.cursorValue('w'), 3, 'shared store row = F, never the faster reader\'s 6');
        assert.strictEqual(inboxCursor.readCursor(path.join(cursorsDir(home), 'w.json')), 3);
        rc.ackFor(s, { partition: 'w', ns: 'nd', reader: 'h:1:1', target: 2, home, cursorPath: cp2, procTable: NO_PS });
        assert.strictEqual(inboxCursor.readCursor(cp2), 1, 'the descriptor cursor is only raised to F_nd (still pinned by h:2:2)');
        let names = [];
        try { names = fs.readdirSync(cursorsDir(home)); } catch (_) { names = []; }
        assert.deepStrictEqual(names.filter((n) => n.includes('#')), []);
      } finally { s.close(); }
    } finally { rm(home); }
  });
}

test('[journal] lock fails CLOSED: with reader_cursors.lock held, the ack writes NOTHING (re-delivery, never loss)', () => {
  const home = tmpHome();
  try {
    const s = open(home, 'journal', { lock: { maxTries: 3, appendRetries: 1, staleMs: 60000 } });
    try {
      seedMsgs(s, 'w', 3);
      rc.declare(s, { partition: 'w', reader: 'h:1:1', home, procTable: NO_PS });
      const before = JSON.stringify(rowsOf(s, 'w'));
      const lock = path.join(home, '.anti-hall', 'devswarm', 'store', HASH, 'journal', 'reader_cursors.lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: Date.now() }));
      const r = rc.ackFor(s, { partition: 'w', ns: 'store', reader: 'h:1:1', target: 3, home, procTable: NO_PS });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'ELOCKUNAVAIL');
      assert.strictEqual(JSON.stringify(rowsOf(s, 'w')), before, 'no partial ack');
      fs.unlinkSync(lock);
    } finally { s.close(); }
  } finally { rm(home); }
});

// Concurrency: N processes interleave declare + ack on ONE store; afterwards the
// floor never exceeds any live declared reader's own row (the loss invariant).
for (const backend of BACKENDS) {
  test(`[${backend}] concurrent declare + ack across processes: F <= every live declared row`, () => {
    const home = tmpHome();
    {
      const s0 = open(home, backend);
      try { seedMsgs(s0, 'w', 40); } finally { s0.close(); }
      const script = `
        const rc = require(${JSON.stringify(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'))});
        const st = require(${JSON.stringify(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'))});
        const [home, backend, reader] = process.argv.slice(1);
        const s = st.openStore({ home, hash: ${JSON.stringify(HASH)}, backend });
        rc.declare(s, { partition: 'w', reader, home, procTable: new Map() });
        for (let t = 1; t <= 40; t += 3) rc.ackFor(s, { partition: 'w', ns: 'store', reader, target: reader.endsWith(':9') ? Math.min(t, 10) : t, home, procTable: new Map() });
        s.close();`;
      const kids = ['h:11:1', 'h:12:2', 'h:13:9', 'self:4:4'].map((r) => cp.spawn(process.execPath, ['-e', script, home, backend, r], { stdio: 'ignore' }));
      const wait = (k) => new Promise((res) => k.on('exit', res));
      return Promise.all(kids.map(wait)).then(() => {
        const s = open(home, backend);
        try {
          const rows = s.readerCursorRows('w').filter((r) => r.ns === 'store');
          const F = rows.find((r) => r.reader === rc.FLOOR).value;
          const live = rows.filter((r) => r.reader !== rc.FLOOR);
          assert.strictEqual(live.length, 3, 'three declared readers; the headless one has no row');
          // (A reader that declares AFTER the others raised F is a newcomer and is
          // seeded at F, so the exact final F depends on interleaving; the loss
          // invariant does not.)
          for (const r of live) assert.ok(F <= r.value, 'F ' + F + ' passed live reader ' + r.reader + ' at ' + r.value);
          assert.strictEqual(F, Math.min(...live.map((r) => r.value)), 'the last ack leaves F at MIN(live)');
        } finally { s.close(); rm(home); }
      });
    }
  });
}

test('unionUnread: a store read error is reported as storeError (the NDJSON-only numbers are no longer a silent 0 for countFor)', () => {
  const u = unread.unionUnread({ inboxPath: null, cursorPath: null, id: 'w', storeHandle: { cursorValue() { return 0; }, listMessages() { throw new Error('boom'); } } });
  assert.strictEqual(u.storeError, 'boom');
});

test('liveness.unionPendingFor: a store read error reports PENDING + unknown (fail toward the alarm), never an empty mailbox', () => {
  const origOpen = unread.openStoreForUnread;
  unread.openStoreForUnread = () => ({ cursorValue() { return 0; }, listMessages() { throw new Error('boom'); }, readerCursorRows() { return []; }, close() {} });
  try {
    const r = liveness.unionPendingFor({ id: 'w', worktreePath: '/nope', inboxPath: null, cursorPath: null }, tmpHome(), {});
    assert.strictEqual(r.unknown, true);
    assert.strictEqual(r.pending, true);
  } finally { unread.openStoreForUnread = origOpen; }
});
