#!/usr/bin/env node
// anti-hall :: version-alert-refresh (background, detached)
//
// Fetches the latest anti-hall release tag from GitHub and writes
// ~/.anti-hall/version-check.json = { latest, checkedAt }.
//
// Spawned by version-alert.js with { detached:true, stdio:'ignore' }.unref()
// so SessionStart returns IMMEDIATELY. This script runs entirely in the
// background; its output is irrelevant to the calling session.
//
// Strategy:
//   1. git ls-remote --tags https://github.com/talas9/anti-hall (live network)
//   2. Fallback: git ls-remote --tags origin  (local marketplace clone, no net)
//   3. If both fail (git absent, no network, no clone) => no-op, no cache write.
// The highest vX.Y.Z tag found is stored. Write is atomic (tmp + rename).
//
// Pure Node built-ins only, no dependencies. Fail-open on every error.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const CACHE_FILE    = path.join(os.homedir(), '.anti-hall', 'version-check.json');
const REMOTE_URL    = 'https://github.com/talas9/anti-hall';
const LOCAL_CLONE   = path.join(
  os.homedir(), '.claude', 'plugins', 'marketplaces', 'anti-hall'
);

// Parse git ls-remote --tags output, return highest vX.Y.Z tag or null.
function parseHighestTag(output) {
  const tags = [];
  for (const line of (output || '').split('\n').map((l) => l.replace(/\r$/, ''))) {
    // Skip peeled refs (^{}) and non-version tags. Strip a trailing CR first so the `$`
    // anchor still matches under git CRLF output on Windows (else all tags silently fail).
    const m = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)$/);
    if (m) tags.push(m[1]);
  }
  if (!tags.length) return null;

  tags.sort((a, b) => {
    const parse = (s) => s.replace(/^v/, '').split('.').map(Number);
    const [aMaj, aMin, aPatch] = parse(a);
    const [bMaj, bMin, bPatch] = parse(b);
    if (aMaj !== bMaj) return bMaj - aMaj;
    if (aMin !== bMin) return bMin - aMin;
    return bPatch - aPatch;
  });
  return tags[0];
}

// Run git ls-remote --tags with the given args. cwd is optional (for local clone).
function tryFetch(extraArgs, cwd) {
  try {
    const opts = {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    };
    if (cwd) opts.cwd = cwd;
    const r = spawnSync('git', ['ls-remote', '--tags', ...extraArgs], opts);
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout;
  } catch (_) {
    return null;
  }
}

function main() {
  // Try live network first; fall back to local marketplace clone.
  let output = tryFetch([REMOTE_URL]);
  if (!output) {
    output = tryFetch(['origin'], LOCAL_CLONE);
  }
  if (!output) return; // git absent or no connectivity => no-op

  const latest = parseHighestTag(output);
  if (!latest) return; // no vX.Y.Z tags found => no-op

  // Ensure cache dir exists.
  const cacheDir = path.dirname(CACHE_FILE);
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}

  // Atomic write: tmp file + rename avoids partial reads if a session starts
  // while we are writing.
  const data = JSON.stringify({ latest, checkedAt: Date.now() });
  const tmp  = CACHE_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, CACHE_FILE);
}

try {
  main();
} catch (_) {
  // Fail-open silently — never crash the background child.
}
