'use strict';
// companion/lib/devswarm-archived-cache.js — the CACHE FILE contract.
//
// The four-conjunct absence RULE is pinned in
// tests/companion/devswarm-active-cache-absence.test.js. This file pins the
// layer beneath it: what may be written, what a reader accepts, and the
// freshness bound — the invariants a malformed or hostile file must not be able
// to break.
//
// The shape changed with the D3->D4 redesign (measured: hivecontrol 2.5.1's
// `workspace list all` carries no archive field, so the cache holds the ACTIVE
// set and archive is derived from absence). These tests were rewritten with it.
//
// MUTATION CHECKS (each must turn a named test RED):
//   M1: drop the freshness bound (`fresh = true`) -> "a STALE file yields nothing".
//   M2: make writeActiveCache MERGE instead of replace -> "a newer sweep REPLACES".
//   M3: accept a record with no id -> "malformed records are dropped".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

const NOW = 1_700_000_000_000;
const MAX_AGE = 60_000;
const ENV = { ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS: String(MAX_AGE) };

function mkhome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-cache-'));
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function writeRaw(home, obj) {
  const p = cacheLib.cachePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function read(home, now) {
  return cacheLib.readActiveCache({ home, env: ENV, now: now == null ? NOW : now });
}

test('a well-formed FRESH file round-trips its records and count', () => {
  const h = mkhome();
  try {
    cacheLib.writeActiveCache({
      home: h.home, now: NOW,
      byRepoKey: { 'repo-a': [{ id: 'ws1', worktreePath: '/w/1' }, { id: 'ws2', worktreePath: '/w/2' }] },
    });
    const c = read(h.home);
    assert.strictEqual(c.present, true);
    assert.strictEqual(c.fresh, true);
    assert.strictEqual(c.fetchedAt, NOW);
    assert.strictEqual(c.recordCount, 2);
    assert.deepStrictEqual(c.byRepoKey['repo-a'].map((r) => r.id), ['ws1', 'ws2']);
  } finally { h.cleanup(); }
});

test('M1 — a STALE file yields nothing, and the boundary is inclusive', () => {
  const h = mkhome();
  try {
    cacheLib.writeActiveCache({ home: h.home, now: NOW, byRepoKey: { 'repo-a': [{ id: 'ws1' }] } });
    assert.strictEqual(read(h.home, NOW + MAX_AGE).fresh, true, 'exactly at the bound is still fresh');
    const stale = read(h.home, NOW + MAX_AGE + 1);
    assert.strictEqual(stale.fresh, false);
    assert.deepStrictEqual(stale.byRepoKey, {}, 'a stale snapshot must expose no records at all');
    assert.strictEqual(stale.recordCount, 0);
  } finally { h.cleanup(); }
});

test('a FUTURE fetchedAt is treated as stale, never as fresh', () => {
  const h = mkhome();
  try {
    cacheLib.writeActiveCache({ home: h.home, now: NOW + 60_000, byRepoKey: { 'repo-a': [{ id: 'ws1' }] } });
    assert.strictEqual(read(h.home, NOW).fresh, false);
  } finally { h.cleanup(); }
});

test('M3 — malformed files and malformed records are dropped, never guessed at', () => {
  const h = mkhome();
  try {
    for (const bad of ['not json at all', '[]', 'null', '"a string"']) {
      writeRaw(h.home, bad);
      assert.deepStrictEqual(read(h.home).byRepoKey, {}, 'input: ' + bad);
    }
    // Present but with no usable fetchedAt.
    writeRaw(h.home, { byRepoKey: { 'repo-a': [{ id: 'ws1' }] } });
    const noTs = read(h.home);
    assert.strictEqual(noTs.present, true);
    assert.strictEqual(noTs.fresh, false);
    // A non-array bucket, and records with no id, are both discarded.
    writeRaw(h.home, { fetchedAt: NOW, byRepoKey: { 'repo-a': 'nope', 'repo-b': [{ worktreePath: '/w' }, 5, null, { id: 'ok' }] } });
    const c = read(h.home);
    assert.strictEqual(c.byRepoKey['repo-a'], undefined);
    assert.deepStrictEqual(c.byRepoKey['repo-b'], [{ id: 'ok', worktreePath: null }]);
  } finally { h.cleanup(); }
});

test('a bucket that normalizes to ZERO records is dropped, not read as "all archived"', () => {
  const h = mkhome();
  try {
    writeRaw(h.home, { fetchedAt: NOW, byRepoKey: { 'repo-a': [{ nope: 1 }] } });
    const c = read(h.home);
    assert.strictEqual(c.fresh, true);
    assert.strictEqual(c.byRepoKey['repo-a'], undefined,
      'an empty bucket is absence-of-evidence, never evidence that nothing is live');
  } finally { h.cleanup(); }
});

test('a MISSING file reads as absent, and nothing throws', () => {
  const h = mkhome();
  try {
    const c = read(h.home);
    assert.strictEqual(c.present, false);
    assert.strictEqual(c.fresh, false);
    assert.deepStrictEqual(c.byRepoKey, {});
  } finally { h.cleanup(); }
});

test('M2 — a newer sweep REPLACES the previous snapshot (never merges it forward)', () => {
  const h = mkhome();
  try {
    cacheLib.writeActiveCache({ home: h.home, now: NOW, byRepoKey: { 'repo-a': [{ id: 'ws1' }], 'repo-b': [{ id: 'x' }] } });
    cacheLib.writeActiveCache({ home: h.home, now: NOW + 1000, byRepoKey: { 'repo-a': [{ id: 'ws1' }, { id: 'ws2' }] } });
    const c = read(h.home, NOW + 1000);
    assert.deepStrictEqual(c.byRepoKey['repo-a'].map((r) => r.id), ['ws1', 'ws2']);
    assert.strictEqual(c.byRepoKey['repo-b'], undefined,
      'a project not probed this tick must not inherit an older tick\'s fetchedAt');
  } finally { h.cleanup(); }
});

test('writeActiveCache refuses an empty snapshot and leaves no file behind', () => {
  const h = mkhome();
  try {
    assert.strictEqual(cacheLib.writeActiveCache({ home: h.home, byRepoKey: {}, now: NOW }), null);
    assert.strictEqual(cacheLib.writeActiveCache({ home: h.home, byRepoKey: { 'repo-a': [] }, now: NOW }), null);
    assert.strictEqual(cacheLib.writeActiveCache({ home: h.home, byRepoKey: { 'repo-a': 'nope' }, now: NOW }), null);
    assert.strictEqual(fs.existsSync(cacheLib.cachePath(h.home)), false);
  } finally { h.cleanup(); }
});

test('the freshness bound defaults to 2x the sweep interval and is env-tunable', () => {
  const sup = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');
  const env = {};
  assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs(env), 2 * sup.resolveReconcileCooldownMs(env));
  assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs(ENV), MAX_AGE);
  // A junk override falls back to the derived default rather than disabling the bound.
  assert.strictEqual(
    cacheLib.resolveArchivedCacheMaxAgeMs({ ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS: 'forever' }),
    2 * sup.resolveReconcileCooldownMs({}));
});

test('the cache file lives under devswarmRoot and is named for what it holds', () => {
  const h = mkhome();
  try {
    assert.strictEqual(cacheLib.CACHE_BASENAME, 'hivecontrol-active.json');
    assert.strictEqual(path.basename(cacheLib.cachePath(h.home)), cacheLib.CACHE_BASENAME);
    assert.strictEqual(cacheLib.archivedCachePath(h.home), cacheLib.cachePath(h.home));
  } finally { h.cleanup(); }
});
