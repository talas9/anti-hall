'use strict';
// limit-conserve — tests for the shared helper and the UserPromptSubmit injector.
//
// Helper tests exercise isConserving() via a tiny wrapper script so the fake HOME
// env is honoured by os.homedir() at module-load time (CACHE_FILE is computed then).
// Injector E2E tests use testHook / testHookRaw against limit-conserve-inject.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { testHook, testHookRaw, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const INJECT_HOOK = 'limit-conserve-inject.js';

// Wrapper script: requires limit-conserve.js and writes isConserving() result as JSON.
// Written to a temp dir once; reused across tests.
const WRAPPER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wrapper-'));
const WRAPPER_SCRIPT = path.join(WRAPPER_DIR, 'lc-wrapper.js');
fs.writeFileSync(
  WRAPPER_SCRIPT,
  `'use strict';
const fs = require('fs');
const { isConserving } = require(${JSON.stringify(path.join(HOOKS_DIR, 'limit-conserve.js'))});
try {
  const r = isConserving();
  fs.writeSync(1, JSON.stringify(r) + '\\n');
} catch (e) {
  fs.writeSync(1, JSON.stringify({ active: false, error: String(e) }) + '\\n');
}
process.exit(0);
`,
  'utf8'
);

// isolatedEnv mirrors spawn-hook.js logic (fake HOME, cross-platform).
function isolatedEnv(home, extra) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (process.platform === 'win32') {
    const root = path.parse(home).root;
    env.USERPROFILE = home;
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length);
  }
  return Object.assign(env, extra || {});
}

// runWrapper: call the wrapper script inside a fake HOME.
function runWrapper(home, extraEnv) {
  const res = spawnSync(process.execPath, [WRAPPER_SCRIPT], {
    encoding: 'utf8',
    env: isolatedEnv(home, extraEnv),
    timeout: 10000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) {}
  return { status: res.status, stdout: res.stdout || '', json };
}

// writeCacheFile: create the OMC usage cache at the expected path under fakeHome.
function writeCacheFile(home, cacheObj) {
  const dir = path.join(home, '.claude', 'plugins', 'oh-my-claudecode');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, '.usage-cache-anthropic.json');
  fs.writeFileSync(p, typeof cacheObj === 'string' ? cacheObj : JSON.stringify(cacheObj), 'utf8');
  return p;
}

// futureISO: ISO string N ms from now.
function futureISO(ms) { return new Date(Date.now() + ms).toISOString(); }
// pastISO: ISO string N ms in the past.
function pastISO(ms) { return new Date(Date.now() - ms).toISOString(); }

// Cache shape helpers.
function makeCache({ fiveHour = 0, weekly = 0, sonnet = 0, tsOffset = 0,
                     fiveHourResetsAt, weeklyResetsAt, sonnetResetsAt } = {}) {
  return {
    timestamp: Date.now() - tsOffset,
    data: {
      fiveHourPercent: fiveHour,
      fiveHourResetsAt: fiveHourResetsAt || futureISO(3600000),
      weeklyPercent: weekly,
      weeklyResetsAt: weeklyResetsAt || futureISO(7 * 24 * 3600000),
      sonnetWeeklyPercent: sonnet,
      sonnetWeeklyResetsAt: sonnetResetsAt || futureISO(7 * 24 * 3600000),
    },
    rateLimited: false,
  };
}

// ── isConserving() unit tests (via wrapper) ──────────────────────────────────

test('HIGH weekly (90%) -> active, source:cache', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 90 }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r, 'wrapper returned JSON');
    assert.strictEqual(r.active, true, 'active');
    assert.ok(/weekly/i.test(r.reason), 'reason names weekly bucket');
    assert.strictEqual(r.source, 'cache');
    assert.strictEqual(r.stale, false);
    assert.strictEqual(r.weekly, 90);
  } finally { h.cleanup(); }
});

test('HIGH 5h (85%) -> active', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ fiveHour: 85 }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === true, 'active on 5h >= threshold');
    assert.ok(/5h/i.test(r.reason), 'reason names 5h bucket');
    assert.strictEqual(r.fiveHour, 85);
  } finally { h.cleanup(); }
});

