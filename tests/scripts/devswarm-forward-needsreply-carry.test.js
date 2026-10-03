'use strict';
// GUARD: a forwarded copy MUST keep `needsReply`.
//
// WHY THIS TEST EXISTS. A proposed fix for defect f3b8f326bfc3 was to stop
// copying `needsReply` onto forwarded rows, on the premise that "a forwarded
// question is FYI to the new recipient, not addressed to it". That premise does
// not hold for either forward site in this file, and acting on it would DELETE a
// real pending question. Both facts below are mechanically demonstrated by the
// assertions in this file rather than argued:
//
//   1. BOTH forward sites forward strictly WITHIN ONE IDENTITY FAMILY — i.e. to
//      another registry row of the SAME worktree, which is the same logical
//      agent. The archived-orphan heal resolves
//      `familyKey = canonicalMeshId(desc.worktreePath)` and forwards to
//      `pickSurvivor(byMesh.get(familyKey))` (scripts/devswarm.js, the `archived`
//      branch of healOrphanPartitions); the fold groups with
//      `groupRegistryByMeshId`. So the question is still addressed to the agent
//      it was always addressed to.
//
//   2. THE FORWARDED COPY IS THE ONLY CARRIER. computeSummary projects
//      pendingQuestions from the ACTIVE registry set, and both paths retire the
//      source row (archive tombstones it; the fold calls removeRegistryIf). Once
//      that row is gone the original needs_reply row is still physically in the
//      partition but NOTHING projects it — asserted directly below. Dropping the
//      flag on the copy therefore makes the question invisible everywhere,
//      permanently, which is the one direction this codebase's loss-free
//      contract forbids.
//
// The real f3b8f326bfc3 gap is fixed in
// tests/hooks/devswarm-unanswered-family-parity.test.js (the per-turn notice was
// missing the identity-family cross-check the Stop gate already had).
//
// MUTATION LIST (proven RED against this file):
//   M1: drop `needsReply` from MESH_ROW_COPY_FIELDS -> kills the carry test.
//   M2: have forwardArchivedOrphanUnread override `needsReply: false`
//       -> kills the carry test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const REPO_CWD = process.cwd();
const MESH = installIngest.primaryWorkspaceId(REPO_CWD);
const KEY = 'repo-forward-carry';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-carry-'));
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

test('a forwarded copy KEEPS needsReply (the survivor is the same logical agent)', () => {
  const h = makeHome();
  const s = store.openStore({ home: h.home, workspaceId: 'archived-row', hash: KEY });
  try {
    s.upsertRegistry({ id: 'survivor-row', worktreePath: REPO_CWD, sessionId: 'live' });
    const f = {
      from: MESH, to: 'archived-row', type: 'direct', message: 'do you approve the merge?',
      timestamp: Date.now(), urgency: 'normal', needsReply: true,
    };
    store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));

    const fwd = cli.forwardArchivedOrphanUnread(s, 'archived-row', 'survivor-row', { maxAgeMs: 60 * 60 * 1000 });
    assert.strictEqual(fwd.forwarded, 1, 'precondition: the row was actually forwarded');

    const copies = s.listMessages('survivor-row');
    assert.strictEqual(copies.length, 1);
    assert.strictEqual(copies[0].needsReply, true,
      'the copy is the only carrier once the source row is retired — dropping this flag deletes the question');
    assert.ok(copies[0].origHash, 'the copy still carries origHash provenance');
    assert.strictEqual(s.listNeedsReply('survivor-row').length, 1,
      'and it must survive the predicate computeSummary actually queries');
  } finally { s.close(); h.cleanup(); }
});

test('a RETIRED registry row projects NOTHING, even though its needs_reply row remains', () => {
  // This is the fact that makes the copy load-bearing.
  const h = makeHome();
  const s = store.openStore({ home: h.home, workspaceId: 'recipient-row', hash: KEY });
  try {
    s.upsertRegistry({ id: 'sender-row', worktreePath: REPO_CWD, sessionId: 's-send' });
    s.upsertRegistry({ id: 'recipient-row', worktreePath: REPO_CWD, sessionId: 's-recv' });
    const f = {
      from: MESH, to: 'recipient-row', type: 'direct', message: 'do you approve?',
      timestamp: 1000, urgency: 'normal', needsReply: true,
    };
    store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));

    const before = store.computeSummary(s, { home: h.home, now: 2000 });
    assert.strictEqual((before.workspaces['recipient-row'].pendingQuestions || []).length, 1,
      'precondition: with a live registry row the question projects');

    const snap = s.listRegistry().find((r) => r.id === 'recipient-row');
    assert.strictEqual(
      s.removeRegistryIf('recipient-row', { sessionId: snap.sessionId, updatedAt: snap.updatedAt, writeSeq: snap.writeSeq }),
      true, 'precondition: the row is actually retired');

    const after = store.computeSummary(s, { home: h.home, now: 2000 });
    assert.strictEqual(after.workspaces['recipient-row'], undefined,
      'a retired row projects nothing at all');
    assert.strictEqual(s.listNeedsReply('recipient-row').length, 1,
      'the physical needs_reply row is still there — it just has no surface left to reach');
  } finally { s.close(); h.cleanup(); }
});
