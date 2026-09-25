'use strict';
// homedir-call-site-ratchet — Wave v0.110 hygiene lint.
//
// ROOT CAUSE this guards against: `os.homedir()` is called directly at ~300
// call sites across plugins/anti-hall. Every one of those is a place a test
// that forgets to pass an explicit home/env can silently fall through to the
// REAL developer machine home instead of an isolated fixture (the recurring
// "tests never touch the real home" defect class — see
// tests/hygiene/no-real-home-entrypoints.test.js and
// tests/hygiene/no-real-home-spawn.test.js for two prior fixes in this same
// class). companion/lib/test-home-guard.js#resolveHome() is the CANONICAL
// replacement: same `explicitHome || os.homedir()` fallback in production,
// but it refuses (throws) instead of silently reading/writing the real home
// when that fallback would resolve to it under `node --test`.
//
// This is a RATCHET, not a rewrite: migrating all ~300 call sites in one
// pass would be its own large, risky change. Instead this test freezes the
// count at its current (migration-in-progress) value and fails if it goes
// UP — a new call site must either use resolveHome() or knowingly bump the
// baseline (and explain why in the same commit). Baseline (measured by this
// test's own walk/scan, recursive .js files under plugins/anti-hall minus
// codex/ minus the resolver itself) was 316 before this wave;
// hooks/lib/settings.js (homeDir/homeFromEnv) and hooks/lib/jev-assist.js
// (homeDir) were migrated to resolveHome() in this wave, bringing it to 313.
//
// EXCLUDED: companion/lib/test-home-guard.js itself (the resolver's own
// `os.homedir()` call is the canonical one, not a call site to migrate) and
// plugins/anti-hall/codex/ (the Codex port mirrors the Claude source files;
// its own call sites are a separate, parallel migration — see the file
// header of any touched codex mirror for parity notes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const EXCLUDED_FILES = new Set([
  path.join(PLUGIN_ROOT, 'companion', 'lib', 'test-home-guard.js'),
]);

// Baseline recorded 2026-09-26 (v0.110 lane #3, "tests never touch the real
// HOME"). Was 316 before hooks/lib/settings.js + hooks/lib/jev-assist.js
// migrated their homeDir() helpers to resolveHome(); is 313 now. Lower this
// number as more call sites migrate; raise it only with a comment explaining
// the new call site's own test-isolation story.
const BASELINE = 313;

const HOMEDIR_CALL_RE = /\bos\s*\.\s*homedir\s*\(\s*\)/g;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'codex') continue; // separate Codex-port migration, see header
      out.push(...walk(p));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

test('os.homedir() direct call sites in plugins/anti-hall do not exceed the recorded baseline', () => {
  const files = walk(PLUGIN_ROOT).filter((f) => !EXCLUDED_FILES.has(f));
  let count = 0;
  const perFile = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const matches = src.match(HOMEDIR_CALL_RE);
    if (matches && matches.length) {
      count += matches.length;
      perFile.push(path.relative(PLUGIN_ROOT, file) + ': ' + matches.length);
    }
  }
  assert.ok(count <= BASELINE,
    'os.homedir() call-site count grew from the recorded baseline (' + BASELINE + ') to ' + count
    + ' — migrate the new call site(s) to companion/lib/test-home-guard.js#resolveHome() instead, '
    + 'or bump BASELINE in this test with a comment explaining why it is safe:\n' + perFile.join('\n'));
});
