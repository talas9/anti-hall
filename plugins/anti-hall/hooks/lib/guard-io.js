'use strict';
// guard-io — the decision shape + CLI wrapper shared by the Bash pre/post guards.
//
// A guard exports evaluate(payload, env, opts) -> { exitCode, stdout, stderr }
// and never calls process.exit: a block is a RETURNED decision, so a surrounding
// fail-open try/catch (or an in-process dispatcher grouping several guards) cannot
// turn it into an allow. The `require.main === module` wrapper calls runCli(),
// which reads stdin, calls evaluate(), writes both streams and exits with the code.
//
//   payload  parsed stdin JSON (undefined when stdin was unreadable or not JSON)
//   env      the environment the guard reads (default process.env)
//   opts     { argv } — CLI flags such as --post / --audit (default [])
//
// fs.writeSync, not process.stdout/stderr.write: an exit right after an async pipe
// write can truncate large output on macOS.

const fs = require('fs');

function decision(exitCode, stdout, stderr) {
  return { exitCode: exitCode || 0, stdout: stdout || '', stderr: stderr || '' };
}

// Collects what a guard would write; done(code) freezes it into a decision.
function recorder() {
  const r = {
    stdout: '',
    stderr: '',
    out(s) { r.stdout += s; },
    err(s) { r.stderr += s; },
    json(o) { r.stdout += JSON.stringify(o) + '\n'; },
    done(code) { return decision(code, r.stdout, r.stderr); },
  };
  return r;
}

// The exit-2 block both hosts honor (see lib/emit-block.js): the JSON decision on
// stdout, the same reason on stderr, exit 2.
function blockDecision(reason, jsonObj) {
  const text = String(reason);
  return decision(2, JSON.stringify(jsonObj || { decision: 'block', reason: text }) + '\n', text + '\n');
}

function writeAll(fd, s) {
  if (!s) return;
  try {
    const buf = Buffer.from(s, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
  } catch (_) { /* still exit with the decision's code */ }
}

function readStdinPayload() {
  let raw;
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return undefined; }
  try { return JSON.parse(raw); } catch (_) { return undefined; }
}

// Run evaluate over stdin and exit. Fail-open: any throw is an allow.
function runCli(evaluate, opts) {
  let d;
  try {
    d = evaluate(readStdinPayload(), process.env, Object.assign({ argv: process.argv.slice(2) }, opts));
  } catch (_) { d = decision(0); }
  writeAll(1, d && d.stdout);
  writeAll(2, d && d.stderr);
  process.exit(d && d.exitCode === 2 ? 2 : 0);
}

module.exports = { decision, recorder, blockDecision, runCli };
