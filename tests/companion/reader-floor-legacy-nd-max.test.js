'use strict';
// v0.107.1 — phantom "N unread" on a partition whose legacy NDJSON inbox was
// fully read. A reader_cursors import that ran without a cursorPath seeded the
// nd '#floor' at 0 and every live session's nd row at 0; the legacy descriptor
// cursor (== line count) was ignored, so computeSummary's directUnread counted
// the whole legacy inbox as unread.
//   (a) read path: the nd floor is max(nd #floor, the descriptor's legacy nd
//       cursor) -> summary directUnread counts only real store unread
//   (b) repair (repairPinnedFloors / 'repair-reader-floors'): raises the
//       import-seeded, unmapped nd rows and the nd floor to the legacy cursor
//       (max-only, no row removed), a second run is a no-op
//   (c) a descriptor whose cursorPath IS the shared store cursor
//       (cursors/<id>.json, the primary-anchor shape) is never read as an nd
//       position (it holds store-namespace values)
//   (d) update.js's reader-floor-repair stage runs WITHOUT a DevSwarm env

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const dwReal = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const updateJs = require(path.join(ROOT, 'skills', 'update', 'scripts', 'update.js'));

const HASH = 'fixture-repo-abc124';
const BACKENDS = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? ['sqlite', 'journal'] : ['journal'];
const PART = 'builder-root-1';
const LEGACY_LINES = 40;

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function withHome(home, backend, fn) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ANTIHALL_DEVSWARM_STORE_BACKEND: process.env.ANTIHALL_DEVSWARM_STORE_BACKEND };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.ANTIHALL_DEVSWARM_STORE_BACKEND = backend;
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

// seed(backend, { anchorShape }) -> the field shape: a fully-read legacy inbox
// (LEGACY_LINES lines, cursor LEGACY_LINES), 12 store messages with the store
// floor at 10 (2 real unread), nd '#floor' 0 and three import-seeded nd rows at 0
// (one of them with a store row that advanced, i.e. a live local reader).
function seed(backend, opts) {
  const o = opts || {};
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-nd-max-')));
  const home = path.join(base, 'home');
  const wt = path.join(base, 'wt');
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
  const root = liveness.devswarmRoot(home);
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cursors'), { recursive: true });
  const inboxPath = path.join(wt, 'inbox.ndjson');
  fs.writeFileSync(inboxPath, Array.from({ length: LEGACY_LINES }, (_, i) => JSON.stringify({ ts: i + 1, from: 'x', body: 'legacy ' + i }) + '\n').join(''));
  const cursorPath = o.anchorShape ? path.join(root, 'cursors', PART + '.json') : path.join(wt, 'inbox.cursor');
  fs.writeFileSync(cursorPath, String(LEGACY_LINES));
  fs.writeFileSync(path.join(root, 'workspaces', PART + '.json'), JSON.stringify({ id: PART, worktreePath: wt, sessionId: null, inboxPath, cursorPath }));
  const readers = ['h:7001:1790000007001', 'h:7002:1790000007002', 'h:7003:1790000007003'];
  const s = storeLib.openStore({ home, hash: HASH, backend });
  try {
    s.upsertRegistry({ id: PART, worktreePath: wt, sessionId: null, inboxPath, cursorPath });
    for (let i = 0; i < 12; i++) s.appendMessage({ workspaceId: PART, hash: 'm' + i, body: 'b' + i, ts: 1000 + i });
    s.readerCursorTxn((tx) => {
      const put = (ns, reader, value) => tx.put({ partition: PART, ns, reader, value, updatedAt: 1 });
      put('store', rc.FLOOR, 10); put('nd', rc.FLOOR, 0);
      for (const r of readers) { put('store', r, r === readers[0] ? 12 : 10); put('nd', r, 0); }
    });
  } finally { s.close(); }
  return { base, home, wt, inboxPath, cursorPath, readers, backend };
}
function open(f, readOnly) { return storeLib.openStore({ home: f.home, hash: HASH, backend: f.backend, readOnly: !!readOnly }); }
function directUnread(f) {
  const s = open(f, true);
  try { return storeLib.computeSummary(s, { home: f.home }).workspaces[PART].directUnread; } finally { s.close(); }
}
function ndRows(f) {
  const s = open(f, true);
  try { return s.readerCursorRows(PART).filter((r) => r.ns === 'nd'); } finally { s.close(); }
}

