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
    { id: 'a', worktreePath: '/Users/x/.devswarm/repos/1/aa/one', repositoryId: 'repo-uuid', label: 'Some workspace', branch: 'fix/a' },
    { id: 'b', worktreePath: '/Users/x/.devswarm/repos/1/bb/two', repositoryId: 'repo-uuid', label: 'Some workspace', branch: 'fix/b' },
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
  assert.deepStrictEqual(r.records, [{ id: 'a', worktreePath: null, repositoryId: null, label: null, branch: null }]);
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
    assert.deepStrictEqual(c.byRepoKey, { 'repo-a': [{ id: 'ws1', worktreePath: '/w/a', repositoryId: null }] });
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

// ---------------------------------------------------------------------------
// D12b (v0.96.2) — three MEASURED field facts, closed together:
//   (A) `hivecontrol workspace list all` is GLOBAL — the SAME full record set
//       regardless of which repo's cwd the probe ran from — yet the pre-fix
//       sweep wrote that raw global answer verbatim into EVERY probed repoKey's
//       bucket, so repo X's cache held repo Y's records too.
//   (B) fetchActiveWorkspaceRecords dropped `repositoryId` even though the SAME
//       raw record parseChildrenList already extracts it from carries the
//       field — every cached record had repositoryId:null, so the D11-B
//       conjunct-3 repositoryId guard (companion/lib/devswarm-archived-cache.js
//       isAppArchived) could never fire.
//   (C) activeProbeFailure dropped error/status/signal/stderr, collapsing a
//       real field failure (a fast non-zero exit, not a timeout) to a bare
//       reason string with no diagnosable detail.
// ---------------------------------------------------------------------------

test('D12b(a): repositoryId (and label/branch) are threaded through onto every normalized record, not dropped', () => {
  const r = cli.fetchActiveWorkspaceRecords(CTX(fakeRun([REC('a', '/w/a')])));
  assert.strictEqual(r.records[0].repositoryId, 'repo-uuid');
  assert.strictEqual(r.records[0].label, 'Some workspace');
  assert.strictEqual(r.records[0].branch, 'fix/a');
});

test('D12b(b): the GLOBAL hivecontrol answer is SCOPED per repoKey — repo X\'s subset excludes repo Y\'s records; absence-from-global still archives an X row correctly', () => {
  const h = makeHome();
  try {
    const wtA = '/Users/x/.devswarm/repos/1/aa/one'; // repo A's live workspace
    const wtB = '/Users/x/.devswarm/repos/2/bb/two'; // repo B's live workspace — a DIFFERENT repo
    const repoKeyMap = { [wtA]: 'repoA-key', [wtB]: 'repoB-key' };
    // ONE global answer, IDENTICAL regardless of which target's worktreePath
    // probed it — the measured field fact this fix must survive.
    const globalList = [
      { id: 'a1', worktreePath: wtA, repositoryId: 'repoA-uuid' },
      { id: 'b1', worktreePath: wtB, repositoryId: 'repoB-uuid' },
    ];
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: {
        readDescriptors: () => [
          { id: 'a1', worktreePath: wtA, sessionId: 's1' },
          { id: 'b1', worktreePath: wtB, sessionId: 's2' },
        ],
        repoKeyForWorktree: (wt) => repoKeyMap[wt] || null,
        readReconcileSweepState: () => ({ lastRunAt: 0 }),
        writeReconcileSweepState: () => {},
        runReconcile: () => ({ ok: true }),
        runFold: () => ({ ok: true }),
        runActiveList: () => ({ ok: true, records: globalList, count: 2 }),
      },
    });
    const c = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW });
    assert.deepStrictEqual(c.byRepoKey['repoA-key'].map((r) => r.id), ['a1'],
      'repo A\'s subset must contain ONLY its own record, never repo B\'s');
    assert.deepStrictEqual(c.byRepoKey['repoB-key'].map((r) => r.id), ['b1'],
      'repo B\'s subset must contain ONLY its own record, never repo A\'s');

    // a1 is present (correctly scoped under repoA-key) -> NOT archived.
    assert.strictEqual(cacheLib.isAppArchived({
      home: h.home, repoKey: 'repoA-key', id: 'a1', worktreePath: wtA,
      env: {}, now: SWEEP_NOW, firstSeenMs: SWEEP_NOW - 20 * 60 * 1000, cache: c,
    }), false, 'a1 is present in the (correctly scoped) global answer and must read as live');

    // a2 is registered under repo A but is genuinely ABSENT from the global
    // list entirely -> the absence rule must still fire for its own repo.
    assert.strictEqual(cacheLib.isAppArchived({
      home: h.home, repoKey: 'repoA-key', id: 'a2',
      worktreePath: '/Users/x/.devswarm/repos/1/aa/gone',
      env: {}, now: SWEEP_NOW, firstSeenMs: SWEEP_NOW - 20 * 60 * 1000, cache: c,
    }), true, 'a workspace genuinely absent from the global list must still archive for its own repo');
  } finally { h.cleanup(); }
});

