'use strict';
// Regression tests for six TRACED mesh CLI defects (root-caused, not re-derived):
//   FIX 1 — listMessages()'s `seq` used to be the per-workspace positional
//     ordinal (opposite of what `send`/`cmdMeshRead` mean by `seq`, the PHYSICAL
//     mesh seq). Renamed the ordinal to `index`; `seq` now always means physical.
//   FIX 2 — `inbox messages` conflated a MODE flag (`unread`) with the summary
//     projection's UNREAD COUNT under the same key. Split into `unreadOnly`
//     (bool) + `unreadCount` (number).
//   FIX 3 — `send`'s `ok:true` carried no integrity data. Now echoes `bytes`
//     (String(message).length) and `hash` (meshMessageHash of the sent fields).
//   FIX 4 — argv was the only way to pass a message body, AND a value starting
//     with `--` degraded `--message` to a bare boolean. Added `--message-file`/
//     `--message-stdin`, and made those (plus `--message`) consume their value
//     unconditionally.
//   FIX 5 — the read/ack path (`resolveWorkspaceStoreForRead`) had no
//     fail-closed check for a totally unregistered id (no descriptor, no
//     registry row, no store history) — contrast `send --to`'s
//     `unregistered-recipient`. Also makes a zero-progress ack visible via
//     `acked`/`ackedFrom`.
//   FIX 6 — `inbox count`/`inbox read` labeled the NDJSON+store SUM as `unread`
//     beside a `storeUnread` component, with no field naming the NDJSON
//     component. Added explicit `unreadTotal`/`unreadNdjson`/`unreadStore` +
//     `cursorNdjson`/`cursorStore` (old keys kept as exact aliases).

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixes-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixes-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function fakeCwd(home) { return path.join(home, 'no-git-here'); }
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

// ---- FIX 1: listMessages index (positional) vs seq (physical) --------------

test('FIX 1: listMessages returns index (positional) and seq (physical); they DIVERGE across a broadcast + direct send, and seq matches what send returned', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix1');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'recip-1', worktreePath: repo, sessionId: 's' });

    // Broadcast FIRST — consumes the store's global physical seq counter
    // WITHOUT landing in recip-1's own partition.
    const b = cli.run(['send', '--broadcast', '--message', 'bcast'], ctx(home, { cwd: repo }));
    assert.equal(b.result.ok, true, JSON.stringify(b.result));

    // Direct send to recip-1 SECOND — its physical seq is now > 1 (the
    // broadcast incremented the shared counter first), while it is the FIRST
    // (and only) row in recip-1's own partition (positional index 1).
    const d = cli.run(['send', '--to', 'recip-1', '--message', 'direct'], ctx(home, { cwd: repo }));
    assert.equal(d.result.ok, true, JSON.stringify(d.result));
    assert.ok(Number.isFinite(d.result.seq), 'send must return a numeric physical seq');
    assert.ok(d.result.seq > 1, 'the direct message\'s physical seq must be AFTER the broadcast\'s (precondition for divergence)');

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const rows = s.listMessages('recip-1');
      assert.equal(rows.length, 1, 'recip-1\'s own partition holds only the direct message');
      assert.equal(rows[0].index, 1, 'index is the PER-WORKSPACE positional ordinal (1-based)');
      assert.equal(rows[0].seq, d.result.seq, 'seq must be the PHYSICAL mesh seq — the SAME value send() returned');
      assert.notEqual(rows[0].index, rows[0].seq, 'index and seq must DIVERGE once a broadcast has consumed the shared counter first');
      assert.equal(rows[0].storeSeq, rows[0].seq, 'storeSeq stays an exact alias of the physical seq (back-compat)');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('FIX 1: `inbox messages` result seq matches send\'s returned seq for the same message', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix1b');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'recip-2', worktreePath: repo, sessionId: 's' });

    cli.run(['send', '--broadcast', '--message', 'noise'], ctx(home, { cwd: repo }));
    const d = cli.run(['send', '--to', 'recip-2', '--message', 'hello'], ctx(home, { cwd: repo }));
    assert.equal(d.result.ok, true);

    const r = cli.run(['inbox', 'messages', 'recip-2'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.messages.length, 1);
    assert.equal(r.result.messages[0].seq, d.result.seq, 'inbox messages\' seq must match send\'s returned seq');
  } finally { rm(home); rm(repo); }
});

// ---- FIX 2: unreadOnly (bool) vs unreadCount (number) -----------------------

