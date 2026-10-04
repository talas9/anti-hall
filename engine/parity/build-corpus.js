#!/usr/bin/env node
// Build parity/corpus.jsonl: {id, rule, command, source}. Usage:
//   node build-corpus.js --cmds <cmds.jsonl> [--tests <repo>/tests/hooks] [--cap 250] > corpus.jsonl
// cmds.jsonl: one JSON object per line with a `cmd` field (real Bash commands; read only, streamed).
const fs = require('fs'), path = require('path'), readline = require('readline');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CAP = +arg('--cap', 250);
const RULES = {
  'git-force-push': { rel: /\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*(--force|\s-[a-zA-Z]*f|\s\+\S)/, benign: /^\s*git\s+push\b/ },
  'git-ai-credit': { rel: /\bgit\b[^\n]*\bcommit\b[\s\S]*(co-authored-by|generated with)/i, benign: /^\s*git\s+commit\b/ },
  'rm-rf-root-home': { rel: /\brm\s+(-\S+\s+)*-\S*[rR]\S*\s+(--\s+)?(\/|~|\$HOME)\/?(\s|$)/, benign: /^\s*rm\s+-\S*r/ },
};
const out = {}, seen = new Set();
for (const r of Object.keys(RULES)) out[r] = { hit: [], benign: [] };
const add = (rule, kind, command, source) => {
  const b = out[rule][kind];
  if (command.length > 400 || seen.has(rule + kind + command)) return;
  seen.add(rule + kind + command);
  if (b.length < CAP) b.push({ rule, command, source, expect_relevant: kind === 'hit' });
};
const classify = (cmd, source) => {
  for (const [rule, d] of Object.entries(RULES)) {
    if (d.rel.test(cmd)) add(rule, 'hit', cmd, source);
    else if (d.benign.test(cmd)) add(rule, 'benign', cmd, source);
  }
};
(async () => {
  const tests = arg('--tests');
  if (tests) for (const f of fs.readdirSync(tests).filter(f => /^(git-guard|command-guard).*\.test\.js$/.test(f))) {
    const src = fs.readFileSync(path.join(tests, f), 'utf8');
    // plain single-line quoted literals that start with git/rm (escapes are left as written, so tricky
    // multi-line fixtures are skipped rather than mis-decoded)
    for (const m of src.matchAll(/(['"`])((?:git|rm)\s[^'"`\\\n]*)\1/g)) classify(m[2], 'node-tests:' + f);
  }
  const cmds = arg('--cmds');
  if (cmds) {
    const rl = readline.createInterface({ input: fs.createReadStream(cmds) });
    for await (const line of rl) {
      if (!line || !/git|rm /.test(line)) continue;
      try { const o = JSON.parse(line); if (typeof o.cmd === 'string') classify(o.cmd, 'real-corpus'); } catch {}
    }
  }
  let n = 0;
  for (const r of Object.values(out)) for (const e of [...r.hit, ...r.benign]) console.log(JSON.stringify({ id: ++n, ...e }));
})();
