'use strict';
// migrations — THE one registry of the all-store forward-migrations + the
// shared completion marker (mesh redesign Phase 4). A fake devswarm module
// stands in for scripts/devswarm.js so each case controls pending/errors
// exactly; the marker file lives in an isolated tmp HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const M = require(path.join(REPO, 'plugins', 'anti-hall', 'companion', 'lib', 'migrations.js'));
const U = require(path.join(REPO, 'plugins', 'anti-hall', 'skills', 'update', 'scripts', 'update.js'));

function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-migr-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// fakeDw({pending, errors}) — every registry fn reports `pending` work on a dry
// run until it has been applied once; `errors` makes every call report errors.
function fakeDw(opts) {
  const o = opts || {};
  const applied = new Set();
  const calls = [];
  const mk = (fn, shape) => (home, ctx) => {
    calls.push({ fn, dryRun: !!(ctx && ctx.dryRun) });
    if (!(ctx && ctx.dryRun)) applied.add(fn);
    const pend = o.pending && !applied.has(fn) ? 1 : 0;
    return shape(pend, o.errors ? 1 : 0);
  };
  return {
    calls,
    foldMeshDuplicatesAllStores: mk('foldMeshDuplicatesAllStores', (p, e) => ({ retired: p, stores: 1, errors: e })),
    healOrphanPartitionsAllStores: mk('healOrphanPartitionsAllStores', (p, e) => ({ adopted: p, forwarded: 0, stores: 1, errors: e })),
    foldArchivedRegistryRows: mk('foldArchivedRegistryRows', (p, e) => ({ pending: p, left: [], errors: e, ok: true })),
    foldArchivedFamilyDescriptors: mk('foldArchivedFamilyDescriptors', (p, e) => ({ pending: p, left: [], errors: e, ok: true })),
    repairReaderFloorsAllStores: mk('repairReaderFloorsAllStores', (p, e) => ({ ok: true, pending: p, stores: 1, errors: e })),
    reconcileDualPartitionAcksAllStores: mk('reconcileDualPartitionAcksAllStores', (p, e) => ({ wouldRaise: p, rows: p, stores: 1, errors: e })),
    mergeSplitBackendStoresAllStores: mk('mergeSplitBackendStoresAllStores', (p, e) => ({ ok: true, pending: p, stores: 1, splitStores: p, errors: e })),
    markAppArchivedDescriptors: mk('markAppArchivedDescriptors', (p, e) => ({ ok: true, appDb: true, pending: p, scanned: 1, errors: e })),
    reRetireResurrectedRowsAllStores: () => { throw new Error('deletion-class entry must never run from runMigrations'); },
  };
}

test('registry: every default entry is non-deleting; the deletion-class entry is opt-in only', () => {
  const defaults = M.defaultMigrations();
  assert.deepStrictEqual(defaults.map((m) => m.id),
    ['merge-split-backend-stores', 'fold-all-stores', 'heal-orphan-partitions', 'fold-archived-rows', 'fold-archived-family-descriptors', 'repair-reader-floors', 'reconcile-dual-partition-acks', 'mark-app-archived']);
  for (const m of defaults) assert.ok(!m.deletes && !m.optIn, m.id + ' must not be deletion-class');
  const rr = M.byId('re-retire-resurrected');
  assert.ok(rr && rr.optIn && rr.deletes, 're-retire-resurrected is registered as opt-in + deletion-class');
});

