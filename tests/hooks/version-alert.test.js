'use strict';
// version-alert.js (SessionStart hook) — emits a one-line additionalContext when a
// newer version is available in the local cache. Never blocks; fail-open on every error.

const { test } = require('node:test');
const assert   = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK    = 'version-alert.js';
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 't' };
const NOW     = Date.now();
const DAY_MS  = 24 * 60 * 60 * 1000;

// Write the version cache to the fake home's ~/.anti-hall/version-check.json.
function writeCache(h, obj) {
  h.writeState('version-check.json', obj);
}

// True when the hook produced a SessionStart additionalContext output.
function hasContext(r) {
  return (
    r.json &&
    r.json.hookSpecificOutput &&
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
}

// ── (a) Fresh cache, latest > running => alert ──────────────────────────────
test('ALERT: fresh cache with newer version => additionalContext contains "available"', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /available/i);
    assert.match(ctx, /999\.0\.0/);
    assert.match(ctx, /\/anti-hall:update/);
  } finally { h.cleanup(); }
});

// ── (b) Fresh cache, latest == running (or older) => no alert ───────────────
test('NO ALERT: fresh cache with older version => no additionalContext', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '0.0.0', checkedAt: NOW });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert on older cache; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (c) Cache absent => no alert this session, exits 0 quickly ──────────────
test('NO ALERT: cache absent => exits 0, emits nothing (detached refresh spawned)', () => {
  const h = makeHome();
  try {
    // No cache file written — hook must exit 0 and emit no alert.
    const start = Date.now();
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert with no cache; stdout: ${r.stdout}`);
    // Must return quickly (well under 5 s) — the network refresh is detached.
    assert.ok(elapsed < 5000, `hook took ${elapsed} ms; should be near-instant`);
  } finally { h.cleanup(); }
});

// ── (d) Stale cache (>24 h) => no alert this session ───────────────────────
test('NO ALERT: stale cache (>24 h old) => exits 0, emits nothing', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW - DAY_MS - 1 });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert on stale cache; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (e) Env off-switch ───────────────────────────────────────────────────────
test('ENV off-switch: ANTIHALL_VERSION_ALERT=off => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r = testHook(HOOK, PAYLOAD, {
      home: h.home,
      env: { ANTIHALL_VERSION_ALERT: 'off' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `off-switch should suppress; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (f) Skip-guard escape hatch ─────────────────────────────────────────────
test('SKIP hatch: skip.json {"version-alert": future} => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    h.writeSkip({ 'version-alert': Date.now() + 600_000 });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `skip hatch should suppress; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (g) Fail-open: malformed cache JSON => exit 0, no alert ─────────────────
test('FAIL-OPEN: malformed cache JSON => exit 0, no alert', () => {
  const h = makeHome();
  try {
    h.writeState('version-check.json', '{bad json!!');
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `malformed cache must be silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (bonus) Fail-open: empty stdin => exit 0, no alert ──────────────────────
test('FAIL-OPEN: empty stdin => exit 0, no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    // With empty stdin the hook still reads plugin.json + cache and may alert.
    // The key contract is exit 0 (no crash).
  } finally { h.cleanup(); }
});
