'use strict';
// devswarm-drain-marker.js — write/read/clear the per-(home, primaryId)
// in-flight-drain TTL marker (defect 13dedc334eb6). Pure fs, isolated fixture
// HOME per test (never the real machine's ~/.anti-hall).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');
const drainMarker = require('../../plugins/anti-hall/companion/lib/devswarm-drain-marker.js');

const ID = 'primary-abc123';

test('markDrainStart writes a marker; readDrainMarker reads it back fresh', () => {
  const h = makeHome();
  try {
    const now = Date.now();
    const ok = drainMarker.markDrainStart(h.home, ID, { now, sessionId: 'sess-1', pid: 4242, count: 3 });
    assert.strictEqual(ok, true);
    const marker = drainMarker.readDrainMarker(h.home, ID, { now });
    assert.ok(marker, 'marker must be readable');
    assert.strictEqual(marker.stale, false);
    assert.strictEqual(marker.sessionId, 'sess-1');
    assert.strictEqual(marker.pid, 4242);
    assert.strictEqual(marker.count, 3);
    assert.strictEqual(marker.startedAt, now);
  } finally { h.cleanup(); }
});

test('readDrainMarker: absent marker -> null', () => {
  const h = makeHome();
  try {
    const marker = drainMarker.readDrainMarker(h.home, ID, {});
    assert.strictEqual(marker, null);
  } finally { h.cleanup(); }
});

// MUTATION-CHECK TARGET: delete the TTL check ("age >= 0 && age <= ttl") in
// devswarm-drain-marker.js's readDrainMarker and this test fails (a marker
// far past the TTL would read back stale:false).
test('TTL staleness: a marker older than the TTL reads back stale:true', () => {
  const h = makeHome();
  try {
    const startedAt = Date.now() - (20 * 60 * 1000); // 20 min ago, default TTL is 10 min
    drainMarker.markDrainStart(h.home, ID, { now: startedAt, sessionId: 'sess-1' });
    const marker = drainMarker.readDrainMarker(h.home, ID, { now: Date.now() });
    assert.ok(marker, 'marker file itself must still be readable');
    assert.strictEqual(marker.stale, true, 'a marker past the TTL must be reported as stale');
  } finally { h.cleanup(); }
});

test('TTL staleness: a marker within a CUSTOM ttlMs stays fresh, and past it goes stale', () => {
  const h = makeHome();
  try {
    const startedAt = Date.now() - 5000; // 5s ago
    drainMarker.markDrainStart(h.home, ID, { now: startedAt, sessionId: 'sess-1' });
    const fresh = drainMarker.readDrainMarker(h.home, ID, { now: Date.now(), ttlMs: 10000 }); // 10s TTL
    assert.strictEqual(fresh.stale, false);
    const stale = drainMarker.readDrainMarker(h.home, ID, { now: Date.now(), ttlMs: 1000 }); // 1s TTL
    assert.strictEqual(stale.stale, true);
  } finally { h.cleanup(); }
});

test('ANTIHALL_DEVSWARM_DRAIN_TTL_MS env override is honored by ttlMs()/readDrainMarker', () => {
  const h = makeHome();
  try {
    const startedAt = Date.now() - 5000; // 5s ago
    drainMarker.markDrainStart(h.home, ID, { now: startedAt, sessionId: 'sess-1' });
    const env = { ANTIHALL_DEVSWARM_DRAIN_TTL_MS: '1000' }; // 1s TTL via env
    const marker = drainMarker.readDrainMarker(h.home, ID, { now: Date.now(), env });
    assert.strictEqual(marker.stale, true, 'a 1s env TTL must make a 5s-old marker stale');
  } finally { h.cleanup(); }
});

test('a future startedAt (clock skew) is never treated as fresh', () => {
  const h = makeHome();
  try {
    const now = Date.now();
    drainMarker.markDrainStart(h.home, ID, { now: now + 60000, sessionId: 'sess-1' }); // 1 min in the future
    const marker = drainMarker.readDrainMarker(h.home, ID, { now });
    assert.strictEqual(marker.stale, true, 'a future startedAt must not count as proof of a fresh drain');
  } finally { h.cleanup(); }
});

test('clearDrainMarker removes the marker file; returns true when nothing existed', () => {
  const h = makeHome();
  try {
    drainMarker.markDrainStart(h.home, ID, { now: Date.now(), sessionId: 'sess-1' });
    const p = drainMarker.drainMarkerPathFor(ID, h.home);
    assert.ok(fs.existsSync(p));
    assert.strictEqual(drainMarker.clearDrainMarker(h.home, ID), true);
    assert.ok(!fs.existsSync(p));
    // clearing again (nothing there) still reports true (already cleared)
    assert.strictEqual(drainMarker.clearDrainMarker(h.home, ID), true);
  } finally { h.cleanup(); }
});

test('clearStaleDrainMarker only clears when the marker is actually stale', () => {
  const h = makeHome();
  try {
    const p = drainMarker.drainMarkerPathFor(ID, h.home);

    // fresh marker: clearStaleDrainMarker must NOT remove it.
    const now = Date.now();
    drainMarker.markDrainStart(h.home, ID, { now, sessionId: 'sess-1' });
    const clearedFresh = drainMarker.clearStaleDrainMarker(h.home, ID, { now });
    assert.strictEqual(clearedFresh, false);
    assert.ok(fs.existsSync(p), 'fresh marker must survive clearStaleDrainMarker');

    // stale marker: clearStaleDrainMarker must remove it.
    const staleStart = Date.now() - (20 * 60 * 1000);
    drainMarker.markDrainStart(h.home, ID, { now: staleStart, sessionId: 'sess-1' });
    const clearedStale = drainMarker.clearStaleDrainMarker(h.home, ID, { now: Date.now() });
    assert.strictEqual(clearedStale, true);
    assert.ok(!fs.existsSync(p), 'stale marker must be removed');
  } finally { h.cleanup(); }
});