test('HIGH sonnetWeekly (95%) -> active', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ sonnet: 95 }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === true, 'active on sonnetWeekly >= threshold');
    assert.ok(/sonnetWeekly/i.test(r.reason), 'reason names sonnetWeekly bucket');
    assert.strictEqual(r.sonnetWeekly, 95);
  } finally { h.cleanup(); }
});

test('ALL buckets below threshold (50%) -> inactive', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ fiveHour: 50, weekly: 50, sonnet: 50 }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === false, 'inactive when all below threshold');
    assert.strictEqual(r.source, 'cache');
  } finally { h.cleanup(); }
});

test('RESET-AWARE: weekly 90% but resetsAt is in the PAST -> inactive', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 90, weeklyResetsAt: pastISO(60000) }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === false, 'inactive because reset already happened');
  } finally { h.cleanup(); }
});

test('RESET-AWARE: 5h 90% past + weekly 90% future -> only weekly trips', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({
      fiveHour: 90, fiveHourResetsAt: pastISO(60000),
      weekly: 90,
    }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === true, 'still active (weekly trips)');
    assert.ok(!/5h/i.test(r.reason), '5h should NOT appear in reason');
    assert.ok(/weekly/i.test(r.reason), 'weekly should appear in reason');
  } finally { h.cleanup(); }
});

test('MANUAL ON (env=on, no cache) -> active, source:env, reason:manual-on', () => {
  const h = makeHome();
  try {
    // No cache file written — purely env-driven.
    const { json: r } = runWrapper(h.home, { ANTIHALL_LIMIT_CONSERVE: 'on' });
    assert.ok(r && r.active === true, 'active via manual-on');
    assert.strictEqual(r.source, 'env');
    assert.strictEqual(r.reason, 'manual-on');
  } finally { h.cleanup(); }
});

test('MANUAL ON sticky: env=on even when cache is 95% (no auto-deactivate logic needed)', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 10 })); // low cache
    const { json: r } = runWrapper(h.home, { ANTIHALL_LIMIT_CONSERVE: 'on' });
    assert.ok(r && r.active === true, 'manual-on overrides low cache');
    assert.strictEqual(r.source, 'env');
  } finally { h.cleanup(); }
});

test('MANUAL OFF (env=off, cache at 95%) -> inactive, source:env', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 95 }));
    const { json: r } = runWrapper(h.home, { ANTIHALL_LIMIT_CONSERVE: 'off' });
    assert.ok(r && r.active === false, 'manual-off overrides high cache');
    assert.strictEqual(r.source, 'env');
  } finally { h.cleanup(); }
});

test('CACHE ABSENT + env=auto -> inactive, source:manual-only, reason:cache-absent', () => {
  const h = makeHome();
  try {
    // No cache written.
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === false, 'inactive when cache absent');
    assert.strictEqual(r.source, 'manual-only');
    assert.strictEqual(r.reason, 'cache-absent');
  } finally { h.cleanup(); }
});

test('STALE CACHE (>15 min old) with high weekly -> active AND stale:true', () => {
  const h = makeHome();
  try {
    const staleMs = 16 * 60 * 1000; // 16 min > STALE_MS
    writeCacheFile(h.home, makeCache({ weekly: 90, tsOffset: staleMs }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === true, 'still active (conservative on stale)');
    assert.strictEqual(r.stale, true, 'stale flag set');
  } finally { h.cleanup(); }
});

test('MALFORMED JSON cache -> fail-open inactive, source:manual-only', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, '{bad json');
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === false, 'fail-open on malformed cache');
    assert.strictEqual(r.source, 'manual-only');
  } finally { h.cleanup(); }
});

test('BAD SHAPE (missing data field) -> fail-open inactive', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, JSON.stringify({ timestamp: Date.now(), rateLimited: false }));
    const { json: r } = runWrapper(h.home);
    assert.ok(r && r.active === false, 'fail-open on bad cache shape');
    assert.strictEqual(r.source, 'manual-only');
  } finally { h.cleanup(); }
});

// ── Injector E2E tests (limit-conserve-inject.js via testHook) ──────────────

function promptPayload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: process.cwd() };
}

function additionalContext(r) {
  return r.json &&
    r.json.hookSpecificOutput &&
    r.json.hookSpecificOutput.additionalContext || '';
}

