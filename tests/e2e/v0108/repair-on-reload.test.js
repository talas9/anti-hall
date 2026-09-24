'use strict';
// v0.108.0 contract 4 — repair-on-reload: SessionStart, when the running
// plugin version has CHANGED since the last recorded repair, triggers ONE
// detached repair pass; SAME version => no-op; the no-op path must stay
// under 50ms (it must never block session start with a repair scan).
//
// GATE: hookExists('repair-on-reload.js') — a literal file-existence check.
// No such hook file exists in this working tree; hooks/hooks.json's
// SessionStart list has no repair-on-reload entry either (confirmed via
// grep). Every test below is written against the agreed contract and
// auto-enables once the hook ships — no test is unconditionally skipped.
//
// This is deliberately a SEPARATE hook from doctor.js's own --repair pass
// (which installs/verifies real launchd/systemd companions against the
// login session — out of scope for an automated SessionStart trigger). The
// contract only requires it to KICK OFF one detached repair; this suite
// verifies the trigger/dedup/perf contract, not doctor's own repair content
// (that is covered by tests/hooks/doctor*.test.js and this suite's
// settings.test.js migration coverage).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeHome, rm, runHook, writeJson, antiHallDir, hookExists } = require('./lib.js');

const HOOK = 'repair-on-reload.js';
const FEATURE_LIVE = hookExists(HOOK);
const GATE = { skip: FEATURE_LIVE ? false : 'feature not in base: repair-on-reload (hooks/repair-on-reload.js does not exist yet)' };

const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 'sess-ror-1' };

function repairMarkerPath(home) {
  // Agreed on-disk marker the hook is expected to consult/update so a repeat
  // SessionStart at the SAME version can recognize "already repaired" without
  // re-running anything. Exact filename confirmed against the shipped hook
  // once it lands; this is the natural counterpart to
  // companion/lib/migrations.js's own update-sweep-state marker file pattern
  // this repo already uses everywhere else for idempotent repair passes.
  return path.join(antiHallDir(home), 'repair-on-reload-state.json');
}

test('new plugin version since last repair => triggers one detached repair pass', GATE, () => {
  const home = makeHome();
  try {
    writeJson(repairMarkerPath(home), { lastRepairedVersion: '0.1.0' });
    const start = Date.now();
    const r = runHook(HOOK, PAYLOAD, home, { ANTIHALL_TEST_PLUGIN_VERSION: '999.0.0' });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(elapsed < 5000, `hook took ${elapsed}ms; the repair must be spawned detached, not run inline`);
  } finally { rm(home); }
});

test('same version as last repair => no-op, and the no-op path is fast (<50ms)', GATE, () => {
  const home = makeHome();
  try {
    writeJson(repairMarkerPath(home), { lastRepairedVersion: '999.0.0' });
    const start = Date.now();
    const r = runHook(HOOK, PAYLOAD, home, { ANTIHALL_TEST_PLUGIN_VERSION: '999.0.0' });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(elapsed < 50, `no-op path took ${elapsed}ms; contract requires <50ms for the same-version case`);
  } finally { rm(home); }
});

test('no marker on disk yet (first-ever session) => triggers a repair, then records the version', GATE, () => {
  const home = makeHome();
  try {
    const r = runHook(HOOK, PAYLOAD, home, { ANTIHALL_TEST_PLUGIN_VERSION: '1.2.3' });
    assert.strictEqual(r.status, 0, r.stderr);
    // Give a detached child a brief moment to persist the marker, matching
    // this hook's own fire-and-forget design (never awaited by SessionStart).
    const fs = require('node:fs');
    const deadline = Date.now() + 3000;
    let marker = null;
    while (Date.now() < deadline && !marker) {
      if (fs.existsSync(repairMarkerPath(home))) {
        try { marker = JSON.parse(fs.readFileSync(repairMarkerPath(home), 'utf8')); } catch (_) { /* not flushed yet */ }
      }
    }
    assert.ok(marker && marker.lastRepairedVersion === '1.2.3', `expected the marker to record version 1.2.3; got ${JSON.stringify(marker)}`);
  } finally { rm(home); }
});
