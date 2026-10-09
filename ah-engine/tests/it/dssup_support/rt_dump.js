'use strict';
// A stable text dump of everything retention can touch under a scratch home: every table of every store (all columns, in rowid or
// key order), the archive months (decompressed), the retention state (timings masked) and the retention log (timestamps masked).
//   usage: node rt_dump.js <home>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const home = process.argv[2];
const ds = path.join(home, '.anti-hall', 'devswarm');
const out = [];
const walk = (d, f) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, f); else f(p); } };
walk(path.join(ds, 'store'), (p) => {
  if (!p.endsWith('devswarm.db')) { if (!/-(wal|shm)$/.test(p)) out.push('FILE ' + path.relative(home, p) + ' ' + fs.statSync(p).size); return; }
  const db = new DatabaseSync(p, { readOnly: true });
  out.push('DB ' + path.relative(home, p));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    const order = cols.some((c) => c.pk) && cols.find((c) => c.pk).name ? cols.filter((c) => c.pk).map((c) => c.name).join(', ') : 'rowid';
    out.push('TABLE ' + t);
    for (const r of db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all()) out.push(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  }
  db.close();
});
walk(path.join(ds, 'archive'), (p) => {
  out.push('ARCHIVE ' + path.relative(ds, p));
  out.push(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
});
try {
  const st = JSON.parse(fs.readFileSync(path.join(ds, 'retention-state.json'), 'utf8'));
  for (const h of Object.keys(st.stores || {})) if (st.stores[h] && st.stores[h].vacuum) delete st.stores[h].vacuum.ms;
  out.push('STATE ' + JSON.stringify(st));
} catch (_) { out.push('STATE none'); }
try {
  for (const l of fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'devswarm-retention.ndjson'), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const o = JSON.parse(l); delete o.ts; out.push('LOG ' + JSON.stringify(o));
  }
} catch (_) { out.push('LOG none'); }
process.stdout.write(out.join('\n') + '\n');
