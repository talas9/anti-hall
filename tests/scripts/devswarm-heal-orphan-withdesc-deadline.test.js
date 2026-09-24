'use strict';
// D11-C, defect e7307778b614 — healOrphanPartitions honored ctx.deadline only
// for the no-descriptor bucket (a class of orphans that can NEVER produce a
// write); the REAL work — the with-descriptor bucket (adopt/forward) — ran
// to full completion regardless, so a store with many descriptor-backed
// orphans could still blow past update.js's own sweep budget (field-measured
// 45.8s against a 20s budget). The fix adds the SAME "stop before the next
// item, never mid-item, first item always runs" deadline gate to the
// with-descriptor loop, deferring the rest to `skipped` (not `unhealable` —
// they were never classified this pass, so a reappearing descriptor is still
// adopted next time).
//
// MUTATION CHECK: removing the deadline check from the with-descriptor loop
// must turn the first test below RED — both orphans would adopt instead of
// only the first.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-healorphan-dl-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-healorphan-dl-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function descFile(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}
function seedDirect(home, repoKey, toId, body) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    const f = { from: 'sender-x', to: toId, type: 'direct', message: body, timestamp: Date.now(), urgency: 'normal' };
    storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
  } finally { s.close(); }
}
function regIds(home, repoKey) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.listRegistry().map((d) => d.id).sort(); } finally { s.close(); }
}

test('healOrphanPartitions: an already-spent ctx.deadline adopts only the FIRST descriptor-backed orphan, defers the rest (skipped, not unhealable)', () => {
  const home = tmpHome();
  const W1 = makeGitRepo('healdl');
  const repoKey = repokey.repoKeyForWorktree(W1);
  try {
    // Two INDEPENDENT descriptor-backed orphans, no live family for either
    // (own worktreePath, no matching registry group) — each is real
    // adopt-only work, no forwarding complexity.
    descFile(home, 'orphan-dl-a', { id: 'orphan-dl-a', worktreePath: topOf(W1) + '/a', sessionId: null });
    seedDirect(home, repoKey, 'orphan-dl-a', 'msg-a');
    descFile(home, 'orphan-dl-b', { id: 'orphan-dl-b', worktreePath: topOf(W1) + '/b', sessionId: null });
    seedDirect(home, repoKey, 'orphan-dl-b', 'msg-b');

    const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: 'journal', deadline: Date.now() - 1 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.adopted, 1, 'only the FIRST orphan adopts this pass');
    assert.strictEqual(r.skipped, 1, 'the second orphan is deferred (skipped), not unhealable');
    assert.strictEqual(r.unhealable, 0, 'a deferred with-descriptor orphan must never misclassify as unhealable');
    assert.ok(r.detail.some((d) => d.action === 'deadline-skip' && d.reason === 'with-descriptor bucket deferred to next pass' && d.count === 1));

    const ids = regIds(home, repoKey);
    assert.ok(ids.includes('orphan-dl-a'), 'orphan-dl-a was adopted');
    assert.ok(!ids.includes('orphan-dl-b'), 'orphan-dl-b was NOT adopted — deferred to next pass');
  } finally { rm(home); rm(W1); }
});

test('healOrphanPartitions: no ctx.deadline set still adopts every descriptor-backed orphan (unchanged default behavior)', () => {
  const home = tmpHome();
  const W1 = makeGitRepo('healnodl');
  const repoKey = repokey.repoKeyForWorktree(W1);
  try {
    descFile(home, 'orphan-nodl-a', { id: 'orphan-nodl-a', worktreePath: topOf(W1) + '/a', sessionId: null });
    seedDirect(home, repoKey, 'orphan-nodl-a', 'msg-a');
    descFile(home, 'orphan-nodl-b', { id: 'orphan-nodl-b', worktreePath: topOf(W1) + '/b', sessionId: null });
    seedDirect(home, repoKey, 'orphan-nodl-b', 'msg-b');

    const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: 'journal' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.adopted, 2);
    assert.strictEqual(r.skipped, 0);
  } finally { rm(home); rm(W1); }
});