test('FIX 2: `inbox messages` returns unreadOnly:bool + unreadCount:number, distinct keys, on both ack and non-ack paths', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix2');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    // A distinct recipient id (not the caller's own derived id — `send --to`
    // self-addressing is rejected outright, independent of this fix).
    const id = 'recip-fix2';
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's' });
    cli.run(['send', '--to', id, '--message', 'm1'], ctx(home, { cwd: repo }));
    cli.run(['send', '--to', id, '--message', 'm2'], ctx(home, { cwd: repo }));

    // Non-ack, non-unread-scoped read.
    const plain = cli.run(['inbox', 'messages', id], ctx(home, { cwd: repo }));
    assert.equal(plain.result.ok, true, JSON.stringify(plain.result));
    assert.strictEqual(typeof plain.result.unreadOnly, 'boolean');
    assert.strictEqual(plain.result.unreadOnly, false);
    assert.strictEqual(typeof plain.result.unreadCount, 'number');
    assert.strictEqual(plain.result.unreadCount, 2, 'unreadCount must be the actual unread count, not the mode flag');

    // Non-ack, --unread-scoped read.
    const unreadOnlyRead = cli.run(['inbox', 'messages', id, '--unread'], ctx(home, { cwd: repo }));
    assert.strictEqual(unreadOnlyRead.result.unreadOnly, true);
    assert.strictEqual(typeof unreadOnlyRead.result.unreadCount, 'number');
    assert.strictEqual(unreadOnlyRead.result.unreadCount, 2);

    // Ack path (read-primary).
    const acked = cli.run(['inbox', 'read-primary', id, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(acked.result.ok, true, JSON.stringify(acked.result));
    assert.strictEqual(acked.result.unreadOnly, true, 'read-primary is inherently unread-then-ack');
    assert.strictEqual(typeof acked.result.unreadCount, 'number');
    assert.strictEqual(acked.result.unreadCount, 2, 'unreadCount reflects the count AS OF the pre-ack cursor');

    // A follow-up read now shows zero unread.
    const after = cli.run(['inbox', 'messages', id], ctx(home, { cwd: repo }));
    assert.strictEqual(after.result.unreadCount, 0);
  } finally { rm(home); rm(repo); }
});

// ---- FIX 3: send echoes bytes + hash -----------------------------------------

test('FIX 3: send success object carries bytes (== body length) and hash (== meshMessageHash of the sent fields)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix3');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'recip-3', worktreePath: repo, sessionId: 's' });
    const now = 1700000000000;
    const body = 'hello world, this is the message body';
    const r = cli.run(['send', '--to', 'recip-3', '--message', body], ctx(home, { cwd: repo, now }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.bytes, body.length);
    assert.strictEqual(typeof r.result.hash, 'string');

    const from = inst.primaryWorkspaceId(inst.resolveWorktree(repo));
    const expectedHash = storeLib.meshMessageHash({
      from, to: r.result.toId, type: 'direct', urgency: r.result.urgency,
      message: body, timestamp: now, needsReply: r.result.needsReply,
    });
    assert.strictEqual(r.result.hash, expectedHash, 'hash must match meshMessageHash for the same fields cmdSend used');

    // Verify the hash actually landed on the persisted row too.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const rows = s.listMessages('recip-3');
      assert.equal(rows[0].hash, r.result.hash);
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// ---- FIX 4: --message-file / --message-stdin / parser fix -------------------

test('FIX 4: --message-file round-trips a body with backticks, $VAR, $(cmd), and newlines BYTE-EXACT', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix4a');
  const bodyFile = path.join(os.tmpdir(), 'anti-hall-fix4-body-' + Date.now() + '.txt');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'recip-4', worktreePath: repo, sessionId: 's' });
    const body = 'line one `backtick` and $HOME and $(whoami)\nline two\nline three with trailing newline\n';
    fs.writeFileSync(bodyFile, body, 'utf8');

    const r = cli.run(['send', '--to', 'recip-4', '--message-file', bodyFile], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.bytes, Buffer.byteLength(body, 'utf8'));

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const rows = s.listMessages('recip-4');
      assert.strictEqual(rows[0].body, body, 'the stored body must be byte-exact, including backticks/$VAR/$(cmd)/newlines');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); try { fs.rmSync(bodyFile, { force: true }); } catch (_) {} }
});

