'use strict';
// SkyCrew Primary report: `read-primary` printed `from: null` for the native "DONE: <branch> ..." notices. A native
// message names only its branch; the registry row checked out under that branch (DevSwarm: `/` -> `-` in the directory
// name) is the sender. Stamped at write (ingest / pull); legacy null-sender rows are attributed at READ time only.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const ops = require('../harness/ops.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const { resolveBranchSender, branchOfDoneBody } = require('../../plugins/anti-hall/companion/lib/devswarm-branch-sender.js');

const T0 = 1_700_000_000_000;
let HAS_SQLITE = true;
try { require('node:sqlite'); } catch (_) { HAS_SQLITE = false; }

const ROWS = [
  { id: 'c1', worktreePath: '/x/repos/0/ab/fix-skydart-pdf-and-tests' },
  { id: 'c2', worktreePath: '/x/repos/0/cd/chore-find-new-website' },
  { id: 'dupA', worktreePath: '/x/a/same-dir' },
  { id: 'dupB', worktreePath: '/y/b/same-dir' },
];

test('resolveBranchSender: slash -> dash directory match; unknown or ambiguous stays null', () => {
  assert.strictEqual(resolveBranchSender(ROWS, 'fix/skydart-pdf-and-tests'), 'c1');
  assert.strictEqual(resolveBranchSender(ROWS, 'chore/find-new-website'), 'c2');
  assert.strictEqual(resolveBranchSender(ROWS, 'nope/unknown'), null);
  assert.strictEqual(resolveBranchSender(ROWS, 'same-dir'), null, 'two rows share the directory name: never a guess');
  assert.strictEqual(resolveBranchSender(ROWS, null), null);
  assert.strictEqual(resolveBranchSender(null, 'a/b'), null);
});

test('branchOfDoneBody: names the branch of a DONE notice only', () => {
  assert.strictEqual(branchOfDoneBody('DONE: fix/skydart-pdf-and-tests — skydart@main@acd48aad'), 'fix/skydart-pdf-and-tests');
  assert.strictEqual(branchOfDoneBody('hello DONE: a/b x'), null);
  assert.strictEqual(branchOfDoneBody(null), null);
});

(HAS_SQLITE ? test : test.skip)('ingestPayload stamps the sender of a native DONE notice from its branch', () => {
  const fx = ops.makeMeshFixture(['r1', 'r2'], 'branchsender-ingest');
  try {
    ops.opRegister(fx, 'r1', T0);
    ops.opRegister(fx, 'r2', T0 + 1);
    const s = storeLib.openStore({ home: fx.home, hash: fx.repoKey, backend: 'sqlite' });
    try {
      for (const id of ['r1', 'r2']) s.upsertRegistry({ id, worktreePath: fx.readers[id], sessionId: 's-' + id, inboxPath: null, cursorPath: null, nudgeCommand: null });
      const raw = JSON.stringify([
        { fromBranch: 'wt/r1', toBranch: 'main', message: 'DONE: wt/r1 — repo@main@abc', createdAt: '2026-01-01T00:00:00Z' },
        { fromBranch: 'wt/ghost', toBranch: 'main', message: 'DONE: wt/ghost — repo@main@def', createdAt: '2026-01-01T00:00:01Z' },
      ]);
      assert.strictEqual(ingest.ingestPayload(s, raw, { workspaceId: 'r2', home: fx.home }).inserted, 2);
      const rows = s.listMessages('r2');
      assert.strictEqual(rows.find((r) => /wt\/r1/.test(r.body)).sender, 'r1');
      assert.strictEqual(rows.find((r) => /wt\/ghost/.test(r.body)).sender, null, 'an unregistered branch stays unattributed');
    } finally { s.close(); }
  } finally { fx.cleanup(); }
});

test('read-primary attributes a LEGACY null-sender DONE row from its branch at read time (nothing rewritten)', () => {
  const fx = ops.makeMeshFixture(['r1', 'r2'], 'branchsender-read');
  try {
    ops.opRegister(fx, 'r1', T0);
    ops.opRegister(fx, 'r2', T0 + 1);
    const s = storeLib.openStore({ home: fx.home, hash: fx.repoKey, backend: 'journal' });
    try {
      s.appendMessage({ workspaceId: 'r2', ts: T0 + 2, hash: 'native:legacy1', body: 'DONE: wt/r1 — repo@main@abc' });
      s.appendMessage({ workspaceId: 'r2', ts: T0 + 3, hash: 'native:legacy2', body: 'DONE: wt/ghost — repo@main@def' });
    } finally { s.close(); }
    const r = ops.cli.run(['inbox', 'read-primary', 'r2'], ops.baseCtx(fx, 'r2', T0 + 4, { instanceNonce: 'h:4242:1700000000000' })).result;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const by = (re) => r.messages.find((m) => re.test(m.body));
    assert.strictEqual(by(/wt\/r1/).from, 'r1');
    assert.strictEqual(by(/wt\/ghost/).from, null, 'unknown branch: the legacy null is kept for consumers');
  } finally { fx.cleanup(); }
});
