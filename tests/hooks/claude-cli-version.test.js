'use strict';
// claude-cli-version.js (SessionStart hook) — Probe 2 of anti-hall's
// drift-probe family. Emits a one-line additionalContext when the installed
// Claude Code CLI version SEMVER-DRIFTS (major/minor) from anti-hall's
// harness-KB-audited baseline. Mirrors devswarm-version.js's shipped
// contract, sharing mechanics via hooks/lib/drift-baseline.js.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'claude-cli-version.js';
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 't' };
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const drift = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'drift-baseline.js'));
const refreshModule = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'claude-cli-version-refresh.js'));
const { CLAUDE_CLI_BASELINE } = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'claude-cli-baseline.js'));
const BASELINE = CLAUDE_CLI_BASELINE;

function writeCache(h, obj) {
  h.writeState('claude-cli-version.json', obj);
}

function readCache(h) {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.antiHall, 'claude-cli-version.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function hasContext(r) {
  return (
    r.json &&
    r.json.hookSpecificOutput &&
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
}

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(sab, 0, 0, 25);
  }
  return predicate();
}

function emptyBinDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-emptybin-'));
}

const deferredHomes = [];
function deferCleanup(h, isDone) {
  deferredHomes.push({ h, isDone });
}
after(() => {
  for (const { h, isDone } of deferredHomes) {
    waitFor(isDone, 20000);
    h.cleanup();
  }
});

// ── Baseline absent (no cache at all) => silent, exit 0 ────────────────────

test('baseline/cache absent => silent, exit 0, spawns detached refresh', () => {
  const h = makeHome();
  const bin = emptyBinDir();
  try {
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent with no cache; stdout: ${r.stdout}`);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    deferCleanup(h, () => fs.existsSync(path.join(h.antiHall, 'claude-cli-version.json')));
  }
});

// ── installed == baseline => silent ─────────────────────────────────────

test('installed === baseline (exact match) => silent', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: BASELINE, baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent on exact match; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── patch-level advance => silent ───────────────────────────────────────

test('patch-level advance => silent', () => {
  const h = makeHome();
  try {
    const [maj, min] = BASELINE.split('.');
    const patchBump = `${maj}.${min}.999`;
    writeCache(h, { installed: patchBump, baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `patch drift must stay silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── minor/major advance => exactly ONE advisory naming both versions ────

test('minor advance => exactly one advisory line naming both versions', () => {
  const h = makeHome();
  try {
    const [maj, min] = BASELINE.split('.').map(Number);
    const newer = `${maj}.${min + 1}.0`;
    writeCache(h, { installed: newer, baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(newer.replace(/\./g, '\\.')));
    assert.match(ctx, new RegExp(BASELINE.replace(/\./g, '\\.')));
    assert.match(ctx, /docs\/KB-claude-code-harness-features\.md/);
    assert.strictEqual(ctx.split('\n').length, 1, `expected a single line; got: ${JSON.stringify(ctx)}`);
  } finally { h.cleanup(); }
});

test('major advance => advisory fires', () => {
  const h = makeHome();
  try {
    const [maj] = BASELINE.split('.').map(Number);
    const newer = `${maj + 1}.0.0`;
    writeCache(h, { installed: newer, baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `expected additionalContext for major bump; stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, new RegExp(newer.replace(/\./g, '\\.')));
  } finally { h.cleanup(); }
});

// ── same drift twice => second session silent (dedupe holds) ────────────

test('same drift twice => second session silent (dedupe)', () => {
  const h = makeHome();
  try {
    const [maj, min] = BASELINE.split('.').map(Number);
    const newer = `${maj}.${min + 1}.0`;
    writeCache(h, { installed: newer, baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const first = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(first), 'first run should advise');

    const second = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(second.status, 0);
    assert.ok(!hasContext(second), `repeat advisory must be suppressed; stdout: ${second.stdout}`);

    const cache = readCache(h);
    assert.deepStrictEqual(cache.lastAdvised, { installed: newer, baseline: BASELINE });
  } finally { h.cleanup(); }
});

// ── source binary missing / command fails => silent, exit 0, no throw ───

test('source binary missing => refresh writes installed:null, hook stays silent', () => {
  const h = makeHome();
  const bin = emptyBinDir();
  try {
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent with no CLI on PATH; stdout: ${r.stdout}`);

    const cachePath = path.join(h.antiHall, 'claude-cli-version.json');
    const wrote = waitFor(() => fs.existsSync(cachePath), 8000);
    assert.ok(wrote, 'detached refresh child must eventually write the cache file');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.strictEqual(cache.installed, null);
    assert.strictEqual(cache.source, null);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    deferCleanup(h, () => fs.existsSync(path.join(h.antiHall, 'claude-cli-version.json')));
  }
});

test('installed:null (already probed, CLI absent) => silent, never throws', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: null, baseline: BASELINE, checkedAt: NOW, source: null });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent when CLI is absent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('unparseable installed version => silent, never throws', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: 'not-a-real-version', baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `unparseable installed must be silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── stale cache => refresh spawned, no alert this session ───────────────

test('stale cache (>24h) => silent this session, refresh overwrites cache', () => {
  const h = makeHome();
  const bin = emptyBinDir();
  try {
    writeCache(h, { installed: `${BASELINE}`, baseline: BASELINE, checkedAt: NOW - DAY_MS - 1, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `stale cache must not alert this session; stdout: ${r.stdout}`);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    deferCleanup(h, () => fs.existsSync(path.join(h.antiHall, 'claude-cli-version.json')));
  }
});

// ── advisory content sanity: only computed values, no file content ──────

test('advisory text contains only version strings + a doc path, no arbitrary file content', () => {
  const h = makeHome();
  try {
    const [maj, min] = BASELINE.split('.').map(Number);
    const newer = `${maj}.${min + 1}.0`;
    writeCache(h, { installed: newer, baseline: BASELINE, checkedAt: NOW, source: 'claude' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /^Claude Code CLI [\w.]+ installed; anti-hall's harness KB is audited against [\w.]+(?: \(newer\))? — behavior may have drifted, see docs\/KB-claude-code-harness-features\.md$/
    );
  } finally { h.cleanup(); }
});

// ── pure helper: reuses shared drift-baseline classifyVersionDrift ──────

test('classifyVersionDrift (shared lib) used by this probe matches the baseline module', () => {
  assert.deepStrictEqual(drift.classifyVersionDrift(BASELINE, BASELINE), { advise: false, reason: 'match' });
  const [maj, min] = BASELINE.split('.').map(Number);
  assert.deepStrictEqual(
    drift.classifyVersionDrift(`${maj}.${min + 1}.0`, BASELINE),
    { advise: true, reason: 'newer' }
  );
});

test('refresh module BASELINE matches the shared claude-cli-baseline constant', () => {
  assert.strictEqual(refreshModule.BASELINE, BASELINE);
});