test('D12b(c): the partial-list floor compares the PER-REPO subset against that repo\'s own previous count, never the global record count', () => {
  const h = makeHome();
  try {
    const wtA = '/Users/x/.devswarm/repos/1/aa/one';
    const repoKeyMap = { [wtA]: 'repoA-key' };
    const baseDeps = {
      readDescriptors: () => [{ id: 'a0', worktreePath: wtA, sessionId: 's1' }],
      repoKeyForWorktree: (wt) => repoKeyMap[wt] || null,
      readReconcileSweepState: () => ({ lastRunAt: 0 }),
      writeReconcileSweepState: () => {},
      runReconcile: () => ({ ok: true }),
      runFold: () => ({ ok: true }),
    };
    // First sweep: repo A genuinely has 4 live records.
    const firstGlobal = [0, 1, 2, 3].map((i) => ({ id: 'a' + i, worktreePath: wtA, repositoryId: 'repoA-uuid' }));
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on', ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT: '50' }, now: SWEEP_NOW,
      deps: Object.assign({}, baseDeps, { runActiveList: () => ({ ok: true, records: firstGlobal, count: 4 }) }),
    });
    const before = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW });
    assert.strictEqual(before.byRepoKey['repoA-key'].length, 4);

    // Second sweep: the GLOBAL answer now ALSO carries 50 unrelated foreign
    // (repo Z) records — repo A's OWN count crashed to just 1. A floor keyed
    // off the global count would see "51, up from 4" and never suspect a
    // truncation; the per-repo floor must still catch repo A's own crash.
    repoKeyMap['/repoZ/wt'] = 'repoZ-key';
    const secondGlobal = [{ id: 'a0', worktreePath: wtA, repositoryId: 'repoA-uuid' }]
      .concat(Array.from({ length: 50 }, (_, i) => ({ id: 'z' + i, worktreePath: '/repoZ/wt', repositoryId: 'repoZ-uuid' })));
    supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on', ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT: '50' }, now: SWEEP_NOW + 1000,
      deps: Object.assign({}, baseDeps, { runActiveList: () => ({ ok: true, records: secondGlobal, count: 51 }) }),
    });
    const after = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW + 1000 });
    assert.strictEqual(after.byRepoKey['repoA-key'].length, 4,
      'the floor guard must refuse repo A\'s 1-record subset (below 50% of its own previous 4) and KEEP the previous snapshot for repo A, even though the global answer itself grew');
  } finally { h.cleanup(); }
});

test('D12b(d): a failed probe (a fast non-zero exit, not a timeout) carries error/status/signal/stderr through fetchActiveWorkspaceRecords AND the supervisor\'s activeProbeFailure record — never just a bare reason string', () => {
  const stderrText = 'DevSwarm workspace repository unavailable\n'.repeat(10);
  const runFail = () => ({ ok: false, error: 'hivecontrol exited 3', status: 3, signal: null, stderr: stderrText, raw: '' });

  const r = cli.fetchActiveWorkspaceRecords(CTX(runFail));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'hivecontrol exited 3');
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.signal, null);
  assert.strictEqual(r.stderr, stderrText.slice(0, 200));

  const h = makeHome();
  try {
    const res = supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: sweepDeps({ runActiveList: runFail }),
    });
    assert.strictEqual(res.ran, true);
    assert.ok(res.activeProbe.failure, 'a failed probe must surface a failure record');
    assert.strictEqual(res.activeProbe.failure.error, 'hivecontrol exited 3');
    assert.strictEqual(res.activeProbe.failure.status, 3);
    assert.strictEqual(res.activeProbe.failure.signal, null);
    assert.strictEqual(res.activeProbe.failure.stderr, stderrText.slice(0, 200));
  } finally { h.cleanup(); }
});

