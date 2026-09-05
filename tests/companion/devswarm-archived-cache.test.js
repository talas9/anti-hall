'use strict';
// companion/lib/devswarm-archived-cache.js — APP-SIDE archive detection.
//
// FIELD ROOT CAUSE: the owner archived children in the DevSwarm app. That flow
// never calls anti-hall's `archive` verb, so `archived/<id>.json` was never
// written and every reader keyed off isArchivedWorkspace kept rendering those
// rows as escalated / stale / not-draining.
//
// The whole safety argument is FRESHNESS: the cache is a snapshot of another
// system's state, so it may only suppress while it is young. These tests pin
// that bound, the fail-open behaviours around it, and the write shape.
//
// MUTATION LIST (each proven RED against this file, see the task report):
//   M1: drop the freshness bound in readArchivedCache (`const fresh = true`)
//       -> kills "STALE cache suppresses NOTHING".
//   M2: ignore ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS
//       -> kills the env-override test.
//   M3: make writeArchivedCache MERGE instead of replace
//       -> kills "a newer sweep OVERWRITES a re-opened id".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');
const supervisor = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-cache-'));
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function writeRaw(home, obj) {
  const p = cacheLib.archivedCachePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

const NOW = 1_800_000_000_000;
const ENV = {}; // no overrides -> default bound = 2x the sweep interval

test('FRESH cache: a listed id reads as app-archived', () => {
  const h = makeHome();
  try {
    writeRaw(h.home, { fetchedAt: NOW - 60_000, byRepoKey: { 'repo-a': ['ws1', 'ws2'] } });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), true);
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'nope', env: ENV, now: NOW }), false);
    // Another project's list never leaks across.
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-b', id: 'ws1', env: ENV, now: NOW }), false);
  } finally { h.cleanup(); }
});

test('STALE cache suppresses NOTHING (the freshness bound is the safety argument)', () => {
  const h = makeHome();
  try {
    const maxAge = cacheLib.resolveArchivedCacheMaxAgeMs(ENV);
    writeRaw(h.home, { fetchedAt: NOW - (maxAge + 1), byRepoKey: { 'repo-a': ['ws1'] } });
    const c = cacheLib.readArchivedCache({ home: h.home, env: ENV, now: NOW });
    assert.strictEqual(c.present, true);
    assert.strictEqual(c.fresh, false);
    assert.deepStrictEqual(c.byRepoKey, {}, 'a stale snapshot must expose no ids at all');
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
  } finally { h.cleanup(); }
});

test('EXACTLY at the bound is still fresh; one ms past is not', () => {
  const h = makeHome();
  try {
    const maxAge = cacheLib.resolveArchivedCacheMaxAgeMs(ENV);
    writeRaw(h.home, { fetchedAt: NOW - maxAge, byRepoKey: { 'repo-a': ['ws1'] } });
    assert.strictEqual(cacheLib.readArchivedCache({ home: h.home, env: ENV, now: NOW }).fresh, true);
    assert.strictEqual(cacheLib.readArchivedCache({ home: h.home, env: ENV, now: NOW + 1 }).fresh, false);
  } finally { h.cleanup(); }
});

test('a FUTURE fetchedAt is not evidence of freshness', () => {
  const h = makeHome();
  try {
    writeRaw(h.home, { fetchedAt: NOW + 60_000, byRepoKey: { 'repo-a': ['ws1'] } });
    assert.strictEqual(cacheLib.readArchivedCache({ home: h.home, env: ENV, now: NOW }).fresh, false);
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
  } finally { h.cleanup(); }
});

test('MALFORMED / MISSING cache is ignored, never thrown', () => {
  const h = makeHome();
  try {
    // missing
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
    // not JSON
    writeRaw(h.home, 'not json at all');
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
    // JSON, wrong shape (array)
    writeRaw(h.home, ['ws1']);
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
    // no fetchedAt -> unbounded age, must never be believed
    writeRaw(h.home, { byRepoKey: { 'repo-a': ['ws1'] } });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
    // fresh, but the per-project entry is not an array
    writeRaw(h.home, { fetchedAt: NOW, byRepoKey: { 'repo-a': { ws1: true } } });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), false);
    // fresh, entry array with junk members -> only the strings survive
    writeRaw(h.home, { fetchedAt: NOW, byRepoKey: { 'repo-a': [null, 3, '', 'ws1'] } });
    assert.deepStrictEqual(cacheLib.readArchivedCache({ home: h.home, env: ENV, now: NOW }).byRepoKey['repo-a'], ['ws1']);
  } finally { h.cleanup(); }
});

test('no repoKey -> no suppression (fail-open)', () => {
  const h = makeHome();
  try {
    writeRaw(h.home, { fetchedAt: NOW, byRepoKey: { 'repo-a': ['ws1'] } });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: null, id: 'ws1', env: ENV, now: NOW }), false);
  } finally { h.cleanup(); }
});

test('DEFAULT bound is 2x the supervisor reconcile-sweep interval, and TRACKS it', () => {
  // Not a restated constant: read from the supervisor's own resolver, so a
  // change there can never silently leave this bound behind.
  assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs({}),
    2 * supervisor.resolveReconcileCooldownMs({}));
  const tuned = { ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC: '1800' };
  assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs(tuned),
    2 * supervisor.resolveReconcileCooldownMs(tuned));
  assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs(tuned), 3_600_000);
});

test('ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS overrides the bound', () => {
  const h = makeHome();
  try {
    const env = { ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS: '5000' };
    assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs(env), 5000);
    writeRaw(h.home, { fetchedAt: NOW - 6000, byRepoKey: { 'repo-a': ['ws1'] } });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env, now: NOW }), false);
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), true);
    // Junk / non-positive values fall back to the default, never to "no bound".
    for (const raw of ['0', '-1', 'abc', '']) {
      assert.strictEqual(cacheLib.resolveArchivedCacheMaxAgeMs({ ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS: raw }),
        cacheLib.resolveArchivedCacheMaxAgeMs({}), 'junk override -> default bound, not unbounded');
    }
  } finally { h.cleanup(); }
});

test('writeArchivedCache: atomic round-trip, and a newer sweep OVERWRITES a re-opened id', () => {
  const h = makeHome();
  try {
    cacheLib.writeArchivedCache({ home: h.home, byRepoKey: { 'repo-a': ['ws1', 'ws2'] }, now: NOW });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW }), true);
    // ws1 was re-opened in the app; the next sweep reports only ws2.
    cacheLib.writeArchivedCache({ home: h.home, byRepoKey: { 'repo-a': ['ws2'] }, now: NOW + 1000 });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws1', env: ENV, now: NOW + 1000 }), false,
      'a re-opened id must not survive in the cache — the newer sweep is authoritative');
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws2', env: ENV, now: NOW + 1000 }), true);
    // A project absent from the newest sweep is NOT carried forward under the
    // new (fresh) fetchedAt — that would let one timestamp vouch for an older
    // snapshot. Absent == not suppressed.
    cacheLib.writeArchivedCache({ home: h.home, byRepoKey: { 'repo-b': ['x'] }, now: NOW + 2000 });
    assert.strictEqual(cacheLib.isAppArchived({ home: h.home, repoKey: 'repo-a', id: 'ws2', env: ENV, now: NOW + 2000 }), false);
    // No .tmp left behind.
    const dir = path.dirname(cacheLib.archivedCachePath(h.home));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'tmp file must be renamed away');
  } finally { h.cleanup(); }
});
