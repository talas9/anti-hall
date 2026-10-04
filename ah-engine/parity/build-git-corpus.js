#!/usr/bin/env node
// Build a git-related real-command corpus for run-git.js: node build-git-corpus.js --cmds cmds.jsonl [--n 5000] [--seed 1] > real.jsonl
// cmds.jsonl: one JSON object per line with `cmd` (and optional `cwd`); read-only, streamed.
// Half of the sample is uniform over commands that mention git, half over the "interesting" subset (push, commit,
// force flags, heredocs, runners, -c/alias use) so the risky shapes are well represented.
const fs = require('fs'), readline = require('readline');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 5000), SEED = +arg('--seed', 1);
let s = SEED >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const GIT = /\bgit\b/, HOT = /\bpush\b|\bcommit\b|--force|\s-f\b|<<|\bxargs\b|\bparallel\b|\bfind\b.*-exec|\balias\b|\bgit\s+-c\b|\beval\b|\bbash\s+-c|\bsh\s+-c|co-authored|generated with|\bgh\s+(pr|issue|release)/i;
(async () => {
  const seen = new Set(), all = [], hot = [];
  const rl = readline.createInterface({ input: fs.createReadStream(arg('--cmds')) });
  for await (const line of rl) {
    if (!line.includes('git')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (typeof o.cmd !== 'string' || !GIT.test(o.cmd) || seen.has(o.cmd)) continue;
    seen.add(o.cmd);
    const rec = { command: o.cmd, cwd: o.cwd, source: 'real' };
    all.push(rec); if (HOT.test(o.cmd)) hot.push(rec);
  }
  const pick = (arr, k) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  const out = new Map();
  for (const r of pick(hot, Math.ceil(N / 2))) out.set(r.command, r);
  for (const r of pick(all, N)) { if (out.size >= N) break; out.set(r.command, r); }
  process.stderr.write(`git-related unique: ${all.length}, interesting: ${hot.length}, sampled: ${out.size}\n`);
  for (const r of out.values()) console.log(JSON.stringify(r));
})();
