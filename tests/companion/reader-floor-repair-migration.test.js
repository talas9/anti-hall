'use strict';
// migrations.js 'repair-reader-floors' (update.js stage 'reader-floor-repair')
// — the updater repairs the data the v0.106.0 reader_cursors import broke:
// every live session on the machine declared on every partition at the import
// floor (pinning it forever) and the nd floor imported as 0.
//   (e) exact broken shape -> foreign/ended rows RETIRED (never deleted), floor =
//       the local reader's position, nd floor repaired from the legacy cursor,
//       a local reader with unread keeps it, second run = no-op
//   (f) fail-open on a malformed store (counted, never thrown, never stamped)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const identity = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
const M = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
const dwReal = require(path.join(ROOT, 'scripts', 'devswarm.js'));

const HASH = 'fixture-repo-abc123';
const BACKENDS = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? ['sqlite', 'journal'] : ['journal'];
const STARTED = 1790000000000;
const CHILD = 'child-ws-1';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function mkRepo(dir) { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); return fs.realpathSync(dir); }
function readerFor(pid) { return 'h:' + pid + ':' + (STARTED + pid); }
function writeSession(home, pid, cwd) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: 's-' + pid, cwd, startedAt: STARTED + pid }));
}
// withHome — in-process calls get `home` explicitly; HOME/USERPROFILE are
// pointed at the fixture too so nothing can fall through to the real home.
// The backend under test is selected through the env (ANTIHALL_DEVSWARM_STORE_BACKEND),
// the same way a real run picks it, so the all-stores pass opens the same store.
function withHome(home, fn, backend) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ANTIHALL_DEVSWARM_STORE_BACKEND: process.env.ANTIHALL_DEVSWARM_STORE_BACKEND };
  process.env.HOME = home; process.env.USERPROFILE = home;
  if (backend) process.env.ANTIHALL_DEVSWARM_STORE_BACKEND = backend;
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}
// Only the entry under test is present; procTable null = nothing is provable
// from the process table (fixture pids may collide with real processes), so
// every verdict here comes from the session files and cwd locality alone.
const dw = { repairReaderFloorsAllStores: (h, ctx) => dwReal.repairReaderFloorsAllStores(h, Object.assign({}, ctx, { procTable: null })) };

// seedBroken -> the exact v0.106.0 shape on two partitions:
//   PRIMARY (primary-<hash8> of the main worktree): 20 msgs, #floor store 12 /
//     nd 0; the local Primary acked to 20 (store) / 9 (nd); 15 foreign sessions
//     + 1 ended session seeded at the import floor (12 / 0). Legacy nd cursor 9.
//   CHILD (descriptor -> a child worktree): 10 msgs, #floor 4; the local child
//     session is at 6 (4 unread of its own); the same 16 non-local rows at 4.
function seedBroken(backend) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-floor-repair-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const mainWt = mkRepo(path.join(base, 'main'));
  const childWt = mkRepo(path.join(base, 'child'));
  const PRIMARY = identity.meshIdForRealPath(mainWt);
  const root = liveness.devswarmRoot(home);
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cursors'), { recursive: true });
  const primaryCursor = path.join(root, 'cursors', PRIMARY + '.json');
  fs.writeFileSync(primaryCursor, '9');
  fs.writeFileSync(path.join(root, 'workspaces', PRIMARY + '.json'), JSON.stringify({ id: PRIMARY, worktreePath: mainWt, sessionId: 's-p', inboxPath: null, cursorPath: primaryCursor }));
  fs.writeFileSync(path.join(root, 'workspaces', CHILD + '.json'), JSON.stringify({ id: CHILD, worktreePath: childWt, sessionId: 's-c', inboxPath: null, cursorPath: null }));

  const primaryPid = 5000;
  const childPid = 5001;
  writeSession(home, primaryPid, mainWt);
  writeSession(home, childPid, path.join(childWt));
  const foreign = [];
  for (let i = 0; i < 15; i++) {
    const pid = 5100 + i;
    const cwd = i % 2 ? mkRepo(path.join(base, 'other-' + i)) : path.join(base, 'gone-' + i);
    writeSession(home, pid, cwd);
    foreign.push(readerFor(pid));
  }
  const ended = readerFor(5999); // no session file: the session ended

  const s = storeLib.openStore({ home, hash: HASH, backend });
  try {
    for (let i = 0; i < 20; i++) s.appendMessage({ workspaceId: PRIMARY, hash: 'p' + i, body: 'b' + i, ts: i + 1 });
    for (let i = 0; i < 10; i++) s.appendMessage({ workspaceId: CHILD, hash: 'c' + i, body: 'b' + i, ts: i + 1 });
    s.readerCursorTxn((tx) => {
      const put = (partition, ns, reader, value) => tx.put({ partition, ns, reader, value, updatedAt: 1 });
      put(PRIMARY, 'store', rc.FLOOR, 12); put(PRIMARY, 'nd', rc.FLOOR, 0);
      put(PRIMARY, 'store', readerFor(primaryPid), 20); put(PRIMARY, 'nd', readerFor(primaryPid), 9);
      put(CHILD, 'store', rc.FLOOR, 4); put(CHILD, 'nd', rc.FLOOR, 0);
      put(CHILD, 'store', readerFor(childPid), 6); put(CHILD, 'nd', readerFor(childPid), 0);
      for (const r of foreign.concat([ended])) {
        put(PRIMARY, 'store', r, 12); put(PRIMARY, 'nd', r, 0);
        put(CHILD, 'store', r, 4); put(CHILD, 'nd', r, 0);
      }
    });
  } finally { s.close(); }
  return { base, home, PRIMARY, primaryReader: readerFor(primaryPid), childReader: readerFor(childPid), foreign, ended, backend };
}
function rowsOf(f, id) {
  const s = storeLib.openStore({ home: f.home, hash: HASH, backend: f.backend });
  try { return s.readerCursorRows(id); } finally { s.close(); }
}
function floorOf(rows, ns) { return rows.find((r) => r.ns === ns && r.reader === rc.FLOOR).value; }
function snapshot(f) { return JSON.stringify([rowsOf(f, f.PRIMARY), rowsOf(f, CHILD)].map((rs) => rs.map((r) => [r.ns, r.reader, r.value, r.retiredLine]).sort())); }

