'use strict';
// spec item 3 (fold gate) + item 6 (FIELD SCENARIO E2E) — the SkyCrew
// ground-truth defect: two registry rows for ONE worktree realpath, a DEAD
// slug row refreshed by an unidentified --session-less heartbeat caller
// (FRESHER updatedAt, sessionId set to the sibling row's OWN registry id — a
// stale cross-reference, NOT a real session — NO cursor row, unread
// backlog) vs the LIVE UUID row (OLDER updatedAt, self-consistent sessionId,
// cursor present — being drained). Two things must now hold:
//   (1) `send --to meshId` must land on the LIVE (drained) row's partition,
//       despite it losing on plain recency — resolveMeshTarget's ranking
//       (devswarm-liveness-select.js's pickFreshestLive) must pick it.
//   (2) foldGroupIntoSurvivor's realpath-proven path must actually TOMBSTONE
//       the dead alias row (forward-then-tombstone, no message loss) — while
//       a genuinely distinct live child (self-consistent sessionId) sharing
//       the SAME worktree must still be LEFT, never tombstoned (P1
//       precedent, devswarm-retire-duplicate.test.js).
//
// Real git worktrees as cwd (repoKeyForWorktree spawns git). Mirrors
// devswarm-fold-mesh.test.js / devswarm-retire-duplicate.test.js.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-alias-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-alias-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', '-q', wt, '-b', 'branch-' + tag]);
  return wt;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// Mirrors devswarm-send.test.js's own "phantom + live" convention: send FROM
// the mainRepo TO a linked child worktree's meshId — never a self-send.
test('FIELD SCENARIO E2E: send --to meshId lands on the DRAINED (live) row, not the fresher-but-dead stale-cross-reference row', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('field-e2e');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'field-e2e-child');
    const repoKey = repokey.repoKeyForWorktree(mainRepo);
    const childWorktree = inst.resolveWorktree(childWt);
    const meshId = inst.primaryWorkspaceId(childWorktree);

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      // LIVE UUID row FIRST (so its updatedAt is naturally OLDER — no
      // artificial timestamp injection needed, updated_at is always
      // Date.now() at write time). Self-consistent sessionId. Cursor
      // established (genuine drain evidence).
      s.upsertRegistry({ id: 'live-uuid', worktreePath: childWorktree, sessionId: 'live-uuid-session' });
      s.setCursor('live-uuid', 0); // establishes a cursors row (hasCursorRow:true) even at value 0

      // DEAD slug row SECOND (naturally FRESHER updatedAt — mirrors the field
      // observation of a --session-less heartbeat refreshing it every
      // ~30-45s). sessionId aliases the LIVE row's own registry id — the
      // exact stale cross-reference the field data showed. NO cursor row.
      s.upsertRegistry({ id: 'dead-slug', worktreePath: childWorktree, sessionId: 'live-uuid' });
      // Unread backlog sitting in the dead row's own partition, never drained.
      s.appendMessage({ workspaceId: 'dead-slug', body: 'stranded-1', hash: 'native:stranded1' });
      s.appendMessage({ workspaceId: 'dead-slug', body: 'stranded-2', hash: 'native:stranded2' });
    } finally { s.close(); }

    // (1) send --to meshId must resolve to the LIVE row, not the fresher dead one.
    const sendResult = cli.run(['send', '--to', meshId, '--message', 'hello'], ctx(home, { cwd: mainRepo }));
    assert.strictEqual(sendResult.code, 0, JSON.stringify(sendResult.result));
    assert.strictEqual(sendResult.result.ok, true);

    const s2 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let liveMsgs, deadMsgs;
    try {
      liveMsgs = s2.listMessages('live-uuid', {});
      deadMsgs = s2.listMessages('dead-slug', {});
    } finally { s2.close(); }
    assert.ok(liveMsgs.some((m) => m.body === 'hello'), 'the send must land in the LIVE (drained) row\'s partition');
    assert.ok(!deadMsgs.some((m) => m.body === 'hello'), 'the send must NEVER land in the dead alias row\'s partition');
  } finally {
    rm(home);
    if (childWt) { cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]); }
    rm(mainRepo);
  }
});

test('FOLD: a realpath-proven duplicate whose sessionId is a stale cross-reference IS tombstoned (forward-then-tombstone, no message loss)', () => {
  const home = tmpHome();
  const W = makeGitRepo('fold-alias');
  const repoKey = repokey.repoKeyForWorktree(W);
  try {
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'live-uuid', worktreePath: topOf(W), sessionId: 'live-uuid-session' });
      s.setCursor('live-uuid', 0);
      s.upsertRegistry({ id: 'dead-slug', worktreePath: topOf(W), sessionId: 'live-uuid' }); // stale cross-reference
    } finally { s.close(); }
    // A descriptor file for the dead row (descriptor-backed — the case the
    // gate would normally protect UNLESS the stale-cross-reference exception
    // fires).
    const dp = cli.descriptorPath(home, 'dead-slug');
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    fs.writeFileSync(dp, JSON.stringify({ id: 'dead-slug', worktreePath: topOf(W), sessionId: 'live-uuid' }));
    // Unread backlog on the dead row — must be forwarded, not lost.
    // (Only mesh DIRECT rows, appendMeshMessage, are forwardable — a plain
    // appendMessage row is NOT, same distinction devswarm-fold-mesh.test.js's
    // seedDirect vs seedMsg helpers draw.)
    const s3 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const f = { from: 'sender-x', to: 'dead-slug', type: 'direct', message: 'must-not-be-lost', timestamp: Date.now(), urgency: 'normal' };
      storeLib.appendMeshMessage(s3, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    } finally { s3.close(); }

    const r = cli.foldMeshDuplicates(home, { cwd: W, env: {}, backend: 'journal' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.retired.includes('dead-slug'), 'the stale-cross-reference alias row must be TOMBSTONED despite being descriptor-backed');
    assert.ok(r.forwarded >= 1, 'the dead row\'s unread backlog must be forwarded');

    const s4 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let survivorBodies;
    try { survivorBodies = s4.listMessages('live-uuid', {}).map((m) => m.body); } finally { s4.close(); }
    assert.ok(survivorBodies.includes('must-not-be-lost'), 'the forwarded message must land in the surviving live row (no loss)');
  } finally { rm(W); rm(home); }
});

test('FOLD control (P1 precedent, unaffected): a descriptor-backed row with a SELF-CONSISTENT sessionId sharing the worktree stays LEFT, never tombstoned', () => {
  const home = tmpHome();
  const W = makeGitRepo('fold-control');
  const repoKey = repokey.repoKeyForWorktree(W);
  try {
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'w-a', worktreePath: topOf(W), sessionId: 'session-a' });
      s.upsertRegistry({ id: 'w-b', worktreePath: topOf(W), sessionId: 'session-b' }); // self-consistent, NOT an alias
    } finally { s.close(); }
    for (const id of ['w-a', 'w-b']) {
      const dp = cli.descriptorPath(home, id);
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.writeFileSync(dp, JSON.stringify({ id, worktreePath: topOf(W), sessionId: id === 'w-a' ? 'session-a' : 'session-b' }));
    }

    const r = cli.foldMeshDuplicates(home, { cwd: W, env: {}, backend: 'journal' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.retired, [], 'two genuinely distinct, self-consistent descriptor-backed rows must NEVER be tombstoned');
    assert.ok(Array.isArray(r.left) && r.left.length === 1, 'exactly one row is left (the non-survivor of the un-resolvable dual pair)');
  } finally { rm(W); rm(home); }
});
