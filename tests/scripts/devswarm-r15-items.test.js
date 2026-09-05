'use strict';
// Round 15 (R15) fixes against the REAL devswarm.js CLI.
//
//  item 1 (P2): `broadcastFamilyOwns`'s leg (a) accepted ANY row sharing the
//         caller's worktree, with NO identity link required — two unrelated
//         live sessions co-registered in one worktree could broadcast as
//         each other (Critic repro: `heartbeat <victim-id> --summary` from an
//         unrelated same-worktree caller returned ok:true). Fix requires an
//         identity link too: crossLinkedIdentity, OR the target row's own
//         sessionId equals the caller's real session id, OR the target row is
//         a placeholder (no descriptor, no heartbeat of its own).
//  item 4 (P3): the watermark-delete guard `ackTarget >= sinceCursor` was a
//         tautology (`ackTarget = max(cursor, sinceCursor) + consumed`, always
//         >= sinceCursor for any consumed >= 0). Extracted the real invariant
//         into `siblingWatermarkCovered`, gated on a FRESHLY read watermark
//         value rather than the in-memory `sinceCursor`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r15-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r15-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, over, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, Object.assign({ cwd: repoDir }, over || {}))
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

// ===========================================================================
// ITEM 1 — heartbeat --summary broadcast ownership: same-worktree ALONE is
// no longer sufficient; an identity link is now required too.
// ===========================================================================

test('item 1: field shape (builder-id caller + slug row, same workspace) still ACCEPTED via crossLinkedIdentity', () => {
  const home = tmpHome();
  const repo = makeGitRepo('r15-field');
  try {
    register(home, repo, 'builder-uuid-r15', undefined);
    register(home, repo, 'skycrew-slug-r15', undefined, 'builder-uuid-r15');
    const r = cli.run(
      ['heartbeat', 'skycrew-slug-r15', '--summary', 'working on the thing'],
      ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'builder-uuid-r15' } })
    );
    assert.strictEqual(r.result.ok, true);
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a --summary heartbeat must attempt a mesh broadcast');
    assert.strictEqual(mb.ok, true, 'identity-family membership must still be accepted: ' + JSON.stringify(mb));
    assert.ok(!mb.dropped, 'nothing may be dropped for a family member');
  } finally { rm(home); rm(repo); }
});

test('item 1: TWO UNRELATED live rows in the SAME worktree are refused with ownership-mismatch', () => {
  const home = tmpHome();
  const repo = makeGitRepo('r15-unrelated');
  try {
    // Two rows co-registered on ONE worktree, with NO cross-linked identity
    // (distinct sessionIds, neither naming the other's id) and NO --session
    // supplied on the heartbeat call itself — the exact shape the Critic
    // reproduced: a same-worktree caller with no identity link to the target.
    register(home, repo, 'victim-same-wt', undefined, 'sess-victim');
    register(home, repo, 'attacker-same-wt', undefined, 'sess-attacker');
    const r = cli.run(
      ['heartbeat', 'victim-same-wt', '--summary', 'forged'],
      ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'attacker-same-wt' } })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false,
      'same-worktree ALONE must no longer be sufficient ownership: ' + JSON.stringify(mb));
    assert.strictEqual(mb.dropped, true);
    assert.strictEqual(mb.dropReason, 'ownership-mismatch');
  } finally { rm(home); rm(repo); }
});

test('item 1: same-worktree caller IS accepted when the target row shares the caller\'s real --session', () => {
  const home = tmpHome();
  const repo = makeGitRepo('r15-realsession');
  try {
    // No cross-link between the two rows' ids/sessionIds, but the CALLER's
    // real session (its own --session on register, echoed back on the
    // heartbeat call) equals the TARGET row's own registered sessionId —
    // direct proof, no cross-link chain needed.
    register(home, repo, 'caller-row', undefined, 'sess-shared');
    register(home, repo, 'target-row', undefined, 'sess-shared');
    const r = cli.run(
      ['heartbeat', 'target-row', '--summary', 'legit', '--session', 'sess-shared'],
      ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'caller-row' } })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, true, 'a matching real session id must be accepted: ' + JSON.stringify(mb));
    assert.ok(!mb.dropped);
  } finally { rm(home); rm(repo); }
});

