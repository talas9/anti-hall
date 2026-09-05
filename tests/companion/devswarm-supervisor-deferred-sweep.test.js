'use strict';
// devswarm-supervisor.js — task #40 (v0.96.1): the periodic liveness
// supervisor now ALSO picks up the post-update stages update.js's own
// overall post-pull budget (ANTIHALL_UPDATE_POSTPULL_BUDGET_MS, D11-C) can
// defer WHOLE — fold-all-stores, heal-orphan-partitions, fold-archived-rows.
// Unlike reconcile/fold (covered by reconcileSweepIfDue in the same file),
// nothing periodic ever re-ran these three before this change; a machine
// that always exhausts the post-pull budget would never run them again
// until the NEXT explicit `update`/`doctor` call (see update.js's own
// postPullBudgetMs doc comment).
//
// This exercises the new deferredSweepIfDue/hasDeferredWork/runDeferredStage
// surface with fully injected deps (hermetic — no real update.js stage work
// runs unless a test explicitly wants it) PLUS one real, unmocked run through
// the ACTUAL update.js foldArchivedRowsPostUpdate + devswarm.js resume-marker
// reader/writer to prove the wiring is real, not just exercised via a stub.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));
const updateJs = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'skills', 'update', 'scripts', 'update.js',
));
const devswarmCli = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js',
));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-deferred-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function writeUpdateSweepState(home, state) {
  const dir = path.join(home, '.anti-hall');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'update-sweep-state.json'), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// hasDeferredWork — marker peek only, never does the stage's own work
// ---------------------------------------------------------------------------

test('hasDeferredWork: fold-all-stores/heal-orphan-partitions — pending only when update-sweep-state.json carries a matching pendingVersion + non-empty pendingHashes', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.strictEqual(M.hasDeferredWork('fold-all-stores', home), false, 'no state file at all -> nothing pending');
    writeUpdateSweepState(home, { foldAllStores: { completedVersion: '0.96.0', pendingVersion: null, pendingHashes: [] } });
    assert.strictEqual(M.hasDeferredWork('fold-all-stores', home), false, 'a clean completed stamp is not pending work');
    writeUpdateSweepState(home, { foldAllStores: { pendingVersion: '0.96.0', pendingHashes: ['h1', 'h2'] } });
    assert.strictEqual(M.hasDeferredWork('fold-all-stores', home), true);
    assert.strictEqual(M.hasDeferredWork('heal-orphan-partitions', home), false, 'a different stage key is independent');
    writeUpdateSweepState(home, { healOrphanPartitions: { pendingVersion: '0.96.0', pendingHashes: ['h3'] } });
    assert.strictEqual(M.hasDeferredWork('heal-orphan-partitions', home), true);
  } finally { cleanup(); }
});

test('hasDeferredWork: fold-all-stores — corrupt/unreadable sweep-state file fails open to false (never throws)', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = path.join(home, '.anti-hall');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'update-sweep-state.json'), '{not json');
    assert.doesNotThrow(() => M.hasDeferredWork('fold-all-stores', home));
    assert.strictEqual(M.hasDeferredWork('fold-all-stores', home), false);
  } finally { cleanup(); }
});

test('hasDeferredWork: fold-archived-rows — pending when EITHER the per-bucket resume marker or the family resume marker holds ids', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.strictEqual(M.hasDeferredWork('fold-archived-rows', home), false, 'no markers at all -> nothing pending');

    const devswarmDir = path.join(home, '.anti-hall', 'devswarm');
    fs.mkdirSync(devswarmDir, { recursive: true });
    fs.writeFileSync(path.join(devswarmDir, 'fold-archived-resume.json'), JSON.stringify({ buckets: { abc123: [] } }));
    assert.strictEqual(M.hasDeferredWork('fold-archived-rows', home), false, 'a bucket present but empty is not pending');

    fs.writeFileSync(path.join(devswarmDir, 'fold-archived-resume.json'), JSON.stringify({ buckets: { abc123: ['w1'] } }));
    assert.strictEqual(M.hasDeferredWork('fold-archived-rows', home), true, 'a non-empty bucket is pending');

    fs.rmSync(path.join(devswarmDir, 'fold-archived-resume.json'));
    fs.writeFileSync(path.join(devswarmDir, 'fold-archived-family-resume.json'), JSON.stringify({ ids: ['w2'] }));
    assert.strictEqual(M.hasDeferredWork('fold-archived-rows', home), true, 'the family-descriptor marker alone is also pending');
  } finally { cleanup(); }
});