test('FIX 4: --message with a value starting with -- is consumed correctly, not degraded to a bare boolean', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix4b');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'recip-5', worktreePath: repo, sessionId: 's' });
    const body = '--foo bar this looks like a flag';
    const r = cli.run(['send', '--to', 'recip-5', '--message', body], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const rows = s.listMessages('recip-5');
      assert.strictEqual(rows[0].body, body, 'a --message value starting with -- must be consumed verbatim, not treated as a bare boolean flag');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('FIX 4: both --message and --message-file given -> clear error; neither given -> clear error', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix4c');
  const bodyFile = path.join(os.tmpdir(), 'anti-hall-fix4c-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(bodyFile, 'x', 'utf8');
    seedRegistry(home, repokey.repoKeyForWorktree(repo), { id: 'recip-6', worktreePath: repo, sessionId: 's' });

    const both = cli.run(['send', '--to', 'recip-6', '--message', 'a', '--message-file', bodyFile], ctx(home, { cwd: repo }));
    assert.strictEqual(both.result.ok, false);
    assert.match(both.result.error, /exactly one of --message/);

    const neither = cli.run(['send', '--to', 'recip-6'], ctx(home, { cwd: repo }));
    assert.strictEqual(neither.result.ok, false);
    assert.match(neither.result.error, /exactly one of --message/);
  } finally { rm(home); rm(repo); try { fs.rmSync(bodyFile, { force: true }); } catch (_) {} }
});

// ---- FIX 5: fail-closed read/ack identity check + zero-progress ack visibility --

test('FIX 5: read-primary on an id with no registry row AND no descriptor fails closed, does NOT return ok:true, and writes NO cursor', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['inbox', 'read-primary', 'no-such-workspace-xyz', '--ack-as-owner'], ctx(home, { cwd: fakeCwd(home) }));
    assert.notStrictEqual(r.result.ok, true, 'a totally unregistered id must never report ok:true: ' + JSON.stringify(r.result));
    assert.strictEqual(r.result.reason, 'unregistered-workspace');
    const cursorFile = cli.primaryCursorPath(home, 'no-such-workspace-xyz');
    assert.strictEqual(fs.existsSync(cursorFile), false, 'no cursor file may be written for a workspace that was never registered');
  } finally { rm(home); }
});

test('FIX 5: an ack that moves the cursor 0->0 reports acked:0, distinguishable from one that actually moved', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fix5b');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = derivedId(repo);
    // Registered (so FIX 5's existence guard passes) but with ZERO messages.
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's' });

    const zeroAck = cli.run(['inbox', 'read-primary', id], ctx(home, { cwd: repo }));
    assert.strictEqual(zeroAck.result.ok, true, JSON.stringify(zeroAck.result));
    assert.strictEqual(zeroAck.result.ackedFrom, 0);
    assert.strictEqual(zeroAck.result.acked, 0, 'zero-progress ack must report acked:0, not just a bare ok:true');

    // Now a real message arrives and gets acked -> acked must differ from ackedFrom.
    // Seeded directly into the store (not via `send --to`, which rejects
    // self-addressing — `id` here IS the caller's own derived id, and this test
    // is about the ack/cursor mechanics, not send's addressing rules).
    const seedS = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { seedS.appendMessage({ workspaceId: id, body: 'hi', hash: 'fix5b-h0' }); } finally { seedS.close(); }
    const realAck = cli.run(['inbox', 'read-primary', id], ctx(home, { cwd: repo }));
    assert.strictEqual(realAck.result.ok, true, JSON.stringify(realAck.result));
    assert.strictEqual(realAck.result.ackedFrom, 0);
    assert.strictEqual(realAck.result.acked, 1);
    assert.notStrictEqual(realAck.result.acked, realAck.result.ackedFrom, 'a real ack must be distinguishable from a zero-progress one');
  } finally { rm(home); rm(repo); }
});

// ---- FIX 6: unreadTotal / unreadNdjson / unreadStore -------------------------

test('FIX 6: inbox count on a row with an NDJSON backlog and an empty store partition reports unreadNdjson/unreadStore separately, unreadTotal as their sum', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'w-inbox.ndjson');
    const cursor = path.join(home, 'w-cursor.json');
    fs.writeFileSync(inbox, 'm1\nm2\nm3\nm4\n');
    cli.run(['register', 'w-fix6', '--worktree', '/wt/w-fix6', '--session', 's', '--inbox', inbox, '--cursor', cursor], ctx(home));

    const r = cli.run(['inbox', 'count', 'w-fix6'], ctx(home));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.unreadNdjson, 4, 'the NDJSON backlog must be separately visible, never folded into an unlabeled sum');
    assert.strictEqual(r.result.unreadStore, 0, 'the store partition is empty');
    assert.strictEqual(r.result.unreadTotal, 4, 'unreadTotal must be the sum of the two channels');
    assert.strictEqual(r.result.unreadTotal, r.result.unreadNdjson + r.result.unreadStore);
    // Compat aliases stay exact aliases of the primary fields.
    assert.strictEqual(r.result.unread, r.result.unreadTotal);
    assert.strictEqual(r.result.storeUnread, r.result.unreadStore);
    assert.strictEqual(r.result.cursorNdjson, r.result.cursor);
    assert.strictEqual(r.result.cursorStore, r.result.storeCursor);
  } finally { rm(home); }
});
