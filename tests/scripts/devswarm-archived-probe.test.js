'use strict';
// scripts/devswarm.js fetchArchivedWorkspaceIds + companion/devswarm-supervisor.js
// reconcileSweepIfDue's app-side archive probe.
//
// FIELD ROOT CAUSE: the owner archived children in the DevSwarm app; nothing on
// anti-hall's side read the app's own view, so those rows kept rendering as
// escalated/not-draining. The supervisor's already-running, cooldown-gated
// reconcile sweep now also caches `hivecontrol workspace list all`'s archived
// set per repoKey; readers consult that cache (never a spawn of their own).
//
// SHAPE PINNING, not guessing: the archived field is NOT pinned in
// docs/KB-devswarm-hivecontrol.md, so the probe accepts only a small,
// provenance-documented candidate set and reports `no-archived-field` (with the
// keys it actually saw) when none is present — writing NOTHING rather than
// inventing a mapping.
//
// The real hivecontrol binary is NEVER spawned here: `io.run` / `deps` are
// injected in every test.
//
// MUTATION LIST (proven RED against this file):
//   M1: make fetchArchivedWorkspaceIds default `field` to 'archived' when none
//       is present -> kills "NO archived field -> no-archived-field, nothing written".
//   M2: have the sweep write the cache even when the probe failed
//       -> kills "a FAILED probe contributes no entry".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const supervisor = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');
const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-probe-'));
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// fakeRun(records|raw) -> an io.run stub. NEVER spawns the real hivecontrol.
function fakeRun(payload) {
  return function (_call) {
    if (typeof payload === 'string') return { ok: true, raw: payload };
    if (payload === null) return { ok: false, error: 'boom' };
    return { ok: true, raw: JSON.stringify(payload) };
  };
}

const CTX = (run) => ({ home: '/nope', env: {}, cwd: os.tmpdir(), io: { run } });

test('PINNED SHAPES: each candidate archived field is read, and only it', () => {
  const cases = [
    { field: 'archived', records: [{ id: 'a', archived: true }, { id: 'b', archived: false }] },
    { field: 'isArchived', records: [{ id: 'a', isArchived: true }, { id: 'b', isArchived: false }] },
    { field: 'status', records: [{ id: 'a', status: 'archived' }, { id: 'b', status: 'active' }] },
    { field: 'isHidden', records: [{ id: 'a', isHidden: 1 }, { id: 'b', isHidden: 0 }] },
    // isActive is INVERTED: KB §20 live-verified it means exactly "not archived".
    { field: 'isActive', records: [{ id: 'a', isActive: 0 }, { id: 'b', isActive: 1 }] },
  ];
  for (const c of cases) {
    const r = cli.fetchArchivedWorkspaceIds(CTX(fakeRun(c.records)));
    assert.strictEqual(r.ok, true, c.field);
    assert.strictEqual(r.field, c.field);
    assert.deepStrictEqual(r.ids, ['a'], c.field + ': only the archived record is listed');
  }
});

test('a {children:[...]} wrapper is accepted, same as a bare array', () => {
  const r = cli.fetchArchivedWorkspaceIds(CTX(fakeRun({ children: [{ id: 'a', archived: true }] })));
  assert.deepStrictEqual(r.ids, ['a']);
});

test('NO archived field -> no-archived-field, with the keys actually seen', () => {
  const r = cli.fetchArchivedWorkspaceIds(CTX(fakeRun([{ id: 'a', branch: 'x', path: '/p' }])));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-archived-field');
  assert.deepStrictEqual(r.rawKeys.sort(), ['branch', 'id', 'path']);
});

test('EMPTY list is a valid answer (no workspaces), not a shape failure', () => {
  const r = cli.fetchArchivedWorkspaceIds(CTX(fakeRun([])));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, []);
  assert.strictEqual(r.field, null);
});

test('unparseable / non-list output, and a failed spawn, fail SOFT', () => {
  assert.strictEqual(cli.fetchArchivedWorkspaceIds(CTX(fakeRun('<html>'))).reason, 'hivecontrol-shape-unrecognized');
  assert.strictEqual(cli.fetchArchivedWorkspaceIds(CTX(fakeRun({ nope: 1 }))).reason, 'hivecontrol-shape-unrecognized');
  assert.strictEqual(cli.fetchArchivedWorkspaceIds(CTX(fakeRun(null))).reason, 'hivecontrol-unavailable');
  const thrower = () => { throw new Error('spawn exploded'); };
  assert.strictEqual(cli.fetchArchivedWorkspaceIds(CTX(thrower)).reason, 'hivecontrol-unavailable');
});

test('records without an id are ignored', () => {
  const r = cli.fetchArchivedWorkspaceIds(CTX(fakeRun([{ archived: true }, { id: 'a', archived: true }])));
  assert.deepStrictEqual(r.ids, ['a']);
});

// ---------------------------------------------------------------------------
// SUPERVISOR SWEEP — writes the cache, never spawns anything real here.
// ---------------------------------------------------------------------------

function sweepDeps(home, extra) {
  return Object.assign({
    readDescriptors: () => [{ id: 'ws1', worktreePath: '/wt/a', sessionId: 's1' }],
    repoKeyForWorktree: () => 'repo-a',
    readReconcileSweepState: () => ({ lastRunAt: 0 }),
    writeReconcileSweepState: () => {},
    runReconcile: () => ({ ok: true }),
    runFold: () => ({ ok: true }),
  }, extra || {});
}

test('SWEEP writes the app-archived cache from the probe, keyed by repoKey', () => {
  const h = makeHome();
  try {
    const now = 1_800_000_000_000;
    const r = supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now,
      deps: sweepDeps(h.home, { runArchivedList: () => ({ ok: true, field: 'archived', ids: ['ws1'] }) }),
    });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.archivedField, 'archived');
    const c = cacheLib.readArchivedCache({ home: h.home, env: {}, now });
    assert.strictEqual(c.fresh, true);
    assert.deepStrictEqual(c.byRepoKey, { 'repo-a': ['ws1'] });
  } finally { h.cleanup(); }
});

test('a FAILED probe contributes no entry, and no-archived-field writes NOTHING', () => {
  for (const probe of [
    () => ({ ok: false, reason: 'no-archived-field', rawKeys: ['id', 'branch'] }),
    () => ({ ok: false, reason: 'hivecontrol-unavailable' }),
    () => { throw new Error('probe exploded'); },
  ]) {
    const h = makeHome();
    try {
      const now = 1_800_000_000_000;
      const r = supervisor.reconcileSweepIfDue({
        home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now,
        deps: sweepDeps(h.home, { runArchivedList: probe }),
      });
      assert.strictEqual(r.ran, true, 'a probe failure must never break the sweep');
      assert.strictEqual(fs.existsSync(cacheLib.archivedCachePath(h.home)), false,
        'nothing may be written when no target reported an archived set');
    } finally { h.cleanup(); }
  }
});

test('SWEEP: a newer run replaces the previous snapshot (re-opened id disappears)', () => {
  const h = makeHome();
  try {
    const now = 1_800_000_000_000;
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now,
      deps: sweepDeps(h.home, { runArchivedList: () => ({ ok: true, field: 'archived', ids: ['ws1', 'ws2'] }) }),
    });
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: now + 1000,
      deps: sweepDeps(h.home, { runArchivedList: () => ({ ok: true, field: 'archived', ids: ['ws2'] }) }),
    });
    const c = cacheLib.readArchivedCache({ home: h.home, env: {}, now: now + 1000 });
    assert.deepStrictEqual(c.byRepoKey, { 'repo-a': ['ws2'] });
  } finally { h.cleanup(); }
});