test('D12b(d): a signal-killed probe carries `signal` (not just a null status) through to activeProbeFailure', () => {
  const h = makeHome();
  try {
    const res = supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: sweepDeps({
        runActiveList: () => cli.fetchActiveWorkspaceRecords(CTX(() => ({
          ok: false, error: 'hivecontrol killed by signal SIGTERM', status: null, signal: 'SIGTERM', stderr: '', raw: '',
        }))),
      }),
    });
    assert.strictEqual(res.activeProbe.failure.signal, 'SIGTERM');
    assert.strictEqual(res.activeProbe.failure.status, null);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// D12c (v0.96.2, R29 P2) — scopeRecordToRepoKey (devswarm-supervisor.js
// ~:765-772) returned null for a record whose worktreePath fails
// repoKeyForWorktree (deleted/rehomed worktree, symlink mismatch) even when
// hivecontrol still lists it live under the SAME repositoryId as an
// already-attributed sibling — the record was dropped from every bucket
// SILENTLY, and past the archive grace period isAppArchived could then read
// that genuinely-live sibling row as app-archived (a false archive; the 50%
// floor only guards BULK drops, not a single unlucky one). Fix: (1) fold such
// a record into the target repoKey's bucket instead of dropping it, gated on
// same repositoryId as an already-direct-attributed sibling AND the path
// being under the devswarm repos root; (2) log every record STILL dropped
// (one structured `active-scope-drop` line per distinct worktreePath this
// tick, capped at 20 log calls); (3) surface tick-wide kept/dropped counts as
// `activeScope` on reconcileSweepIfDue's return (flows into main()'s sweep
// JSON line via the `reconcile` field).
// ---------------------------------------------------------------------------

const alog = require('../../plugins/anti-hall/companion/lib/anti-hall-log.js');

function withLogDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-log-'));
  const prev = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.ANTI_HALL_LOG_DIR; else process.env.ANTI_HALL_LOG_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('D12c: an unattributable record sharing repositoryId with an already-attributed sibling is KEPT in that repoKey\'s bucket, not dropped', () => {
  const h = makeHome();
  try {
    const wtA = '/Users/x/.devswarm/repos/1/aa/one'; // repo A's LIVE worktree — attributes directly
    const wtAStale = '/Users/x/.devswarm/repos/1/aa/one-stale'; // repo A's OWN sibling row whose worktreePath no longer resolves (deleted/rehomed)
    const repoKeyMap = { [wtA]: 'repoA-key' }; // wtAStale deliberately absent -> unattributable via worktreePath
    const globalList = [
      { id: 'a1', worktreePath: wtA, repositoryId: 'repoA-uuid' },
      { id: 'a2', worktreePath: wtAStale, repositoryId: 'repoA-uuid' }, // same repositoryId as a1 -> sibling fallback
    ];
    const res = supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: {
        readDescriptors: () => [{ id: 'a1', worktreePath: wtA, sessionId: 's1' }],
        repoKeyForWorktree: (wt) => repoKeyMap[wt] || null,
        readReconcileSweepState: () => ({ lastRunAt: 0 }),
        writeReconcileSweepState: () => {},
        runReconcile: () => ({ ok: true }),
        runFold: () => ({ ok: true }),
        runActiveList: () => ({ ok: true, records: globalList, count: 2 }),
      },
    });
    const c = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW });
    assert.deepStrictEqual(c.byRepoKey['repoA-key'].map((r) => r.id).sort(), ['a1', 'a2'],
      'a2 (unattributable via worktreePath) must be folded in via the same-repositoryId sibling fallback, not dropped');
    assert.strictEqual(res.activeScope.kept, 2);
    assert.strictEqual(res.activeScope.dropped, 0);

    // Confirm the practical consequence: a2 must NOT read as app-archived now
    // that it is correctly kept in the live set.
    assert.strictEqual(cacheLib.isAppArchived({
      home: h.home, repoKey: 'repoA-key', id: 'a2', worktreePath: wtAStale,
      env: {}, now: SWEEP_NOW, firstSeenMs: SWEEP_NOW - 20 * 60 * 1000, cache: c,
    }), false, 'a2 is present in the (correctly scoped, sibling-kept) active set and must read as live');
  } finally { h.cleanup(); }
});

