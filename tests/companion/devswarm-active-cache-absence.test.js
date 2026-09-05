'use strict';
// companion/lib/devswarm-archived-cache.js — APP-SIDE archive detection BY ABSENCE.
//
// ROOT CAUSE this pins (measured, hivecontrol 2.5.1): `hivecontrol workspace
// list all` emits records carrying EXACTLY {id, branch, sourceBranch,
// repositoryId, label, aiAgent, worktreePath, createdAt} and takes no filter
// flags. The prior field-pinned probe looked for an `archived`/`isArchived`/
// `status`/`isHidden`/`isActive` key, found none, and therefore wrote NOTHING
// — the feature was inert. Archive is expressed by MEMBERSHIP: an archived
// workspace stops being listed. These tests pin the four conjuncts that make
// deriving "archived" from absence safe.
//
// MUTATION CHECKS (each must turn a named test RED):
//   M1: drop the repos-root conjunct (isUnderDevswarmReposRoot -> always true)
//       -> "a row OUTSIDE the DevSwarm repos root is never app-archived" fails.
//   M2: drop the grace conjunct (skip the fetchedAt - firstSeen comparison)
//       -> "a row younger than the grace is not app-archived" fails.
//   M3: drop the freshness bound (readActiveCache `fresh = true`)
//       -> "a STALE cache suppresses nothing" fails.
//   M4: let writeActiveCache write an empty snapshot
//       -> "an EMPTY active list writes nothing" fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

const NOW = 1_700_000_000_000;
const MAX_AGE = 60_000;
const GRACE = 10 * 60 * 1000;
// ENV pins the freshness bound so the test never depends on the supervisor's
// live cooldown resolver.
const ENV = { ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS: String(MAX_AGE) };

// A worktree the DevSwarm app manages, and one it does not (the Primary's own
// checkout). The repos-root conjunct is exactly this distinction.
const APP_WT = '/Users/x/.devswarm/repos/1/abc123/feat-thing';
const OWN_WT = '/Users/x/Projects/anti-hall';

function mkhome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'active-cache-'));
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// Give a row a registry descriptor whose mtime IS its "first seen" age source.
function seedDescriptor(home, id, firstSeenMs) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, id + '.json');
  fs.writeFileSync(p, JSON.stringify({ id, worktreePath: APP_WT }));
  const t = new Date(firstSeenMs);
  fs.utimesSync(p, t, t);
}

// An OLD row: registered comfortably before the snapshot, so the grace is met.
const OLD = NOW - (GRACE * 3);

function seedCache(home, records, fetchedAt) {
  return cacheLib.writeActiveCache({
    home, byRepoKey: { 'repo-a': records }, now: Number.isFinite(fetchedAt) ? fetchedAt : NOW,
  });
}

function archived(home, id, worktreePath, now) {
  return cacheLib.isAppArchived({
    home, repoKey: 'repo-a', id, worktreePath, env: ENV,
    now: Number.isFinite(now) ? now : NOW,
  });
}

test('a row ABSENT from the active list is app-archived', () => {
  const h = mkhome();
  try {
    seedDescriptor(h.home, 'ws-gone', OLD);
    // The snapshot lists a DIFFERENT workspace; ws-gone is simply not in it.
    seedCache(h.home, [{ id: 'ws-live', worktreePath: '/Users/x/.devswarm/repos/1/def456/other' }]);
    assert.strictEqual(archived(h.home, 'ws-gone', APP_WT), true);
  } finally { h.cleanup(); }
});

test('a row PRESENT in the active list is never app-archived (by id, and by worktreePath)', () => {
  const h = mkhome();
  try {
    seedDescriptor(h.home, 'ws-live', OLD);
    seedDescriptor(h.home, 'ws-twin', OLD);
    // ws-live matches by id. ws-twin has a DIFFERENT id but the SAME worktree —
    // an id-space divergence (a builder-id alias row) must not read as archived.
    seedCache(h.home, [{ id: 'ws-live', worktreePath: APP_WT }]);
    assert.strictEqual(archived(h.home, 'ws-live', APP_WT), false);
    assert.strictEqual(archived(h.home, 'ws-twin', APP_WT), false, 'worktreePath match alone proves liveness');
  } finally { h.cleanup(); }
});

