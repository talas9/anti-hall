'use strict';
// v0.108.0 contract 3 — hooks/version-alert.js (SessionStart).
//
// BASE (already shipped, exercised for real below): fresh cache + newer
// remote version => a single-message additionalContext nudge naming
// /anti-hall:update; up-to-date or stale/absent cache => silent; never
// crashes offline (fail-open).
//
// v0.108.0 extends it (exercised live below): (a) remote > running =>
// "/anti-hall:update, then /reload-plugins"; (b) the local plugin-cache mirror
// (~/.claude/plugins/cache/anti-hall/anti-hall/<version>/) already holds a
// version newer than the running one => "/reload-plugins" only; (c) once per
// session per (case, versions); (d) the harness-owned installed_plugins.json
// is never consulted (it can lag), so it alone never produces a reload nudge.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { makeHome, rm, writeJson, antiHallDir, runHook } = require('./lib.js');

const HOOK = 'version-alert.js';
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 'sess-v0108-1' };
const NOW = Date.now();

function writeVersionCache(home, obj) {
  writeJson(path.join(antiHallDir(home), 'version-check.json'), obj);
}
// The harness's own record (never read by the hook — see (d) above).
function writeHarnessInstalledPlugins(home, version) {
  writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    { version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'user', version, installPath: '/nonexistent' }] } });
}
// A version `/anti-hall:update` already mirrored into the plugin cache.
function mirrorVersion(home, version) {
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall', version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## ' + version + '\n\n- **New: something.**\n');
}
function hasContext(r) {
  return !!(r.json && r.json.hookSpecificOutput && typeof r.json.hookSpecificOutput.additionalContext === 'string' && r.json.hookSpecificOutput.additionalContext.length > 0);
}

// ── base contract: already shipped, real assertions ─────────────────────
test('BASE: fresh cache with newer remote version => additionalContext names /anti-hall:update', () => {
  const home = makeHome();
  try {
    writeVersionCache(home, { latest: '999.0.0', checkedAt: NOW });
    const r = runHook(HOOK, PAYLOAD, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /\/anti-hall:update/);
  } finally { rm(home); }
});

test('BASE: fresh cache, remote not newer => silent', () => {
  const home = makeHome();
  try {
    writeVersionCache(home, { latest: '0.0.1', checkedAt: NOW });
    const r = runHook(HOOK, PAYLOAD, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('BASE: offline (no cache) => silent, exits 0 quickly, never crashes (network refresh is detached)', () => {
  const home = makeHome();
  try {
    const start = Date.now();
    const r = runHook(HOOK, PAYLOAD, home);
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
    assert.ok(elapsed < 5000, `hook took ${elapsed}ms; the network refresh must be detached, not inline`);
  } finally { rm(home); }
});

test('BASE: settings off (ANTIHALL_VERSION_ALERT=off) => silent even with a newer fresh cache', () => {
  const home = makeHome();
  try {
    writeVersionCache(home, { latest: '999.0.0', checkedAt: NOW });
    const r = runHook(HOOK, PAYLOAD, home, { ANTIHALL_VERSION_ALERT: 'off' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasContext(r), `should be silent when disabled; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

// ── v0.108.0 extension ──────────────────────────────────────────────────
test(
  'v0.108.0: remote newer than running => directive names BOTH /anti-hall:update and /reload-plugins',
  () => {
    const home = makeHome();
    try {
      writeVersionCache(home, { latest: '999.0.0', checkedAt: NOW });
      const r = runHook(HOOK, PAYLOAD, home);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
      const ctx = r.json.hookSpecificOutput.additionalContext;
      assert.match(ctx, /\/anti-hall:update/);
      assert.match(ctx, /\/reload-plugins/);
    } finally { rm(home); }
  },
);

test(
  'v0.108.0: installed plugin cache newer than the currently-running version => "/reload-plugins" only (no /anti-hall:update)',
  () => {
    const home = makeHome();
    try {
      // Remote is not ahead (or unknown), but the LOCAL install cache
      // (already pulled into the plugin cache dir) is ahead of what THIS
      // session is currently running.
      writeVersionCache(home, { latest: '0.0.1', checkedAt: NOW });
      mirrorVersion(home, '999.0.0');
      const r = runHook(HOOK, PAYLOAD, home);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
      const ctx = r.json.hookSpecificOutput.additionalContext;
      assert.match(ctx, /\/reload-plugins/);
      assert.doesNotMatch(ctx, /\/anti-hall:update/);
    } finally { rm(home); }
  },
);

test(
  'v0.108.0: fires at most once per session — a second SessionStart in the same session is silent',
  () => {
    const home = makeHome();
    try {
      writeVersionCache(home, { latest: '999.0.0', checkedAt: NOW });
      const first = runHook(HOOK, PAYLOAD, home);
      assert.ok(hasContext(first), `first SessionStart should alert; stdout: ${first.stdout}`);

      const second = runHook(HOOK, PAYLOAD, home);
      assert.strictEqual(second.status, 0, second.stderr);
      assert.ok(!hasContext(second), `second SessionStart, same session, must be silent; stdout: ${second.stdout}`);
    } finally { rm(home); }
  },
);

test(
  'v0.108.0: installed_plugins.json alone (no mirrored cache dir) never triggers the reload nudge',
  () => {
    const home = makeHome();
    try {
      writeVersionCache(home, { latest: '0.0.1', checkedAt: NOW });
      // The harness record claims a newer version, but nothing was mirrored
      // into the plugin cache — the hook trusts only the on-disk mirror.
      writeHarnessInstalledPlugins(home, '999.0.0');
      const r = runHook(HOOK, PAYLOAD, home);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(!hasContext(r), `installed_plugins.json must not alert; stdout: ${r.stdout}`);
    } finally { rm(home); }
  },
);
