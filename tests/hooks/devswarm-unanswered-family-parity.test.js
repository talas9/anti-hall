'use strict';
// DEFECT f3b8f326bfc3 (P2, field): the per-turn notice reported "1 UNANSWERED
// question" for a question the Primary had already answered.
//
// ROOT CAUSE (reproduced end-to-end against BOTH hooks with identical on-disk
// state, then re-run green after the fix): the identity-family cross-check
// (defect 427dbff95f28) shipped INLINE in hooks/devswarm-parent-gate.js only.
// hooks/devswarm-parent-inbox.js computes its every-turn "N remain UNANSWERED"
// notice from the SAME summary pendingQuestions and the SAME reply-state file,
// but called the RAW `unansweredQuestions` string compare. A pendingQuestion's
// `from` is the sender's freshest-LIVE registry row (devswarm-store.js
// resolveSenderRegistryId); a reply is recorded under whatever row `--to`
// actually resolved to (devswarm.js resolveSendTarget). When those diverge — the
// normal case for a worktree carrying both a slug row and a UUID/builder row —
// the gate correctly stopped blocking while the notice kept naming the question
// forever.
//
// FIX: ONE definition, `familyAwareUnanswered` in
// companion/lib/devswarm-reply-state.js, called by BOTH hooks. Behaviour of the
// gate is unchanged; the notice gains the cross-check it was missing.
//
// MUTATION LIST (each proven RED against this file):
//   M1: point the inbox back at the raw `unansweredQuestions`
//       -> kills "PARITY: a family-sibling reply clears BOTH surfaces".
//   M2: make familyAwareUnanswered ignore the ts comparison (any recorded reply
//       clears) -> kills "an EARLIER reply does not clear a LATER question".
//   M3: let familyAwareUnanswered group by something other than the resolved
//       worktree (return a constant family key) -> kills "a DIFFERENT worktree's
//       reply never clears".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const replyStateLib = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');

const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = installIngest.primaryWorkspaceId(REPO_CWD);
const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');

// --- unit: the shared primitive ------------------------------------------

const FAM = [
  { id: 'row-a', worktreePath: '/wt/one' },
  { id: 'row-b', worktreePath: '/wt/one' },   // SAME worktree -> same family
  { id: 'row-z', worktreePath: '/wt/other' }, // different worktree -> different family
];
const resolveMeshId = (wt) => (wt === '/wt/one' ? 'mesh-one' : 'mesh-other');

function fam(pendingQuestions, replyState, descriptors) {
  return replyStateLib.familyAwareUnanswered({
    pendingQuestions, replyState, descriptors: descriptors || FAM, resolveMeshId,
  });
}

test('a reply recorded on a FAMILY SIBLING answers the question', () => {
  const q = [{ from: 'row-a', ts: 1000 }];
  assert.deepStrictEqual(fam(q, { 'row-b': { lastReplyTs: 2000 } }), []);
  // and the exact-match case still works, unchanged
  assert.deepStrictEqual(fam(q, { 'row-a': { lastReplyTs: 2000 } }), []);
});

test('an EARLIER reply does not clear a LATER question', () => {
  const q = [{ from: 'row-a', ts: 3000 }];
  assert.deepStrictEqual(fam(q, { 'row-b': { lastReplyTs: 2000 } }), q);
  // exactly at the question ts counts as answered (>=, matching the gate)
  assert.deepStrictEqual(fam(q, { 'row-b': { lastReplyTs: 3000 } }), []);
});

test('a DIFFERENT worktree\'s reply never clears the question', () => {
  const q = [{ from: 'row-a', ts: 1000 }];
  assert.deepStrictEqual(fam(q, { 'row-z': { lastReplyTs: 9000 } }), q,
    'collapseFamilies groups strictly by resolved worktree — two children can never share a family');
});

