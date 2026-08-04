#!/usr/bin/env node
'use strict';
// anti-hall :: devswarm-store-leak-report — Task #6 part (b) CLI.
//
// READ-ONLY REPORT ONLY. Classifies every bucket under
// ~/.anti-hall/devswarm/store (or --home <dir>) as GARBAGE or REAL using
// companion/lib/devswarm-store-audit.js's auditStore(), then writes a JSON
// report and prints a summary. Deletes, moves, renames, and truncates
// NOTHING — there is no cleanup/fix flag on this script by design. Any
// cleanup decision belongs to the human owner reviewing this report.
//
// Usage:
//   node plugins/anti-hall/scripts/devswarm-store-leak-report.js [--home <dir>] [--out <file>] [--quiet]
//
// Exit code is always 0 (a report, never a gate) unless an internal error
// prevents producing one at all.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { auditStore } = require('../companion/lib/devswarm-store-audit.js');

function parseArgs(argv) {
  const out = { home: null, out: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') { out.home = argv[++i]; }
    else if (a === '--out') { out.out = argv[++i]; }
    else if (a === '--quiet') { out.quiet = true; }
  }
  return out;
}

function defaultOutPath() {
  // Repo-relative .anti-hall/reports/ — this whole dir is gitignored
  // (see .gitignore's blanket `.anti-hall/`), so the report never gets
  // committed or shipped; it is purely local, reviewable owner output.
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const dir = path.join(repoRoot, '.anti-hall', 'reports');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, 'devswarm-store-leak-report-' + ts + '.json');
}

function run(argv, opts) {
  const o = opts || {};
  const args = parseArgs(argv || []);
  const home = args.home || o.home || os.homedir();
  const report = auditStore({ home, fsi: o.fsi });
  const outPath = args.out || defaultOutPath();

  const F = o.fsi || fs;
  try {
    F.mkdirSync(path.dirname(outPath), { recursive: true });
    F.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  } catch (e) {
    return { ok: false, error: 'failed to write report: ' + (e && e.message), report };
  }

  if (!args.quiet) {
    const lines = [
      'devswarm store leak report (READ-ONLY — nothing deleted/moved/modified)',
      '  home:            ' + report.home,
      '  total buckets:   ' + report.total,
      '  live descriptors:' + ' ' + report.descriptorCount,
      '  REAL buckets:    ' + report.realCount,
      '  GARBAGE buckets: ' + report.garbageCount,
      '  report written:  ' + outPath,
    ];
    for (const l of lines) process.stdout.write(l + '\n');
  }

  return { ok: true, outPath, report };
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { run, defaultOutPath };
