'use strict';
// A stable text dump of everything the app sync can touch under a scratch home.
//   usage: node as_dump.js <home>
const fs = require('fs');
const path = require('path');
const home = process.argv[2];
const ds = path.join(home, '.anti-hall', 'devswarm');
const out = [];
const walk = (d) => {
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const rel = path.relative(home, p);
    if (/\.db-(wal|shm)$/.test(e.name)) continue;
    if (/\.db$/.test(e.name) || rel.includes('/locks/') || rel.includes('/cache/')) { out.push('OPAQUE ' + rel); continue; }
    let st = null;
    try { st = fs.lstatSync(p); } catch (_) { /* gone */ }
    out.push('FILE ' + rel + ' ino-shared=' + (st && st.nlink > 1 ? 'yes' : 'no'));
    try { out.push(fs.readFileSync(p, 'utf8')); } catch (_) { out.push('<unreadable>'); }
  }
};
walk(ds);
process.stdout.write(out.join('\n') + '\n');
