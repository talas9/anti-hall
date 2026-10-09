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
  let file = null, ln = 0, skipFile = false;
  const skipRes = cfg.privacy.skip_paths.map((p) => new RegExp(p));
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) { file = row.startsWith('+++ b/') ? row.slice(6) : null; skipFile = file !== null && skipRes.some((r) => r.test(file)); continue; }
    const h = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { ln = Number(h[1]); continue; }
    if (!file || row.startsWith('---')) continue;
    if (row.startsWith('+')) {
      if (!skipFile) {
        for (const x of L.privacyScan(row.slice(1), cfg, deny)) hits.push({ rule: x.rule, file, line: ln });
      }
      ln++;
    } else if (!row.startsWith('-')) ln++;
  }
  return hits;
}

// m***@t*** : first char of the local part and of the domain, rest hidden.
function maskEmail(e) {
  const [l, d = ''] = String(e).split('@');
  return `${l.slice(0, 1)}***@${d.slice(0, 1)}***`;
}

function emailAllowed(email, allow) {
  const e = String(email).trim().toLowerCase();
  return allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*@') ? e.endsWith(p.slice(1)) && e.length > p.length - 1 : e === p;
  });
}

// log: output of `git log --format=%H%x09%ae%x09%ce`; returns one finding per commit with a bad email.
// Rows may carry author/committer epoch seconds (%at, %ct) as fields 4 and 5; a commit whose two
// dates are both before cfg.privacy.identity_check_since is grandfathered. Returns the hits array,
// with a non-enumerable .grandfathered count.
function identityHits(log, cfg) {
  const allow = cfg.privacy.commit_email_allow || [];
  const since = cfg.privacy.identity_check_since ? Date.parse(cfg.privacy.identity_check_since) / 1000 : NaN;
  const hits = [];
  let old = 0;
  Object.defineProperty(hits, 'grandfathered', { get: () => old });
  for (const row of log.split('\n')) {
    if (!row.trim()) continue;
    const [sha, ae = '', ce = '', at = '', ct = ''] = row.split('\t');
    if (!Number.isNaN(since) && at !== '' && ct !== '' && Number(at) < since && Number(ct) < since) { old++; continue; }
    for (const e of [...new Set([ae, ce])]) {
      if (!emailAllowed(e, allow)) hits.push({ rule: 'commit-identity', sha, msg: `commit ${sha.slice(0, 10)} authored as ${maskEmail(e)}; re-author as the maintainer identity` });
    }
  }
  return hits;
}

function main() {
  const [base, head] = process.argv.slice(2);
  const cfg = L.loadConfig();
  const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=AMR', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const hits = scan(diff, cfg, process.env.PRIVATE_DENYLIST);
  const ids = identityHits(execFileSync('git', ['log', '--format=%H%x09%ae%x09%ce%x09%at%x09%ct', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), cfg);
  console.log(`${ids.grandfathered} historical commits grandfathered (before ${cfg.privacy.identity_check_since || 'n/a'})`);
  for (const i of ids) {
    console.log(`::error::${i.msg}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| privacy | ${i.msg} |\n`);
    hits.push({ rule: i.rule, file: '(commit)', line: 0 });
  }
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
module.exports = { scan, identityHits, maskEmail, emailAllowed };
