#!/usr/bin/env node
'use strict';
// anti-hall :: devswarm-store-leak-report — Task #6 part (b) CLI.
//
// READ-ONLY REPORT ONLY. Classifies every bucket under
// ~/.anti-hall/devswarm/store (or --home <dir>) as REAL, UNKNOWN, or GARBAGE
// using companion/lib/devswarm-store-audit.js's auditStore(), then writes a
// JSON report and prints a summary. Deletes, moves, renames, and truncates
// NOTHING — there is no cleanup/fix flag on this script by design. Any
// cleanup decision belongs to the human owner reviewing this report.
//
// --out SAFETY: --out is validated (validateOutPath) before anything is
// written. The run REFUSES (non-zero exit, nothing written) when the
// resolved path resolves under the devswarm store root, does not end in
// `.json`, or would overwrite an existing file that isn't itself a prior
// JSON report from this tool — --out must never become a way to
// overwrite/truncate a production devswarm.db or any unrelated file.
//
// Usage:
//   node plugins/anti-hall/scripts/devswarm-store-leak-report.js [--home <dir>] [--out <file>] [--quiet]
//
// Exit code is always 0 (a report, never a gate) unless an internal error
// prevents producing one at all, OR --out fails validation (non-zero).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { auditStore } = require('../companion/lib/devswarm-store-audit.js');
const { devswarmRoot } = require('../companion/lib/liveness.js');

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

// isPathUnder(child, parent) -> true if resolved `child` is `parent` itself
// or lives anywhere beneath it. Both must already be path.resolve()d.
function isPathUnder(child, parent) {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

// looksLikeAuditReport(parsed) -> true when `parsed` has the shape
// auditStore() produces (see devswarm-store-audit.js), so an existing file
// at --out can be recognized as a PRIOR report from this same tool (safe to
// overwrite on a re-run) rather than an arbitrary file we'd otherwise clobber.
function looksLikeAuditReport(parsed) {
  return !!(
    parsed && typeof parsed === 'object' &&
    typeof parsed.home === 'string' &&
    typeof parsed.total === 'number' &&
    Array.isArray(parsed.garbage) &&
    Array.isArray(parsed.real)
  );
}

// validateOutPath(outPath, home, fsi) -> { ok: true, resolved } | { ok: false, error }
//
// --out is user-controlled and reaches writeFileSync, so an unconstrained
// path could OVERWRITE/TRUNCATE a production devswarm.db (or any other file)
// if pointed there. This is a REPORT tool — it must never be usable as a
// destructive-write primitive against the store it is reporting on, or
// against any file that isn't clearly its own prior output. Refuses when the
// resolved path:
//   (a) resolves anywhere under the devswarm store root (same root the audit
//       lib itself derives: devswarmRoot(home) from liveness.js — computed
//       against the SAME `home` this run is auditing, so a synthetic-home
//       test run is validated against ITS synthetic root, never the real
//       machine home unless that is genuinely the home in use);
//   (b) does not end in `.json`;
//   (c) points at an existing file that does not itself look like a prior
//       JSON report from this tool.
function validateOutPath(outPath, home, fsi) {
  const F = fsi || fs;
  const resolved = path.resolve(outPath);
  const storeRoot = path.resolve(devswarmRoot(home));
  if (isPathUnder(resolved, storeRoot)) {
    return { ok: false, error: 'refusing to write --out inside the devswarm store root (' + storeRoot + '): ' + resolved };
  }
  if (path.extname(resolved).toLowerCase() !== '.json') {
    return { ok: false, error: 'refusing to write --out to a non-.json path: ' + resolved };
  }
  let existingStat = null;
  try { existingStat = F.statSync(resolved); } catch (_) { existingStat = null; }
  if (existingStat && existingStat.isFile()) {
    let parsed = null;
    try { parsed = JSON.parse(F.readFileSync(resolved, 'utf8')); } catch (_) { parsed = null; }
    if (!looksLikeAuditReport(parsed)) {
      return { ok: false, error: 'refusing to overwrite an existing file at --out that is not a prior devswarm-store-leak-report JSON report: ' + resolved };
    }
  } else if (existingStat) {
    // Exists but is not a plain file (dir, socket, symlink to non-file, …).
    return { ok: false, error: 'refusing to write --out to an existing non-file path: ' + resolved };
  }
  return { ok: true, resolved };
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
  const F = o.fsi || fs;
  const outPath = args.out || defaultOutPath();

  const validation = validateOutPath(outPath, home, F);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const report = auditStore({ home, fsi: o.fsi });

  try {
    F.mkdirSync(path.dirname(validation.resolved), { recursive: true });
    F.writeFileSync(validation.resolved, JSON.stringify(report, null, 2) + '\n');
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
      '  UNKNOWN buckets: ' + report.unknownCount,
      '  report written:  ' + validation.resolved,
    ];
    for (const l of lines) process.stdout.write(l + '\n');
  }

  return { ok: true, outPath: validation.resolved, report };
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { run, defaultOutPath, validateOutPath };