// FAIL-SOFT ON FS ERRORS — an injected fs whose calls throw must never crash
// the caller: markDrainStart returns false, readDrainMarker returns null,
// clearDrainMarker returns false.
test('fail-soft: fs errors on every operation degrade instead of throwing', () => {
  const throwingFs = {
    mkdirSync() { throw new Error('boom'); },
    writeFileSync() { throw new Error('boom'); },
    renameSync() { throw new Error('boom'); },
    readFileSync() { throw new Error('boom'); },
    unlinkSync() { throw new Error('boom'); },
  };
  const h = makeHome();
  try {
    assert.strictEqual(drainMarker.markDrainStart(h.home, ID, { fs: throwingFs, now: Date.now() }), false);
    assert.strictEqual(drainMarker.readDrainMarker(h.home, ID, { fs: throwingFs }), null);
    assert.strictEqual(drainMarker.clearDrainMarker(h.home, ID, { fs: throwingFs }), false);
  } finally { h.cleanup(); }
});

test('unsafe id -> every operation fails soft (never throws, never path.joins the raw id)', () => {
  const h = makeHome();
  try {
    assert.strictEqual(drainMarker.markDrainStart(h.home, '../evil', { now: Date.now() }), false);
    assert.strictEqual(drainMarker.readDrainMarker(h.home, '../evil', {}), null);
    assert.strictEqual(drainMarker.clearDrainMarker(h.home, '../evil'), false);
  } finally { h.cleanup(); }
});

test('malformed marker JSON (missing startedAt) reads back as null, not a fabricated marker', () => {
  const h = makeHome();
  try {
    const p = drainMarker.drainMarkerPathFor(ID, h.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sessionId: 'sess-1' })); // no startedAt
    const marker = drainMarker.readDrainMarker(h.home, ID, {});
    assert.strictEqual(marker, null);
  } finally { h.cleanup(); }
});

test('drainMarkerPathFor lands under <home>/.anti-hall/devswarm/drain/<id>.json', () => {
  const h = makeHome();
  const p = drainMarker.drainMarkerPathFor(ID, h.home);
  assert.strictEqual(p, path.join(h.home, '.anti-hall', 'devswarm', 'drain', ID + '.json'));
  h.cleanup();
});

// ---------------------------------------------------------------------------
// matchesSession (R11 Reviewer item 2 + Critic iv, 2026-09): the SOLE
// identity-match rule devswarm-parent-gate.js applies to a fresh drain
// marker — sessionId only. `pid` must NEVER participate: the writer (a
// `devswarm.js inbox read-primary` CLI process) and the reader (this Stop
// hook, a separate process) are always different OS processes, and pid
// reuse inside the marker's TTL window can make an unrelated later process's
// pid coincide with a stale marker's recorded pid purely by chance.
// ---------------------------------------------------------------------------

test('matchesSession: same sessionId -> true, regardless of pid', () => {
  assert.strictEqual(drainMarker.matchesSession({ sessionId: 'sess-1', pid: 42 }, 'sess-1'), true);
});

test('matchesSession: pid EQUALS the caller\'s own process.pid but sessionId differs -> false (pid must never match on its own)', () => {
  // Proves pid is structurally excluded from the match: even the caller's
  // OWN real process.pid recorded on the marker cannot substitute for a
  // matching sessionId.
  assert.strictEqual(drainMarker.matchesSession({ sessionId: 'some-other-session', pid: process.pid }, 'sess-1'), false);
});

test('matchesSession: different sessionId -> false', () => {
  assert.strictEqual(drainMarker.matchesSession({ sessionId: 'sess-a' }, 'sess-b'), false);
});

test('matchesSession: empty-string sessionId on the marker side -> false, even against an empty-string caller sessionId', () => {
  assert.strictEqual(drainMarker.matchesSession({ sessionId: '' }, ''), false);
});

test('matchesSession: null/missing sessionId on either side -> false', () => {
  assert.strictEqual(drainMarker.matchesSession({ sessionId: null }, 'sess-1'), false);
  assert.strictEqual(drainMarker.matchesSession({ sessionId: 'sess-1' }, null), false);
  assert.strictEqual(drainMarker.matchesSession({ sessionId: 'sess-1' }, undefined), false);
  assert.strictEqual(drainMarker.matchesSession({}, 'sess-1'), false);
});

test('matchesSession: null marker -> false', () => {
  assert.strictEqual(drainMarker.matchesSession(null, 'sess-1'), false);
});

// MUTATION-CHECK (documented for reproducibility): restoring the OLD
// `sessionMatch || pidMatch` OR-with-pid logic (e.g. `return sid === markerSid
// || (Number.isFinite(marker.pid) && marker.pid === <caller pid>)`) would KILL
// the "pid equals caller's own process.pid but sessionId differs" test above
// (it would flip from false to true) — confirmed by re-deriving that branch
// inline and re-running this file: RED, then reverted to matchesSession()
// and confirmed GREEN again.
