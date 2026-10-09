'use strict';
// Snapshot (and optionally anonymise) a DevSwarm state tree into a scratch directory for the reconcile-port tests.
//   node snapshot.js <plugin-root> <src-home> <dst-home> [--anonymise] [--stores a,b,c]
// The source is only READ: stores are copied with VACUUM INTO from a read-only connection (never a raw copy of a live
// database and its -wal file); every other file is copied byte for byte (mtime kept). With --anonymise message bodies are
// replaced (the "[forwarded from archived <id>] " prefix is kept) and every hash is recomputed with Node's OWN hash functions
// (meshMessageHash / messageHash) through an old->new map, so dedupe, forwarding and orig_hash chains behave as in the original.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [root, src, dst, ...flags] = process.argv.slice(2);
if (!root || !src || !dst) { console.error('usage: snapshot.js <plugin-root> <src-home> <dst-home> [--anonymise] [--stores a,b]'); process.exit(2); }
const anon = flags.includes('--anonymise');
const only = flags.includes('--stores') ? new Set(flags[flags.indexOf('--stores') + 1].split(',')) : null;
const { DatabaseSync } = require('node:sqlite');
const { meshMessageHash } = require(path.join(root, 'companion/lib/devswarm-store.js'));
const ingest = require(path.join(root, 'companion/devswarm-ingest.js'));
const ds = '.anti-hall/devswarm';
const FWD = /^(\[forwarded from archived [^\]]*\] )/;

function copyTree(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, e.name), t = path.join(to, e.name);
    if (skip && skip(f)) continue;
    if (e.isDirectory()) copyTree(f, t, skip);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(f), t);
    else if (e.isFile()) { fs.copyFileSync(f, t); const st = fs.statSync(f); fs.utimesSync(t, st.atime, st.mtime); }
  }
}

const srcDs = path.join(src, ds), dstDs = path.join(dst, ds);
copyTree(srcDs, dstDs, (f) => f.startsWith(path.join(srcDs, 'store') + path.sep));

const storeDir = path.join(srcDs, 'store');
const report = { stores: 0, messages: 0 };
for (const hash of fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : []) {
  if (only && !only.has(hash)) continue;
  const sd = path.join(storeDir, hash), td = path.join(dstDs, 'store', hash);
  fs.mkdirSync(td, { recursive: true });
  if (fs.existsSync(path.join(sd, 'BACKEND'))) fs.copyFileSync(path.join(sd, 'BACKEND'), path.join(td, 'BACKEND'));
  const db = path.join(sd, 'devswarm.db');
  if (!fs.existsSync(db)) continue;
  const out = path.join(td, 'devswarm.db');
  const from = new DatabaseSync(db, { readOnly: true });
  from.exec('PRAGMA busy_timeout=5000;');
  from.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  from.close();
  report.stores++;
  if (!anon) continue;
  const c = new DatabaseSync(out);
  const map = new Map();
  const rows = c.prepare('SELECT * FROM messages ORDER BY rowid').all();
  const upd = c.prepare('UPDATE messages SET body=?, hash=?, orig_hash=? WHERE rowid=?');
  const cols = rows.length ? Object.keys(rows[0]) : [];
  for (const r of rows) {
    const m = FWD.exec(String(r.body)); const prefix = m ? m[1] : '';
    const rest = String(r.body).slice(prefix.length);
    const body = prefix + 'anon-' + crypto.createHash('sha1').update(rest).digest('hex').slice(0, 8);
    let hash = r.hash;
    if (typeof hash === 'string' && hash.startsWith('mesh:')) {
      hash = meshMessageHash({ from: r.sender, to: r.recipient, type: r.mtype, urgency: r.urgency, message: body, timestamp: String(r.ts), needsReply: !!r.needs_reply });
    } else if (typeof hash === 'string' && hash.startsWith('native:')) {
      hash = ingest.messageHash(r.workspace_id, { message: body, createdAt: String(r.ts) });
    }
    if (r.hash) map.set(r.hash, hash);
    r.__body = body; r.__hash = hash;
  }
  c.exec('BEGIN');
  // hashes are UNIQUE: park them first so a recomputed value never collides with a not-yet-rewritten one
  c.exec("UPDATE messages SET hash = '~' || rowid WHERE hash IS NOT NULL");
  for (const r of rows) {
    const oh = r.orig_hash && map.has(r.orig_hash) ? map.get(r.orig_hash) : r.orig_hash;
    upd.run(r.__body, r.hash == null ? null : r.__hash, oh == null ? null : oh, r.rowid !== undefined ? r.rowid : r.id);
  }
  c.exec('COMMIT');
  c.close();
  report.messages += rows.length;
  void cols;
}
console.log(JSON.stringify(report));
