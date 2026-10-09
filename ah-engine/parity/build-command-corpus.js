#!/usr/bin/env node
// Build a real-command corpus for run-command.js: node build-command-corpus.js --cmds cmds.jsonl [--n 20000] [--seed 1] > real.jsonl
// cmds.jsonl: one JSON object per line with `cmd` (and optional `cwd`, `sub`); read-only, streamed.
// Half of the sample is uniform over all unique commands, half over the shapes command-guard judges (heavy verbs and
// patterns, writes, inline code, cloud CLIs, DevSwarm and stash) so the decisive paths are well represented.
const fs = require('fs'), readline = require('readline');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 20000), SEED = +arg('--seed', 1);
let s = SEED >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const HOT = /\b(npm|npx|pnpm|yarn|pytest|jest|vitest|cargo|go|make|docker|gcloud|gh|kubectl|sqlite3|node|python3?|perl|ruby|tee|sed|cp|mv|eval|bash|sh|timeout|xargs)\b|[<>]|\$\(|`|<<|\bgit\s+(push|pull|fetch|clone)|stash|devswarm|hivecontrol/;
(async () => {
  const seen = new Set(), all = [], hot = [];
  const rl = readline.createInterface({ input: fs.createReadStream(arg('--cmds')) });
  for await (const line of rl) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (typeof o.cmd !== 'string' || seen.has(o.cmd)) continue;
    seen.add(o.cmd);
    const rec = { command: o.cmd, cwd: o.cwd, sub: !!o.sub, source: 'real' };
    all.push(rec); if (HOT.test(o.cmd)) hot.push(rec);
  }
  const pick = (arr, k) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  const out = new Map();
  for (const r of pick(hot, Math.ceil(N / 2))) out.set(r.command, r);
  for (const r of pick(all, N)) { if (out.size >= N) break; out.set(r.command, r); }
  process.stderr.write(`unique: ${all.length}, judged shapes: ${hot.length}, sampled: ${out.size}\n`);
  for (const r of out.values()) console.log(JSON.stringify(r));
})();
