'use strict';
// peer request B (SkyCrew + tf3 Primaries, 2026-09-26): `relay <seq|receipt>
// --to <id> [--note-file f]` — forward a message THIS caller already
// received (its OWN inbox partition) to another workspace, VERBATIM, with a
// provenance header. Same in-process cli.run(argv, ctx) harness as
// devswarm-send.test.js (real git worktrees, journal backend, seeded
// registry rows — never a real hivecontrol).

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-relay-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-relay-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}

test('relay <seq> --to <id> forwards a received message verbatim with a provenance header, and the byte-length check passes', () => {
  const home = tmpHome();
  const repo = makeGitRepo('relay-seq');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const relayerId = derivedId(repo);
    const targetId = 'target-ws';
    seedRegistry(home, repoKey, { id: relayerId, worktreePath: repo, sessionId: 's-relayer' });
    seedRegistry(home, repoKey, { id: targetId, worktreePath: path.join(os.tmpdir(), 'never-exists-relay-target'), sessionId: 's-target' });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, { from: 'upstream-ws', to: relayerId, type: 'direct', message: 'the original body', hash: 'seed-h1', timestamp: Date.now() }); }
    finally { s.close(); }

    const relayerCtx = ctx(home, { cwd: repo });
    const seq = cli.run(['inbox', 'messages', relayerId], relayerCtx).result.messages[0].storeSeq;

    const r = cli.run(['relay', String(seq), '--to', targetId], relayerCtx);
    assert.equal(r.code, 0, JSON.stringify(r.result));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.seq, seq);
    assert.ok(r.result.sourceBytes > 0);
    assert.equal(r.result.relayedBytes, r.result.expectedBytes);

    const targetInbox = cli.run(['inbox', 'messages', targetId], ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: targetId } }));
    assert.equal(targetInbox.result.count, 1);
    const relayedBody = targetInbox.result.messages[0].body;
    assert.match(relayedBody, /^relayed from upstream-ws, seq \d+, 17 bytes\n\nthe original body$/);
  } finally { rm(home); rm(repo); }
});

test('relay --note-file appends the note verbatim after the relayed body', () => {
  const home = tmpHome();
  const repo = makeGitRepo('relay-note');
  const noteFile = path.join(home, 'note.txt');
  try {
    fs.writeFileSync(noteFile, 'fyi: see the linked PR');
    const repoKey = repokey.repoKeyForWorktree(repo);
    const relayerId = derivedId(repo);
    const targetId = 'target-ws-2';
    seedRegistry(home, repoKey, { id: relayerId, worktreePath: repo, sessionId: 's-relayer' });
    seedRegistry(home, repoKey, { id: targetId, worktreePath: path.join(os.tmpdir(), 'never-exists-relay-target-2'), sessionId: 's-target' });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, { from: 'upstream-ws-2', to: relayerId, type: 'direct', message: 'body two', hash: 'seed-h2', timestamp: Date.now() }); }
    finally { s.close(); }

    const relayerCtx = ctx(home, { cwd: repo });
    const seq = cli.run(['inbox', 'messages', relayerId], relayerCtx).result.messages[0].storeSeq;
    const r = cli.run(['relay', String(seq), '--to', targetId, '--note-file', noteFile], relayerCtx);
    assert.equal(r.result.ok, true, JSON.stringify(r.result));

    const targetInbox = cli.run(['inbox', 'messages', targetId], ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: targetId } }));
    assert.match(targetInbox.result.messages[0].body, /body two\n\n---\nfyi: see the linked PR$/);
  } finally { rm(home); rm(repo); rm(noteFile); }
});

test('relay refuses (ok:false) on an empty source body', () => {
  const home = tmpHome();
  const repo = makeGitRepo('relay-empty');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const relayerId = derivedId(repo);
    seedRegistry(home, repoKey, { id: relayerId, worktreePath: repo, sessionId: 's-relayer' });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, { from: 'upstream-ws-3', to: relayerId, type: 'direct', message: '', hash: 'seed-h3', timestamp: Date.now() }); }
    finally { s.close(); }

    const relayerCtx = ctx(home, { cwd: repo });
    const seq = cli.run(['inbox', 'messages', relayerId], relayerCtx).result.messages[0].storeSeq;
    const r = cli.run(['relay', String(seq), '--to', 'nobody'], relayerCtx);
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'empty-body');
  } finally { rm(home); rm(repo); }
});

test('relay at a seq that does not exist in the caller\'s own inbox fails closed', () => {
  const home = tmpHome();
  const repo = makeGitRepo('relay-missing');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const relayerId = derivedId(repo);
    seedRegistry(home, repoKey, { id: relayerId, worktreePath: repo, sessionId: 's-relayer' });
    const r = cli.run(['relay', '9999', '--to', 'nobody'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'message-not-found');
  } finally { rm(home); rm(repo); }
});

test('relay requires --to', () => {
  const home = tmpHome();
  const repo = makeGitRepo('relay-noto');
  try {
    const r = cli.run(['relay', '1'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /--to/);
  } finally { rm(home); rm(repo); }
});

test('relay <receipt> resolves via inbox read-primary\'s readReceiptId when it covers exactly one message', () => {
  const home = tmpHome();
  const repo = makeGitRepo('relay-receipt');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const relayerId = derivedId(repo);
    const targetId = 'target-ws-6';
    seedRegistry(home, repoKey, { id: relayerId, worktreePath: repo, sessionId: 's-relayer' });
    seedRegistry(home, repoKey, { id: targetId, worktreePath: path.join(os.tmpdir(), 'never-exists-relay-target-6'), sessionId: 's-target' });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, { from: 'upstream-ws-6', to: relayerId, type: 'direct', message: 'receipt body', hash: 'seed-h6', timestamp: Date.now() }); }
    finally { s.close(); }

    const relayerCtx = ctx(home, { cwd: repo });
    const readRes = cli.run(['inbox', 'read-primary', relayerId], relayerCtx).result;
    assert.equal(readRes.count, 1);
    assert.ok(readRes.readReceiptId, JSON.stringify(readRes));

    const r = cli.run(['relay', readRes.readReceiptId, '--to', targetId], relayerCtx);
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.receiptId, readRes.readReceiptId);

    const targetInbox = cli.run(['inbox', 'messages', targetId], ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: targetId } }));
    assert.equal(targetInbox.result.count, 1);
    assert.match(targetInbox.result.messages[0].body, /receipt body$/);
  } finally { rm(home); rm(repo); }
});
