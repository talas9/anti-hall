'use strict';
// defect e9e7c99ec924 (P2): a forwarded mesh row preserves the ORIGINAL row's
// `ts` (MESH_ROW_COPY_FIELDS) while `storeSeq` is freshly assigned at forward
// time, so `read-primary`/`inbox messages` prints an out-of-order timestamp
// for it with nothing marking it as a forward. Fix: surface `forwarded:true`
// (derived via the already-exported `forwardedOrigHashOf`, keyed off
// `origHash`) on each message in the read output, WITHOUT touching `ts`/`seq`.
//
// MODULE_UNDER_TEST selects HEAD vs the patched copy (see d56bfaac2da0.test.js
// for the same convention). Isolates HOME to a scratch temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODULE_PATH = process.env.MODULE_UNDER_TEST
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const STORE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');
const REPOKEY_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js');

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function mkGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-e9e-repo-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'a@b.c'], root);
  git(['config', 'user.name', 'a'], root);
  fs.writeFileSync(path.join(root, 'f.txt'), 'x');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

test('inbox messages/read-primary marks a forwarded row forwarded:true without touching ts/seq (e9e7c99ec924)', () => {
  const dev = require(MODULE_PATH);
  const meshStore = require(STORE_PATH);
  const repokey = require(REPOKEY_PATH);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-e9e-home-'));
  const repoCwd = mkGitRepo();
  try {
    const repoKey = repokey.repoKeyForWorktree(repoCwd);
    assert.ok(repoKey, 'test repo must resolve a repoKey');
    const id = 'primary-e9e-test';

    const s = meshStore.openStore({ home, workspaceId: id, hash: repoKey });
    try {
      // A normal (non-forwarded) row: origHash null, ts == send time.
      s.appendMeshRow({
        workspaceId: id, sender: 'someone', recipient: id, body: 'fresh mail',
        ts: 2000, mtype: 'direct', urgency: 'normal', needsReply: false,
        origHash: null, hash: 'e9e-fresh-1',
      });
      // A FORWARDED row: origHash set (stamped at forward time), ts preserved
      // from the ORIGINAL send (older than the fresh row above) while its
      // storeSeq (assigned by appendMeshRow's own auto-increment) is newer —
      // exactly the out-of-order shape the field report describes.
      s.appendMeshRow({
        workspaceId: id, sender: 'archived-child', recipient: id,
        body: '[forwarded from archived archived-child] old instruction',
        ts: 1000, mtype: 'direct', urgency: 'normal', needsReply: false,
        origHash: 'orig-hash-abc', hash: 'e9e-forward-1',
      });
    } finally { s.close(); }

    const ctx = { home, cwd: repoCwd, env: {} };
    const res = dev.cmdInboxMessages(id, {}, ctx, {});
    assert.equal(res.ok, true, 'read must succeed: ' + JSON.stringify(res));
    assert.equal(res.messages.length, 2);

    const fresh = res.messages.find((m) => m.hash === 'e9e-fresh-1');
    const forwarded = res.messages.find((m) => m.hash === 'e9e-forward-1');
    assert.ok(fresh, 'fresh row must be present');
    assert.ok(forwarded, 'forwarded row must be present');

    // The fix under test: forwarded:true on the forward, absent/falsy on the
    // fresh row — and ts/seq are NEVER touched by this fix either way.
    assert.equal(forwarded.forwarded, true,
      'a row with a stamped origHash must be marked forwarded:true in read output');
    assert.equal(forwarded.ts, 1000, 'the fix must never rewrite the preserved ts');
    assert.ok(!fresh.forwarded, 'a non-forwarded row must not be marked forwarded');
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repoCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