test('bootstrap: no marker -> one live scan; clean + nothing pending -> marker written; next run skips with no scan', () => {
  const home = mkHome();
  try {
    const dw = fakeDw({ pending: false });
    const r1 = M.runMigrations({ home, version: '9.9.9', devswarm: dw });
    assert.ok(r1.every((r) => r.status === 'skipped' && /nothing to migrate/.test(r.msg)), JSON.stringify(r1));
    assert.strictEqual(dw.calls.length, 8, 'one dry-run scan per default entry');
    const state = M.readMarkers(home);
    for (const m of M.defaultMigrations()) assert.strictEqual(state[m.key].completedVersion, '9.9.9', m.key);
    const r2 = M.runMigrations({ home, version: '9.9.9', devswarm: dw });
    assert.ok(r2.every((r) => /already applied for 9\.9\.9/.test(r.msg)), JSON.stringify(r2));
    assert.strictEqual(dw.calls.length, 8, 'a marked entry costs no scan at all');
    // A new version re-scans (a new build may carry a new migration shape).
    M.runMigrations({ home, version: '9.9.10', devswarm: dw });
    assert.strictEqual(dw.calls.length, 16);
  } finally { rm(home); }
});

test('pending work: applied once, re-detected, reported fixed, then marked', () => {
  const home = mkHome();
  try {
    const dw = fakeDw({ pending: true });
    const r = M.runMigrations({ home, version: '1.0.0', devswarm: dw });
    assert.ok(r.every((x) => x.status === 'fixed'), JSON.stringify(r));
    assert.strictEqual(dw.calls.filter((c) => !c.dryRun).length, 8, 'each entry applied exactly once');
    assert.strictEqual(M.readMarkers(home).foldAllStores.completedVersion, '1.0.0');
  } finally { rm(home); }
});

test('errors block the marker (the next run retries); dry-run writes nothing at all', () => {
  const home = mkHome();
  try {
    M.runMigrations({ home, version: '1.0.0', devswarm: fakeDw({ pending: false, errors: true }) });
    assert.deepStrictEqual(M.readMarkers(home), {}, 'an errored scan must never be blessed as done');
    const dw = fakeDw({ pending: true });
    const r = M.runMigrations({ home, version: '1.0.0', devswarm: dw, dryRun: true });
    assert.ok(r.every((x) => /\[dry-run\] would migrate/.test(x.msg)), JSON.stringify(r));
    assert.strictEqual(dw.calls.filter((c) => !c.dryRun).length, 0, 'dry-run never applies');
    assert.strictEqual(fs.existsSync(M.markerPath(home)), false, 'dry-run never writes the marker file');
  } finally { rm(home); }
});

test('one marker store: update.js reads/writes the SAME file and keys the registry stamps', () => {
  const home = mkHome();
  try {
    assert.strictEqual(U.sweepStatePath(home), M.markerPath(home));
    M.markApplied(home, 'foldAllStores', '2.0.0');
    assert.strictEqual(U.readSweepState(home).foldAllStores.completedVersion, '2.0.0');
    U.writeSweepState(home, Object.assign(U.readSweepState(home), { healOrphanPartitions: { completedVersion: '2.0.0' } }));
    const r = M.runMigrations({ home, version: '2.0.0', devswarm: fakeDw({ pending: true }) });
    assert.strictEqual(r.find((x) => x.id === 'fold-all-stores').status, 'skipped');
    assert.strictEqual(r.find((x) => x.id === 'heal-orphan-partitions').status, 'skipped');
    assert.strictEqual(r.find((x) => x.id === 'fold-archived-rows').status, 'fixed');
  } finally { rm(home); }
});

