'use strict';
// Mesh redesign Phase 3 — review-wave regressions (message LOSS paths).
//
//   P0-1 rehome with an UNREADABLE reader_cursors table used the legacy shared
//        cursor (an old build's own position) as the copy base: it copied zero
//        unread rows, verified the empty copy and tombstoned the source row.
//   P0-2 the journal import / ack+floor transaction was several NDJSON appends;
//        a crash between them left a PARTIAL transaction on disk (floor rows
//        without the reader rows), so a live reader later declared at an
//        advanced floor and read 0 unread. Now one transaction = one line.
//   P1   summary projections fell back to the legacy cursor on a table read
//        error after import -> a confident 0 unread. Now: conservative count +
//        unreadUnknown, and roster shows the direct count as unknown.
//   P2   the pre-0.99 parity boundary: a new reader's ack raises the shared
//        pair, so an old (v0.98.3-shape) reader that shows up later starts at
//        that advanced shared cursor.
//
// HERMETIC: every fixture HOME is a tmp dir; HOME/USERPROFILE are isolated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const inboxCursor = require(path.join(ROOT, 'companion', 'lib', 'devswarm-inbox-cursor.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-p3v2-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => { const iso = tmpHome(); process.env.HOME = iso; process.env.USERPROFILE = iso; });
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

