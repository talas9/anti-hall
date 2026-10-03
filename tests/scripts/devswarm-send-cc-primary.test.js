'use strict';
// peer request F (SkyCrew + tf3 Primaries, 2026-09-26): `send --to <sibling>
// --cc-primary` delivers to the sibling AND copies the Primary with the
// identical message body, so two lanes can coordinate while the Primary
// still sees it. Best-effort/additive: the cc send's own outcome is reported
// under the result's `ccPrimary` and can never flip the primary send's own
// `ok`/exit code.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-cc-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-cc-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}

test('send --to <sibling> --cc-primary delivers to BOTH the sibling and the Primary with the identical body', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('cc-primary');
  let siblingWt = null;
  let senderWt = null;
  try {
    siblingWt = addLinkedWorktree(mainRepo, 'cc-sibling');
    senderWt = addLinkedWorktree(mainRepo, 'cc-sender');
    const repoKey = repokey.repoKeyForWorktree(mainRepo);

    const primaryId = derivedId(mainRepo);
    const siblingId = derivedId(siblingWt);
    const senderId = derivedId(senderWt);

    seedRegistry(home, repoKey, { id: primaryId, worktreePath: inst.resolveWorktree(mainRepo), sessionId: 's-primary' });
    seedRegistry(home, repoKey, { id: siblingId, worktreePath: inst.resolveWorktree(siblingWt), sessionId: 's-sibling' });
    seedRegistry(home, repoKey, { id: senderId, worktreePath: inst.resolveWorktree(senderWt), sessionId: 's-sender' });

    const r = cli.run(['send', '--to', siblingId, '--message', 'cc me in', '--cc-primary'], ctx(home, { cwd: senderWt }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.type, 'direct');
    assert.ok(r.result.ccPrimary, 'ccPrimary must be reported on the result');
    assert.equal(r.result.ccPrimary.ok, true, JSON.stringify(r.result.ccPrimary));

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const siblingInbox = s.listMessages(siblingId);
      const primaryInbox = s.listMessages(primaryId);
      assert.equal(siblingInbox.length, 1);
      assert.equal(siblingInbox[0].body, 'cc me in');
      assert.equal(primaryInbox.length, 1);
      assert.equal(primaryInbox[0].body, 'cc me in', 'the Primary cc must carry the IDENTICAL body');
      assert.equal(primaryInbox[0].sender, senderId);
    } finally { s.close(); }
  } finally {
    rm(home);
    if (siblingWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', siblingWt]);
    if (senderWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', senderWt]);
    rm(mainRepo);
  }
});

test('send --to <sibling> (no --cc-primary) does NOT touch the Primary\'s inbox and reports no ccPrimary', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('no-cc-primary');
  let siblingWt = null;
  let senderWt = null;
  try {
    siblingWt = addLinkedWorktree(mainRepo, 'nocc-sibling');
    senderWt = addLinkedWorktree(mainRepo, 'nocc-sender');
    const repoKey = repokey.repoKeyForWorktree(mainRepo);

    const primaryId = derivedId(mainRepo);
    const siblingId = derivedId(siblingWt);
    const senderId = derivedId(senderWt);

    seedRegistry(home, repoKey, { id: primaryId, worktreePath: inst.resolveWorktree(mainRepo), sessionId: 's-primary' });
    seedRegistry(home, repoKey, { id: siblingId, worktreePath: inst.resolveWorktree(siblingWt), sessionId: 's-sibling' });
    seedRegistry(home, repoKey, { id: senderId, worktreePath: inst.resolveWorktree(senderWt), sessionId: 's-sender' });

    const r = cli.run(['send', '--to', siblingId, '--message', 'no cc here'], ctx(home, { cwd: senderWt }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.ccPrimary, undefined);

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const primaryInbox = s.listMessages(primaryId);
      assert.equal(primaryInbox.length, 0);
    } finally { s.close(); }
  } finally {
    rm(home);
    if (siblingWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', siblingWt]);
    if (senderWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', senderWt]);
    rm(mainRepo);
  }
});

test('send --broadcast --cc-primary does not attempt a cc (cc-primary only applies to a direct --to send)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('broadcast-cc');
  try {
    const repoKey = repokey.repoKeyForWorktree(mainRepo);
    const primaryId = derivedId(mainRepo);
    seedRegistry(home, repoKey, { id: primaryId, worktreePath: inst.resolveWorktree(mainRepo), sessionId: 's-primary' });

    const r = cli.run(['send', '--broadcast', '--message', 'broadcast body', '--cc-primary'], ctx(home, { cwd: mainRepo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.type, 'broadcast');
    assert.equal(r.result.ccPrimary, undefined, 'cc-primary must be a no-op on a broadcast send');
  } finally { rm(home); rm(mainRepo); }
});

test('a FAILING primary send never fires the cc (never a partial "sibling missed it, primary somehow got it" state)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('cc-on-failure');
  try {
    const r = cli.run(['send', '--to', 'not-a-registered-id', '--message', 'hi', '--cc-primary'], ctx(home, { cwd: mainRepo }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.ccPrimary, undefined);
  } finally { rm(home); rm(mainRepo); }
});