for (const backend of BACKENDS) {
  test(`[${backend}] (a) read path: nd floor = max(#floor, legacy descriptor cursor); summary counts only real unread`, () => {
    const f = seed(backend);
    try {
      withHome(f.home, backend, () => {
        const s = open(f, true);
        try {
          assert.strictEqual(rc.floorOf(s, PART, 'nd', { home: f.home }), LEGACY_LINES, 'floorOf falls back to the descriptor cursorPath');
          const u = rc.countFor(s, { reader: null, partition: PART, inboxPath: f.inboxPath, cursorPath: f.cursorPath, home: f.home });
          assert.strictEqual(u.unknown, false);
          assert.strictEqual(u.ndjsonUnreadLines.length, 0, 'the fully-read legacy inbox contributes nothing');
        } finally { s.close(); }
        assert.strictEqual(directUnread(f), 2, 'only the 2 store rows past the store floor are unread');
      });
    } finally { rm(f.base); }
  });

  test(`[${backend}] (b) repair raises import-seeded nd rows + floor to the legacy cursor, no delete, idempotent`, () => {
    const f = seed(backend);
    try {
      withHome(f.home, backend, () => {
        const before = ndRows(f).length;
        const r1 = dwReal.repairReaderFloorsAllStores(f.home, { procTable: null });
        assert.strictEqual(r1.errors, 0, JSON.stringify(r1.results));
        assert.strictEqual(r1.repaired, 1);
        const rows = ndRows(f);
        assert.strictEqual(rows.length, before, 'no nd row removed');
        for (const r of rows) assert.strictEqual(r.value, LEGACY_LINES, r.reader + ' raised to the legacy cursor');
        assert.strictEqual(fs.readFileSync(f.cursorPath, 'utf8').trim(), String(LEGACY_LINES), 'legacy cursor never lowered');
        const r2 = dwReal.repairReaderFloorsAllStores(f.home, { procTable: null });
        assert.strictEqual(r2.pending, 0, 'second run finds nothing: idempotent');
        assert.strictEqual(directUnread(f), 2);
      });
    } finally { rm(f.base); }
  });

  test(`[${backend}] (c) a cursorPath that IS the shared store cursor is never read as an nd position`, () => {
    const f = seed(backend, { anchorShape: true });
    try {
      withHome(f.home, backend, () => {
        const s = open(f, true);
        try { assert.strictEqual(rc.floorOf(s, PART, 'nd', { home: f.home }), 0, 'store-namespace file ignored for the nd max'); } finally { s.close(); }
        const r = dwReal.repairReaderFloorsAllStores(f.home, { procTable: null, dryRun: true });
        const hit = (r.results || []).find((x) => x.id === PART);
        assert.ok(!hit || !(hit.raised || []).length, 'no nd row raised from a store-namespace cursor');
      });
    } finally { rm(f.base); }
  });
}

test('(d) update.js reader-floor-repair runs without a DevSwarm env (store repair, not a session action)', () => {
  const backend = BACKENDS[0];
  const f = seed(backend);
  try {
    withHome(f.home, backend, () => {
      const env = { HOME: f.home, USERPROFILE: f.home, ANTIHALL_DEVSWARM_STORE_BACKEND: backend };
      const r = updateJs.readerFloorRepairPostUpdate({
        paths: { pluginSrcDir: ROOT }, env, cwd: f.base, home: f.home, version: '9.9.9',
        devswarm: { repairReaderFloorsAllStores: (h, ctx) => dwReal.repairReaderFloorsAllStores(h, Object.assign({}, ctx, { procTable: null })) },
      });
      assert.strictEqual(r.attempted, true, r.detail);
      assert.strictEqual(r.repaired, 1, r.detail);
      assert.ok(!/gate closed/.test(r.detail), r.detail);
      for (const row of ndRows(f)) assert.strictEqual(row.value, LEGACY_LINES);
    });
  } finally { rm(f.base); }
});