// Deadline-deferred ids are unfinished work: healOrphanPartitions reports them
// as `deadlineSkipped` and update.js feeds that into the migration registry's
// pendingRows, so a pass that ran out of time is never stamped done for the
// version (it previously summed `skipped` for display only, and a drained
// sweep stamped completion with the deferred orphan still unadopted).
test('healOrphanPartitions: deadline-deferred ids are reported as deadlineSkipped', () => {
  const home = tmpHome();
  const W1 = makeGitRepo('healdlcount');
  const repoKey = repokey.repoKeyForWorktree(W1);
  try {
    descFile(home, 'orphan-dc-a', { id: 'orphan-dc-a', worktreePath: topOf(W1) + '/a', sessionId: null });
    seedDirect(home, repoKey, 'orphan-dc-a', 'msg-a');
    descFile(home, 'orphan-dc-b', { id: 'orphan-dc-b', worktreePath: topOf(W1) + '/b', sessionId: null });
    seedDirect(home, repoKey, 'orphan-dc-b', 'msg-b');
    seedDirect(home, repoKey, 'orphan-dc-nodesc', 'msg-c'); // no descriptor anywhere
    const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: 'journal', deadline: Date.now() - 1 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deadlineSkipped, 2, 'one with-descriptor + one no-descriptor id deferred by the deadline');
    const r2 = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: 'journal' });
    assert.strictEqual(r2.deadlineSkipped, 0, 'no deadline -> nothing deferred');
  } finally { rm(home); rm(W1); }
});

test('healOrphanPartitionsPostUpdate: a deadline that expires mid-heal is NOT stamped; the next run completes and IS stamped', () => {
  const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');
  const pluginSrcDir = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const home = tmpHome();
  const W1 = makeGitRepo('healdlstamp');
  const repoKey = repokey.repoKeyForWorktree(W1);
  const env = { DEVSWARM_REPO_ID: 'r1', ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' };
  try {
    descFile(home, 'orphan-st-a', { id: 'orphan-st-a', worktreePath: topOf(W1) + '/a', sessionId: null });
    seedDirect(home, repoKey, 'orphan-st-a', 'msg-a');
    descFile(home, 'orphan-st-b', { id: 'orphan-st-b', worktreePath: topOf(W1) + '/b', sessionId: null });
    seedDirect(home, repoKey, 'orphan-st-b', 'msg-b');
    const run = (extra) => U.healOrphanPartitionsPostUpdate(Object.assign({
      paths: { pluginSrcDir }, env, cwd: W1, home, devswarm: cli, hashes: [repoKey], version: '9.9.9',
    }, extra || {}));

    const r1 = run({ postPullDeadline: Date.now() - 1 });
    assert.strictEqual(r1.attempted, true);
    assert.strictEqual(r1.adopted, 1, 'the first orphan adopts, the second is deadline-deferred');
    assert.strictEqual(r1.budgetExhausted, false, 'the single-store sweep itself drained');
    const s1 = U.readSweepState(home);
    assert.ok(!s1.healOrphanPartitions || s1.healOrphanPartitions.completedVersion !== '9.9.9',
      'a pass with deadline-deferred orphans must NOT stamp the version done');
    assert.ok(!regIds(home, repoKey).includes('orphan-st-b'));

    const r2 = run({ hashes: undefined });
    assert.strictEqual(r2.skippedAlreadyDone, undefined, 'the unstamped version re-runs');
    assert.strictEqual(r2.adopted, 1, 'the deferred orphan adopts on the next run');
    assert.ok(regIds(home, repoKey).includes('orphan-st-b'));
    assert.strictEqual(U.readSweepState(home).healOrphanPartitions.completedVersion, '9.9.9', 'the finished run IS stamped');
  } finally { rm(home); rm(W1); }
});
