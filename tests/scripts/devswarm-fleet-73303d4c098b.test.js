'use strict';
// Defect 73303d4c098b (P1): foldGroupIntoSurvivor tombstones a retired twin row
// with no redirect; send/read-primary against the OLD id then fail closed.
//
// Root cause (file:line, HEAD 5631695): plugins/anti-hall/scripts/devswarm.js:2851
// `s.removeRegistryIf(row.id, ...)` deletes the retired row's registry entry
// outright (both backends fully remove it from listRegistry()) with NO trace of
// which survivor it was folded into. resolveSendTarget (devswarm.js:9376-9411,
// pre-fix) and resolveWorkspaceStoreForRead's existence guard (devswarm.js
// ~5769-5782, pre-fix) then see NOTHING for the old id and fail closed as
// unregistered-recipient / unregistered-workspace.
//
// Run against HEAD (RED) vs the patched copy (GREEN) via:
//   DEVSWARM_MODULE=<path>/devswarm.orig.js            node --test 73303d4c098b.test.js
//   DEVSWARM_MODULE=<path>/devswarm.73303d4c098b.js    node --test 73303d4c098b.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// DEVSWARM_ANTIHALL_DIR points at a full plugins/anti-hall/ tree copy (so
// devswarm.js's own relative `../companion/lib/...` requires resolve) — either
// the pristine HEAD copy or one with a single patched scripts/devswarm.js
// swapped in. Defaults to the real repo's plugins/anti-hall for a bare run.
const antiHallDir = process.env.DEVSWARM_ANTIHALL_DIR
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const devswarmModulePath = path.join(antiHallDir, 'scripts', 'devswarm.js');

const cli = require(devswarmModulePath);
const storeLib = require(path.join(antiHallDir, 'companion', 'lib', 'devswarm-store.js'));
const inst = require(path.join(antiHallDir, 'companion', 'install-devswarm-ingest.js'));
const repokey = require(path.join(antiHallDir, 'companion', 'lib', 'devswarm-repokey.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-redirect-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-redirect-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}

const LEGACY_ID = 'child-aaa-legacy-a55f20ef';
const CHILD_ID = 'child-zzz-builder-uuid';

test('after a fold retires a twin row, send --to <old twin> is redirected to the survivor instead of failing unregistered-recipient', () => {
  const home = tmpHome();
  const main = makeGitRepo('conv');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = topOf(main);
    const mesh = meshOf(main);

    // Legacy row live for this worktree; child self-registers under its own
    // builder-id -> retireWorktreeDuplicates folds+tombstones the legacy row.
    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: top, sessionId: 'legacy-sess' });
    const reg = cli.run(['register', CHILD_ID, '--worktree', top, '--session', 'child-sess'], ctx(home, { cwd: main }));
    assert.strictEqual(reg.result.ok, true, 'register should succeed');
    assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the legacy row is retired by the fold');

    // THE BUG: addressing the now-retired legacy id must not fail closed.
    const sent = cli.run(['send', '--to', LEGACY_ID, '--message', 'post-fold-addressed-to-old-twin'], ctx(home, { cwd: main }));
    assert.strictEqual(sent.result.ok, true,
      'send --to the retired twin id must succeed via a one-hop redirect to the survivor (got: ' + JSON.stringify(sent.result) + ')');
    assert.strictEqual(sent.result.redirected, true, 'send result must report redirected:true');
    assert.strictEqual(sent.result.redirectedFrom, LEGACY_ID, 'send result must name the old id it redirected from');

    // The message must actually be readable from the SURVIVOR's own partition.
    const read = cli.run(['inbox', 'messages', CHILD_ID], ctx(home, { cwd: main }));
    assert.strictEqual(read.result.ok, true);
    assert.ok(read.result.messages.map((m) => m.body).includes('post-fold-addressed-to-old-twin'),
      'the redirected send must land in the survivor partition, not be lost');
  } finally {
    rm(main); rm(home);
  }
});

test('after a fold retires a twin row, read-primary against the old twin id is redirected to the survivor instead of failing closed', () => {
  const home = tmpHome();
  const main = makeGitRepo('conv2');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = topOf(main);

    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: top, sessionId: 'legacy-sess' });
    const reg = cli.run(['register', CHILD_ID, '--worktree', top, '--session', 'child-sess'], ctx(home, { cwd: main }));
    assert.strictEqual(reg.result.ok, true, 'register should succeed');
    assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the legacy row is retired by the fold');

    // Seed a message the survivor can read back, addressed via the SURVIVOR
    // id (a real caller would not know the old id died) so this proves the
    // redirect resolves to the LIVE partition, not merely "doesn't crash".
    const sendOk = cli.run(['send', '--to', CHILD_ID, '--message', 'delivered-to-survivor'], ctx(home, { cwd: main }));
    assert.strictEqual(sendOk.result.ok, true);

    // THE BUG: reading the now-retired legacy id must not fail closed.
    const rp = cli.run(['inbox', 'read-primary', LEGACY_ID], ctx(home, { cwd: main }));
    assert.strictEqual(rp.result.ok, true,
      'read-primary against the retired twin id must succeed via a one-hop redirect (got: ' + JSON.stringify(rp.result) + ')');
    assert.strictEqual(rp.result.redirected, true, 'read-primary result must report redirected:true');
    assert.strictEqual(rp.result.redirectedFrom, LEGACY_ID, 'read-primary result must name the old id it redirected from');
    assert.ok(rp.result.messages.map((m) => m.body).includes('delivered-to-survivor'),
      'read-primary via the redirect must actually see the survivor partition\'s mail');
  } finally {
    rm(main); rm(home);
  }
});

