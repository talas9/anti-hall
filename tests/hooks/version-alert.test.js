'use strict';
// version-alert.js (SessionStart hook) — emits a one-line additionalContext
// DIRECTIVE when a newer version is available (CASE 1, cache-based) or already
// mirrored locally but not yet reloaded (CASE 2, disk-based, no network/TTL
// dependency). Never blocks; fail-open on every error. Once-per-session
// dedupe; main-thread only (subagent/sidechain payloads are skipped).

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert   = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK    = 'version-alert.js';
const NOW     = Date.now();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

function payload(sessionId) {
  return { hook_event_name: 'SessionStart', session_id: sessionId || 't' };
}

// Write the version cache to the fake home's ~/.anti-hall/version-check.json.
function writeCache(h, obj) {
  h.writeState('version-check.json', obj);
}

function readCache(h) {
  return JSON.parse(fs.readFileSync(path.join(h.antiHall, 'version-check.json'), 'utf8'));
}

// Create ~/.claude/plugins/cache/anti-hall/anti-hall/<version>/ under the fake
// home, mirroring what `/anti-hall:update` leaves on disk before a reload.
function writeMirroredVersion(h, version, changelogBody) {
  const dir = path.join(h.home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall', version);
  fs.mkdirSync(dir, { recursive: true });
  if (changelogBody !== undefined) {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelogBody, 'utf8');
  }
  return dir;
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

// ── CASE 1 (a) Fresh cache, latest > running => alert with directive wording ─
test('CASE 1 ALERT: fresh cache with newer version => directive additionalContext', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r = testHook(HOOK, payload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Tell the user now/);
    assert.match(ctx, /available/i);
    assert.match(ctx, /999\.0\.0/);
    assert.match(ctx, /\/anti-hall:update/);
    assert.match(ctx, /anti-hall-update skill/); // Codex parity wording
  } finally { h.cleanup(); }
});