test('FAIL-OPEN: unknown sender, no descriptors, malformed entry, throwing resolver', () => {
  const q = [{ from: 'not-in-any-family', ts: 1000 }];
  assert.deepStrictEqual(fam(q, { 'row-b': { lastReplyTs: 9000 } }), q, 'unknown family -> unchanged');
  assert.deepStrictEqual(fam(q, {}, []), q, 'no descriptors -> raw set');
  const malformed = [{ ts: 1000 }]; // no `from`
  assert.deepStrictEqual(fam(malformed, { 'row-b': { lastReplyTs: 9000 } }), malformed);
  const thrower = () => { throw new Error('resolver exploded'); };
  const out = replyStateLib.familyAwareUnanswered({
    pendingQuestions: [{ from: 'row-a', ts: 1000 }],
    replyState: { 'row-b': { lastReplyTs: 9000 } }, descriptors: FAM, resolveMeshId: thrower,
  });
  assert.strictEqual(out.length, 1, 'a throwing resolver must never clear a question');
});

test('a NON-FINITE question ts stays permanently unanswered', () => {
  const q = [{ from: 'row-a', ts: 'nope' }];
  assert.deepStrictEqual(fam(q, { 'row-b': { lastReplyTs: 9e15 } }), q);
});

// --- end-to-end: BOTH hooks over one on-disk state -------------------------

function seed(sibReplyTs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unanswered-parity-'));
  const root = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  // Two registry rows for THIS worktree = one identity family.
  for (const id of ['sib-row-a', 'sib-row-b']) {
    const inboxPath = path.join(root, 'inbox', id + '.ndjson');
    const cursorPath = path.join(root, 'cursor', id + '.json');
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(inboxPath, '');
    fs.writeFileSync(cursorPath, '0');
    fs.writeFileSync(path.join(root, 'workspaces', id + '.json'), JSON.stringify({
      id, worktreePath: REPO_CWD, sessionId: 's-' + id, inboxPath, cursorPath,
    }));
  }
  fs.mkdirSync(path.join(root, 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(root, 'summaries', REPO_KEY + '.json'), JSON.stringify({
    generatedAt: Date.now(), requiredGates: [], recent: [],
    workspaces: {
      [OWN_ID]: {
        worktreePath: REPO_CWD, total: 0, cursor: 0, unread: 0, directUnread: 0,
        broadcastUnread: 0, urgencyMax: null, working_on: null, gates: {}, archive_ready: false,
        pendingQuestions: [{ from: 'sib-row-a', ts: 1000, seq: 1 }],
      },
    },
  }));
  // The reply landed on the SIBLING row, not on the question's `from`.
  if (sibReplyTs != null) replyStateLib.recordReply(REPO_KEY, home, 'sib-row-b', sibReplyTs);
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function runHook(home, name, payload) {
  const r = cp.spawnSync('node', [path.join(HOOKS, name)], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_CWD,
    env: { ...process.env, HOME: home, DEVSWARM_REPO_ID: 'repo-1' },
  });
  return String(r.stdout || '');
}
const gateSaysUnanswered = (home) => /unanswered/i.test(
  runHook(home, 'devswarm-parent-gate.js', { hook_event_name: 'Stop', session_id: 't', cwd: REPO_CWD }));
const noticeSaysUnanswered = (home) => /UNANSWERED/.test(
  runHook(home, 'devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD }));

test('PARITY: a family-sibling reply clears BOTH the Stop gate and the per-turn notice', () => {
  const h = seed(5000); // reply AFTER the question
  try {
    assert.strictEqual(gateSaysUnanswered(h.home), false, 'gate (already correct before this fix)');
    assert.strictEqual(noticeSaysUnanswered(h.home), false,
      'the every-turn notice must reach the SAME verdict from the SAME state');
  } finally { h.cleanup(); }
});

test('PARITY NEGATIVE CONTROL: with NO reply at all, BOTH still report the question', () => {
  const h = seed(null);
  try {
    assert.strictEqual(gateSaysUnanswered(h.home), true);
    assert.strictEqual(noticeSaysUnanswered(h.home), true,
      'the fix must not silently clear a genuinely unanswered question');
  } finally { h.cleanup(); }
});

test('PARITY NEGATIVE CONTROL: a reply OLDER than the question clears neither', () => {
  const h = seed(500); // reply BEFORE the question ts of 1000
  try {
    assert.strictEqual(gateSaysUnanswered(h.home), true);
    assert.strictEqual(noticeSaysUnanswered(h.home), true);
  } finally { h.cleanup(); }
});