test('M2 — a row younger than the grace is not app-archived', () => {
  const h = mkhome();
  try {
    // Registered ONE MINUTE before the snapshot: legitimately absent because the
    // app had not listed it yet, not because it was archived.
    seedDescriptor(h.home, 'ws-new', NOW - 60_000);
    seedCache(h.home, [{ id: 'ws-other', worktreePath: '/Users/x/.devswarm/repos/1/def456/other' }]);
    assert.strictEqual(archived(h.home, 'ws-new', APP_WT), false);
    // The SAME row, once it is older than the grace, IS archived — proving the
    // grace only defers the verdict, never cancels it.
    seedDescriptor(h.home, 'ws-new', OLD);
    assert.strictEqual(archived(h.home, 'ws-new', APP_WT), true);
  } finally { h.cleanup(); }
});

test('M1 — a row OUTSIDE the DevSwarm repos root is never app-archived (the Primary itself)', () => {
  const h = mkhome();
  try {
    seedDescriptor(h.home, 'primary-row', OLD);
    seedCache(h.home, [{ id: 'ws-live', worktreePath: APP_WT }]);
    // The Primary's own checkout was NEVER a DevSwarm workspace, so its absence
    // from the app's list carries no archive meaning at all.
    assert.strictEqual(archived(h.home, 'primary-row', OWN_WT), false);
    assert.strictEqual(cacheLib.isUnderDevswarmReposRoot(OWN_WT), false);
    assert.strictEqual(cacheLib.isUnderDevswarmReposRoot(APP_WT), true);
  } finally { h.cleanup(); }
});

test('M3 — a STALE cache suppresses nothing', () => {
  const h = mkhome();
  try {
    seedDescriptor(h.home, 'ws-gone', OLD);
    seedCache(h.home, [{ id: 'ws-live', worktreePath: APP_WT }], NOW - (MAX_AGE + 1));
    assert.strictEqual(cacheLib.readActiveCache({ home: h.home, env: ENV, now: NOW }).fresh, false);
    assert.strictEqual(archived(h.home, 'ws-gone', APP_WT), false);
  } finally { h.cleanup(); }
});

test('M4 — an EMPTY active list writes nothing (never "everything is archived")', () => {
  const h = mkhome();
  try {
    seedDescriptor(h.home, 'ws-gone', OLD);
    assert.strictEqual(cacheLib.writeActiveCache({ home: h.home, byRepoKey: { 'repo-a': [] }, now: NOW }), null);
    assert.strictEqual(fs.existsSync(cacheLib.cachePath(h.home)), false, 'no file written');
    assert.strictEqual(archived(h.home, 'ws-gone', APP_WT), false);
  } finally { h.cleanup(); }
});

test('a MISSING cache, an unknown row age, and another project\'s bucket all suppress nothing', () => {
  const h = mkhome();
  try {
    seedDescriptor(h.home, 'ws-gone', OLD);
    // No cache file at all.
    assert.strictEqual(archived(h.home, 'ws-gone', APP_WT), false);
    seedCache(h.home, [{ id: 'ws-live', worktreePath: APP_WT }]);
    // A row with NO descriptor file has no knowable age -> never suppressed.
    assert.strictEqual(archived(h.home, 'no-descriptor', APP_WT), false);
    // A snapshot for a DIFFERENT project says nothing about this one.
    assert.strictEqual(cacheLib.isAppArchived({
      home: h.home, repoKey: 'repo-b', id: 'ws-gone', worktreePath: APP_WT, env: ENV, now: NOW,
    }), false);
  } finally { h.cleanup(); }
});

test('the grace is tunable via ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS', () => {
  assert.strictEqual(cacheLib.resolveArchivedGraceMs({}), cacheLib.DEFAULT_ARCHIVED_GRACE_MS);
  assert.strictEqual(cacheLib.resolveArchivedGraceMs({ ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS: '900' }), 900);
  // A junk value falls back to the default rather than disabling the conjunct.
  assert.strictEqual(cacheLib.resolveArchivedGraceMs({ ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS: 'soon' }), cacheLib.DEFAULT_ARCHIVED_GRACE_MS);
});