test('INJECTOR: active cache (weekly 90%) -> additionalContext contains "LIMIT CONSERVATION ACTIVE"', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 90 }));
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'exit 0');
    const ctx = additionalContext(r);
    assert.ok(ctx.includes('LIMIT CONSERVATION ACTIVE'), `directive missing; got: ${ctx}`);
    assert.ok(/weekly/i.test(ctx), 'reason (weekly) in directive');
  } finally { h.cleanup(); }
});

test('INJECTOR: all buckets below threshold -> additionalContext is empty', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ fiveHour: 40, weekly: 40, sonnet: 40 }));
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(additionalContext(r), '', 'no directive when limits are low');
  } finally { h.cleanup(); }
});

test('INJECTOR: env=on (no cache) -> directive emitted with reason=manual-on', () => {
  const h = makeHome();
  try {
    const r = testHook(INJECT_HOOK, promptPayload(), {
      home: h.home,
      env: { ANTIHALL_LIMIT_CONSERVE: 'on' },
      expectJson: true,
    });
    assert.strictEqual(r.status, 0);
    const ctx = additionalContext(r);
    assert.ok(ctx.includes('LIMIT CONSERVATION ACTIVE'), `directive missing; got: ${ctx}`);
    assert.ok(ctx.includes('manual-on'), 'manual-on reason in directive');
  } finally { h.cleanup(); }
});

test('INJECTOR: skip hatch {limit-conserve: future} -> additionalContext is empty', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 90 }));
    h.writeSkip({ 'limit-conserve': Date.now() + 600000 });
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(additionalContext(r), '', 'skip hatch suppresses directive');
  } finally { h.cleanup(); }
});

test('INJECTOR FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(INJECT_HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0, 'exit 0 on empty stdin');
  } finally { h.cleanup(); }
});

test('INJECTOR FAIL-OPEN: malformed stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(INJECT_HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0, 'exit 0 on malformed stdin');
  } finally { h.cleanup(); }
});

// ── Main-model downshift directive tests ─────────────────────────────────────

test('INJECTOR DOWNSHIFT: conserving -> directive contains MAIN-MODEL DOWNSHIFT', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 90 }));
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    const ctx = additionalContext(r);
    assert.ok(ctx.includes('MAIN-MODEL DOWNSHIFT'), `downshift directive missing; got: ${ctx}`);
  } finally { h.cleanup(); }
});

test('INJECTOR DOWNSHIFT: conserving -> directive names Sonnet 5 and gpt-5.4', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ fiveHour: 90 }));
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    const ctx = additionalContext(r);
    assert.ok(ctx.includes('Sonnet 5'), `Sonnet 5 missing from downshift directive; got: ${ctx}`);
    assert.ok(ctx.includes('gpt-5.4'), `gpt-5.4 missing from downshift directive; got: ${ctx}`);
  } finally { h.cleanup(); }
});

test('INJECTOR DOWNSHIFT: conserving -> warns against sub-1M model (gpt-5.4-mini)', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 90 }));
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    const ctx = additionalContext(r);
    assert.ok(ctx.includes('gpt-5.4-mini'), `sub-1M warning missing; got: ${ctx}`);
    assert.ok(/NEVER/i.test(ctx), 'NEVER guard missing from downshift directive');
  } finally { h.cleanup(); }
});

test('INJECTOR DOWNSHIFT: NOT conserving -> directive absent', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ fiveHour: 40, weekly: 40, sonnet: 40 }));
    const r = testHook(INJECT_HOOK, promptPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    const ctx = additionalContext(r);
    assert.strictEqual(ctx, '', 'no downshift directive when not conserving');
  } finally { h.cleanup(); }
});

test('INJECTOR DOWNSHIFT: env=off -> directive absent even with high cache', () => {
  const h = makeHome();
  try {
    writeCacheFile(h.home, makeCache({ weekly: 95 }));
    const r = testHook(INJECT_HOOK, promptPayload(), {
      home: h.home,
      env: { ANTIHALL_LIMIT_CONSERVE: 'off' },
      expectJson: true,
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(additionalContext(r), '', 'env=off suppresses downshift directive');
  } finally { h.cleanup(); }
});