test('update fold-archived-rows stage stamps both registry keys on a clean pass and skips next time', () => {
  const home = mkHome();
  try {
    let calls = 0;
    const dw = {
      foldArchivedRegistryRows: () => { calls++; return { retired: [], forwarded: 0, left: [], errors: 0, ok: true }; },
      foldArchivedFamilyDescriptors: () => { calls++; return { retired: [], left: [], errors: 0, ok: true }; },
    };
    const args = {
      paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') },
      env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home, devswarm: dw, version: '3.0.0',
    };
    const r1 = U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(r1.attempted, true);
    assert.strictEqual(calls, 2);
    const st = M.readMarkers(home);
    assert.strictEqual(st.foldArchivedRows.completedVersion, '3.0.0');
    assert.strictEqual(st.foldArchivedFamilyDescriptors.completedVersion, '3.0.0');
    const r2 = U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(r2.skippedAlreadyDone, true);
    assert.strictEqual(calls, 2, 'a stamped version is not re-run');
    // A budget-exhausted pass is NOT stamped (it resumes next run).
    const home2 = mkHome();
    try {
      const dw2 = {
        foldArchivedRegistryRows: () => ({ retired: [], left: [], errors: 0, ok: true, budgetExhausted: true, skipped: 3 }),
        foldArchivedFamilyDescriptors: () => ({ retired: [], left: [], errors: 0, ok: true }),
      };
      U.foldArchivedRowsPostUpdate(Object.assign({}, args, { home: home2, devswarm: dw2 }));
      const st2 = M.readMarkers(home2);
      assert.strictEqual(st2.foldArchivedRows, undefined);
      assert.strictEqual(st2.foldArchivedFamilyDescriptors.completedVersion, '3.0.0');
    } finally { rm(home2); }
  } finally { rm(home); }
});

// ---- the ONE completeness predicate (Codex review of Phase 4: P0/P1) --------

test('isRunComplete: budget, errors, retryable left[], pendingRows and forwardFailed all block; terminal refusals do not', () => {
  const ok = (r) => M.isRunComplete(r);
  assert.strictEqual(ok({ errors: 0, left: [] }), true);
  assert.strictEqual(ok({ errors: 0, budgetExhausted: true }), false, 'a resume list was written: work remains');
  assert.strictEqual(ok({ errors: 1 }), false);
  assert.strictEqual(ok({ ok: false }), false);
  assert.strictEqual(ok({ pendingRows: 2 }), false);
  assert.strictEqual(ok({ forwardFailed: ['x'] }), false);
  assert.strictEqual(ok({ left: [{ id: 'a', reason: 'lock-busy' }] }), false, 'lock-busy is retryable');
  assert.strictEqual(ok({ left: [{ id: 'a', reason: 'raced-re-register' }] }), false);
  assert.strictEqual(ok({ left: [{ id: 'a', reason: 'some-new-reason' }] }), false, 'unknown reason never blesses');
  assert.strictEqual(ok({ left: [{ id: 'a', reason: 'live-descriptor' }, { id: 'b', reason: 'archived-tombstone-differs' }, { id: 'c', reason: 'mesh-anchor-attended' }] }), true, 'permanent refusals only');
  // Round 2: refusals derived from CURRENT worktree/session state can change -> retryable.
  assert.strictEqual(ok({ left: [{ id: 'b', reason: 'live-or-unprovable-worktree' }] }), false);
  assert.strictEqual(ok({ left: [{ id: 'b', reason: 'descriptor-no-live-session' }] }), false);
  assert.strictEqual(ok({ left: ['bare-id'] }), true, 'bare-id left (descriptor-backed survivor) is terminal');
  assert.strictEqual(ok({ pending: 5, retired: [1, 2, 3, 4, 5] }), true, '`pending` is the retired count on apply, not remaining work');
  assert.strictEqual(ok(null), false);
});

test('P0: family-descriptor pass that hits its budget is NOT stamped; the next run resumes, finishes, then stamps', () => {
  const home = mkHome();
  try {
    let famCalls = 0;
    const dw = {
      foldArchivedRegistryRows: () => ({ retired: [], forwarded: 0, left: [], errors: 0, ok: true }),
      foldArchivedFamilyDescriptors: () => {
        famCalls++;
        return famCalls === 1
          ? { ok: true, retired: [], left: [], errors: 0, budgetExhausted: true }
          : { ok: true, retired: [], left: [], errors: 0 };
      },
    };
    const args = { paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home, devswarm: dw, version: '5.0.0' };
    U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(M.readMarkers(home).foldArchivedFamilyDescriptors, undefined, 'partial pass must not stamp');
    U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(famCalls, 2, 'the unstamped pass runs again (resumes)');
    assert.strictEqual(M.readMarkers(home).foldArchivedFamilyDescriptors.completedVersion, '5.0.0', 'finished pass stamps');
    U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(famCalls, 2, 'stamped: not re-run at this version');
  } finally { rm(home); }
});

