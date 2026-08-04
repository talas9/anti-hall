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
// HARDENING (P0 fix): the containment check canonicalizes both the store
// root and the --out target via realpathSync of the nearest EXISTING
// ancestor before comparing — a lexical path.resolve/path.relative check
// alone is bypassable by a symlink whose target lands inside the store, or
// (on a case-insensitive filesystem) by a differently-cased alias of a path
// under the store. The actual write is also TOCTOU-safe: a brand-new report
// is always created with the 'wx' flag (O_EXCL — fails if the path already
// exists); only on EEXIST do we consider overwriting, and only when the
// existing file carries the distinctive `_antihallLeakReport: true` marker
// (not just "looks like an audit report" by generic shape) — containment is
// re-validated again immediately before that overwrite.
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

// REPORT_MARKER — the distinctive field every report this tool writes
// carries. Recognizing "a prior report from this tool" now requires this
// exact marker, not merely 4 generic shape-shaped fields (home/total/
// garbage/real) that any unrelated JSON file could coincidentally have.
const REPORT_MARKER = '_antihallLeakReport';

// isPriorReport(parsed) -> true only when `parsed` carries the distinctive
// marker this tool stamps into every report it writes. An existing file at
// --out is only ever eligible for overwrite when this is true.
function isPriorReport(parsed) {
  return !!(parsed && typeof parsed === 'object' && parsed[REPORT_MARKER] === true);
}

// nearestExistingAncestor(p, fsi) -> the closest path at or above `p`
// (inclusive of `p` itself) that exists on disk, or null if nothing along
// that chain exists. Used to canonicalize a path whose leaf may not exist
// yet (a fresh --out target) — realpathSync requires an existing path.
function nearestExistingAncestor(p, fsi) {
  const F = fsi || fs;
  let cur = p;
  for (;;) {
    try { F.lstatSync(cur); return cur; } catch (_) { /* keep climbing */ }
    const parent = path.dirname(cur);
    if (parent === cur) return null; // reached filesystem root; nothing exists
    cur = parent;
  }
}

// canonicalPath(p, fsi) -> the realpath-resolved form of `p`, closing BOTH
// the symlink-into-store bypass (an ancestor directory that is itself a
// symlink pointing inside the store) and the case-alias bypass on a
// case-insensitive filesystem (realpathSync returns the on-disk canonical
// casing). Falls back to the plain resolved path when nothing on the chain
// exists yet (nothing to canonicalize) or realpathSync itself fails.
function canonicalPath(p, fsi) {
  const F = fsi || fs;
  const resolved = path.resolve(p);
  const ancestor = nearestExistingAncestor(resolved, F);
  if (ancestor == null) return resolved;
  let realAncestor;
  try { realAncestor = F.realpathSync(ancestor); } catch (_) { return resolved; }
  const suffix = path.relative(ancestor, resolved);
  return suffix === '' ? realAncestor : path.join(realAncestor, suffix);
}

