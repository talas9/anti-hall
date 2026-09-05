'use strict';
// Defect f3b8f326bfc3 (P2) — a phantom "unanswered question" that never clears.
//
// SCOPE NOTE, and why this file is smaller than the defect's two hypotheses.
// The proposed fix had two halves. Only ONE of them survived verification:
//
//   (a) REJECTED — "stop copying `needsReply` onto forwarded rows". This was
//       already proposed, evaluated and guarded against by an earlier wave; see
//       tests/scripts/devswarm-forward-needsreply-carry.test.js, which
//       mechanically demonstrates the two facts that sink it. Both forward sites
//       forward strictly WITHIN ONE IDENTITY FAMILY (the archived-orphan heal
//       resolves `familyKey = canonicalMeshId(desc.worktreePath)` and forwards to
//       `pickSurvivor` of that family; the fold groups by `groupRegistryByMeshId`)
//       — so the copy reaches the SAME logical agent the question was always
//       addressed to. And the source registry row is RETIRED by both paths, after
//       which computeSummary projects nothing from it, so the copy is the ONLY
//       carrier. Dropping the flag there deletes a real pending question
//       permanently. Confirmed in this repo's code, not taken on the guard's word.
//
//   (b) CONFIRMED and fixed here — THE TWO SIDES USED DIFFERENT ID SPACES.
//       `pendingQuestions.from` is a STORE-REGISTRY row id
//       (resolveSenderRegistryId); a reply is recorded under whichever registry
//       row `send --to` resolved. familyAwareUnanswered reconciles the two
//       through identity families — but it built its family map from DESCRIPTOR
//       FILES alone. Measured on a live machine: 40 descriptor files against 183
//       distinct registry ids, 146 of them (builder-id aliases among others) with
//       no descriptor file at all. A reply recorded under any of those 146 was
//       invisible to the cross-check, so the question it answered never cleared —
//       a permanently pending question with no code path able to clear it.
//
// MUTATION CHECK:
//   M1: drop `registryRows` from familyAwareUnanswered's merge
//       -> "a reply under a registry-only alias clears the question" fails.

const test = require('node:test');
const assert = require('node:assert');

const replyState = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');

test('M1 — a reply recorded under a REGISTRY-ONLY alias clears the question', () => {
  // The question resolved to the family's slug row; the reply was addressed to
  // the same agent's builder-id alias, which has NO descriptor file. Before the
  // fix the family map never saw the alias and the question never cleared.
  const WT = '/w/child';
  const pendingQuestions = [{ from: 'child-slug', ts: 1000 }];
  const state = { 'primary-deadbeef': { lastReplyTs: 2000 } };
  const descriptors = [{ id: 'child-slug', worktreePath: WT }];
  const registryRows = [{ id: 'child-slug', worktreePath: WT }, { id: 'primary-deadbeef', worktreePath: WT }];
  const resolveMeshId = (wt) => (wt === WT ? 'mesh-child' : null);

  assert.deepStrictEqual(
    replyState.familyAwareUnanswered({ pendingQuestions, replyState: state, descriptors, resolveMeshId, registryRows }),
    [], 'the reply landed on a family sibling; the question is answered');

  // Without the registry rows — the pre-fix input — the same reply is invisible.
  assert.strictEqual(
    replyState.familyAwareUnanswered({ pendingQuestions, replyState: state, descriptors, resolveMeshId }).length,
    1, 'control: the descriptor-only map cannot see a registry-only alias');
});

test('a registry row with NO descriptor twin can carry the whole family', () => {
  // The extreme of the same gap: the question's `from` is itself a registry-only
  // id, so before the fix there was no family entry for it at all.
  const WT = '/w/child';
  const resolveMeshId = (wt) => (wt === WT ? 'mesh-child' : null);
  assert.deepStrictEqual(replyState.familyAwareUnanswered({
    pendingQuestions: [{ from: 'primary-aaaa1111', ts: 1000 }],
    replyState: { 'primary-bbbb2222': { lastReplyTs: 2000 } },
    descriptors: [],
    registryRows: [{ id: 'primary-aaaa1111', worktreePath: WT }, { id: 'primary-bbbb2222', worktreePath: WT }],
    resolveMeshId,
  }), []);
});

test('the widened map never manufactures a false NEGATIVE', () => {
  const pendingQuestions = [{ from: 'child-slug', ts: 5000 }];
  const descriptors = [{ id: 'child-slug', worktreePath: '/w/child' }];
  const registryRows = [{ id: 'primary-deadbeef', worktreePath: '/w/child' }];
  const resolveMeshId = (wt) => (wt === '/w/child' ? 'mesh-child' : null);
  // A reply OLDER than the question does not answer it.
  assert.strictEqual(replyState.familyAwareUnanswered({
    pendingQuestions, replyState: { 'primary-deadbeef': { lastReplyTs: 1000 } },
    descriptors, resolveMeshId, registryRows,
  }).length, 1);
  // A reply to an UNRELATED worktree does not answer it either.
  assert.strictEqual(replyState.familyAwareUnanswered({
    pendingQuestions, replyState: { 'someone-else': { lastReplyTs: 9000 } },
    descriptors, resolveMeshId, registryRows: [{ id: 'someone-else', worktreePath: '/w/other' }],
  }).length, 1);
  // A malformed registryRows entry is skipped, never thrown on.
  assert.strictEqual(replyState.familyAwareUnanswered({
    pendingQuestions, replyState: {}, descriptors, resolveMeshId,
    registryRows: [null, {}, 'nope'],
  }).length, 1);
  // A question with a non-finite ts stays permanently blocking, unchanged.
  assert.strictEqual(replyState.familyAwareUnanswered({
    pendingQuestions: [{ from: 'child-slug', ts: null }],
    replyState: { 'primary-deadbeef': { lastReplyTs: 9_999_999 } },
    descriptors, resolveMeshId, registryRows,
  }).length, 1);
});

test('the DESCRIPTOR wins when both spaces carry the same id', () => {
  // Same id in both lists must produce ONE family member, not two.
  const WT = '/w/child';
  const out = replyState.familyAwareUnanswered({
    pendingQuestions: [{ from: 'dup', ts: 1000 }],
    replyState: { dup: { lastReplyTs: 2000 } },
    descriptors: [{ id: 'dup', worktreePath: WT }],
    registryRows: [{ id: 'dup', worktreePath: '/w/somewhere-else' }],
    resolveMeshId: (wt) => (wt === WT ? 'mesh-child' : 'mesh-other'),
  });
  assert.deepStrictEqual(out, [], 'the descriptor\'s worktree is the one that counts');
});
