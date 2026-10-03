'use strict';
// NON-DRIFT GUARD for makeForwardedDrainedTest's duplicated provenance prefix.
//
// devswarm-orphan-policy.js's makeForwardedDrainedTest cannot import
// scripts/devswarm.js's PRIVATE archivedForwardProvenancePrefix(id) (not
// exported, and this file may not edit scripts/devswarm.js), so it carries a
// literal mirror of that exact string format. If the two ever diverge, the
// hash this policy computes for a forwarded row stops matching the hash the
// REAL forward produces, and the id would incorrectly stay in orphans[]
// forever even after a genuine full forward — a silent regression back to the
// B2 defect this fix exists to close.
//
// This test closes that gap by running the ACTUAL healOrphanPartitions
// (dryRun:false) against a fixture — a REAL forward, using devswarm.js's own
// private prefix and hash — and then asserting makeForwardedDrainedTest
// classifies the result as fully drained. If the mirrored prefix ever
// diverges from the real one, this goes red.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const policy = require('../../plugins/anti-hall/companion/lib/devswarm-orphan-policy.js');
const devswarm = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fwddrained-equiv-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function writeDescriptor(home, sub, id, desc) {
  const dir = path.join(home, '.anti-hall', 'devswarm', sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc)), 'utf8');
}

test('makeForwardedDrainedTest agrees with a REAL healOrphanPartitions forward (proves the mirrored prefix)', () => {
  const home = tmpHome();
  try {
    const repoKey = 'fixture-fwd-1'; // heal opens store/<repoKey>/ — open the fixture in the SAME bucket
    const s = store.openStore({ home, hash: repoKey, backend: 'journal' });

    const shared = path.join(home, 'wt-shared');
    fs.mkdirSync(shared, { recursive: true });
    s.upsertRegistry({ id: 'live-sibling', worktreePath: shared, sessionId: 'sess-1', inboxPath: '/i', cursorPath: '/c', nudgeCommand: null });
    writeDescriptor(home, 'workspaces', 'live-sibling', { worktreePath: shared, sessionId: 'sess-1' });
    writeDescriptor(home, 'archived', 'archived-with-family', { worktreePath: shared });

    // Two real unread DIRECT rows addressed to the archived orphan. Timestamps
    // must be RECENT (within the default 30-day forward age cap) or heal
    // classifies them archived-stale and skips forwarding entirely.
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      const fields = { from: 'someone', to: 'archived-with-family', type: 'direct', message: 'real-msg-' + i, timestamp: now - 1000 + i, urgency: 'normal' };
      store.appendMeshMessage(s, Object.assign({}, fields, { hash: store.meshMessageHash(fields) }));
    }
    s.close();

    // The REAL heal — forwards for real, using devswarm.js's own PRIVATE
    // archivedForwardProvenancePrefix and hash formula. NO dryRun: this must
    // actually write the forwarded rows into live-sibling's partition.
    const res = devswarm.healOrphanPartitions(home, { env: {}, dryRun: false, repoKey, backend: 'journal' });
    assert.equal(res.forwarded, 2, 'sanity: heal must have actually forwarded both rows');

    const s2 = store.openStore({ home, hash: repoKey, backend: 'journal' });
    const registry = s2.listRegistry();
    const isForwardedDrained = policy.makeForwardedDrainedTest(home, registry, s2, store.meshMessageHash);
    const verdict = isForwardedDrained('archived-with-family');
    s2.close();

    assert.equal(verdict, true,
      'the policy classifier must agree with the REAL heal: an id heal genuinely fully-forwarded must classify forwardedDrained');

    // End-to-end: computeSummary must also agree.
    const s3 = store.openStore({ home, hash: repoKey, backend: 'journal' });
    const sum = store.computeSummary(s3, { home, now: 999999 });
    s3.close();
    assert.deepStrictEqual((sum.orphans || []).map((o) => o.id), []);
    assert.deepStrictEqual((sum.forwardedDrained || []).map((o) => o.id), ['archived-with-family']);
  } finally { rm(home); }
});
