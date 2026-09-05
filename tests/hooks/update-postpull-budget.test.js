'use strict';
// D11-C, defect e7307778b614 — an OVERALL wall-clock budget across every
// DevSwarm post-pull sweep stage combined (update.js's runUpdate). Field
// evidence: reconcile + fold-all-stores + heal-orphan-partitions + a
// fold-archived-rows pass that never finished summed past a 300s kill
// ceiling, with no ceiling on the TOTAL. The fix adds
// `postPullBudgetMs(env)` (env `ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`, default
// 90000) and threads a `postPullDeadline` through
// foldAllStoresPostUpdate/healOrphanPartitionsPostUpdate/
// foldArchivedRowsPostUpdate so each stage's OWN internal per-call deadline
// is capped by the overall run's remaining budget, never allowed to outlive
// it with a fresh default window.
//
// These tests exercise the per-function `postPullDeadline` threading in
// isolation (the lightest-weight, most direct proof the wiring works) rather
// than the full `runUpdate` pipeline, which needs a real git marketplace
// clone + full plugin tree fixture that tests/hooks/update-skill.test.js
// already owns.
//
// MUTATION CHECK: removing the `Number.isFinite(o.postPullDeadline) ?
// Math.min(...) : ...` cap (falling back to the stage's own fresh
// nowFn()+sweepBudgetMs(env) window unconditionally) must turn each test
// below RED — the injected fake's received `deadline` would be LATER than
// the given past `postPullDeadline`, not capped by it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_PLUGIN_SRC_DIR = path.join(REPO_ROOT, 'plugins', 'anti-hall');

function tmpHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'update-postpull-budget-' + tag + '-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

test('foldAllStoresPostUpdate: an already-past postPullDeadline caps foldMeshDuplicates\' own deadline (never a later fresh default)', () => {
  const home = tmpHome('fold');
  try {
    const pastDeadline = Date.now() - 1;
    let receivedDeadline = null;
    const fakeDevswarm = {
      foldMeshDuplicates: (h, ctx) => { receivedDeadline = ctx.deadline; return { retired: [], forwarded: 0, folded: 0 }; },
    };
    const fakeStore = { listStoreHashes: () => ['repo-abcdef'] };
    const result = U.foldAllStoresPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
      home,
      devswarm: fakeDevswarm,
      devswarmStore: fakeStore,
      version: '1.2.3',
      postPullDeadline: pastDeadline,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(receivedDeadline, pastDeadline, 'the stage must use the overall deadline verbatim when it is the tighter bound');
  } finally { rm(home); }
});

test('healOrphanPartitionsPostUpdate: an already-past postPullDeadline caps healOrphanPartitions\' own deadline', () => {
  const home = tmpHome('heal');
  try {
    const pastDeadline = Date.now() - 1;
    let receivedDeadline = null;
    const fakeDevswarm = {
      healOrphanPartitions: (h, ctx) => {
        receivedDeadline = ctx.deadline;
        return { adopted: 0, forwarded: 0, unhealable: 0, skipped: 0, errors: 0, detail: [] };
      },
    };
    const fakeStore = { listStoreHashes: () => ['repo-abcdef'] };
    const result = U.healOrphanPartitionsPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
      home,
      devswarm: fakeDevswarm,
      devswarmStore: fakeStore,
      version: '1.2.3',
      postPullDeadline: pastDeadline,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(receivedDeadline, pastDeadline, 'the stage must use the overall deadline verbatim when it is the tighter bound');
  } finally { rm(home); }
});

test('foldArchivedRowsPostUpdate: an already-past postPullDeadline caps foldArchivedRegistryRows\' + foldArchivedFamilyDescriptors\' own deadline', () => {
  const home = tmpHome('archrows');
  try {
    const pastDeadline = Date.now() - 1;
    let receivedRegistryDeadline = null;
    let receivedFamilyDeadline = null;
    const fakeDevswarm = {
      foldArchivedRegistryRows: (h, ctx) => { receivedRegistryDeadline = ctx.deadline; return { retired: [], forwarded: 0, left: [], errors: 0, ok: true }; },
      foldArchivedFamilyDescriptors: (h, ctx) => { receivedFamilyDeadline = ctx.deadline; return { retired: [], left: [], errors: 0, ok: true }; },
    };
    const result = U.foldArchivedRowsPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
      home,
      devswarm: fakeDevswarm,
      postPullDeadline: pastDeadline,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(receivedRegistryDeadline, pastDeadline);
    assert.strictEqual(receivedFamilyDeadline, pastDeadline);
  } finally { rm(home); }
});

test('postPullBudgetMs: ANTIHALL_UPDATE_POSTPULL_BUDGET_MS overrides the 90s default; invalid values fall back', () => {
  assert.strictEqual(U.postPullBudgetMs({}), 90000);
  assert.strictEqual(U.postPullBudgetMs({ ANTIHALL_UPDATE_POSTPULL_BUDGET_MS: '5000' }), 5000);
  assert.strictEqual(U.postPullBudgetMs({ ANTIHALL_UPDATE_POSTPULL_BUDGET_MS: '0' }), 0);
  assert.strictEqual(U.postPullBudgetMs({ ANTIHALL_UPDATE_POSTPULL_BUDGET_MS: 'garbage' }), 90000);
});
