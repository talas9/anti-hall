#!/usr/bin/env node
// anti-hall :: devswarm-version-refresh (background, detached)
//
// Probes the installed DevSwarm CLI version and writes
// ~/.anti-hall/devswarm-version.json = { installed, baseline, checkedAt, source }.
//
// Spawned by devswarm-version.js with { detached:true, stdio:'ignore' }.unref()
// so SessionStart returns IMMEDIATELY. This script runs entirely in the
// background; its output is irrelevant to the calling session.
//
// Strategy:
//   1. `devswarm --version` (the primary DevSwarm CLI binary name).
//   2. Fallback: `hivecontrol --version` (a thin sh shim that execs the same
//      sibling `devswarm` binary — see docs/KB-devswarm-hivecontrol.md).
//   3. If neither binary is on PATH (ENOENT) or errors (EACCES/ENOTDIR/etc.),
//      or the output is unparseable => write { installed: null, ... }. FAIL
//      OPEN AND SILENT — anti-hall must work perfectly on machines with no
//      DevSwarm installed.
//
// PARSE DEFENSIVELY: the CLI's `--version` output shape is NOT guaranteed
// stable across releases (observed live: a bare "2.5.1" this session, but
// earlier KB passes captured differing wrapper text). extractVersion() below
// prefers a full X.Y.Z token, prefers stdout over stderr, and treats AMBIGUITY
// (more than one distinct version-shaped token in the chosen stream) as
// unparseable rather than guessing — a wrong cached version is worse than no
// cached version, since it would silently suppress a real drift alarm or
// falsely trip one.
//
// Pure Node built-ins only, no dependencies. Fail-open on every error.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');
const { DEVSWARM_BASELINE } = require('./lib/devswarm-baseline.js');

const CACHE_FILE = path.join(os.homedir(), '.anti-hall', 'devswarm-version.json');
const BASELINE   = DEVSWARM_BASELINE; // single source: hooks/lib/devswarm-baseline.js

// FULL_SEMVER_RE — a full X.Y.Z token (leading 'v' optional). Preferred over
// a bare X.Y token because it is far less likely to collide with an unrelated
// number-dot-number in banner text (build numbers, dates, etc.).
const FULL_SEMVER_RE = /\bv?(\d+\.\d+\.\d+)\b/g;
// PARTIAL_SEMVER_RE — a bare X.Y token, used only when no full semver is found.
const PARTIAL_SEMVER_RE = /\bv?(\d+\.\d+)\b/g;

// extractVersion(text) -> semver-ish string | null.
//   - No match in either pass => null (unparseable).
//   - Exactly one DISTINCT full X.Y.Z token => that token.
//   - More than one DISTINCT full X.Y.Z token => null (ambiguous; guessing
//     the "first" one is exactly the bug this replaces).
//   - No full token, exactly one DISTINCT partial X.Y token => that token.
//   - No full token, more than one DISTINCT partial X.Y token => null.
//
// PURE — no I/O, exported for direct unit testing.
function extractVersion(text) {
  if (typeof text !== 'string' || !text) return null;

  const full = Array.from(new Set((text.match(FULL_SEMVER_RE) || []).map((s) => s.replace(/^v/, ''))));
  if (full.length === 1) return full[0];
  if (full.length > 1) return null; // ambiguous full matches — never guess

  const partial = Array.from(new Set((text.match(PARTIAL_SEMVER_RE) || []).map((s) => s.replace(/^v/, ''))));
  if (partial.length === 1) return partial[0];
  return null; // none, or ambiguous partial matches
}

// probeVersion(bin, spawnFn=spawnSync) -> semver-ish string | null. Runs
// `<bin> --version` and extracts a version-shaped token, preferring stdout
// over stderr (only falls back to stderr when stdout yields nothing). Never
// throws. spawnFn is injectable so tests can drive fixed stdout/stderr
// without depending on a real DevSwarm install.
function probeVersion(bin, spawnFn) {
  const run = spawnFn || spawnSync;
  try {
    const r = run(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // spawnSync sets r.error on ENOENT/EACCES/ENOTDIR (binary absent/unreachable).
    if (!r || r.error) return null;
    return extractVersion(r.stdout) || extractVersion(r.stderr);
  } catch (_) {
    return null;
  }
}

// main(opts={}) — opts.spawnFn / opts.home / opts.fsi are injectable for
// direct unit testing; production use (require.main===module) takes no args
// and uses the real spawnSync / os.homedir() / fs.
function main(opts) {
  const o = opts || {};
  const spawnFn = o.spawnFn || spawnSync;
  const F = o.fsi || fs;
  const cacheFile = o.home
    ? path.join(o.home, '.anti-hall', 'devswarm-version.json')
    : CACHE_FILE;

  let installed = probeVersion('devswarm', spawnFn);
  let source = 'devswarm';
  if (installed === null) {
    installed = probeVersion('hivecontrol', spawnFn);
    source = installed !== null ? 'hivecontrol' : null;
  }

  const data = {
    installed,      // string | null (absent/unparseable => null, fail-open)
    baseline: BASELINE,
    checkedAt: Date.now(),
    source: installed !== null ? source : null,
  };

  // Ensure cache dir exists.
  const cacheDir = path.dirname(cacheFile);
  try { F.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}

  // Atomic write: tmp file + rename avoids partial reads if a session starts
  // while we are writing.
  const tmp = cacheFile + '.tmp.' + process.pid;
  F.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  F.renameSync(tmp, cacheFile);

  return data;
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    // Fail-open silently — never crash the background child.
  }
}

module.exports = { BASELINE, extractVersion, probeVersion, main };