test('hasDeferredWork: an unknown stage name is never pending (fail-open, never throws)', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.strictEqual(M.hasDeferredWork('not-a-real-stage', home), false);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// deferredSweepIfDue — gating + rotation + no-op-vs-ran shape
// ---------------------------------------------------------------------------

test('deferredSweepIfDue: disabled via the supervisor kill-switches -> {ran:false, reason:"disabled"}; never rotates, never peeks a marker', () => {
  const { home, cleanup } = makeHome();
  try {
    let peeked = 0;
    const res = M.deferredSweepIfDue({
      home, env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'off' },
      deps: { hasDeferredWork: () => { peeked++; return true; } },
    });
    assert.strictEqual(res.ran, false);
    assert.strictEqual(res.reason, 'disabled');
    assert.strictEqual(peeked, 0);
    assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'deferred-sweep-state.json')), false, 'a disabled call must not persist rotation state');
  } finally { cleanup(); }
});

test('deferredSweepIfDue: no marker for the current rotation stage -> {ran:false, reason:"no-marker"}, but rotation still advances', () => {
  const { home, cleanup } = makeHome();
  try {
    const seenStages = [];
    for (let i = 0; i < 3; i++) {
      const res = M.deferredSweepIfDue({
        home,
        deps: { hasDeferredWork: (stage) => { seenStages.push(stage); return false; } },
      });
      assert.strictEqual(res.ran, false);
      assert.strictEqual(res.reason, 'no-marker');
    }
    assert.deepStrictEqual(seenStages, ['fold-all-stores', 'heal-orphan-partitions', 'fold-archived-rows'],
      'three consecutive passes must rotate through all three stages exactly once each, in order');
  } finally { cleanup(); }
});

test('deferredSweepIfDue: a marker present for the current stage -> runs it via runDeferredStage and reports ran:true + the stage result', () => {
  const { home, cleanup } = makeHome();
  try {
    let ranStage = null; let ranOpts = null;
    const res = M.deferredSweepIfDue({
      home,
      deps: {
        hasDeferredWork: (stage) => stage === 'fold-all-stores',
        runDeferredStage: (stage, opts) => { ranStage = stage; ranOpts = opts; return { attempted: true, retired: 3 }; },
      },
    });
    assert.strictEqual(res.stage, 'fold-all-stores');
    assert.strictEqual(res.ran, true);
    assert.deepStrictEqual(res.result, { attempted: true, retired: 3 });
    assert.strictEqual(ranStage, 'fold-all-stores');
    assert.strictEqual(ranOpts.home, home);
  } finally { cleanup(); }
});

test('deferredSweepIfDue: rotation position survives across calls via the persisted state file (real fs, no injected deps)', () => {
  const { home, cleanup } = makeHome();
  try {
    const stages = [];
    for (let i = 0; i < 4; i++) {
      const res = M.deferredSweepIfDue({ home, deps: { hasDeferredWork: () => false } });
      stages.push(res.stage);
    }
    assert.deepStrictEqual(stages, ['fold-all-stores', 'heal-orphan-partitions', 'fold-archived-rows', 'fold-all-stores'],
      'the 4th call must wrap back around to the first stage');
  } finally { cleanup(); }
});

test('deferredSweepIfDue: a corrupt rotation-state file fails open to stage index 0, never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'deferred-sweep-state.json'), '{not json');
    let res;
    assert.doesNotThrow(() => { res = M.deferredSweepIfDue({ home, deps: { hasDeferredWork: () => false } }); });
    assert.strictEqual(res.stage, 'fold-all-stores');
  } finally { cleanup(); }
});

test('deferredSweepIfDue: runDeferredStage/hasDeferredWork throwing is fully fail-open — never throws out of the sweep', () => {
  const { home, cleanup } = makeHome();
  try {
    let res;
    assert.doesNotThrow(() => {
      res = M.deferredSweepIfDue({ home, deps: { hasDeferredWork: () => { throw new Error('boom'); } } });
    });
    assert.strictEqual(res.ran, false);
  } finally { cleanup(); }
});

