'use strict';
// Extra fixtures on a seeded retention home.
//   node rt_extra.js dry-state <home> [withReport]      -> state back to the first-run phase (optionally a half-done report)
//   node rt_extra.js archive <home> <seed> <nowMs> <n>   -> n archive month files (and odd legacy ones) of varied size and age
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const [mode, home, a, b, c] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const ds = path.join(home, '.anti-hall', 'devswarm');
if (mode === 'dry-state') {
  const p = path.join(ds, 'retention-state.json');
  const st = JSON.parse(fs.readFileSync(p, 'utf8'));
  st.phase = 'dry-run';
  fs.writeFileSync(p, JSON.stringify(st));
  if (a === 'withReport') {
    const first = fs.readdirSync(path.join(ds, 'store'))[0];
    fs.writeFileSync(path.join(ds, 'retention-dry-run.json'), JSON.stringify({ startedAt: 1700000000000, stores: { [first]: { ok: true, hash: first, skipped: null, error: null, dryRun: true, mbBefore: 0, mbAfter: 0, rows: 1, alreadyTombstoned: 0, ageCandidates: 0, sizeCandidates: 0, candidateMB: 0, tombstoned: 0, overLimit: false, overLimitProtected: false, vacuum: null, budgetExhausted: false, protected: {}, legacy: null } } }));
  }
} else if (mode === 'archive') {
  let s = Number(a) >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const ri = (x, y) => x + Math.floor(rnd() * (y - x + 1));
  const NOW = Number(b);
  const n = Number(c);
  const stores = fs.readdirSync(path.join(ds, 'store'));
  for (let i = 0; i < n; i++) {
    const store = stores[i % stores.length];
    const dir = path.join(ds, 'archive', store);
    fs.mkdirSync(dir, { recursive: true });
    const y = 2024 + ri(0, 1);
    const m = String(ri(1, 12)).padStart(2, '0');
    const kind = rnd() < 0.25 ? 'legacy' : 'month';
    const name = kind === 'month' ? `${y}-${m}.ndjson.gz` : `old-${i}-${ri(1, 1e6)}.ndjson.gz`;
    const target = kind === 'month' ? dir : path.join(dir, 'legacy-journal');
    fs.mkdirSync(target, { recursive: true });
    const lines = [];
    for (let k = 0; k < ri(1, 40); k++) lines.push(JSON.stringify({ id: k + 1, body: 'archived body ' + k + ' é日本 ' + 'z'.repeat(ri(0, 200)) }));
    const f = path.join(target, name);
    if (fs.existsSync(f)) continue;
    fs.writeFileSync(f, zlib.gzipSync(lines.join('\n') + '\n'));
    const t = (NOW - ri(1, 900) * 86400000) / 1000 + (rnd() < 0.3 ? 0.5 : 0);
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(ds, 'archive', 'README.txt'), 'not an archive file');
}
