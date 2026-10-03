#!/usr/bin/env node
'use strict';
// anti-hall :: coordinator-work baseline — replay a session transcript's
// main-thread Bash calls through the coordinator-work classifier and window
// (hooks/lib/coordinator-work.js) and print what F1 would have done: a
// "before" number for a session that ran without the guard.
//
// USAGE
//   node plugins/anti-hall/scripts/coordinator-work-baseline.js <transcript.jsonl> [--from-line N] [--cwd DIR] [--json]
//
// Subagent (isSidechain) entries and lines before --from-line are skipped. A
// call is posted unless its tool_result has is_error. The first collected
// call is the session start (script freshness). Known limits: $VAR paths
// resolve from THIS process's environment, a direct-exec script that no
// longer exists is not counted, and freshness uses current mtimes.
// Output: {calls, work, share, attemptedShare, wouldNudge, wouldBlock}. share is as
// recorded (no enforcement); attemptedShare is with enforcement (blocked rows not posted).
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function parseArgs(argv) {
  const o = { file: null, fromLine: 0, cwd: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--from-line') o.fromLine = Number(argv[++i]) || 0;
    else if (a === '--cwd') o.cwd = argv[++i] || null;
    else if (!o.file) o.file = a;
  }
  return o;
}

// run(argv) -> Promise<{calls, work, share, attemptedShare, wouldNudge, wouldBlock}>;
// rejects when the transcript cannot be read.
async function run(argv) {
  const o = parseArgs(argv || []);
  if (!o.file || !fs.statSync(o.file).isFile()) throw new Error('transcript not found: ' + o.file);
  const rows = [];
  const byId = new Map();
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(o.file), crlfDelay: Infinity });
  for await (const line of rl) {
    n++;
    if (n < o.fromLine) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || e.isSidechain === true) continue;
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    if (e.type === 'assistant') {
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || b.name !== 'Bash' || !b.input || typeof b.input.command !== 'string') continue;
        const row = { n: rows.length + 1, ts: e.timestamp, command: b.input.command, cwd: o.cwd || e.cwd || process.cwd(), posted: true };
        rows.push(row);
        if (b.id) byId.set(b.id, row);
      }
    } else if (e.type === 'user') {
      for (const b of content) {
        if (b && b.type === 'tool_result' && byId.has(b.tool_use_id)) byId.get(b.tool_use_id).posted = !b.is_error;
      }
    }
  }
  const lib = require(path.join(__dirname, '..', 'hooks', 'lib', 'coordinator-work.js'));
  const cg = require(path.join(__dirname, '..', 'hooks', 'command-guard.js'));
  let cfg = lib.config();
  if (!cfg.tMs) cfg = Object.assign({}, lib.DEFAULTS);
  const r = lib.replay(rows, cfg, cg.classifyBashWork);
  return { calls: r.calls, work: r.work, share: r.share, attemptedShare: r.attemptedShare, wouldNudge: r.wouldNudge, wouldBlock: r.wouldBlock };
}

function render(r) {
  const pct = (x) => (x == null ? 'n/a' : (Math.round(x * 1000) / 10) + '%');
  return 'coordinator work baseline: calls ' + r.calls + ' · work ' + r.work + ' · share ' + pct(r.share) +
    ' as recorded (no enforcement) · attempted share ' + pct(r.attemptedShare) + ' with enforcement · would nudge ' + r.wouldNudge +
    ' · would block ' + r.wouldBlock;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  run(argv).then((r) => {
    fs.writeSync(1, (argv.includes('--json') ? JSON.stringify(r) : render(r)) + '\n');
    process.exit(0);
  }, (e) => {
    fs.writeSync(2, 'coordinator-work-baseline: ' + ((e && e.message) || String(e)) + '\n');
    process.exit(1);
  });
}

module.exports = { run };
