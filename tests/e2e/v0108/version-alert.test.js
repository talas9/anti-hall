'use strict';
// v0.108.0 contract 3 — hooks/version-alert.js (SessionStart).
//
// BASE (already shipped, exercised for real below): fresh cache + newer
// remote version => a single-message additionalContext nudge naming
// /anti-hall:update; up-to-date or stale/absent cache => silent; never
// crashes offline (fail-open).
//
// v0.108.0 EXTENDS this contract (not yet in this working tree — see the
// gate below): the ONE alert message must fork into two distinct directives
// depending on WHICH version is ahead of what: (a) remote > running =>
// "/anti-hall:update then /reload-plugins"; (b) the local plugin CACHE
// (already pulled/installed) is newer than the currently-loaded running
// version => just "/reload-plugins" (no need to re-pull anything); (c) once
// per session (a second SessionStart in the same session must stay silent
// even if the condition still holds); (d) a stale installed_plugins.json is
// ignored for purposes of (b) — only a FRESH read counts.
//
// GATE: sourceHasMarker checks hooks/version-alert.js's own source for the
// 'reload-plugins' string, which only exists once the two-message contract
// above lands (today's shipped hook only ever emits '/anti-hall:update').
// This is a concrete file-content check, not a guess — it flips on the
// instant the real code changes, with no behavioral pre-run involved.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeHome, rm, writeJson, antiHallDir, runHook, sourceHasMarker } = require('./lib.js');

const HOOK = 'version-alert.js';
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 'sess-v0108-1' };
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const HAS_RELOAD_PLUGINS_CONTRACT = sourceHasMarker('hooks/version-alert.js', 'reload-plugins');

function writeVersionCache(home, obj) {
  writeJson(path.join(antiHallDir(home), 'version-check.json'), obj);
}
function writeInstalledPlugins(home, obj) {
  writeJson(path.join(antiHallDir(home), 'installed_plugins.json'), obj);
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

// ── v0.108.0 extension: gated on the two-message contract landing ────────
test(
  'v0.108.0: remote newer than running => directive names BOTH /anti-hall:update and /reload-plugins',
  { skip: HAS_RELOAD_PLUGINS_CONTRACT ? false : 'feature not in base: version-alert two-message contract (marker "reload-plugins" absent from hooks/version-alert.js)' },
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
  { skip: HAS_RELOAD_PLUGINS_CONTRACT ? false : 'feature not in base: version-alert two-message contract (marker "reload-plugins" absent from hooks/version-alert.js)' },
  () => {
    const home = makeHome();
    try {
      // Remote is not ahead (or unknown), but the LOCAL install cache
      // (already pulled into the plugin cache dir) is ahead of what THIS
      // session is currently running.
      writeVersionCache(home, { latest: '0.0.1', checkedAt: NOW });
      writeInstalledPlugins(home, { 'anti-hall': { version: '999.0.0' }, checkedAt: NOW });
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
  { skip: HAS_RELOAD_PLUGINS_CONTRACT ? false : 'feature not in base: version-alert two-message contract (marker "reload-plugins" absent from hooks/version-alert.js)' },
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
  'v0.108.0: a STALE installed_plugins.json is ignored for the cache-newer-than-running check',
  { skip: HAS_RELOAD_PLUGINS_CONTRACT ? false : 'feature not in base: version-alert two-message contract (marker "reload-plugins" absent from hooks/version-alert.js)' },
  () => {
    const home = makeHome();
    try {
      writeVersionCache(home, { latest: '0.0.1', checkedAt: NOW });
      // installed_plugins.json claims a newer version, but its own
      // checkedAt/mtime is stale (>24h) — must not trigger the reload-only alert.
      writeInstalledPlugins(home, { 'anti-hall': { version: '999.0.0' }, checkedAt: NOW - DAY_MS - 1 });
      const r = runHook(HOOK, PAYLOAD, home);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(!hasContext(r), `stale installed_plugins.json must not alert; stdout: ${r.stdout}`);
    } finally { rm(home); }
  },
);
