'use strict';
// Golden corpus of the retention sweep: ONE realistic message store (written by Node's own store code) with direct partitions of
// every reader shape (floor rows, declared readers, retired readers, legacy cursor files and rows, NDJSON inboxes that repeat
// message bodies, open questions), the broadcast partition (heartbeat runs, cursors), restore holds, multi-byte and empty
// bodies, tombstones from an earlier run, an armed retention state.
//   usage: node rt_corpus.js <home> <hash> <seed> <nowMs> <scale: small|big>
// Prints a manifest {partitions, rows}. Deterministic for one seed.
const path = require('path');
const fs = require('fs');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const [home, hash, seedArg, nowArg, scale] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const NOW = Number(nowArg);
const BIG = scale === 'big';
let s = Number(seedArg) >>> 0;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const DAY = 86400000;
const ds = path.join(home, '.anti-hall', 'devswarm');
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const WORDS = ['alpha', 'build', 'green', 'merge', 'review', 'ö', '日本語', 'émoji', '🚀', 'task', 'ready', 'blocked', 'a\nb', 'tab\there', '"quoted"', 'back\\slash'];
const body = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(pick(WORDS)); return out.join(' '); };

const st = store.openStore({ home, hash });
const parts = [];
const nParts = ri(4, BIG ? 24 : 12);
const senders = ['primary-aaaaaaaa', 'peer-1', 'peer-2', null];
let uniq = 0;
const inboxLines = {};
let totalRows = 0;
for (let p = 0; p < nParts; p++) {
  const id = p === 0 ? 'primary-aaaaaaaa' : (p % 5 === 4 ? `ws.dot-${p}` : `ws-${p}`);
  parts.push(id);
  const n = pick([0, 1, 5, 30, 120, 400, BIG ? 4000 : 800]);
  const kind = pick(['mixed', 'old', 'recent', 'questions', 'bigbodies']);
  for (let j = 0; j < n; j++) {
    const ageDays = kind === 'old' ? 40 + rnd() * 200 : kind === 'recent' ? rnd() * 20 : rnd() * 120;
    const ts = Math.floor(NOW - ageDays * DAY);
    const needsReply = kind === 'questions' ? rnd() < 0.25 : rnd() < 0.02;
    const len = kind === 'bigbodies' ? ri(50, 400) : (rnd() < 0.05 ? 0 : ri(1, 30));
    const m = { from: pick(senders), to: id, type: 'direct', message: len === 0 ? '' : body(len) + ' #' + (uniq++), timestamp: ts, urgency: pick(['normal', 'normal', 'high']), needsReply };
    try { store.appendMeshMessage(st, Object.assign({}, m, { hash: store.meshMessageHash(m) })); totalRows++; } catch (_) { /* duplicate hash */ }
    if (rnd() < 0.02) (inboxLines[id] = inboxLines[id] || []).push(m.message);
  }
}
// the broadcast partition: heartbeats and ordinary broadcasts with runs of identical rows
const nb = ri(0, BIG ? 3000 : 400);
for (let j = 0; j < nb; j++) {
  const hb = rnd() < 0.5;
  const msg = hb ? pick(['working on x', 'working on y', 'idle']) : body(ri(1, 12)) + ' #' + (uniq++);
  const ageDays = rnd() * 150;
  const m = { from: pick(['peer-1', 'peer-2', 'primary-aaaaaaaa']), to: null, type: 'broadcast', message: msg, timestamp: Math.floor(NOW - ageDays * DAY), urgency: pick(['low', 'normal']), needsReply: false, isHeartbeat: hb };
  try { store.appendMeshMessage(st, Object.assign({}, m, { hash: store.meshMessageHash(m) })); totalRows++; } catch (_) { /* duplicate */ }
}
// the registry (with inbox paths) and broadcast cursors
for (const id of parts) {
  const inboxPath = inboxLines[id] ? path.join(ds, 'inbox', `${id}.ndjson`) : null;
  st.upsertRegistry({ id, worktreePath: `/nowhere/${id}`, sessionId: `s-${id}`, inboxPath, cursorPath: path.join(ds, 'cursors', `${id}.nd.json`), nudgeCommand: null });
  if (inboxPath) { mk(path.dirname(inboxPath)); fs.writeFileSync(inboxPath, inboxLines[id].join('\n') + '\n\n  \n'); }
  if (rnd() < 0.7) st.setBroadcastCursor(id, ri(0, nb));
}
// reader cursors: per partition a random mix
const cdir = path.join(ds, 'cursors');
mk(cdir);
const count = (id) => st.messageCount(id);
st.readerCursorTxn((tx) => {
  for (const id of parts) {
    const n = count(id);
    const shape = pick(['floor', 'floor', 'floor', 'none', 'readers']);
    if (shape !== 'none') {
      tx.put({ partition: id, ns: 'store', reader: '#floor', value: ri(0, n), updatedAt: NOW });
      tx.put({ partition: id, ns: 'nd', reader: '#floor', value: ri(0, 5), updatedAt: NOW });
    }
    if (shape === 'readers' || rnd() < 0.3) {
      for (let r = 0; r < ri(1, 3); r++) {
        const v = ri(0, n);
        const rec = { partition: id, ns: 'store', reader: `h:${1000 + r}:1700000000000`, value: v, updatedAt: NOW };
        if (rnd() < 0.4) rec.retiredLine = ri(0, n);
        tx.put(rec);
      }
    }
  }
});
for (const id of parts) {
  const n = count(id);
  if (rnd() < 0.25) st.setCursor(id, ri(0, n));
  if (rnd() < 0.2) fs.writeFileSync(path.join(cdir, `${id}.json`), String(ri(0, n)));
  if (rnd() < 0.1) fs.writeFileSync(path.join(cdir, `${id}#base.json`), JSON.stringify({ line: ri(0, n) }));
  if (rnd() < 0.1) fs.writeFileSync(path.join(cdir, `${id}#inst-abcdef.json`), String(ri(0, n)));
  if (rnd() < 0.05) fs.writeFileSync(path.join(cdir, `${id}#inst-0123ab.json`), 'garbage');
}
// earlier tombstones
const earlier = ri(0, 30);
st.close();
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(ds, 'store', hash, 'devswarm.db'));
db.exec('UPDATE messages SET body = NULL WHERE id IN (SELECT id FROM messages ORDER BY id LIMIT ' + earlier + ');');
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
// the armed state, with restore holds on some id ranges
const maxId = totalRows;
const holds = {};
if (rnd() < 0.5) holds[hash] = [{ minId: ri(1, Math.max(1, maxId)), maxId: ri(1, Math.max(1, maxId)) + 50, until: NOW + DAY, month: '2026-01' }, { minId: 1, maxId: 5, until: NOW - DAY, month: '2025-12' }];
fs.writeFileSync(path.join(ds, 'retention-state.json'), JSON.stringify({ stores: {}, holds, phase: 'armed' }));
process.stdout.write(JSON.stringify({ partitions: parts, rows: totalRows, broadcast: nb }));
