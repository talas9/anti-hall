'use strict';
// D8 (v0.94.0) — DETERMINISTIC sender attribution when a sender's
// worktree-derived meshId maps to N>1 sibling registry rows.
//
// ROOT CAUSE this closes: devswarm-store.js's resolveSenderRegistryId used to
// delegate its final leg to devswarm-liveness-select.js's pickFreshestLive,
// whose ranking reads PRESENT-TENSE mutable signals (updatedAt, cursor drain,
// heartbeat freshness). Those signals move independently on sibling rows
// between computeSummary passes, so pendingQuestions[].from FLIPPED for the
// SAME stored message across passes whenever a worktree had N>1 registry rows
// (a branch-slug row + a sub-agent row, same or different real sessionIds).
//
// FIX: devswarm-attribution.js's pickAttributionRow ranks purely on row
// VALUES (never liveness): (C1) a real, non-`unclaimed:` sessionId beats one
// that is not; (C2) an id prefixed `basename(worktreePath) + '-'` (the
// branch-slug row) beats a sub-agent row on the same worktree; (D) ascending
// lexical id is the final, always-decisive tiebreak. This file proves the
// picker is flip-proof and exercises its priority order directly; the
// existing regressions (recipient-family exclusion, empty-pool raw-sender
// fallback, builder-id cross-link priority) live in
// devswarm-sender-attribution.test.js and are re-affirmed narrowly here (4/5)
// only where D8's change touches them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const attribution = require('../../plugins/anti-hall/companion/lib/devswarm-attribution.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-attrib-det-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// buildFakeStore(registry, messagesByWorkspace, cursorValues) -> the minimal
// store double computeSummary needs (same shape as the hand-built double in
// devswarm-store-mesh.test.js's tie-break test).
function buildFakeStore(registry, messagesByWorkspace, cursorValues) {
  return {
    listMessages(id) {
      if (id === store.BROADCAST_PARTITION_ID) return [];
      return messagesByWorkspace[id] || [];
    },
    listRegistry() { return registry; },
    messageCount(id) { return (messagesByWorkspace[id] || []).length; },
    cursorValue(id) { return (cursorValues || {})[id]; },
    currentGates() { return {}; },
  };
}

// -----------------------------------------------------------------------
// (a) Two sibling rows on ONE worktree, distinct real sessionIds, the
//     recipient on a DIFFERENT worktree. Liveness signals (updatedAt/cursor)
//     inverted between two passes must NOT change which row wins.
// -----------------------------------------------------------------------
test('(a) attribution is flip-proof: inverting which sibling row is liveness-fresher across two passes yields the SAME `from`, and it is the branch-slug row (C2)', () => {
  const senderWorktree = '/repo/.claude/worktrees/feat-x';
  const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
  const recipientWorktree = '/repo';

  const registry = [
    { id: 'feat-x-a55f20ef', worktreePath: senderWorktree, sessionId: 'sess-real-a', updatedAt: 1000 },
    { id: 'sub-agent-3c64bf63170689c1', worktreePath: senderWorktree, sessionId: 'sess-real-b', updatedAt: 1000 },
    { id: 'recipient-row', worktreePath: recipientWorktree, sessionId: 'sess-recipient', updatedAt: 1000 },
  ];
  const messagesByWorkspace = {
    'recipient-row': [{ mtype: 'direct', needsReply: true, sender: senderMeshId, ts: 100, storeSeq: 1, body: 'proceed?' }],
  };

  // Pass 1: the branch-slug row (`feat-x-a55f20ef`) looks liveness-FRESHER
  // (higher cursor). Under the OLD pickFreshestLive-based leg C this could
  // have won on that basis alone.
  const home1 = tmpHome();
  let from1;
  try {
    const fakeStore1 = buildFakeStore(registry, messagesByWorkspace, {
      'feat-x-a55f20ef': 9, 'sub-agent-3c64bf63170689c1': 0, 'recipient-row': 0,
    });
    from1 = store.computeSummary(fakeStore1, { home: home1 }).workspaces['recipient-row'].pendingQuestions[0].from;
  } finally { rm(home1); }

  // Pass 2: liveness INVERTED — now the sub-agent row looks fresher.
  const home2 = tmpHome();
  let from2;
  try {
    const fakeStore2 = buildFakeStore(registry, messagesByWorkspace, {
      'feat-x-a55f20ef': 0, 'sub-agent-3c64bf63170689c1': 9, 'recipient-row': 0,
    });
    from2 = store.computeSummary(fakeStore2, { home: home2 }).workspaces['recipient-row'].pendingQuestions[0].from;
  } finally { rm(home2); }

  assert.equal(from1, from2, 'inverting liveness signals between passes must not flip attribution');
  assert.equal(from1, 'feat-x-a55f20ef', 'the branch-slug row (id prefixed by the worktree basename) wins via C2');
});

