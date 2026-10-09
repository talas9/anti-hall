'use strict';
// A realistic split store: a sqlite store (chosen backend) that still has the old journal/*.ndjson on disk, whose messages were
// all merged into sqlite (MERGE-STATE.json recorded by Node's own merge). Plus journal-only extras when asked (merge pending).
//   usage: node rt_split.js <home> <hash> <seed> <nowMs> <nfiles> <pending 0|1>
const path = require('path');
const fs = require('fs');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const [home, hash, seedArg, nowArg, nfilesArg, pendingArg] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const NOW = Number(nowArg);
let s = Number(seedArg) >>> 0;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const DAY = 86400000;
const mk = (n, to, extra) => { const m = Object.assign({ from: 'peer-1', to, type: 'direct', message: 'm' + n + ' ' + 'x'.repeat(ri(1, 40)) + ' é日本', timestamp: NOW - ri(1, 100) * DAY, urgency: 'normal', needsReply: false }, extra || {}); return Object.assign(m, { hash: store.meshMessageHash(m) }); };
const msgs = [];
for (let i = 0; i < ri(20, 60); i++) msgs.push(mk(i, 'ws-' + ri(1, 4)));
// journal side first (forced), then the sqlite side (forced)
const j = store.openStore({ home, hash, backend: 'journal' });
for (const m of msgs) store.appendMeshMessage(j, m);
j.close();
const q = store.openStore({ home, hash, backend: 'sqlite' });
for (const m of msgs) store.appendMeshMessage(q, m);
q.close();
fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'store', hash, 'BACKEND'), 'sqlite\n');
const r = store.mergeSplitBackendStore(home, hash, {});
if (pendingArg === '1') {
  // after the merge the journal gets a message sqlite never saw: the merge is pending again, so nothing may be folded
  const jj = store.openStore({ home, hash, backend: 'journal' });
  store.appendMeshMessage(jj, mk(9999, 'ws-1'));
  jj.close();
}
process.stdout.write(JSON.stringify({ merge: { split: r.split, pending: r.pending, merged: r.messagesMerged }, files: fs.readdirSync(path.join(home, '.anti-hall', 'devswarm', 'store', hash, 'journal')), marker: store.readMergeMarker(path.join(home, '.anti-hall', 'devswarm', 'store', hash)) }));
// extra journal files the way older versions left them: odd names, blank, with a multi-byte body; mtimes spread (one fractional)
const jd = path.join(home, '.anti-hall', 'devswarm', 'store', hash, 'journal');
const extra = Number(nfilesArg) || 0;
for (let i = 0; i < extra; i++) {
  const f = path.join(jd, i % 2 ? `old-${i}.ndjson` : `ws.dot-${i}.ndjson`);
  fs.writeFileSync(f, i % 3 === 0 ? '' : '\n  \n');
  const t = (NOW - ri(1, 400) * DAY) / 1000 + (i === 1 ? 0.123456 : 0);
  fs.utimesSync(f, t, t);
}
fs.writeFileSync(path.join(jd, 'notes.txt'), 'not a journal');