test('P1: registry-row pass with a lock-busy left[] is NOT stamped; a terminal refusal alone IS', () => {
  const home = mkHome();
  try {
    let rowCalls = 0;
    let leftNow = [{ id: 'a', bucket: 'b', reason: 'lock-busy' }];
    const dw = {
      foldArchivedRegistryRows: () => { rowCalls++; return { retired: [], forwarded: 0, left: leftNow, errors: 0, ok: true }; },
      foldArchivedFamilyDescriptors: () => ({ ok: true, retired: [], left: [], errors: 0 }),
    };
    const args = { paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home, devswarm: dw, version: '6.0.0' };
    U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(M.readMarkers(home).foldArchivedRows, undefined, 'lock-busy must not stamp');
    leftNow = [{ id: 'a', bucket: 'b', reason: 'live-descriptor' }];
    U.foldArchivedRowsPostUpdate(args);
    assert.strictEqual(rowCalls, 2);
    assert.strictEqual(M.readMarkers(home).foldArchivedRows.completedVersion, '6.0.0', 'terminal refusal only: stamped');
  } finally { rm(home); }
});

test('doctor registry path: an apply that leaves a retryable row reports fixed but does NOT stamp', () => {
  const home = mkHome();
  try {
    const dw = fakeDw({ pending: true });
    const orig = dw.foldArchivedRegistryRows;
    dw.foldArchivedRegistryRows = (h, ctx) => {
      const r = orig(h, ctx);
      if (!(ctx && ctx.dryRun)) r.left = [{ id: 'x', reason: 'lock-busy' }];
      return r;
    };
    const r = M.runMigrations({ home, version: '7.0.0', devswarm: dw });
    assert.strictEqual(r.find((x) => x.id === 'fold-archived-rows').status, 'fixed');
    assert.strictEqual(M.readMarkers(home).foldArchivedRows, undefined, 'lock-busy on apply: no stamp');
    assert.strictEqual(M.readMarkers(home).foldAllStores.completedVersion, '7.0.0', 'the clean entries still stamp');
  } finally { rm(home); }
});

test('fold-all-stores stage: a store whose own group loop hit its deadline is NOT stamped', () => {
  const home = mkHome();
  try {
    let calls = 0;
    const dw = { foldMeshDuplicates: () => { calls++; return calls === 1 ? { ok: true, retired: [], forwarded: 0, folded: 0, budgetExhausted: true, skipped: 3 } : { ok: true, retired: [], forwarded: 0, folded: 0 }; } };
    const args = {
      paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home,
      devswarm: dw, devswarmStore: { listStoreHashes: () => ['k1'] }, hashes: ['k1'], version: '8.0.0',
    };
    U.foldAllStoresPostUpdate(args);
    assert.ok(!M.isApplied(M.readMarkers(home), 'foldAllStores', '8.0.0'), 'partial store must not stamp');
    U.foldAllStoresPostUpdate(args);
    assert.strictEqual(calls, 2, 're-run at the same version');
    assert.ok(M.isApplied(M.readMarkers(home), 'foldAllStores', '8.0.0'), 'drained + complete: stamped');
  } finally { rm(home); }
});


// ---- round 2: bounded doctor runs, visible reasons, one stamper -------------

