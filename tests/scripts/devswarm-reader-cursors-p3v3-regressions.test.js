'use strict';
// Mesh redesign Phase 3 — review round 2 regressions (message LOSS paths).
//
//   R2-P0 rehome tombstoned the source after copying an INCOMPLETE tail: a
//         source messages.ndjson read error (-> []) or a torn row was silently
//         treated as "nothing more to move".
//   R2-P1a forwardedDrained classification fell back to the legacy shared
//         cursor when reader_cursors was unreadable, and could file a real
//         unread orphan as quietly drained.
//   R2-P1b the journal O_EXCL lock: a LIVE holder past staleMs was stolen, and
//         the original holder's release then unlinked the successor's lock.
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
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-p3v3-'));
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

const openJ = (home, hash, extra) => storeLib.openStore(Object.assign({ home, hash, backend: 'journal' }, extra || {}));
const jdir = (home, hash) => path.join(liveness.devswarmRoot(home), 'store', hash, 'journal');
function seedMesh(s, id, n, tag) {
  for (let i = 0; i < n; i++) {
    const f = { from: 'peer', to: id, type: 'direct', message: tag + '-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
    storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
  }
}

// ---------------------------------------------------------------------------
// R2-P0 rehome
// ---------------------------------------------------------------------------
function rehomeFixture(breakSource) {
  const home = tmpHome();
  const id = 'child-rehome-src';
  const fromKey = 'from-r2';
  const toKey = 'to-r2';
  const s = openJ(home, fromKey);
  try { s.upsertRegistry({ id, worktreePath: '/fake/A', sessionId: 'sess-a' }); seedMesh(s, id, 3, id); } finally { s.close(); }
  breakSource(path.join(jdir(home, fromKey), 'messages.ndjson'), id);
  const out = cli.rehomeAcrossStores(home, id, fromKey, toKey, { backend: 'journal', env: {} });
  const src = openJ(home, fromKey);
  let srcHasRow;
  try { srcHasRow = (src.listRegistry() || []).some((r) => String(r.id) === id); } finally { src.close(); }
  return { home, out, srcHasRow };
}

test('R2-P0 rehome aborts (no tombstone) when the source messages file cannot be read', () => {
  const f = rehomeFixture((file) => { fs.renameSync(file, file + '.bak'); fs.mkdirSync(file); });
  try {
    assert.strictEqual(f.out.rehomed, false, JSON.stringify(f.out));
    assert.ok(f.srcHasRow, 'the source registry row must survive: ' + JSON.stringify(f.out));
  } finally { rm(f.home); }
});

test('R2-P0 rehome aborts (no tombstone) when the source messages file has a torn row', () => {
  const f = rehomeFixture((file, id) => {
    const row = JSON.stringify({ workspaceId: id, hash: 'torn-4', body: 'the fourth message', ts: 1700000000009 });
    fs.appendFileSync(file, row.slice(0, Math.floor(row.length / 2))); // crash mid-append
  });
  try {
    assert.strictEqual(f.out.rehomed, false, JSON.stringify(f.out));
    assert.ok(f.srcHasRow, 'the source registry row must survive: ' + JSON.stringify(f.out));
  } finally { rm(f.home); }
});

test('R2-P0 control: a healthy source still rehomes and moves every unread row', () => {
  const f = rehomeFixture(() => {});
  try {
    assert.strictEqual(f.out.rehomed, true, JSON.stringify(f.out));
    assert.strictEqual(f.out.movedMessages, 3);
  } finally { rm(f.home); }
});

// ---------------------------------------------------------------------------
// R2-P1a forwardedDrained never uses the legacy cursor
// ---------------------------------------------------------------------------
test('R2-P1a an unreadable reader_cursors table never files an unread orphan as forwardedDrained', () => {
  const home = tmpHome();
  try {
    const s = storeLib.openStore({ home, backend: 'journal' });
    try {
      const root = liveness.devswarmRoot(home);
      const wt = path.join(home, 'wt-shared');
      fs.mkdirSync(wt, { recursive: true });
      const writeDesc = (sub, id, d) => { fs.mkdirSync(path.join(root, sub), { recursive: true }); fs.writeFileSync(path.join(root, sub, id + '.json'), JSON.stringify(Object.assign({ id }, d))); };
      s.upsertRegistry({ id: 'live-sibling', worktreePath: wt, sessionId: 'sess-live', inboxPath: '/i', cursorPath: '/c', nudgeCommand: null });
      writeDesc('workspaces', 'live-sibling', { worktreePath: wt, sessionId: 'sess-live' });
      writeDesc('archived', 'arch', { worktreePath: wt, sessionId: 'sess-old' });
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const fields = { from: 'someone', to: 'arch', type: 'direct', message: 'msg-' + i, timestamp: 5000 + i, urgency: 'normal' };
        storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
        rows.push(fields);
      }
      // Rows 1 and 2 are proven forwarded; row 0 is NOT. An old build's ack put
      // the legacy shared cursor at 1 — past the unforwarded row 0.
      for (const m of rows.slice(1)) {
        const fw = { from: m.from, to: 'live-sibling', type: 'direct', message: '[forwarded from archived arch] ' + m.message, timestamp: m.timestamp, urgency: 'normal' };
        storeLib.appendMeshMessage(s, Object.assign({}, fw, { hash: storeLib.meshMessageHash(fw) }));
      }
      s.setCursor('arch', 1);
      const rcFile = path.join(storeLib.journalDir(home), 'reader_cursors.ndjson');
      fs.rmSync(rcFile, { force: true });
      fs.mkdirSync(rcFile, { recursive: true });
      const sum = storeLib.computeSummary(s, { home, now: 999999 });
      const fd = (sum.forwardedDrained || []).map((o) => o.id);
      const orph = (sum.orphans || []).map((o) => o.id);
      assert.ok(!fd.includes('arch'), 'row 0 was never forwarded: must not be filed quietly drained: ' + JSON.stringify({ fd, orph }));
      assert.ok(orph.includes('arch'), 'it must stay an actionable orphan: ' + JSON.stringify({ fd, orph }));
    } finally { s.close(); }
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// R2-P1b journal lock
// ---------------------------------------------------------------------------
test('R2-P1b a LIVE lock holder past staleMs is not stolen (pid-aware stale detection)', () => {
  const home = tmpHome();
  try {
    const hash = 'lock-live';
    const s = openJ(home, hash, { lock: { maxTries: 3, appendRetries: 1 } });
    try {
      const lock = path.join(jdir(home, hash), 'reader_cursors.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      // This very process holds it, 20 s ago (> the 10 s staleMs, a long txn).
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - 20000, token: 'live-holder' }));
      let err = null;
      try { s.readerCursorTxn((tx) => tx.put({ partition: 'w', ns: 'store', reader: '#floor', value: 1, updatedAt: 1 })); }
      catch (e) { err = e; }
      assert.ok(err && err.code === 'ELOCKUNAVAIL', 'a live holder must not be stolen from: ' + (err && err.code));
      assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live-holder', 'the holder keeps its lock');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('R2-P1b a DEAD holder past staleMs is still stolen (recovery unchanged)', () => {
  const home = tmpHome();
  try {
    const hash = 'lock-dead';
    const s = openJ(home, hash, { lock: { maxTries: 3, appendRetries: 1 } });
    try {
      const lock = path.join(jdir(home, hash), 'reader_cursors.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, ts: Date.now() - 20000, token: 'dead-holder' }));
      s.readerCursorTxn((tx) => tx.put({ partition: 'w', ns: 'store', reader: '#floor', value: 1, updatedAt: 1 }));
      assert.strictEqual(s.readerCursorRows('w')[0].value, 1);
      assert.ok(!fs.existsSync(lock), 'released after the txn');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('R2-P1b a holder whose lock was taken over never unlinks the successor\'s lock (tokenized release)', () => {
  const home = tmpHome();
  try {
    const hash = 'lock-token';
    const s = openJ(home, hash);
    try {
      const lock = path.join(jdir(home, hash), 'reader_cursors.lock');
      s.readerCursorTxn(() => {
        // Mid-txn a successor took the lock over (it judged ours stale).
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'successor' }));
      });
      assert.ok(fs.existsSync(lock), 'the successor\'s lock must survive the original holder\'s release');
      assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'successor');
    } finally { s.close(); }
  } finally { rm(home); }
});