test('deferredSweepIfDue: budget default is 20s; ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS overrides it end to end into runDeferredStage', () => {
  const { home, cleanup } = makeHome();
  try {
    let seenBudget = null;
    M.deferredSweepIfDue({
      home, env: { ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS: '5000' },
      deps: {
        hasDeferredWork: () => true,
        runDeferredStage: (stage, opts) => { seenBudget = opts.budgetMs; return { attempted: true }; },
      },
    });
    assert.strictEqual(seenBudget, 5000);

    const { home: home2, cleanup: cleanup2 } = makeHome();
    try {
      let seenDefault = null;
      M.deferredSweepIfDue({
        home: home2, env: {},
        deps: {
          hasDeferredWork: () => true,
          runDeferredStage: (stage, opts) => { seenDefault = opts.budgetMs; return { attempted: true }; },
        },
      });
      assert.strictEqual(seenDefault, 20000, 'default budget is 20s when the env var is absent');
    } finally { cleanup2(); }
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// runDeferredStage — dispatches to the RIGHT update.js stage function, with
// the RIGHT (version, hashes-via-state, budget-scoped-env) shape — injected
// updateJs spy, no real fold/heal work performed.
// ---------------------------------------------------------------------------

test('runDeferredStage: fold-all-stores / heal-orphan-partitions — reads the pending version straight off update-sweep-state.json and forwards it', () => {
  const { home, cleanup } = makeHome();
  try {
    writeUpdateSweepState(home, { foldAllStores: { pendingVersion: '0.96.1', pendingHashes: ['h1'] } });
    let seenOpts = null;
    const stubUpdateJs = {
      resolvePaths: () => ({ pluginSrcDir: '/fake' }),
      readSweepState: updateJs.readSweepState,
      foldAllStoresPostUpdate: (opts) => { seenOpts = opts; return { attempted: true }; },
    };
    const r = M.runDeferredStage('fold-all-stores', { home, env: {}, budgetMs: 5000, deps: { updateJs: stubUpdateJs } });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(seenOpts.version, '0.96.1');
    assert.strictEqual(seenOpts.home, home);
    assert.strictEqual(seenOpts.env.ANTIHALL_UPDATE_SWEEP_BUDGET_MS, '5000', 'the per-pass budget is threaded through the SAME knob update.js sweeps already read');
  } finally { cleanup(); }
});

test('runDeferredStage: fold-archived-rows — calls foldArchivedRowsPostUpdate with no version/hashes plumbing (it self-resumes off its own marker)', () => {
  const { home, cleanup } = makeHome();
  try {
    let seenOpts = null;
    const stubUpdateJs = {
      resolvePaths: () => ({ pluginSrcDir: '/fake' }),
      foldArchivedRowsPostUpdate: (opts) => { seenOpts = opts; return { attempted: true, retired: 1 }; },
    };
    const r = M.runDeferredStage('fold-archived-rows', { home, env: {}, budgetMs: 5000, deps: { updateJs: stubUpdateJs } });
    assert.strictEqual(r.retired, 1);
    assert.strictEqual(seenOpts.home, home);
  } finally { cleanup(); }
});

test('runDeferredStage: an unknown stage returns attempted:false rather than throwing', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = M.runDeferredStage('not-a-real-stage', { home, env: {}, deps: {} });
    assert.strictEqual(r.attempted, false);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// main()'s JSON line — deferredSweep field present alongside reconcile
// ---------------------------------------------------------------------------

test('deferredSweepIfDue result shape is what main() forwards verbatim as `deferredSweep` in its JSON line (contract check, not a main() spawn)', () => {
  const { home, cleanup } = makeHome();
  try {
    const res = M.deferredSweepIfDue({ home, deps: { hasDeferredWork: () => false } });
    assert.ok('stage' in res && 'ran' in res, 'main() logs {stage, ran, ...} verbatim as deferredSweep');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Real, unmocked end-to-end: an actual fold-archived-family resume marker on
// disk is detected and actually drained through the REAL update.js +
// devswarm.js code path (proves the isDevswarmActive gate override + the
// module wiring is real, not just exercised via a stub).
// ---------------------------------------------------------------------------

test('deferredSweepIfDue (real update.js + devswarm.js, no stubs): a real fold-archived-family-resume.json marker is picked up and cleared', () => {
  const { home, cleanup } = makeHome();
  try {
    const devswarmDir = path.join(home, '.anti-hall', 'devswarm');
    // An EMPTY archived/ dir (real checkedArchivedDir sees exists:true, zero
    // entries) so foldArchivedFamilyDescriptors actually runs its resume-
    // clearing tail instead of short-circuiting on "no archived dir at all".
    fs.mkdirSync(path.join(devswarmDir, 'archived'), { recursive: true });
    // A resume marker naming an id with NO corresponding archived descriptor
    // on disk — foldArchivedFamilyDescriptors' own candidate pre-filter drops
    // it immediately (not a genuine candidate), so the REAL call is exercised
    // end-to-end (gate open, function invoked, marker re-read) without
    // requiring a full archived-workspace fixture just to prove the wiring.
    fs.writeFileSync(path.join(devswarmDir, 'fold-archived-family-resume.json'), JSON.stringify({ ids: ['ghost-id'] }));

    // Rotate to the fold-archived-rows slot (3rd in rotation order).
    M.deferredSweepIfDue({ home, deps: { hasDeferredWork: () => false } }); // fold-all-stores, no-op
    M.deferredSweepIfDue({ home, deps: { hasDeferredWork: () => false } }); // heal-orphan-partitions, no-op
    const res = M.deferredSweepIfDue({ home }); // fold-archived-rows — REAL hasDeferredWork + REAL runDeferredStage

    assert.strictEqual(res.stage, 'fold-archived-rows');
    assert.strictEqual(res.ran, true, 'the real marker must be detected as pending work');
    assert.ok(res.result && res.result.attempted, 'the real update.js/devswarm.js stage must actually run, not gate-close');
    // The marker naming a non-candidate id is cleared on a clean (non-budget-
    // exhausted) pass — proves the call reached the real resume-clearing code,
    // not merely a gated no-op.
    assert.deepStrictEqual(devswarmCli.readFoldArchivedFamilyResume(home), []);
  } finally { cleanup(); }
});