test('D12c: an unattributable record with a FOREIGN repositoryId (no matching sibling) is dropped and logged once, never reassigned', () => {
  const h = makeHome();
  withLogDir(() => {
    try {
      const wtA = '/Users/x/.devswarm/repos/1/aa/one';
      const wtForeignStale = '/Users/x/.devswarm/repos/9/zz/gone'; // unattributable, DIFFERENT repositoryId than any direct sibling
      const repoKeyMap = { [wtA]: 'repoA-key' };
      const globalList = [
        { id: 'a1', worktreePath: wtA, repositoryId: 'repoA-uuid' },
        { id: 'z1', worktreePath: wtForeignStale, repositoryId: 'repoZ-uuid' },
      ];
      const res = supervisor.reconcileSweepIfDue({
        home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
        deps: {
          readDescriptors: () => [{ id: 'a1', worktreePath: wtA, sessionId: 's1' }],
          repoKeyForWorktree: (wt) => repoKeyMap[wt] || null,
          readReconcileSweepState: () => ({ lastRunAt: 0 }),
          writeReconcileSweepState: () => {},
          runReconcile: () => ({ ok: true }),
          runFold: () => ({ ok: true }),
          runActiveList: () => ({ ok: true, records: globalList, count: 2 }),
        },
      });
      const c = cacheLib.readActiveCache({ home: h.home, env: {}, now: SWEEP_NOW });
      assert.deepStrictEqual(c.byRepoKey['repoA-key'].map((r) => r.id), ['a1'],
        'z1 (foreign repositoryId, no attributed sibling) must never be folded into repo A\'s bucket');
      assert.strictEqual(res.activeScope.kept, 1);
      assert.strictEqual(res.activeScope.dropped, 1);

      const entries = alog.readRecent({ component: 'devswarm-supervisor' });
      const drop = entries.find((e) => e.op === 'active-scope-drop');
      assert.ok(drop, 'a dropped record must produce ONE active-scope-drop log line');
      assert.strictEqual(drop.ctx.worktreePath, wtForeignStale);
      assert.strictEqual(drop.ctx.recordId, 'z1');
      assert.strictEqual(drop.ctx.repoKeyTarget, 'repoA-key');
      assert.strictEqual(entries.filter((e) => e.op === 'active-scope-drop').length, 1,
        'exactly one drop line for the one distinct dropped record this tick, never duplicated');
    } finally { h.cleanup(); }
  });
});

test('D12c: reconcileSweepIfDue\'s return carries activeScope{kept,dropped} — the shape main()\'s sweep JSON line surfaces via its `reconcile` field', () => {
  const h = makeHome();
  try {
    const res = supervisor.reconcileSweepIfDue({
      home: h.home, env: { ANTIHALL_DEVSWARM: 'on' }, now: SWEEP_NOW,
      deps: sweepDeps({ runActiveList: () => ({ ok: true, records: [{ id: 'ws1', worktreePath: '/w/a' }], count: 1 }) }),
    });
    assert.deepStrictEqual(res.activeScope, { kept: 1, dropped: 0 });
    // Sanity: this is exactly what would be JSON.stringify'd as reconcile.activeScope in main()'s line.
    const line = JSON.stringify({ ts: new Date().toISOString(), sweep: 0, reconcile: res });
    assert.ok(line.includes('"activeScope":{"kept":1,"dropped":0}'));
  } finally { h.cleanup(); }
});