// -----------------------------------------------------------------------
// (b) Shuffling the registry array must not change the winner — attribution
//     depends only on row VALUES, never on enumeration order.
// -----------------------------------------------------------------------
test('(b) shuffling the registry array yields the SAME `from`', () => {
  const senderWorktree = '/repo/.claude/worktrees/feat-x';
  const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
  const rowA = { id: 'feat-x-a55f20ef', worktreePath: senderWorktree, sessionId: 'sess-real-a', updatedAt: 1000 };
  const rowB = { id: 'sub-agent-3c64bf63170689c1', worktreePath: senderWorktree, sessionId: 'sess-real-b', updatedAt: 1000 };
  const recipientRow = { id: 'recipient-row', worktreePath: '/repo', sessionId: 'sess-recipient', updatedAt: 1000 };
  const messagesByWorkspace = {
    'recipient-row': [{ mtype: 'direct', needsReply: true, sender: senderMeshId, ts: 100, storeSeq: 1, body: 'proceed?' }],
  };

  const orderings = [
    [rowA, rowB, recipientRow],
    [rowB, rowA, recipientRow],
    [recipientRow, rowB, rowA],
  ];
  const froms = orderings.map((registry) => {
    const home = tmpHome();
    try {
      const fakeStore = buildFakeStore(registry, messagesByWorkspace, {});
      return store.computeSummary(fakeStore, { home }).workspaces['recipient-row'].pendingQuestions[0].from;
    } finally { rm(home); }
  });
  assert.equal(froms[0], 'feat-x-a55f20ef');
  assert.ok(froms.every((f) => f === froms[0]), 'registry order must never change the winner: ' + JSON.stringify(froms));
});

// -----------------------------------------------------------------------
// (c) Direct unit coverage of pickAttributionRow's priority order.
// -----------------------------------------------------------------------
test('(c) neither id matches the worktree basename: ascending lexical id wins', () => {
  const rows = [
    { id: 'zzz-row', worktreePath: '/wt/other-name', sessionId: 'sess-z' },
    { id: 'aaa-row', worktreePath: '/wt/other-name', sessionId: 'sess-a' },
  ];
  const picked = attribution.pickAttributionRow(rows);
  assert.equal(picked.id, 'aaa-row', 'both tie on field-shape and branch-slug match; ascending lexical id decides');
});

test('(c) a row with a real sessionId beats one whose sessionId is `unclaimed:...`, regardless of lexical order', () => {
  const rows = [
    { id: 'aaa-row', worktreePath: '/wt/other-name', sessionId: 'unclaimed:auto-ensure-1' },
    { id: 'zzz-row', worktreePath: '/wt/other-name', sessionId: 'sess-real' },
  ];
  const picked = attribution.pickAttributionRow(rows);
  assert.equal(picked.id, 'zzz-row', 'C1 (real sessionId) outranks the lexical tiebreak entirely');
});

// -----------------------------------------------------------------------
// (e) Regression: builder-id cross-link (row.sessionId === sender) still
//     wins outright over a lexically-smaller non-linked sibling — this is
//     leg B of resolveSenderRegistryId, unchanged by D8, which runs BEFORE
//     pickAttributionRow is ever consulted.
// -----------------------------------------------------------------------
test('(e) builder-id cross-link wins over a lexically smaller non-linked sibling', () => {
  const senderWorktree = '/repo/.claude/worktrees/linked-case';
  const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
  const registry = [
    // cross-linked: sessionId === the sender's OWN meshId value.
    { id: 'zzz-linked', worktreePath: senderWorktree, sessionId: senderMeshId, updatedAt: 1000 },
    { id: 'aaa-notlinked', worktreePath: senderWorktree, sessionId: 'sess-other', updatedAt: 1000 },
    { id: 'recipient-row', worktreePath: '/repo', sessionId: 'sess-recipient', updatedAt: 1000 },
  ];
  const messagesByWorkspace = {
    'recipient-row': [{ mtype: 'direct', needsReply: true, sender: senderMeshId, ts: 100, storeSeq: 1, body: 'proceed?' }],
  };
  const home = tmpHome();
  try {
    const fakeStore = buildFakeStore(registry, messagesByWorkspace, {});
    const from = store.computeSummary(fakeStore, { home }).workspaces['recipient-row'].pendingQuestions[0].from;
    assert.equal(from, 'zzz-linked', 'the cross-linked row wins via leg B, even though `aaa-notlinked` sorts first lexically');
  } finally { rm(home); }
});

// -----------------------------------------------------------------------
// (d) Regression: pickAttributionRow itself is fail-open on malformed input,
//     matching the pure-function contract the other legs of
//     resolveSenderRegistryId already rely on (recipient-family exclusion +
//     empty-pool raw-sender fallback are exercised end-to-end in
//     devswarm-sender-attribution.test.js and are unchanged by this wave).
// -----------------------------------------------------------------------
test('(d) pickAttributionRow is fail-open: empty/absent/malformed input never throws, returns null', () => {
  assert.doesNotThrow(() => attribution.pickAttributionRow([]));
  assert.equal(attribution.pickAttributionRow([]), null);
  assert.equal(attribution.pickAttributionRow(null), null);
  assert.equal(attribution.pickAttributionRow(undefined), null);
  assert.doesNotThrow(() => attribution.pickAttributionRow([null, {}, 'nope', undefined]));
});