test('runMigrations is budgeted: past the deadline every unmarked entry is deferred, reported, not stamped', () => {
  const home = mkHome();
  try {
    const dw = fakeDw({ pending: true });
    const r = M.runMigrations({ home, version: '9.0.0', devswarm: dw, deadline: Date.now() - 1 });
    assert.ok(r.every((x) => x.status === 'skipped' && /deferred — migration budget/.test(x.msg)), JSON.stringify(r));
    assert.strictEqual(dw.calls.length, 0, 'nothing scanned past the deadline');
    assert.deepStrictEqual(M.readMarkers(home), {});
  } finally { rm(home); }
});

test('runMigrations: default budget comes from the shared post-pull env; only deadline-aware entries receive it', () => {
  const home = mkHome();
  try {
    assert.strictEqual(M.runBudgetMs({}), 90000);
    assert.strictEqual(M.runBudgetMs({ ANTIHALL_UPDATE_POSTPULL_BUDGET_MS: '1234' }), 1234);
    assert.strictEqual(U.postPullBudgetMs({ ANTIHALL_UPDATE_POSTPULL_BUDGET_MS: '1234' }), 1234, 'update shares the same budget');
    const seen = {};
    const dw = fakeDw({ pending: false });
    for (const fn of ['foldMeshDuplicatesAllStores', 'healOrphanPartitionsAllStores', 'foldArchivedRegistryRows', 'foldArchivedFamilyDescriptors']) {
      const orig = dw[fn];
      dw[fn] = (h, ctx) => { seen[fn] = ctx && ctx.deadline; return orig(h, ctx); };
    }
    M.runMigrations({ home, version: '9.1.0', devswarm: dw, env: {} });
    assert.ok(Number.isFinite(seen.foldArchivedRegistryRows) && Number.isFinite(seen.foldArchivedFamilyDescriptors), JSON.stringify(seen));
    assert.strictEqual(seen.foldMeshDuplicatesAllStores, undefined, 'all-stores aggregate cannot report a per-store partial: no inner deadline');
    assert.strictEqual(seen.healOrphanPartitionsAllStores, undefined);
  } finally { rm(home); }
});

test('an unstamped pass ALWAYS says why, with counts — on "nothing to migrate" and on "fixed"', () => {
  const home = mkHome();
  try {
    const dw = fakeDw({ pending: false });
    const origRows = dw.foldArchivedRegistryRows;
    dw.foldArchivedRegistryRows = (h, ctx) => Object.assign(origRows(h, ctx), { left: [{ id: 'a', reason: 'lock-busy' }, { id: 'b', reason: 'lock-busy' }, { id: 'c', reason: 'descriptor-no-live-session' }] });
    const r = M.runMigrations({ home, version: '9.2.0', devswarm: dw });
    const row = r.find((x) => x.id === 'fold-archived-rows');
    assert.match(row.msg, /nothing to migrate — not stamped, retries next run: retryable: lock-busy×2, descriptor-no-live-session×1/, row.msg);
    assert.strictEqual(M.readMarkers(home).foldArchivedRows, undefined);
    const dw2 = fakeDw({ pending: true });
    const orig2 = dw2.foldArchivedFamilyDescriptors;
    dw2.foldArchivedFamilyDescriptors = (h, ctx) => Object.assign(orig2(h, ctx), (ctx && ctx.dryRun) ? {} : { budgetExhausted: true, skipped: 4 });
    const r2 = M.runMigrations({ home, version: '9.3.0', devswarm: dw2 });
    assert.match(r2.find((x) => x.id === 'fold-archived-family-descriptors').msg, /migrated: .* — not stamped, retries next run: budget hit \(4 deferred\)/);
  } finally { rm(home); }
});

test('update fold-archived stage detail reports why it did not stamp', () => {
  const home = mkHome();
  try {
    const dw = {
      foldArchivedRegistryRows: () => ({ retired: [], forwarded: 0, left: [{ id: 'a', reason: 'lock-busy' }], errors: 0, ok: true }),
      foldArchivedFamilyDescriptors: () => ({ ok: true, retired: [], left: [{ id: 't', reason: 'live-or-unprovable-worktree' }], errors: 0 }),
    };
    const res = U.foldArchivedRowsPostUpdate({ paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home, devswarm: dw, version: '9.4.0' });
    assert.match(res.detail, /not stamped, retries next run: rows: retryable: lock-busy×1 \| twin descriptors: retryable: live-or-unprovable-worktree×1/, res.detail);
    assert.deepStrictEqual(M.readMarkers(home), {});
  } finally { rm(home); }
});

