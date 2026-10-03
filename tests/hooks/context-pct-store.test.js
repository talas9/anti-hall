'use strict';
// hooks/lib/context-pct-store.js — the statusline -> hook bridge for the
// harness's own context_window figure.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeHome } = require('../helpers/fixtures.js');
const store = require('../../plugins/anti-hall/hooks/lib/context-pct-store.js');

test('tagFromSessionId: sanitizes and bounds; null for absent/blank', () => {
  assert.strictEqual(store.tagFromSessionId('abc-123_XYZ'), 'abc-123_XYZ');
  assert.strictEqual(store.tagFromSessionId('a/b c!'), 'abc');
  assert.strictEqual(store.tagFromSessionId(''), null);
  assert.strictEqual(store.tagFromSessionId('   '), null);
  assert.strictEqual(store.tagFromSessionId(undefined), null);
  assert.strictEqual(store.tagFromSessionId(null), null);
});

test('write() then read(): round-trips pct/usedTokens/maxTokens', () => {
  const h = makeHome();
  try {
    const ok = store.write(h.home, 's1', { pct: 62, usedTokens: 620000, maxTokens: 1000000 });
    assert.strictEqual(ok, true);
    const r = store.read(h.home, 's1', 10 * 60 * 1000);
    assert.deepStrictEqual({ pct: r.pct, usedTokens: r.usedTokens, maxTokens: r.maxTokens }, { pct: 62, usedTokens: 620000, maxTokens: 1000000 });
  } finally {
    h.cleanup();
  }
});

test('read(): null when the file is older than maxAgeMs (stale)', () => {
  const h = makeHome();
  try {
    store.write(h.home, 's1', { pct: 90, usedTokens: 1, maxTokens: 2 }, Date.now() - 11 * 60 * 1000);
    const r = store.read(h.home, 's1', 10 * 60 * 1000);
    assert.strictEqual(r, null);
  } finally {
    h.cleanup();
  }
});

test('read(): null for a missing tag / no file at all', () => {
  const h = makeHome();
  try {
    assert.strictEqual(store.read(h.home, 'nope', 10 * 60 * 1000), null);
    assert.strictEqual(store.read(h.home, null, 10 * 60 * 1000), null);
  } finally {
    h.cleanup();
  }
});

test('write(): throttled — skips a write within WRITE_INTERVAL_MS when the delta is under WRITE_MIN_DELTA', () => {
  const h = makeHome();
  try {
    const t0 = Date.now();
    assert.strictEqual(store.write(h.home, 's1', { pct: 50 }, t0), true);
    // 5s later, pct barely moved -> throttled (no write).
    const wrote = store.write(h.home, 's1', { pct: 50.4 }, t0 + 5000);
    assert.strictEqual(wrote, false);
    const r = store.read(h.home, 's1', 10 * 60 * 1000);
    assert.strictEqual(r.pct, 50); // unchanged — the throttled write never landed
  } finally {
    h.cleanup();
  }
});

test('write(): a >=1-point delta writes immediately even inside the throttle interval', () => {
  const h = makeHome();
  try {
    const t0 = Date.now();
    store.write(h.home, 's1', { pct: 50 }, t0);
    const wrote = store.write(h.home, 's1', { pct: 52 }, t0 + 1000);
    assert.strictEqual(wrote, true);
    assert.strictEqual(store.read(h.home, 's1', 10 * 60 * 1000).pct, 52);
  } finally {
    h.cleanup();
  }
});

test('write(): writes again once WRITE_INTERVAL_MS has elapsed, even with no delta', () => {
  const h = makeHome();
  try {
    const t0 = Date.now();
    store.write(h.home, 's1', { pct: 50 }, t0);
    const wrote = store.write(h.home, 's1', { pct: 50 }, t0 + store.WRITE_INTERVAL_MS + 1);
    assert.strictEqual(wrote, true);
  } finally {
    h.cleanup();
  }
});

test('write(): no tag -> false, never throws', () => {
  const h = makeHome();
  try {
    assert.strictEqual(store.write(h.home, null, { pct: 50 }), false);
  } finally {
    h.cleanup();
  }
});