const NO_PS = new Map();
const READER = 'h:4242:1700000000000';
const openJ = (home, hash) => storeLib.openStore({ home, hash, backend: 'journal' });
const rcFileOf = (home, hash) => path.join(liveness.devswarmRoot(home), 'store', hash, 'journal', 'reader_cursors.ndjson');
function seedMesh(s, id, n, tag) {
  for (let i = 0; i < n; i++) {
    const f = { from: 'peer', to: id, type: 'direct', message: tag + '-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
    storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
  }
}
// The Codex shape: a declared reader has read NOTHING (floor 0), an old build's
// ack moved the legacy shared cursor to 3, then the table becomes unreadable.
function floorZeroLegacyThree(home, hash, id, n) {
  const s = openJ(home, hash);
  try {
    seedMesh(s, id, n, id);
    rc.declare(s, { partition: id, reader: READER, home, procTable: NO_PS });
    assert.strictEqual(rc.floorOf(s, id, 'store', { home }), 0, 'precondition: floor 0');
    s.setCursor(id, n);
  } finally { s.close(); }
  const f = rcFileOf(home, hash);
  fs.rmSync(f, { force: true });
  fs.mkdirSync(f, { recursive: true }); // EISDIR on every read of the table
}

// ---------------------------------------------------------------------------
// P0-1
// ---------------------------------------------------------------------------
test('P0-1 rehome never strands unread when the reader_cursors floor is UNKNOWN', () => {
  const home = tmpHome();
  try {
    const id = 'child-rehome-unknown';
    const fromKey = 'from-p01';
    const toKey = 'to-p01';
    const s0 = openJ(home, fromKey);
    try { s0.upsertRegistry({ id, worktreePath: '/fake/A', sessionId: 'sess-a' }); } finally { s0.close(); }
    floorZeroLegacyThree(home, fromKey, id, 3);

    const out = cli.rehomeAcrossStores(home, id, fromKey, toKey, { backend: 'journal', env: {} });

    const src = openJ(home, fromKey);
    const dst = openJ(home, toKey);
    try {
      const srcHasRow = (src.listRegistry() || []).some((r) => String(r.id) === id);
      const destBodies = (dst.listMessages(id, { sinceCursor: 0 }) || []).map((m) => m.body).sort();
      if (out.rehomed) {
        assert.deepStrictEqual(destBodies, [id + '-0', id + '-1', id + '-2'], 'a completed rehome must carry every possibly-unread row: ' + JSON.stringify(out));
      } else {
        assert.ok(srcHasRow, 'an aborted rehome must leave the source registry row in place: ' + JSON.stringify(out));
      }
      assert.ok(srcHasRow || destBodies.length === 3, 'messages must stay reachable: ' + JSON.stringify(out));
    } finally { src.close(); dst.close(); }
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// P0-2 — crash atomicity of one journal transaction
// ---------------------------------------------------------------------------
function rowsSnapshot(s, id) {
  return s.readerCursorRows(id).map((r) => [r.ns, r.reader, r.value, r.retiredLine]).sort((a, b) => String(a).localeCompare(String(b)));
}
// Truncate the journal to EVERY byte offset strictly inside the transaction the
// op appended: the reduced rows must equal the pre-transaction rows (the whole
// transaction is absent), and a later transaction must still land.
function assertCrashAtomic(label, setup, op, after) {
  const home = tmpHome();
  try {
    const hash = 'p02-' + label;
    const id = 'w';
    let s = openJ(home, hash);
    try { setup(s, home, id); } finally { s.close(); }
    const file = rcFileOf(home, hash);
    const pre = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    s = openJ(home, hash);
    let preRows;
    try { preRows = rowsSnapshot(s, id); op(s, home, id); } finally { s.close(); }
    const post = fs.readFileSync(file);
    s = openJ(home, hash);
    let postRows;
    try { postRows = rowsSnapshot(s, id); } finally { s.close(); }
    assert.notDeepStrictEqual(postRows, preRows, label + ': the op must have changed rows');
    assert.ok(post.length > pre.length, label + ': the op must have written');
    assert.ok(post.subarray(0, pre.length).equals(pre), label + ': append-only');
    const mid = pre.length + Math.floor((post.length - pre.length) / 2);
    for (let cut = pre.length + 1; cut < post.length; cut++) {
      fs.writeFileSync(file, post.subarray(0, cut));
      s = openJ(home, hash);
      try {
        const got = rowsSnapshot(s, id);
        const whole = JSON.stringify(got) === JSON.stringify(preRows) || JSON.stringify(got) === JSON.stringify(postRows);
        assert.ok(whole, label + ': a crash at byte ' + cut + '/' + post.length + ' left a PARTIAL transaction: ' + JSON.stringify(got));
        if (after && (cut === mid || cut === post.length - 1)) after(s, home, id, JSON.stringify(got) === JSON.stringify(preRows));
      } finally { s.close(); }
    }
  } finally { rm(home); }
}

test('P0-2 journal IMPORT is crash-atomic: a torn import leaves no floor rows (needsImport stays true)', () => {
  assertCrashAtomic('import',
    (s, home, id) => { seedMesh(s, id, 3, 'imp'); s.setCursor(id, 1); },
    (s, home, id) => { rc.importLegacy(s, { partition: id, home, harnesses: [READER], procTable: NO_PS }); },
    (s, home, id) => {
      // After the torn tail, the next transaction still lands and re-imports
      // WITH the live reader row (the Codex loss shape: floor present, reader absent).
      rc.importLegacy(s, { partition: id, home, harnesses: [READER], procTable: NO_PS });
      const rows = s.readerCursorRows(id);
      for (const ns of rc.NAMESPACES) {
        assert.ok(rows.some((r) => r.ns === ns && r.reader === rc.FLOOR), 'floor ' + ns);
        assert.ok(rows.some((r) => r.ns === ns && r.reader === READER), 'reader row ' + ns);
      }
    });
});

test('P0-2 journal ACK+FLOOR is crash-atomic: a torn ack never leaves the own row without the floor (or vice versa)', () => {
  const OTHER = 'h:4343:1700000000000';
  assertCrashAtomic('ack',
    (s, home, id) => {
      seedMesh(s, id, 3, 'ack');
      rc.declare(s, { partition: id, reader: READER, home, procTable: NO_PS });
      rc.declare(s, { partition: id, reader: OTHER, home, procTable: NO_PS });
      rc.ackFor(s, { partition: id, ns: 'store', reader: OTHER, target: 3, home, procTable: NO_PS });
    },
    (s, home, id) => {
      const r = rc.ackFor(s, { partition: id, ns: 'store', reader: READER, target: 3, home, procTable: NO_PS });
      assert.ok(r.ok && r.floor === 3, JSON.stringify(r));
    },
    (s, home, id, absent) => {
      const u = rc.countFor(s, { reader: READER, partition: id, home });
      assert.strictEqual(u.unknown, false);
      if (absent) assert.strictEqual(u.unread, 3, 'the torn ack is absent: the reader still has its 3 unread');
      const r = rc.ackFor(s, { partition: id, ns: 'store', reader: READER, target: 3, home, procTable: NO_PS });
      assert.ok(r.ok && r.floor === 3, 'a later ack lands after a torn tail: ' + JSON.stringify(r));
    });
});

// ---------------------------------------------------------------------------
// P1 — summary projections: unknown, never a legacy-derived 0
// ---------------------------------------------------------------------------
test('P1 computeSummary: an unreadable reader_cursors table reports unreadUnknown, never a legacy-derived 0', () => {
  const home = tmpHome();
  try {
    const hash = 'p1-sum';
    const s0 = openJ(home, hash);
    try { s0.upsertRegistry({ id: 'ws1', worktreePath: home, sessionId: 's1' }); } finally { s0.close(); }
    floorZeroLegacyThree(home, hash, 'ws1', 3);
    const s1 = openJ(home, hash);
    try { seedMesh(s1, 'orph', 2, 'orph'); s1.setCursor('orph', 2); } finally { s1.close(); }
    const s = openJ(home, hash);
    try {
      const sum = storeLib.computeSummary(s, { home, env: {}, now: Date.now() });
      const w = sum.workspaces.ws1;
      assert.ok(w, 'workspace projected');
      assert.strictEqual(w.unreadUnknown, true, 'unknown must be flagged: ' + JSON.stringify(w));
      assert.ok(w.unread > 0 && w.directUnread > 0, 'never a legacy-derived 0: ' + JSON.stringify({ unread: w.unread, directUnread: w.directUnread }));
      const o = (sum.orphans || []).find((x) => x.id === 'orph');
      assert.ok(o && o.unread > 0, 'an orphan with an unknown floor still surfaces: ' + JSON.stringify(sum.orphans));
    } finally { s.close(); }
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// P2 — pre-0.99 parity boundary
// ---------------------------------------------------------------------------
test('P2 parity boundary: a new reader acks first; an old (pre-0.99, shared-cursor) reader later starts at the advanced shared cursor', () => {
  const home = tmpHome();
  try {
    const hash = 'p2-parity';
    const id = 'wp';
    const s = openJ(home, hash);
    try {
      seedMesh(s, id, 3, 'par');
      rc.declare(s, { partition: id, reader: READER, home, procTable: NO_PS });
      const r = rc.ackFor(s, { partition: id, ns: 'store', reader: READER, target: 3, home, procTable: NO_PS });
      assert.ok(r.ok && r.floor === 3, JSON.stringify(r));
      // What a v0.98.3 build reads: the shared pair (cursors/<id>.json, store cursor row).
      const json = inboxCursor.readCursor(path.join(liveness.devswarmRoot(home), 'cursors', id + '.json'));
      const row = s.cursorValue(id);
      assert.strictEqual(json, 3, 'the new ack raised the shared JSON cursor to the floor');
      assert.strictEqual(row, 3, 'the new ack raised the store cursor row to the floor');
      const oldView = s.listMessages(id, { sinceCursor: Math.max(json, row) });
      assert.strictEqual(oldView.length, 0, 'documented boundary: the late old reader starts past the rows the new reader consumed');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('P1 roster: an unreadable reader_cursors table shows the direct count as UNKNOWN, never 0', () => {
  const home = tmpHome();
  const cp = require('node:child_process');
  const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-p3v2-repo-'));
  try {
    cp.spawnSync('git', ['init', '-q', repo]);
    cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const hash = repokey.repoKeyForWorktree(repo);
    assert.ok(hash, 'precondition: a repoKey');
    const s0 = openJ(home, hash);
    try { s0.upsertRegistry({ id: 'wr', worktreePath: repo, sessionId: 'sr' }); } finally { s0.close(); }
    floorZeroLegacyThree(home, hash, 'wr', 3);
    const r = cli.cmdRoster({}, { home, cwd: repo, env: { HOME: home }, backend: 'journal', now: Date.now() });
    const row = (r.workspaces || []).find((w) => w.id === 'wr');
    assert.ok(row, 'row present: ' + JSON.stringify(r).slice(0, 400));
    assert.strictEqual(row.directUnread, null, 'unknown, not a number: ' + JSON.stringify(row));
    assert.strictEqual(row.unreadUnknown, true);
  } finally { rm(home); rm(repo); }
});