for (const backend of BACKENDS) {
  test(`[${backend}] (e) migration repairs the v0.106.0 broken shape: retire (not delete), floor = local min, nd repaired, idempotent`, () => {
    const f = seedBroken(backend);
    try {
      withHome(f.home, () => {
        const before = { p: rowsOf(f, f.PRIMARY).length, c: rowsOf(f, CHILD).length };
        const dry = dwReal.repairReaderFloorsAllStores(f.home, { dryRun: true, procTable: null });
        assert.strictEqual(dry.pending, 2, 'both partitions detected as pinned');

        const r1 = M.runMigrations({ home: f.home, version: '9.9.9', devswarm: dw });
        const row = r1.find((x) => x.id === 'repair-reader-floors');
        assert.ok(row, JSON.stringify(r1));
        assert.strictEqual(row.status, 'fixed', row.msg);
        assert.strictEqual(M.isApplied(M.readMarkers(f.home), 'repairReaderFloors', '9.9.9'), true, 'stamped via recordRun');

        const p = rowsOf(f, f.PRIMARY);
        const c = rowsOf(f, CHILD);
        assert.strictEqual(p.length, before.p, 'no row deleted (primary)');
        assert.strictEqual(c.length, before.c, 'no row deleted (child)');
        for (const r of f.foreign.concat([f.ended])) {
          for (const rows of [p, c]) {
            for (const ns of ['store', 'nd']) {
              const x = rows.find((y) => y.ns === ns && y.reader === r);
              assert.ok(x && rc.isRetired(x), ns + ':' + r + ' retired');
            }
          }
        }
        for (const [rows, reader] of [[p, f.primaryReader], [c, f.childReader]]) {
          for (const ns of ['store', 'nd']) assert.ok(!rc.isRetired(rows.find((y) => y.ns === ns && y.reader === reader)), 'local reader never retired');
        }
        assert.strictEqual(floorOf(p, 'store'), 20, 'primary floor = the local Primary\'s position');
        assert.strictEqual(floorOf(p, 'nd'), 9, 'nd floor repaired (local nd row / legacy cursor)');
        assert.strictEqual(floorOf(c, 'store'), 6, 'child floor = the local child reader\'s position, not past it');

        const s = storeLib.openStore({ home: f.home, hash: HASH, backend });
        try {
          assert.strictEqual(rc.countFor(s, { partition: CHILD, reader: f.childReader, home: f.home }).unread, 4, 'the local reader keeps its own unread');
          assert.strictEqual(rc.countFor(s, { partition: f.PRIMARY, reader: null, home: f.home }).unread, 0, 'no phantom floor-view unread');
        } finally { s.close(); }

        const once = snapshot(f);
        const again = dwReal.repairReaderFloorsAllStores(f.home, { procTable: null });
        assert.strictEqual(again.pending, 0, 'second run finds nothing');
        assert.strictEqual(snapshot(f), once, 'second run writes nothing');
        const r2 = M.runMigrations({ home: f.home, version: '9.9.9', devswarm: dw });
        assert.match(r2.find((x) => x.id === 'repair-reader-floors').msg, /already applied/);
      }, backend);
    } finally { rm(f.base); }
  });

  test(`[${backend}] (e2) nd floor 0 with no declared reader left is repaired from the legacy descriptor cursor`, () => {
    const f = seedBroken(backend);
    try {
      withHome(f.home, () => {
        fs.rmSync(path.join(f.home, '.claude', 'sessions', '5000.json')); // the Primary session ended too
        dwReal.repairReaderFloorsAllStores(f.home, { procTable: null });
        const p = rowsOf(f, f.PRIMARY);
        assert.strictEqual(floorOf(p, 'nd'), 9, 'legacy descriptor cursor');
        assert.strictEqual(floorOf(p, 'store'), 12, 'store floor never raised past what a reader proved');
      }, backend);
    } finally { rm(f.base); }
  });
}

