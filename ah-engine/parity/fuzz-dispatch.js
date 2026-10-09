#!/usr/bin/env node
// Combination fuzz for the dispatcher (D58): writes a fake hook, a fallback map that points every non-built-in
// Bash PreToolUse entry at it, and a corpus whose commands tell each fake hook what to print and exit with. Run the
// result through run-dispatch.js (which applies the map on both sides) to compare the dispatcher's combination with
// the reference model on outputs the real guards rarely produce together.
//   node fuzz-dispatch.js --out <dir> [--n 3000] [--seed 1]
//   node run-dispatch.js --plugin <plugin> --corpus <dir>/corpus.jsonl --fallback-map <dir>/map.json
'use strict';
const fs = require('fs'), path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out')), N = +arg('--n', 3000);
let seed = +arg('--seed', 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
fs.mkdirSync(OUT, { recursive: true });
// git-guard is answered by the built-in check; the command text below is never a git command, so it says nothing.
const IDS = ['compact-declaration-guard', 'command-guard', 'coordinator-work-guard', 'merge-side-pick', 'merge-gate', 'scan-throttle', 'api-guard', 'ship-it-guard'];
const fake = path.join(OUT, 'fake-hook.js');
fs.writeFileSync(fake, `const id = process.argv[2]; let raw = ''; process.stdin.on('data', d => raw += d).on('end', () => {
  let spec = {}; try { spec = JSON.parse(JSON.parse(raw).tool_input.command.slice(5))[id] || {}; } catch {}
  if (spec.out) process.stdout.write(spec.out); if (spec.err) process.stderr.write(spec.err);
  process.exitCode = spec.code || 0; });\n`);
const map = { PreToolUse: Object.fromEntries(IDS.map(id => [id, `node "${fake}" ${id}`])) };
fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(map));
const texts = ['plain words', 'quote " and \\\\ backslash', 'line1\nline2', 'tab\there', 'unicode é ✓   sep', '', 'ctl \u0001 char', '{"looks":"json"}'];
const hso = (o) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }) + '\n';
const kinds = [
  () => ({}),
  () => ({}),
  () => ({ out: hso({ additionalContext: pick(texts) }) }),
  () => ({ out: hso({ additionalContext: pick(texts) }) }),
  () => ({ out: JSON.stringify({ systemMessage: pick(texts) }) + '\n' }),
  () => ({ out: JSON.stringify({ systemMessage: pick(texts), hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: pick(texts) } }) + '\n' }),
  () => ({ code: 2, err: pick(texts) + '\n' }),
  () => { const r = pick(texts); return { code: 2, out: JSON.stringify({ decision: 'block', reason: r }) + '\n', err: r + '\n' }; },
  () => ({ out: JSON.stringify({ decision: 'block', reason: pick(texts) }) + '\n' }),
  () => ({ out: hso({ permissionDecision: pick(['allow', 'ask', 'defer', 'deny']), permissionDecisionReason: pick(texts) }) }),
  () => ({ out: hso({ permissionDecision: pick(['allow', 'ask']) }) }),
  () => ({ out: pick(texts) }),
  () => ({ code: 1, err: 'boom\n' }),
  () => ({ out: JSON.stringify({ continue: pick([true, false]) }) + '\n' }),
  () => ({ out: JSON.stringify({ hookSpecificOutput: { hookEventName: pick(['PreToolUse', 'PostToolUse']), additionalContext: 'x' } }) + '\n' }),
  () => ({ out: hso({ updatedInput: { command: pick(texts), b: 1, a: [1, { z: 2, y: 3 }] }, permissionDecision: 'allow' }) }),
  () => ({ err: 'stderr only at exit 0\n' }),
];
const lines = [];
for (let i = 0; i < N; i++) {
  const spec = {};
  const k = 1 + Math.floor(rnd() * 4);
  for (let j = 0; j < k; j++) spec[pick(IDS)] = pick(kinds)();
  lines.push(JSON.stringify({ command: 'echo ' + JSON.stringify(spec), source: 'fuzz-dispatch' }));
}
fs.writeFileSync(path.join(OUT, 'corpus.jsonl'), lines.join('\n') + '\n');
console.log(`wrote ${N} cases, ${fake}, map.json and corpus.jsonl to ${OUT}`);