test('the other one-time stages stamp only through the predicate (ownerKey errors / dry-run import -> unstamped)', () => {
  const home = mkHome();
  try {
    const base = { paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home, version: '9.5.0' };
    U.ownerKeyMigratePostUpdate(Object.assign({}, base, { devswarm: { migrateOwnerKeys: () => ({ errors: 2 }) } }));
    assert.strictEqual(M.readMarkers(home).ownerKeyMigrate, undefined, 'errors: not stamped');
    U.ownerKeyMigratePostUpdate(Object.assign({}, base, { devswarm: { migrateOwnerKeys: () => ({ errors: 0 }) } }));
    assert.strictEqual(M.readMarkers(home).ownerKeyMigrate.completedVersion, '9.5.0');
    U.readerCursorsImportPostUpdate(Object.assign({}, base, { devswarm: { importReaderCursorsAllStores: () => ({ errors: 0, dryRun: true }) } }));
    assert.strictEqual(M.readMarkers(home).readerCursorsImport, undefined, 'a dry-run import is still pending');
  } finally { rm(home); }
});

// ---- integration: Phase 3's `pending` (rows a pass could NOT act on) --------

test('phase 3 pending rows block the one stamper on every path (update stage + doctor registry)', () => {
  const home = mkHome();
  try {
    // update stage: a store fold that left lock-busy rows is NOT stamped.
    let calls = 0;
    const dw = { foldMeshDuplicates: () => { calls++; return { ok: true, retired: [], forwarded: 0, folded: 0, pending: calls === 1 ? 2 : 0 }; } };
    const args = {
      paths: { pluginSrcDir: path.join(REPO, 'plugins', 'anti-hall') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home,
      devswarm: dw, devswarmStore: { listStoreHashes: () => ['k1'] }, hashes: ['k1'], version: '10.0.0',
    };
    U.foldAllStoresPostUpdate(args);
    assert.ok(!M.isApplied(M.readMarkers(home), 'foldAllStores', '10.0.0'), 'pending rows: no stamp');
    U.foldAllStoresPostUpdate(args);
    assert.ok(M.isApplied(M.readMarkers(home), 'foldAllStores', '10.0.0'), 'clean re-run: stamped');

    // doctor registry: an all-stores apply reporting pending rows is not stamped;
    // fold-archived-rows' `pending` (work done) still stamps.
    const home2 = mkHome();
    try {
      const f = fakeDw({ pending: true });
      const origFold = f.foldMeshDuplicatesAllStores;
      f.foldMeshDuplicatesAllStores = (h, ctx) => Object.assign(origFold(h, ctx), (ctx && ctx.dryRun) ? {} : { pending: 1 });
      const origHeal = f.healOrphanPartitionsAllStores;
      f.healOrphanPartitionsAllStores = (h, ctx) => Object.assign(origHeal(h, ctx), (ctx && ctx.dryRun) ? {} : { pending: 1 });
      const r = M.runMigrations({ home: home2, version: '10.0.0', devswarm: f });
      const marks = M.readMarkers(home2);
      assert.strictEqual(marks.foldAllStores, undefined, JSON.stringify(r));
      assert.strictEqual(marks.healOrphanPartitions, undefined, JSON.stringify(r));
      assert.match(r.find((x) => x.id === 'fold-all-stores').msg, /1 pending row\(s\)/);
      assert.strictEqual(marks.foldArchivedRows.completedVersion, '10.0.0');
    } finally { rm(home2); }
  } finally { rm(home); }
});
