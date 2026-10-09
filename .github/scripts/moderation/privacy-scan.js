'use strict';
// privacy-scan.yml helper: privacy rules over the lines ADDED between two commits.
// Usage: node privacy-scan.js <base> <head>   (run in the scanned checkout; this file and the
// rules come from the default branch). Prints rule + file:line only, never the value. Exit 1 on a hit.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');

function scan(diff, cfg, deny) {
  const hits = [];
  let file = null, ln = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) { file = row.startsWith('+++ b/') ? row.slice(6) : null; continue; }
    const h = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { ln = Number(h[1]); continue; }
    if (!file || row.startsWith('---')) continue;
    if (row.startsWith('+')) {
      if (!cfg.privacy.skip_paths.some((p) => new RegExp(p).test(file))) {
        for (const x of L.privacyScan(row.slice(1), cfg, deny)) hits.push({ rule: x.rule, file, line: ln });
      }
      ln++;
    } else if (!row.startsWith('-')) ln++;
  }
  return hits;
}

function main() {
  const [base, head] = process.argv.slice(2);
  const cfg = L.loadConfig();
  const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=AMR', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const hits = scan(diff, cfg, process.env.PRIVATE_DENYLIST);
  const sum = process.env.GITHUB_STEP_SUMMARY;
  for (const h of hits.slice(0, cfg.privacy.max_hits_reported)) {
    console.log(`::error file=${h.file},line=${h.line}::privacy rule "${h.rule}" (value not shown)`);
    if (sum) fs.appendFileSync(sum, `| privacy | ${h.rule} at \`${h.file}:${h.line}\` |\n`);
  }
  if (process.env.RUNNER_TEMP) {
    fs.appendFileSync(path.join(process.env.RUNNER_TEMP, 'privacy-scan-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), workflow: 'privacy-scan', event: process.env.GITHUB_EVENT_NAME || '', item: `${base.slice(0, 8)}..${head.slice(0, 8)}`, verdict: hits.length ? 'fail' : 'pass', hits: hits.length, rules: [...new Set(hits.map((h) => h.rule))], denylist: process.env.PRIVATE_DENYLIST ? 'set' : 'unset', provider: 'none' }) + '\n');
  }
  console.log(`${hits.length} privacy hit(s); deny-list ${process.env.PRIVATE_DENYLIST ? 'set' : 'unset (rule skipped)'}`);
  process.exitCode = hits.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { scan };