// validateOutPath(outPath, home, fsi) -> { ok: true, resolved, storeRootCanonical } | { ok: false, error }
//
// --out is user-controlled and reaches writeFileSync, so an unconstrained
// path could OVERWRITE/TRUNCATE a production devswarm.db (or any other file)
// if pointed there. This is a REPORT tool — it must never be usable as a
// destructive-write primitive against the store it is reporting on, or
// against any file that isn't clearly its own prior output. Refuses when the
// CANONICAL (realpath-resolved) target:
//   (a) resolves anywhere under the CANONICAL devswarm store root (same root
//       the audit lib itself derives: devswarmRoot(home) from liveness.js —
//       computed against the SAME `home` this run is auditing, so a
//       synthetic-home test run is validated against ITS synthetic root,
//       never the real machine home unless that is genuinely the home in
//       use);
//   (b) does not end in `.json`.
// An existing non-file at the target (dir/socket/…) is also rejected here as
// an early, non-authoritative UX check — the AUTHORITATIVE decision on
// whether an existing *file* may be overwritten is made at write time (wx +
// EEXIST + marker + immediate re-validate; see writeReport) to close the
// check/use TOCTOU window.
function validateOutPath(outPath, home, fsi) {
  const F = fsi || fs;
  const resolved = path.resolve(outPath);
  const storeRootRaw = path.resolve(devswarmRoot(home));
  const storeRootCanonical = canonicalPath(storeRootRaw, F);
  const outCanonical = canonicalPath(resolved, F);

  if (isPathUnder(outCanonical, storeRootCanonical)) {
    return { ok: false, error: 'refusing to write --out inside the devswarm store root (' + storeRootCanonical + '): ' + resolved + (outCanonical !== resolved ? ' (canonicalizes to ' + outCanonical + ')' : '') };
  }
  if (path.extname(resolved).toLowerCase() !== '.json') {
    return { ok: false, error: 'refusing to write --out to a non-.json path: ' + resolved };
  }
  let existingLstat = null;
  try { existingLstat = F.lstatSync(resolved); } catch (_) { existingLstat = null; }
  if (existingLstat && !existingLstat.isFile()) {
    return { ok: false, error: 'refusing to write --out to an existing non-file path: ' + resolved };
  }
  return { ok: true, resolved, storeRootCanonical };
}

// writeReport(resolved, storeRootCanonical, payload, fsi) -> { ok: true } | { ok: false, error }
//
// TOCTOU-safe write: always attempts a brand-new file first via 'wx'
// (O_EXCL — fails if the path already exists). Only on EEXIST do we consider
// overwriting, and only when the existing file is itself a prior report from
// this tool (REPORT_MARKER, checked above) — containment is re-validated
// immediately before that overwrite, since the target could in principle
// have been swapped (e.g. for a symlink into the store) between the earlier
// validateOutPath check and now.
function writeReport(resolved, storeRootCanonical, payload, fsi) {
  const F = fsi || fs;
  const data = JSON.stringify(payload, null, 2) + '\n';
  try {
    F.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (e) {
    return { ok: false, error: 'failed to create --out directory: ' + (e && e.message) };
  }
  try {
    F.writeFileSync(resolved, data, { flag: 'wx' });
    return { ok: true };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') {
      return { ok: false, error: 'failed to write report: ' + (e && e.message) };
    }
  }
  let existingLstat = null;
  try { existingLstat = F.lstatSync(resolved); } catch (e2) {
    return { ok: false, error: 'failed to stat existing --out path: ' + (e2 && e2.message) };
  }
  if (!existingLstat.isFile()) {
    return { ok: false, error: 'refusing to write --out to an existing non-file path: ' + resolved };
  }
  let parsed = null;
  try { parsed = JSON.parse(F.readFileSync(resolved, 'utf8')); } catch (_) { parsed = null; }
  if (!isPriorReport(parsed)) {
    return { ok: false, error: 'refusing to overwrite an existing file at --out that is not a prior devswarm-store-leak-report JSON report (missing ' + REPORT_MARKER + ' marker): ' + resolved };
  }
  const recheckCanonical = canonicalPath(resolved, F);
  if (isPathUnder(recheckCanonical, storeRootCanonical)) {
    return { ok: false, error: 'refusing to write --out inside the devswarm store root (' + storeRootCanonical + '): ' + resolved };
  }
  try {
    F.writeFileSync(resolved, data);
    return { ok: true };
  } catch (e3) {
    return { ok: false, error: 'failed to write report: ' + (e3 && e3.message) };
  }
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
  report[REPORT_MARKER] = true;

  const writeResult = writeReport(validation.resolved, validation.storeRootCanonical, report, F);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, report };
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
    if (report.storeEnumerationError) {
      lines.push('  WARNING: store-root enumeration FAILED (' + report.storeEnumerationError + ') — total/bucket counts above are NOT a confident zero-leak result.');
    }
    for (const l of lines) process.stdout.write(l + '\n');
  }

  return { ok: true, outPath: validation.resolved, report };
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { run, defaultOutPath, validateOutPath, writeReport, canonicalPath, isPriorReport, REPORT_MARKER };