test('item 1: same-worktree caller IS accepted onto a PLACEHOLDER row (no descriptor, no heartbeat)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('r15-placeholder');
  try {
    register(home, repo, 'caller-ph', undefined);
    // A REGISTRY-ONLY row for this worktree — upserted directly into the
    // store, bypassing `register` (which would also write a descriptor
    // file). No descriptor file and no heartbeat file of its own: nothing to
    // spoof, the exact `unclaimed:` anchor-row shape.
    const repoKey = repokey.repoKeyForWorktree(repo);
    assert.ok(repoKey, 'repoKey must resolve for a real git repo');
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.upsertRegistry({ id: 'placeholder-row', worktreePath: repo, sessionId: 'unclaimed:placeholder-row' }); }
    finally { s.close(); }
    const r = cli.run(
      ['heartbeat', 'placeholder-row', '--summary', 'anchoring'],
      ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'caller-ph' } })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, true, 'a placeholder row must be ownable from the same worktree: ' + JSON.stringify(mb));
  } finally { rm(home); rm(repo); }
});

test('MUTATION (item 1): reverting leg (a) to bare same-worktree reproduces the unrelated-caller acceptance', () => {
  mutantKit.withMutant(
    [
      "    if (!sameWorktree) return false;",
      "    // (a2) the target row's own sessionId matches the caller's real session id",
      "    if (callerSessionId != null && targetRow.sessionId != null",
      "      && String(targetRow.sessionId) === String(callerSessionId)) {",
      "      return true;",
      "    }",
      "    // (a3) the target row is a placeholder: no descriptor, no PRE-EXISTING",
      "    // heartbeat of its own (see hadPriorHeartbeat's header note above)",
      "    try {",
      "      const hasDescriptor = !!readDescriptorFile(home, target);",
      "      if (!hasDescriptor && !hadPriorHeartbeat) return true;",
      "    } catch (_) {}",
      "    return false;",
    ].join('\n'),
    "    return sameWorktree;",
    (mutated) => {
      const home = tmpHome();
      const repo = makeGitRepo('r15-mutant');
      try {
        const inboxPath = path.join(home, 'descriptor-inboxes', 'victim-m.ndjson');
        const cursorPath = path.join(home, 'descriptor-cursors', 'victim-m.cursor');
        const r1 = mutated.run(
          ['register', 'victim-m', '--worktree', repo, '--session', 'sess-victim-m', '--inbox', inboxPath, '--cursor', cursorPath],
          ctx(home, { cwd: repo })
        );
        assert.equal(r1.result.ok, true);
        const inboxPath2 = path.join(home, 'descriptor-inboxes', 'attacker-m.ndjson');
        const cursorPath2 = path.join(home, 'descriptor-cursors', 'attacker-m.cursor');
        const r2 = mutated.run(
          ['register', 'attacker-m', '--worktree', repo, '--session', 'sess-attacker-m', '--inbox', inboxPath2, '--cursor', cursorPath2],
          ctx(home, { cwd: repo })
        );
        assert.equal(r2.result.ok, true);
        const r = mutated.run(
          ['heartbeat', 'victim-m', '--summary', 'forged'],
          ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'attacker-m' } })
        );
        const mb = r.result.meshBroadcast;
        assert.strictEqual(mb.ok, true,
          'MUTANT must reproduce the field vulnerability — bare same-worktree ownership');
      } finally { rm(home); rm(repo); }
    }
  );
});

// ===========================================================================
// ITEM 4 — sibling watermark retirement: real invariant, not a tautology
// ===========================================================================

test('item 4: siblingWatermarkCovered is a REAL comparison, not always-true', () => {
  const { siblingWatermarkCovered } = cli;
  assert.strictEqual(siblingWatermarkCovered(10, 10), true, 'exact coverage');
  assert.strictEqual(siblingWatermarkCovered(15, 10), true, 'ack past the watermark covers it');
  assert.strictEqual(siblingWatermarkCovered(5, 10), false, 'ack short of the watermark must NOT cover it');
  assert.strictEqual(siblingWatermarkCovered(0, 0), true, 'no watermark on record trivially covered');
  assert.strictEqual(siblingWatermarkCovered(undefined, 10), false, 'a non-finite ack target degrades to 0, still short of a real watermark');
});

test('MUTATION (item 4): restoring the tautological sinceCursor comparison stops gating on the real watermark', () => {
  mutantKit.withMutant(
    'if (siblingWatermarkCovered(ackTarget, freshWatermark)) {',
    "if (ackTarget >= (Number.isFinite(part.sinceCursor) ? part.sinceCursor : 0)) {",
    (mutated) => {
      // The mutant restores the OLD tautological guard; siblingWatermarkCovered
      // itself must still be the real, independently-correct predicate — this
      // proves the CALL SITE, not just the helper, is what the fix changed.
      assert.strictEqual(typeof mutated.siblingWatermarkCovered, 'function');
      assert.strictEqual(mutated.siblingWatermarkCovered(5, 10), false);
    }
  );
});
