'use strict';
// hooks/lib/auto-handover-config.js — precedence + validation for the
// auto-handover trigger's settings, and scripts/auto-handover-config.js's CLI.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');
const {
  readConfig, writeConfig, resolveEffective, DEFAULT_PCT, DEFAULT_NAG_STEP_PCT, DEFAULT_NAG_QUIET_MIN,
} = require('../../plugins/anti-hall/hooks/lib/auto-handover-config.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');

test('resolveEffective(): default-on with no settings file at all', () => {
  const h = makeHome();
  try {
    const r = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.pct, DEFAULT_PCT);
    assert.strictEqual(r.nag, true);
    assert.strictEqual(r.nagStepPct, DEFAULT_NAG_STEP_PCT);
    assert.strictEqual(r.nagQuietMin, DEFAULT_NAG_QUIET_MIN);
    assert.strictEqual(r.source, 'default');
  } finally {
    h.cleanup();
  }
});

test('resolveEffective(): settings file pct wins over default', () => {
  const h = makeHome();
  try {
    settings.set('autoHandover', 'pct', 70, { home: h.home });
    const r = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r.pct, 70);
    assert.strictEqual(r.source, 'file');
  } finally {
    h.cleanup();
  }
});

test('resolveEffective(): env wins over settings file', () => {
  const h = makeHome();
  try {
    settings.set('autoHandover', 'pct', 70, { home: h.home });
    const r = resolveEffective({ home: h.home, env: { ANTIHALL_AUTO_HANDOVER_PCT: '60' } });
    assert.strictEqual(r.pct, 60);
    assert.strictEqual(r.source, 'env');
  } finally {
    h.cleanup();
  }
});

test('resolveEffective(): env "0" disables outright, taking precedence over settings.enabled', () => {
  const h = makeHome();
  try {
    const r = resolveEffective({ home: h.home, env: { ANTIHALL_AUTO_HANDOVER_PCT: '0' } });
    assert.strictEqual(r.enabled, false);
  } finally {
    h.cleanup();
  }
});

test('resolveEffective(): settings.enabled=false disables (persists across "sessions")', () => {
  const h = makeHome();
  try {
    settings.set('autoHandover', 'enabled', false, { home: h.home });
    const r1 = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r1.enabled, false);
    // A fresh resolveEffective call (simulating a new process/session) reads
    // the same persisted file and gets the same answer.
    const r2 = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r2.enabled, false);
  } finally {
    h.cleanup();
  }
});

test('resolveEffective(): out-of-range file pct (0, negative, >99, non-numeric) falls back to default, never disables', () => {
  const h = makeHome();
  try {
    // Note: the canonical settings-schema.js `pct` entry only bounds by
    // range (min:1, max:99), not integer-ness, so a non-integer WITHIN range
    // (e.g. 3.5) is a legitimately valid value there now, not a "bad" one —
    // excluded from this list accordingly.
    for (const bad of [0, -5, 100, 'nope']) {
      settings.set('autoHandover', 'pct', bad, { home: h.home });
      const r = resolveEffective({ home: h.home, env: {} });
      assert.strictEqual(r.enabled, true, `bad=${bad}`);
      assert.strictEqual(r.pct, DEFAULT_PCT, `bad=${bad}`);
    }
  } finally {
    h.cleanup();
  }
});

test('resolveEffective(): invalid env value (not 0, not 1-99) falls through to file/default, fail-open', () => {
  const h = makeHome();
  try {
    const r = resolveEffective({ home: h.home, env: { ANTIHALL_AUTO_HANDOVER_PCT: 'nope' } });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.pct, DEFAULT_PCT);
  } finally {
    h.cleanup();
  }
});

test('writeConfig(): read-modify-write never clobbers sibling settings sections', () => {
  const h = makeHome();
  try {
    // A real, schema-declared sibling setting (settings.set rejects unknown
    // section/key pairs outright, so this must be a setting the canonical
    // settings-schema.js actually declares — see plugins/anti-hall/hooks/lib/
    // settings-schema.js's "guards" section).
    const r = settings.set('guards', 'mergeGate', true, { home: h.home });
    assert.strictEqual(r.ok, true, r.error);
    writeConfig(h.home, (cfg) => { cfg.pct = 55; return cfg; });
    const all = settings.load({ home: h.home });
    assert.strictEqual(all.guards.mergeGate, true);
    assert.strictEqual(all.autoHandover.pct, 55);
  } finally {
    h.cleanup();
  }
});

// --- CLI (scripts/auto-handover-config.js) ---------------------------------

const CLI = require('../../plugins/anti-hall/scripts/auto-handover-config.js');

function withHomeEnv(home, fn) {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
  }
}

