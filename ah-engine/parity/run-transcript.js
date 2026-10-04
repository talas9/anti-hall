#!/usr/bin/env node
// Transcript-index parity over real transcripts (X1): for each file, the engine's facts (the `transcript_facts`
// example, which reads the whole file) must equal the Node readers' facts (`transcript-facts.js`).
//   node run-transcript.js --hooks <repo>/plugins/anti-hall/hooks [--engine ../target/release/examples/transcript_facts] file.jsonl ...
// Read-only: it never writes to the transcripts. Exit code 1 when any file differs.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HOOKS = path.resolve(arg('--hooks', path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks')));
const ENGINE = path.resolve(arg('--engine', path.join(__dirname, '..', 'target', 'release', 'examples', 'transcript_facts')));
const files = process.argv.slice(2).filter((a, i, v) => !a.startsWith('--') && (i === 0 || !['--hooks', '--engine'].includes(v[i - 1])));
if (!files.length) { console.log('SKIPPED: no corpus (pass transcript file paths); nothing was compared'); process.exit(0); }
let bad = 0;
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const run = (cmd, args) => { const r = cp.spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30 }); if (r.status !== 0) throw new Error(cmd + ' failed: ' + r.stderr); return JSON.parse(r.stdout); };
for (const f of files) {
  const t0 = Date.now();
  const node = run('node', [path.join(__dirname, 'transcript-facts.js'), f, '--hooks', HOOKS]);
  const t1 = Date.now();
  const eng = run(ENGINE, [f]);
  const t2 = Date.now();
  if (node.last_prompt === undefined) delete eng.last_prompt;
  const diff = Object.keys(eng).filter((k) => canon(eng[k]) !== canon(node[k]));
  if (diff.length) { bad++; console.log('DIFF', f, diff.join(',')); for (const k of diff) console.log('  ', k, 'engine=', JSON.stringify(eng[k]).slice(0, 200), 'node=', JSON.stringify(node[k]).slice(0, 200)); }
  else console.log('same', (fs.statSync(f).size / 1048576).toFixed(1) + 'MB', 'records=' + eng.records, 'node ' + (t1 - t0) + 'ms engine ' + (t2 - t1) + 'ms', f);
}
console.log(files.length - bad + '/' + files.length + ' transcripts identical');
process.exit(bad ? 1 : 0);