test('(f) migration is fail-open on a malformed store: counted, never thrown, never stamped', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-floor-repair-bad-')));
  const home = path.join(base, 'home');
  try {
    withHome(home, () => {
      const dir = path.join(liveness.devswarmRoot(home), 'store', 'broken-repo-abcdef');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'devswarm.db'), 'this is not a sqlite database');
      // A second store whose reader_cursors journal is unreadable (EISDIR) —
      // a per-partition failure, not a per-store one.
      const js = storeLib.openStore({ home, hash: 'jrepo-abcdef', backend: 'journal' });
      try { js.appendMessage({ workspaceId: 'w1', hash: 'a', body: 'b', ts: 1 }); } finally { js.close(); }
      fs.mkdirSync(path.join(liveness.devswarmRoot(home), 'store', 'jrepo-abcdef', 'journal', 'reader_cursors.ndjson'), { recursive: true });
      let r;
      assert.doesNotThrow(() => { r = dwReal.repairReaderFloorsAllStores(home, { procTable: null, backend: 'sqlite' }); });
      assert.strictEqual(r.ok, true);
      assert.ok(r.errors >= 1, 'the corrupt sqlite store is counted: ' + JSON.stringify(r));
      assert.doesNotThrow(() => { r = dwReal.repairReaderFloorsAllStores(home, { procTable: null, backend: 'journal' }); });
      assert.ok(r.errors >= 1 && r.results.some((x) => x.id === 'w1' && /unreadable/.test(x.error)), 'the unreadable partition is counted: ' + JSON.stringify(r));
      // Through the registry: an erroring real pass is never stamped.
      const realDw = { repairReaderFloorsAllStores: (h, ctx) => dwReal.repairReaderFloorsAllStores(h, Object.assign({}, ctx, { procTable: null, backend: 'journal' })) };
      const real = M.runMigrations({ home, version: '9.9.9', devswarm: realDw }).find((x) => x.id === 'repair-reader-floors');
      assert.notStrictEqual(real.status, 'failed', 'fail-open: nothing pending, just not stamped');
      assert.strictEqual(M.isApplied(M.readMarkers(home), 'repairReaderFloors', '9.9.9'), false, 'errors block the stamp');
      const badDw = { repairReaderFloorsAllStores: () => ({ ok: true, pending: 1, errors: 1, stores: 1 }) };
      const rows = M.runMigrations({ home, version: '9.9.9', devswarm: badDw });
      const row = rows.find((x) => x.id === 'repair-reader-floors');
      assert.notStrictEqual(row.status, 'fixed');
      assert.strictEqual(M.isApplied(M.readMarkers(home), 'repairReaderFloors', '9.9.9'), false, 'an erroring pass is never stamped');
      const throwing = { repairReaderFloorsAllStores: () => { throw new Error('boom'); } };
      const t = M.runMigrations({ home, version: '9.9.9', devswarm: throwing }).find((x) => x.id === 'repair-reader-floors');
      assert.strictEqual(t.status, 'failed');
      assert.match(t.msg, /boom/);
    });
  } finally { rm(base); }
});
