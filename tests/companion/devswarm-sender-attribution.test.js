'use strict';
// Defect f3b8f326bfc3 (P2), SECOND mechanism — SENDER ATTRIBUTION.
//
// FIELD SYMPTOM: "1 UNANSWERED question from <a row that never sent anything>"
// — the named row being either the RECIPIENT's own registry row or a dormant
// sub-agent/uuid twin registered on the same worktree.
//
// ROOT CAUSE (reproduced against the real store before the fix; the repro is
// re-run as the first test below). A question row's `sender` is the sender's
// WORKTREE-DERIVED meshId (scripts/devswarm.js's callerIdentity), so every row
// registered on ONE worktree — a Primary's anchor row, its uuid twin, and any
// sub-agent on the same path — shares a single sender value. Both sides of the
// unanswered-question feature then guessed, and guessed differently:
//
//   * ATTRIBUTION (devswarm-store.js's resolveSenderRegistryId) re-resolved that
//     meshId to the FRESHEST LIVE row on the worktree, which is routinely the
//     RECIPIENT'S OWN row -> `from` named the workspace being asked.
//   * CLEARING (devswarm-reply-state.js's familyAwareUnanswered) grouped
//     STRICTLY by worktree, so a reply the recipient recorded against ITSELF or
//     against its own twin cleared a question a THIRD party had asked.
//
// FIX / CONTRACT: one shared definition of "the recipient's own identity"
// (devswarm-identity-family.js's recipientFamilyIds) is excluded on BOTH sides.
// Within what remains, the sender's own identity wins (exact id, then a
// cross-linked row, then the shared freshest-live ranking). When the exclusion
// empties the pool the STORED sender id is kept verbatim — the question is still
// shown, labelled with its raw origin, never re-attributed to its own recipient.
//
// REJECTED alternatives are guarded elsewhere and deliberately not revisited
// here: clearing needsReply on forwarded copies
// (tests/scripts/devswarm-forward-needsreply-carry.test.js) and excluding
// forwarded rows from pendingQuestions.
//
// MUTATION CHECK (both MEASURED on a scratch copy of the tree, not projected):
//   M1: revert resolveSenderRegistryId to "the freshest live row on the
//       worktree" (plain `pickFreshestLive(candidates)`, no recipient-family
//       exclusion) -> 5 of 9 fail: the attribution test on sqlite, and the
//       clearing and sender-retired tests on BOTH backends. Note the
//       attribution test alone is backend-sensitive under this mutation (the
//       journal's row ordering happens to leave S-sub freshest), which is
//       precisely why the pre-fix behavior was an intermittent field symptom
//       and why the clearing test carries the load-bearing P/T assertion.
//   M2: drop the `excluded.has(mid)` skip in familyAwareUnanswered -> 2 of 9
//       fail: a reply against the recipient's own uuid twin clears a third
//       party's question, on both backends.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const replyStateLib = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-attrib-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

const SHARED_WT = '/wt/shared-worktree';

const descriptor = (id, over) => Object.assign({
  id,
  worktreePath: SHARED_WT,
  sessionId: 'sess-' + id,
  inboxPath: '/inbox/' + id + '.ndjson',
  cursorPath: '/cursor/' + id + '.json',
  nudgeCommand: null,
}, over || {});

// ask(s, meshId, to, ts) — a --question send: a direct row flagged needsReply
// whose `sender` is the sender's worktree-derived meshId, exactly as
// callerIdentity() stamps it.
function ask(s, meshId, to, ts, body) {
  const f = {
    from: meshId, to, type: 'direct',
    message: body != null ? body : 'may I proceed?',
    timestamp: ts, urgency: 'normal', needsReply: true,
  };
  return store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
}