test('CLI set: persists a valid threshold and enables the feature', () => {
  const h = makeHome();
  try {
    withHomeEnv(h.home, () => CLI.cmdSet('60'));
    const r = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r.pct, 60);
    assert.strictEqual(r.enabled, true);
  } finally {
    h.cleanup();
  }
});

test('CLI set: rejects an out-of-range value without writing', () => {
  const h = makeHome();
  try {
    let code;
    withHomeEnv(h.home, () => {
      const prevExit = process.exitCode;
      CLI.cmdSet('150');
      code = process.exitCode;
      process.exitCode = prevExit;
    });
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(readConfig(h.home), {});
  } finally {
    h.cleanup();
  }
});

test('CLI off/on: off persists enabled:false, on restores default pct if unset', () => {
  const h = makeHome();
  try {
    withHomeEnv(h.home, () => CLI.cmdOff());
    assert.strictEqual(resolveEffective({ home: h.home, env: {} }).enabled, false);
    withHomeEnv(h.home, () => CLI.cmdOn());
    const r = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.pct, DEFAULT_PCT);
  } finally {
    h.cleanup();
  }
});

test('CLI nag/nag-step/nag-quiet: persist their values', () => {
  const h = makeHome();
  try {
    withHomeEnv(h.home, () => {
      CLI.cmdNag('off');
      CLI.cmdNagStep('10');
      CLI.cmdNagQuiet('30');
    });
    const r = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r.nag, false);
    assert.strictEqual(r.nagStepPct, 10);
    assert.strictEqual(r.nagQuietMin, 30);
  } finally {
    h.cleanup();
  }
});

test('maxTokens: default 0 (off, opt-in), env override, 0 stays disabled; overThreshold picks pct / tokens / pct-unknown-window', () => {
  const { overThreshold, DEFAULT_MAX_TOKENS } = require('../../plugins/anti-hall/hooks/lib/auto-handover-config.js');
  const h = makeHome();
  try {
    // Default: OFF. The real per-session context-window pct trigger (default
    // 85%) is the only thing that fires unless a user explicitly opts a
    // ceiling in — a fixed absolute token default would fire far too early
    // on a genuinely large (e.g. 1M) window.
    const d = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(DEFAULT_MAX_TOKENS, 0);
    assert.strictEqual(d.maxTokens, 0);
    assert.strictEqual(resolveEffective({ home: h.home, env: { ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '0' } }).maxTokens, 0);
    assert.strictEqual(resolveEffective({ home: h.home, env: { ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '300000' } }).maxTokens, 300000);
    // 1M window, 214K tokens, no settings at all -> the token ceiling is
    // off by default and 214K/1M is nowhere near the 85% pct threshold, so
    // NOTHING fires (the exact "default-off" regression this default change
    // exists to prevent: a fixed 170000 default would have fired here).
    assert.strictEqual(overThreshold({ pct: 21.4, used: 214000, windowKnown: true }, d), null);
    // With an explicit opt-in ceiling, the SAME shape now fires via tokens.
    const withCeiling = Object.assign({}, d, { maxTokens: 170000 });
    assert.strictEqual(overThreshold({ pct: 90, used: 180000, windowKnown: true }, withCeiling), 'pct');
    assert.strictEqual(overThreshold({ pct: 20, used: 200000, windowKnown: true }, withCeiling), 'tokens');
    assert.strictEqual(overThreshold({ pct: 90, used: 180000, windowKnown: false }, withCeiling), 'tokens');
    assert.strictEqual(overThreshold({ pct: 90, used: 180000, windowKnown: false }, Object.assign({}, d, { maxTokens: 0 })), 'pct-unknown-window');
    assert.strictEqual(overThreshold({ pct: 10, used: 20000, windowKnown: true }, withCeiling), null);
    assert.strictEqual(overThreshold({ pct: 99, used: 999999, windowKnown: true }, resolveEffective({ home: h.home, env: { ANTIHALL_AUTO_HANDOVER_PCT: '0' } })), null);
  } finally {
    h.cleanup();
  }
});

test('CLI max-tokens: persists a valid ceiling (0 = off), rejects junk without writing', () => {
  const h = makeHome();
  try {
    let code;
    withHomeEnv(h.home, () => {
      const prevExit = process.exitCode;
      CLI.cmdMaxTokens('-5');
      code = process.exitCode;
      process.exitCode = prevExit;
    });
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(readConfig(h.home), {});
    withHomeEnv(h.home, () => CLI.cmdMaxTokens('250000'));
    assert.strictEqual(resolveEffective({ home: h.home, env: {} }).maxTokens, 250000);
    withHomeEnv(h.home, () => CLI.cmdMaxTokens('0'));
    assert.strictEqual(resolveEffective({ home: h.home, env: {} }).maxTokens, 0);
  } finally {
    h.cleanup();
  }
});
