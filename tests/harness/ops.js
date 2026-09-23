'use strict';
// tests/harness/ops.js — callable, in-process wrappers over the REAL DevSwarm
// mesh entry points (no re-implementation), per phase1-harness-spec.md §1 /
// File layout. Each reader is a distinct linked git worktree off one shared
// repo (so `from`/meshId derive off a real, distinct cwd per reader — matching
// how production derives identity; see tests/scripts/devswarm-send.test.js's
// makeGitRepo/addLinkedWorktree pattern, reused here).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const cli = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'scripts', 'devswarm.js'));
const storeLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js'));
const cursorLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-inbox-cursor.js'));

// makeMeshFixture() -> a real, committed git repo + one worktree per reader id,
// all under a fresh tmp dir. Returns { repoDir, home, readers: {id -> worktreeDir},
// repoKey, cleanup() }.
function makeMeshFixture(readerIds, tag) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-harness-' + (tag || 'x') + '-'));
  const repoDir = path.join(scratch, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  cp.spawnSync('git', ['init', '-q', repoDir]);
  cp.spawnSync('git', ['-C', repoDir, 'config', 'user.email', 'harness@anti-hall.test']);
  cp.spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'Harness']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), tag || 'harness');
  cp.spawnSync('git', ['-C', repoDir, 'add', '.']);
  cp.spawnSync('git', ['-C', repoDir, 'commit', '-q', '-m', 'init']);

  const readers = {};
  for (const id of readerIds) {
    const wt = path.join(scratch, 'wt-' + id);
    cp.spawnSync('git', ['-C', repoDir, 'worktree', 'add', wt, '-b', 'branch-' + id]);
    readers[id] = wt;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-harness-home-' + (tag || 'x') + '-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });

  const repoKey = repokey.repoKeyForWorktree(repoDir);

  function cleanup() {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  }
  return { repoDir, home, readers, repoKey, cleanup };
}

// baseCtx(fixture, readerId, over) -> the ctx.run(argv, ctx) context for a call
// made "as" readerId (cwd = that reader's own worktree). now is threaded
// explicitly (never Date.now() inside op generation/SUT default args — spec §2).
function baseCtx(fixture, readerId, now, over) {
  return Object.assign({
    home: fixture.home,
    backend: 'journal',
    env: { ANTIHALL_INGEST_DRY_RUN: '1' },
    cwd: fixture.readers[readerId],
    now,
  }, over || {});
}

function inboxPath(fixture, id) { return path.join(fixture.home, '.anti-hall', 'devswarm', 'inbox', id + '.ndjson'); }
function cursorPath(fixture, id) { return path.join(fixture.home, '.anti-hall', 'devswarm', 'cursor', id + '.json'); }

// opRegister — real entry point: devswarm.js cmdRegister via cli.run(['register',...]).
function opRegister(fixture, readerId, now) {
  const ctx = baseCtx(fixture, readerId, now);
  const r = cli.run([
    'register', readerId,
    '--worktree', fixture.readers[readerId],
    '--session', 'sess-' + readerId,
    '--inbox', inboxPath(fixture, readerId),
    '--cursor', cursorPath(fixture, readerId),
  ], ctx);
  return r;
}

// opSend — real entry point: devswarm.js cmdSend via cli.run(['send',...]),
// `--to` targets the RECIPIENT's own derived meshId (the recipient's cwd, not
// its registered id string) — mirroring resolveSendTarget's real resolution.
function opSend(fixture, fromId, toId, text, now) {
  const ctx = baseCtx(fixture, fromId, now);
  const r = cli.run(['send', '--to', toId, '--message', text], ctx);
  return r;
}

// opPull — real entry point: devswarm.js cmdInbox('pull', ...) (native mesh
// drain into the descriptor's durable NDJSON inbox), spec §1's `pull` op.
function opPull(fixture, readerId, now) {
  const ctx = baseCtx(fixture, readerId, now);
  const r = cli.run(['inbox', 'pull', readerId], ctx);
  return r;
}

// opAck — real entry point: devswarm-inbox-cursor.js ackTo(cursorPath, n, ...)
// against the DESCRIPTOR durable inbox (spec §1 "inbox read/ack" row): reads
// the current unread count and acks the whole batch, mirroring `inbox ack`'s
// own effect without going through the CLI parse layer (no CLI `ack` verb
// exists distinct from pull/count in this file — ack is the cursor-lib call
// pull's own drain path itself does not perform automatically).
function opAck(fixture, readerId) {
  const ip = inboxPath(fixture, readerId);
  const cp_ = cursorPath(fixture, readerId);
  const total = cursorLib.countMessages(ip, fs);
  cursorLib.ackTo(cp_, total, fs, ip);
  return { ok: true, action: 'ack', id: readerId, ackedTo: total };
}

// opHeartbeat — real entry point: devswarm.js cmdHeartbeat via cli.run.
function opHeartbeat(fixture, readerId, now) {
  const ctx = baseCtx(fixture, readerId, now);
  const r = cli.run(['heartbeat', readerId], ctx);
  return r;
}

// opTick — real entry point: devswarm.js cmdInboxTick via cli.run(['inbox','tick',...]).
function opTick(fixture, readerId, now) {
  const ctx = baseCtx(fixture, readerId, now);
  const r = cli.run(['inbox', 'tick', readerId, '--child'], ctx);
  return r;
}

// opArchive — real entry point: devswarm.js cmdArchive via cli.run(['archive',...]).
function opArchive(fixture, readerId, now) {
  const ctx = baseCtx(fixture, readerId, now);
  const r = cli.run(['archive', readerId], ctx);
  return r;
}

// applyOp(fixture, op, now) -> the result of dispatching one generated op
// (from prng.genOpSequence) to its real entry point.
function applyOp(fixture, op, now) {
  switch (op.op) {
    case 'register': return opRegister(fixture, op.args.readerId, now);
    case 'send': return opSend(fixture, op.args.from, op.args.to, op.args.text, now);
    case 'pull': return opPull(fixture, op.args.readerId, now);
    case 'ack': return opAck(fixture, op.args.readerId);
    case 'heartbeat': return opHeartbeat(fixture, op.args.readerId, now);
    case 'tick': return opTick(fixture, op.args.readerId, now);
    case 'archive': return opArchive(fixture, op.args.readerId, now);
    default: throw new Error('harness ops.js: unknown op ' + op.op);
  }
}

module.exports = {
  makeMeshFixture, baseCtx, inboxPath, cursorPath,
  opRegister, opSend, opPull, opAck, opHeartbeat, opTick, opArchive, applyOp,
  storeLib, repokey, cursorLib, cli,
};