// ── (b) Fresh cache, latest == running (or older) => no alert ───────────────
test('NO ALERT: fresh cache with older version => no additionalContext', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '0.0.0', checkedAt: NOW });
    const r = testHook(HOOK, payload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert on older cache; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (c) Cache absent => no alert this session, exits 0 quickly ──────────────
test('NO ALERT: cache absent => exits 0, emits nothing (detached refresh spawned)', () => {
  const h = makeHome();
  try {
    const start = Date.now();
    const r = testHook(HOOK, payload(), { home: h.home });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert with no cache; stdout: ${r.stdout}`);
    assert.ok(elapsed < 5000, `hook took ${elapsed} ms; should be near-instant`);
  } finally { h.cleanup(); }
});

// ── (d) Stale cache (>24 h) => no alert this session ───────────────────────
test('NO ALERT: stale cache (>24 h old) => exits 0, emits nothing', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW - DAY_MS - 1 });
    const r = testHook(HOOK, payload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert on stale cache; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (d2) ROOT-CAUSE REGRESSION: 3h-old cache is stale under the NEW 2h TTL ──
// (the old 24h TTL would have called this "fresh" and alerted on stale data —
// exactly the proven failure mode: a multi-release day's cache never re-checks).
test('TTL FIX: 3h-old cache is now stale (was "fresh" under the old 24h TTL)', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW - (3 * HOUR_MS) });
    const r = testHook(HOOK, payload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `3h-old cache must be stale under the 2h TTL; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('TTL FIX: 1h-old cache is still fresh under the new 2h TTL => alerts', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW - (1 * HOUR_MS) });
    const r = testHook(HOOK, payload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(hasContext(r), `1h-old cache should still be fresh; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (e) Env off-switch ───────────────────────────────────────────────────────
test('ENV off-switch: ANTIHALL_VERSION_ALERT=off => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r = testHook(HOOK, payload(), {
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
    const r = testHook(HOOK, payload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `skip hatch should suppress; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── (g) Fail-open: malformed cache JSON => exit 0, no alert ─────────────────
test('FAIL-OPEN: malformed cache JSON => exit 0, no alert', () => {
  const h = makeHome();
  try {
    h.writeState('version-check.json', '{bad json!!');
    const r = testHook(HOOK, payload(), { home: h.home });
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
  } finally { h.cleanup(); }
});

// ── CASE 2 (h) Mirrored newer version on disk => reload-only directive, no
//     network dependency, fires even with NO cache file at all ─────────────
test('CASE 2 ALERT: mirrored newer version on disk => reload-only directive', () => {
  const h = makeHome();
  try {
    writeMirroredVersion(h, '999.0.0', '## 999.0.0\n\n- Big new feature headline.\n\n## 0.1.0\n');
    const r = testHook(HOOK, payload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Tell the user now/);
    assert.match(ctx, /already downloaded/i);
    assert.match(ctx, /\/reload-plugins/);
    assert.match(ctx, /restart Codex/);
    assert.doesNotMatch(ctx, /\/anti-hall:update/); // reload-only, not an update nudge
    assert.match(ctx, /Big new feature headline/); // cheap local changelog headline
  } finally { h.cleanup(); }
});

// ── CASE 2 (i) Mirrored version present but NOT newer than running => no alert
test('CASE 2 NO ALERT: mirrored version <= running => silent', () => {
  const h = makeHome();
  try {
    writeMirroredVersion(h, '0.0.1');
    const r = testHook(HOOK, payload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `mirrored-but-not-newer must be silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── CASE 2 (j) Mirrored newer version takes priority over a stale/absent cache
test('CASE 2 PRIORITY: mirrored-newer alerts even with a stale cache (no TTL dependency)', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '0.0.1', checkedAt: NOW - DAY_MS - 1 }); // stale, and not even newer
    writeMirroredVersion(h, '999.0.0');
    const r = testHook(HOOK, payload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(hasContext(r), `case 2 must not depend on cache freshness; stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /already downloaded/i);
  } finally { h.cleanup(); }
});

// ── ONCE-PER-SESSION (k) same session_id, same versions => second call suppressed
test('ONCE PER SESSION: same session_id repeats (compact/resume) => no repeat alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r1 = testHook(HOOK, payload('same-session'), { home: h.home, expectJson: true });
    assert.ok(hasContext(r1), `first call should alert; stdout: ${r1.stdout}`);

    const r2 = testHook(HOOK, payload('same-session'), { home: h.home });
    assert.strictEqual(r2.status, 0);
    assert.ok(!hasContext(r2), `same-session re-fire must not repeat; stdout: ${r2.stdout}`);

    // lastAdvised persisted onto the same cache file.
    const cache = readCache(h);
    assert.ok(cache.lastAdvised, 'lastAdvised should be persisted');
  } finally { h.cleanup(); }
});

// ── ONCE-PER-SESSION (l) a DIFFERENT session_id gets the alert again ────────
test('PER-SESSION RE-ARM: a different session_id gets the alert again', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const r1 = testHook(HOOK, payload('session-A'), { home: h.home, expectJson: true });
    assert.ok(hasContext(r1), `session A should alert; stdout: ${r1.stdout}`);

    const r2 = testHook(HOOK, payload('session-B'), { home: h.home, expectJson: true });
    assert.ok(hasContext(r2), `session B must get its own alert; stdout: ${r2.stdout}`);
  } finally { h.cleanup(); }
});

// ── MAIN-THREAD ONLY (m) subagent/sidechain markers suppress the alert ──────
test('SUBAGENT SKIP: agent_type marker on the payload => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const p = Object.assign(payload(), { agent_type: 'general-purpose' });
    const r = testHook(HOOK, p, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `subagent payload must be skipped; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('SUBAGENT SKIP: isSidechain marker on the payload => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { latest: '999.0.0', checkedAt: NOW });
    const p = Object.assign(payload(), { isSidechain: true });
    const r = testHook(HOOK, p, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `sidechain payload must be skipped; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── STALE installed_plugins.json IGNORED (n) ────────────────────────────────
// Running version must come from plugin.json next to the executing hook
// (this repo checkout's own ../.claude-plugin/plugin.json), never from
// ~/.claude/plugins/installed_plugins.json — which is harness-owned and can
// lag (observed 2026-09-24: it reported 0.105.3 while 0.107.0 was actually
// loaded). Plant a stale/contradictory installed_plugins.json under the fake
// HOME and prove it has zero effect on the alert decision.
test('RUNNING VERSION: a stale installed_plugins.json is ignored entirely', () => {
  const h = makeHome();
  try {
    const realPluginJson = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json');
    const realRunning = JSON.parse(fs.readFileSync(realPluginJson, 'utf8')).version;

    const installedDir = path.join(h.home, '.claude', 'plugins');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': [{ version: '0.0.1', installPath: '/nonexistent' }] }),
      'utf8'
    );

    // latest just above the REAL running version so the test is sensitive to
    // which "running" value the hook actually used.
    const [maj, min, patch] = realRunning.split('.').map(Number);
    const latest = `${maj}.${min}.${patch + 1}`;
    writeCache(h, { latest, checkedAt: NOW });

    const r = testHook(HOOK, payload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected alert using the REAL running version; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(`running v${realRunning.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(ctx, /0\.0\.1/, 'must never surface the stale installed_plugins.json version');
  } finally { h.cleanup(); }
});

// ── CASE 2 DEDUPE WITHOUT ANY REMOTE CACHE (o) ──────────────────────────────
// The reload nudge must still be once-per-session even when
// ~/.anti-hall/version-check.json has never existed (case 2 must not depend
// on the remote cache for its own dedupe — see RELOAD_MARK_FILE).
test('CASE 2 ONCE PER SESSION: reload nudge dedupes with no remote cache at all', () => {
  const h = makeHome();
  try {
    writeMirroredVersion(h, '999.0.0');
    const r1 = testHook(HOOK, payload('same-session'), { home: h.home, expectJson: true });
    assert.ok(hasContext(r1), `first call should alert; stdout: ${r1.stdout}`);

    const r2 = testHook(HOOK, payload('same-session'), { home: h.home });
    assert.strictEqual(r2.status, 0);
    assert.ok(!hasContext(r2), `same-session re-fire must not repeat; stdout: ${r2.stdout}`);

    const marker = JSON.parse(fs.readFileSync(path.join(h.antiHall, 'version-alert-reload.json'), 'utf8'));
    assert.ok(marker.lastAdvised, 'reload dedupe marker should be persisted separately from version-check.json');
  } finally { h.cleanup(); }
});