// THE FIXTURE: three registry rows on ONE worktree.
//   P      — the Primary's anchor row; the RECIPIENT of the question.
//   T-uuid — P's uuid twin (T.sessionId === P.id, the documented cross-link).
//   S-sub  — a sub-agent registered on the same path; the ACTUAL sender.
// `withSub: false` retires S (no live family row left for the sender).
function seed(s, opts) {
  const o = opts || {};
  s.upsertRegistry(descriptor('P'));
  s.upsertRegistry(descriptor('T-uuid', { sessionId: 'P' }));
  if (o.withSub !== false) s.upsertRegistry(descriptor('S-sub'));
  const mesh = inst.primaryWorkspaceId(SHARED_WT);
  ask(s, mesh, 'P', 1000);
  return mesh;
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  // -------------------------------------------------------------------------
  // 1. ATTRIBUTION: `from` is the SENDER, never the recipient or its twin.
  // -------------------------------------------------------------------------
  test(`[${B.name}] pendingQuestions[].from names the SENDER's row, never the recipient's own row or its uuid twin`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      seed(s);
      const pq = store.computeSummary(s, { home }).workspaces.P.pendingQuestions;
      assert.equal(pq.length, 1, 'the question is still projected');
      assert.equal(pq[0].from, 'S-sub',
        'attribution must resolve within the SENDER\'s family; pre-fix this was the freshest live row on the worktree');
      assert.notEqual(pq[0].from, 'P', 'a question can never be attributed to its own recipient');
      assert.notEqual(pq[0].from, 'T-uuid', 'nor to a row cross-linked to the recipient');
    } finally { s.close(); rm(home); }
  });

  // -------------------------------------------------------------------------
  // 2-3. CLEARING agrees with attribution: only the TRUE sender's family clears.
  // -------------------------------------------------------------------------
  test(`[${B.name}] a reply to the TRUE sender clears the question; a reply to the recipient's own row or twin does NOT`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const mesh = seed(s);
      const pendingQuestions = store.computeSummary(s, { home }).workspaces.P.pendingQuestions;
      const registryRows = s.listRegistry();
      const resolveMeshId = (wt) => (wt === SHARED_WT ? mesh : null);
      const check = (state) => replyStateLib.familyAwareUnanswered({
        pendingQuestions, replyState: state, descriptors: [], registryRows, resolveMeshId, selfId: 'P',
      }).length;

      assert.equal(check({ 'S-sub': { lastReplyTs: 2000 } }), 0,
        'a reply recorded against the true sender answers the question');
      assert.equal(check({ 'T-uuid': { lastReplyTs: 2000 } }), 1,
        'a reply against the RECIPIENT\'s own uuid twin must NOT clear a third party\'s question');
      assert.equal(check({ P: { lastReplyTs: 2000 } }), 1,
        'nor may the recipient clear it by recording a reply against itself');
      assert.equal(check({}), 1, 'control: with no reply at all it stays unanswered');
    } finally { s.close(); rm(home); }
  });

  // -------------------------------------------------------------------------
  // 4. SENDER RETIRED: still listed, under the RAW sender id — never
  //    re-attributed to the recipient, and NOT the structural drop (which stays
  //    reserved for a sender matching no registry row at all, see
  //    devswarm-store-mesh.test.js's permanent-deadlock tests).
  // -------------------------------------------------------------------------
  test(`[${B.name}] with the sender retired (no live family row) the question is still listed, labelled with the RAW sender id`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const mesh = seed(s, { withSub: false });
      const pq = store.computeSummary(s, { home }).workspaces.P.pendingQuestions;
      assert.equal(pq.length, 1, 'the question must not vanish just because its sender is gone');
      assert.equal(pq[0].from, mesh, 'kept under the stored sender id verbatim');
      assert.notEqual(pq[0].from, 'P', 'never re-attributed to the recipient');
      assert.notEqual(pq[0].from, 'T-uuid', 'never re-attributed to the recipient\'s twin');
    } finally { s.close(); rm(home); }
  });

  // -------------------------------------------------------------------------
  // 5. FORWARDED COPY: attributed to its STORED sender (the archived
  //    workspace), never to the survivor that inherited the row.
  // -------------------------------------------------------------------------
  test(`[${B.name}] a forwarded copy is attributed to its stored sender (the archived workspace), never to the survivor`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('survivor'));
      s.upsertRegistry(descriptor('archived-child'));
      const mesh = inst.primaryWorkspaceId(SHARED_WT);
      // The fold re-addresses the row to the survivor and prefixes the body,
      // but carries `sender` through verbatim (scripts/devswarm.js's
      // MESH_ROW_COPY_FIELDS).
      ask(s, mesh, 'survivor', 1500, '[forwarded from archived archived-child] which approach?');
      const pq = store.computeSummary(s, { home }).workspaces.survivor.pendingQuestions;
      assert.equal(pq.length, 1);
      assert.equal(pq[0].from, 'archived-child', 'the forwarded copy keeps the ORIGINAL sender identity');
      assert.notEqual(pq[0].from, 'survivor', 'the survivor received the question; it did not send it');
    } finally { s.close(); rm(home); }
  });
}

// ---------------------------------------------------------------------------
// 6. recipientFamilyIds — the ONE shared definition both sides consume.
// ---------------------------------------------------------------------------
test('recipientFamilyIds covers the recipient and its cross-linked twins only, and is empty without a recipient', () => {
  const identityFamily = require('../../plugins/anti-hall/companion/lib/devswarm-identity-family.js');
  const rows = [
    { id: 'P', worktreePath: SHARED_WT, sessionId: 'sess-P' },
    { id: 'T-uuid', worktreePath: SHARED_WT, sessionId: 'P' },   // twin: sessionId IS P's id
    { id: 'S-sub', worktreePath: SHARED_WT, sessionId: 'sess-S' },
    { id: 'elsewhere', worktreePath: '/wt/other', sessionId: 'sess-e' },
  ];
  assert.deepStrictEqual(
    Array.from(identityFamily.recipientFamilyIds('P', rows)).sort(),
    ['P', 'T-uuid'],
    'the recipient plus its cross-linked twin — a same-worktree sub-agent is NOT part of it');
  // BACKWARD COMPATIBILITY: no recipient -> empty set -> every pre-existing
  // caller keeps its exact prior behavior.
  for (const absent of [null, undefined, '']) {
    assert.equal(identityFamily.recipientFamilyIds(absent, rows).size, 0);
  }
  // A recipient with no row of its own still catches rows pointing AT it.
  assert.deepStrictEqual(
    Array.from(identityFamily.recipientFamilyIds('P', [rows[1], rows[2]])).sort(),
    ['P', 'T-uuid']);
  // Malformed rows are skipped, never thrown on.
  assert.doesNotThrow(() => identityFamily.recipientFamilyIds('P', [null, {}, 'nope', undefined]));
});