// fl-wave3 fix: the count/read/ack verb group (a separate code path from
// messages/read-primary/peek-primary above) fell through resolveReadArgToId's
// generic meshId resolution for a retired id — silently reporting
// `resolvedFrom` instead of `redirected`/`redirectedFrom`, AND (for `ack`)
// letting an arbitrary/unresolvable caller advance the SURVIVOR's own
// durable NDJSON cursor merely by naming the dead twin id.
test('after a fold retires a twin row, `inbox count` against the old twin id reports redirected (not resolvedFrom)', () => {
  const home = tmpHome();
  const main = makeGitRepo('conv3');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = topOf(main);

    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: top, sessionId: 'legacy-sess' });
    const inboxPath = path.join(home, 'descriptor-inboxes', CHILD_ID + '.ndjson');
    const cursorPath = path.join(home, 'descriptor-cursors', CHILD_ID + '.cursor');
    const reg = cli.run(
      ['register', CHILD_ID, '--worktree', top, '--session', 'child-sess', '--inbox', inboxPath, '--cursor', cursorPath],
      ctx(home, { cwd: main }));
    assert.strictEqual(reg.result.ok, true, 'register should succeed');
    assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the legacy row is retired by the fold');

    const cnt = cli.run(['inbox', 'count', LEGACY_ID], ctx(home, { cwd: main }));
    assert.strictEqual(cnt.result.ok, true,
      '`inbox count` against the retired twin id must succeed via a one-hop redirect (got: ' + JSON.stringify(cnt.result) + ')');
    assert.strictEqual(cnt.result.redirected, true, '`inbox count` must report redirected:true for a retired-redirect id');
    assert.strictEqual(cnt.result.redirectedFrom, LEGACY_ID, '`inbox count` must name the old id it redirected from');
    assert.strictEqual(cnt.result.resolvedFrom, undefined,
      'a retired-redirect must never report resolvedFrom — that field is for the generic meshId resolution path only');
  } finally {
    rm(main); rm(home);
  }
});

test('after a fold retires a twin row, `inbox ack` against the old twin id from an unresolvable caller does NOT move the survivor cursor', () => {
  const home = tmpHome();
  const main = makeGitRepo('conv4');
  const unrelated = makeGitRepo('conv4-unrelated');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = topOf(main);

    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: top, sessionId: 'legacy-sess' });
    const inboxPath = path.join(home, 'descriptor-inboxes', CHILD_ID + '.ndjson');
    const cursorPath = path.join(home, 'descriptor-cursors', CHILD_ID + '.cursor');
    const reg = cli.run(
      ['register', CHILD_ID, '--worktree', top, '--session', 'child-sess', '--inbox', inboxPath, '--cursor', cursorPath],
      ctx(home, { cwd: main }));
    assert.strictEqual(reg.result.ok, true, 'register should succeed');
    assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the legacy row is retired by the fold');

    // Seed a real unread row directly in the survivor's own durable NDJSON
    // descriptor inbox, so a moved cursor is provable, not merely "still 0".
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    fs.writeFileSync(inboxPath, JSON.stringify({ from: 'x', to: CHILD_ID, body: 'must-not-be-drained', ts: Date.now() }) + '\n');

    const before = cli.run(['inbox', 'count', CHILD_ID], ctx(home, { cwd: main }));
    assert.strictEqual(before.result.unreadNdjson, 1, 'survivor must start with exactly one unread NDJSON row');

    // THE BUG: an ack from a caller with no relation to this workspace (a
    // different, unrelated git repo — no shared worktree/meshId, no matching
    // sessionId) must NOT be able to advance the survivor's real cursor just
    // because it names the dead legacy id.
    const ack = cli.run(['inbox', 'ack', LEGACY_ID], ctx(home, { cwd: unrelated }));
    assert.strictEqual(ack.result.ok, false,
      '`inbox ack` on a retired-redirect id from an unresolvable caller must refuse (got: ' + JSON.stringify(ack.result) + ')');
    assert.strictEqual(ack.result.reason, 'retired-redirect-unresolvable-caller');
    assert.strictEqual(ack.result.redirectedFrom, LEGACY_ID);

    const after = cli.run(['inbox', 'count', CHILD_ID], ctx(home, { cwd: main }));
    assert.strictEqual(after.result.unreadNdjson, 1, 'the survivor cursor must NOT have moved — the row must still be unread');
    assert.strictEqual(after.result.cursorNdjson, 0, 'the survivor NDJSON cursor must still be at its pre-ack value');

    // Sanity: the LEGITIMATE caller (same worktree as the survivor) can still
    // ack via the retired id — this fix must not break the real redirect use
    // case, only the unrelated-caller hazard.
    const ackOk = cli.run(['inbox', 'ack', LEGACY_ID], ctx(home, { cwd: main }));
    assert.strictEqual(ackOk.result.ok, true, 'a legitimate (same-worktree) caller must still be able to ack via the retired id');
    assert.strictEqual(ackOk.result.redirected, true);
    assert.strictEqual(ackOk.result.redirectedFrom, LEGACY_ID);
    const finalCnt = cli.run(['inbox', 'count', CHILD_ID], ctx(home, { cwd: main }));
    assert.strictEqual(finalCnt.result.unreadNdjson, 0, 'the legitimate ack must have actually drained the row');
  } finally {
    rm(main); rm(home); rm(unrelated);
  }
});
