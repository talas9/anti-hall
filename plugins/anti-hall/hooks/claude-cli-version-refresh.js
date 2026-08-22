#!/usr/bin/env node
// anti-hall :: claude-cli-version-refresh (background, detached)
//
// Probes the installed Claude Code CLI version and writes
// ~/.anti-hall/claude-cli-version.json = { installed, baseline, checkedAt, source }.
//
// Spawned by claude-cli-version.js with { detached:true, stdio:'ignore' }.unref()
// so SessionStart returns IMMEDIATELY. Runs entirely in the background.
//
// Strategy: `claude --version`. If the binary is not on PATH (ENOENT) or
// errors, or the output is unparseable => write { installed: null, ... }.
// FAIL OPEN AND SILENT.
//
// PARSE DEFENSIVELY (same approach as devswarm-version-refresh.js): prefer a
// full X.Y.Z token, prefer stdout over stderr, and treat ambiguity (more than
// one distinct version-shaped token) as unparseable rather than guessing.
//
// Pure Node built-ins only, no dependencies. Fail-open on every error.

'use strict';

const { spawnSync } = require('child_process');
const { cacheFilePath, atomicWriteJSON } = require('./lib/drift-baseline.js');
const { CLAUDE_CLI_BASELINE } = require('./lib/claude-cli-baseline.js');

const CACHE_FILE = cacheFilePath('claude-cli-version.json');
const BASELINE = CLAUDE_CLI_BASELINE;

const FULL_SEMVER_RE = /\bv?(\d+\.\d+\.\d+)\b/g;
const PARTIAL_SEMVER_RE = /\bv?(\d+\.\d+)\b/g;

// extractVersion(text) -> semver-ish string | null. PURE — exported for
// direct unit testing. See devswarm-version-refresh.js's twin for the full
// rationale (never guess on ambiguous matches).
function extractVersion(text) {
  if (typeof text !== 'string' || !text) return null;

  const full = Array.from(new Set((text.match(FULL_SEMVER_RE) || []).map((s) => s.replace(/^v/, ''))));
  if (full.length === 1) return full[0];
  if (full.length > 1) return null;

  const partial = Array.from(new Set((text.match(PARTIAL_SEMVER_RE) || []).map((s) => s.replace(/^v/, ''))));
  if (partial.length === 1) return partial[0];
  return null;
}

// probeVersion(bin, spawnFn=spawnSync) -> semver-ish string | null. Never
// throws. spawnFn injectable for tests.
function probeVersion(bin, spawnFn) {
  const run = spawnFn || spawnSync;
  try {
    const r = run(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!r || r.error) return null;
    return extractVersion(r.stdout) || extractVersion(r.stderr);
  } catch (_) {
    return null;
  }
}

// main(opts={}) — opts.spawnFn / opts.cacheFile are injectable for direct
// unit testing; production use (require.main===module) takes no args.
function main(opts) {
  const o = opts || {};
  const spawnFn = o.spawnFn || spawnSync;
  const cacheFile = o.cacheFile || CACHE_FILE;

  const installed = probeVersion('claude', spawnFn);

  const data = {
    installed,      // string | null (absent/unparseable => null, fail-open)
    baseline: BASELINE,
    checkedAt: Date.now(),
    source: installed !== null ? 'claude' : null,
  };

  atomicWriteJSON(cacheFile, data);

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
