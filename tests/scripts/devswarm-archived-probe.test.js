'use strict';
// scripts/devswarm.js fetchActiveWorkspaceRecords + companion/devswarm-supervisor.js
// reconcileSweepIfDue's cache write — the APP-SIDE ARCHIVE PROBE, BY ABSENCE.
//
// ROOT CAUSE (measured on hivecontrol 2.5.1): `hivecontrol workspace list all`
// returns a flat JSON array whose records carry EXACTLY {id, branch,
// sourceBranch, repositoryId, label, aiAgent, worktreePath, createdAt}, and the
// subcommand accepts no filter flags. The earlier revision of this probe pinned
// an archive FIELD (`archived`/`isArchived`/`status`/`isHidden`/`isActive`),
// found none on any record, and therefore wrote nothing on every run — the
// feature was inert in the field. Archive is expressed by MEMBERSHIP instead, so
// the probe now caches the ACTIVE set verbatim and absence is evaluated at read
// time (companion/lib/devswarm-archived-cache.js).
//
// NO REAL hivecontrol IS EVER SPAWNED: `io.run` / `deps.runActiveList` are
// injected throughout.
//
// MUTATION CHECKS (each must turn a named test RED):
//   M1: let fetchActiveWorkspaceRecords report an empty list as ok
//       -> "an EMPTY list is refused" fails.
//   M2: drop the supervisor's `active.records.length` admission check
//       -> "a failed/empty probe writes NOTHING" fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const supervisor = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');
const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

// The measured record shape, verbatim — including the fields the probe ignores,
// so a future narrowing of the parser is caught here.
const REC = (id, wt) => ({
  id, branch: 'fix/' + id, sourceBranch: 'main', repositoryId: 'repo-uuid',
  label: 'Some workspace', aiAgent: 'claude', worktreePath: wt,
  createdAt: '2026-08-03T16:47:55.303Z',
});

const fakeRun = (payload) => () => ({ ok: true, raw: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const CTX = (run) => ({ io: { run }, env: {}, cwd: '/tmp' });

test('the MEASURED shape parses into {id, worktreePath} records', () => {
  const r = cli.fetchActiveWorkspaceRecords(CTX(fakeRun([
    REC('a', '/Users/x/.devswarm/repos/1/aa/one'),
    REC('b', '/Users/x/.devswarm/repos/1/bb/two'),
  ])));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 2);
  assert.deepStrictEqual(r.records, [
    { id: 'a', worktreePath: '/Users/x/.devswarm/repos/1/aa/one' },
    { id: 'b', worktreePath: '/Users/x/.devswarm/repos/1/bb/two' },
  ]);
});

test('a {children:[...]} envelope is accepted, and a record with no id is dropped', () => {
  const r = cli.fetchActiveWorkspaceRecords(CTX(fakeRun({ children: [REC('a', '/w/a'), { branch: 'x' }] })));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.records.map((x) => x.id), ['a']);
});

test('a record with NO worktreePath still yields an id-only record', () => {
  const r = cli.fetchActiveWorkspaceRecords(CTX(fakeRun([{ id: 'a' }])));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.records, [{ id: 'a', worktreePath: null }]);
});

test('M1 — an EMPTY list is refused, never reported as a usable snapshot', () => {
  // Under absence semantics this is the dangerous case: cached, it would assert
  // that EVERY registry row in the project is archived.
  const r = cli.fetchActiveWorkspaceRecords(CTX(fakeRun([])));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'hivecontrol-empty-list');
});

test('unusable output fails closed with a reason, never throws', () => {
  assert.strictEqual(cli.fetchActiveWorkspaceRecords(CTX(fakeRun('<html>'))).reason, 'hivecontrol-shape-unrecognized');
  assert.strictEqual(cli.fetchActiveWorkspaceRecords(CTX(fakeRun({ nope: 1 }))).reason, 'hivecontrol-shape-unrecognized');
  assert.strictEqual(cli.fetchActiveWorkspaceRecords(CTX(() => null)).reason, 'hivecontrol-unavailable');
  assert.strictEqual(cli.fetchActiveWorkspaceRecords(CTX(() => ({ ok: false, error: 'Repository not found' }))).reason, 'hivecontrol-unavailable');
  assert.strictEqual(cli.fetchActiveWorkspaceRecords(CTX(() => { throw new Error('boom'); })).reason, 'hivecontrol-unavailable');
});

// --- supervisor sweep: what actually reaches disk -------------------------
const { makeHome } = require('../helpers/fixtures.js');

// Drive reconcileSweepIfDue with EVERY heavy dep injected — no reconcile, no
// fold, no hivecontrol, no git.
function sweepDeps(extra) {
  return Object.assign({
    readDescriptors: () => [{ id: 'ws1', worktreePath: '/Users/x/.devswarm/repos/1/aa/one', sessionId: 's1' }],
    repoKeyForWorktree: () => 'repo-a',
    readReconcileSweepState: () => ({ lastRunAt: 0 }),
    writeReconcileSweepState: () => {},
    runReconcile: () => ({ ok: true }),
    runFold: () => ({ ok: true }),
  }, extra || {});
}

const SWEEP_NOW = 1_800_000_000_000;

test('a SUCCESSFUL probe writes the active set under the sweep target repoKey', () => {
  const h = makeHome();
  try {
    const r = supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: sweepDeps({ runActiveList: () => ({ ok: true, records: [{ id: 'ws1', worktreePath: '/w/a' }], count: 1 }) }),
    });
    assert.strictEqual(r.ran, true);
    const c = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW });
    assert.strictEqual(c.fresh, true);
    assert.deepStrictEqual(c.byRepoKey, { 'repo-a': [{ id: 'ws1', worktreePath: '/w/a' }] });
    assert.strictEqual(c.recordCount, 1);
  } finally { h.cleanup(); }
});

test('M2 — a failed or empty probe writes NOTHING (nothing suppressed)', () => {
  for (const probe of [
    () => ({ ok: false, reason: 'hivecontrol-empty-list' }),
    () => ({ ok: false, reason: 'hivecontrol-unavailable' }),
    () => ({ ok: true, records: [], count: 0 }), // belt AND braces: ok-but-empty is still refused
    () => { throw new Error('probe exploded'); },
  ]) {
    const h = makeHome();
    try {
      const r = supervisor.reconcileSweepIfDue({
        home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
        deps: sweepDeps({ runActiveList: probe }),
      });
      assert.strictEqual(r.ran, true, 'a probe failure must never break the sweep');
      assert.strictEqual(fs.existsSync(cacheLib.cachePath(h.home)), false,
        'no cache file may be written from a probe that reported no records');
    } finally { h.cleanup(); }
  }
});

test('a newer sweep REPLACES the previous snapshot (a re-opened workspace reappears)', () => {
  const h = makeHome();
  try {
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: sweepDeps({ runActiveList: () => ({ ok: true, records: [{ id: 'ws2', worktreePath: '/w/b' }], count: 1 }) }),
    });
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW + 1000,
      deps: sweepDeps({ runActiveList: () => ({ ok: true, records: [{ id: 'ws1', worktreePath: '/w/a' }, { id: 'ws2', worktreePath: '/w/b' }], count: 2 }) }),
    });
    const c = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW + 1000 });
    assert.deepStrictEqual(c.byRepoKey['repo-a'].map((r) => r.id), ['ws1', 'ws2']);
  } finally { h.cleanup(); }
});
