'use strict';
// v0.107.1 — tick vs read-primary off by the Primary's own builder partition
// after a SESSION RESUME. A resumed Claude Code session gets a new session id;
// the anchor row (register-primary, primary-<hash>) keeps the pre-resume one.
// siblingAckGate's PROCESS-SELF leg required anchor.sessionId ===
// CLAUDE_CODE_SESSION_ID, so the Primary's own builder partition read as a
// foreign LIVE sibling: read-primary delivered its rows but only moved the
// caller-scoped `.seen-` watermark, and every count kept them unread.
//   (1) the resumed Primary (its own session positively alive, the anchor's
//       recorded session not) acks its builder partition: counts reach 0
//   (2) state already written by the defect (a `.seen-` watermark past the real
//       reader) heals on the next read: the reader rises to/through the
//       watermark (max-only, loss-free) and is not left behind
//   (3) a child on the Primary's worktree still never acks the anchor while the
//       Primary's recorded session is alive

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHILD = '11111111-2222-4333-8444-555555555555';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-resume-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}
function devswarmDir(home) { return path.join(home, '.anti-hall', 'devswarm'); }
// A harness session file mapping `sid` to an alive pid (this test process by
// default; its parent for a second concurrent session).
// Returns the reader key ('h:<pid>:<startedAt>') that session reads as.
const STARTED = Date.now();
function liveSession(home, sid, cwd, pid) {
  const p = pid || process.pid;
  const dir = liveness.sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, p + '.json'), JSON.stringify({ pid: p, sessionId: sid, cwd, startedAt: STARTED }));
  return 'h:' + p + ':' + STARTED;
}
function markLive(home, id) {
  const p = liveness.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts: Date.now(), state_ts: Date.now(), source: 'inbox-tick', sessionId: null }));
}

// register-primary under the PRE-resume session, the builder row (no session)
// on the same worktree, heartbeats fresh for both. The caller env is the
// RESUMED session.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-resume-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = makeRepo();
  const oldEnv = { DEVSWARM_BUILDER_ID: UUID, CLAUDE_CODE_SESSION_ID: 'sess-before-resume' };
  const rp = cli.run(['register-primary'], { home, env: oldEnv, cwd: repo });
  assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
  const PID = rp.result.id;
  const repoKey = repokey.repoKeyForWorktree(repo);
  const inboxPath = path.join(repo, '.devswarm-temp', 'inbox.ndjson');
  const cursorPath = path.join(repo, '.devswarm-temp', 'inbox.cursor');
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.writeFileSync(inboxPath, '');
  const s = storeLib.openStore({ home, hash: repoKey });
  try { s.upsertRegistry({ id: UUID, worktreePath: repo, sessionId: null, inboxPath, cursorPath }); } finally { s.close(); }
  fs.mkdirSync(path.join(devswarmDir(home), 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(devswarmDir(home), 'workspaces', UUID + '.json'),
    JSON.stringify({ id: UUID, worktreePath: repo, sessionId: null, inboxPath, cursorPath, repoKey, ownerKey: repoKey }));
  markLive(home, UUID);
  markLive(home, PID);
  const env = { DEVSWARM_BUILDER_ID: UUID, CLAUDE_CODE_SESSION_ID: 'sess-after-resume' };
  // This process IS the resumed Primary's harness session: its reader key is
  // the one its session file names (what deriveReaderNonce resolves in the field).
  const ctx = (over) => Object.assign({ home, env, cwd: repo, instanceNonce: 'h:' + process.pid + ':' + STARTED }, over || {});
  return { home, repo, env, ctx, PID, repoKey };
}
function send(f, to, body) {
  const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
  try {
    const fields = { from: 'primary-child1', to, type: 'direct', urgency: 'normal', message: body, timestamp: 1790262004759 };
    storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
  } finally { s.close(); }
}
const bodies = (r) => (r.result.messages || []).map((m) => m.body);
function readAndAck(f, id, over) {
  const rd = cli.run(['inbox', 'read-primary', id], f.ctx(over));
  assert.equal(rd.result.ok, true, JSON.stringify(rd.result));
  if (rd.result.readReceiptId) {
    const a = cli.run(['inbox', 'ack-primary', id, '--receipt', rd.result.readReceiptId], f.ctx(over));
    assert.equal(a.result.ok, true, JSON.stringify(a.result));
  }
  return bodies(rd);
}
const count = (f, id) => cli.run(['inbox', 'count', id], f.ctx()).result.unreadTotal;

test('(1) resumed Primary acks its own builder partition: count reaches 0', () => {
  const f = fixture();
  try {
    liveSession(f.home, 'sess-after-resume', f.repo);
    send(f, UUID, 'to the builder id');
    assert.deepEqual(readAndAck(f, f.PID), ['to the builder id']);
    assert.equal(count(f, UUID), 0, 'the builder partition is acked, not only watermarked');
    assert.deepEqual(readAndAck(f, f.PID), [], 'not re-delivered');
  } finally { rm(f.home); rm(f.repo); }
});

test('(2) a `.seen-` watermark left by the defect heals on the next read (reader rises, loss-free)', () => {
  const f = fixture();
  try {
    send(f, UUID, 'm1');
    send(f, UUID, 'm2');
    // Pre-fix shape: the caller's session is not provably alive -> the builder
    // partition is not ackable; only the caller-scoped watermark moves.
    assert.deepEqual(readAndAck(f, f.PID), ['m1', 'm2']);
    assert.equal(count(f, UUID), 2, 'defect state: still unread for every count');
    send(f, UUID, 'm3');
    liveSession(f.home, 'sess-after-resume', f.repo);
    assert.deepEqual(readAndAck(f, f.PID), ['m3'], 'the watermark still suppresses re-delivery of m1/m2');
    assert.equal(count(f, UUID), 0, 'the reader rose through the watermark and the new row');
  } finally { rm(f.home); rm(f.repo); }
});

test('(3) a child on the Primary worktree never acks the anchor while the Primary session is alive', () => {
  const f = fixture();
  try {
    // The anchor's recorded session is the live one this time (no resume).
    liveSession(f.home, 'sess-before-resume', f.repo);
    const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
    try { s.upsertRegistry({ id: CHILD, worktreePath: f.repo, sessionId: 'sess-child' }); } finally { s.close(); }
    markLive(f.home, CHILD);
    liveSession(f.home, 'sess-child', f.repo, process.ppid); // the child is a real running session too
    send(f, f.PID, 'mail for the PRIMARY anchor');
    const cenv = { DEVSWARM_BUILDER_ID: CHILD, CLAUDE_CODE_SESSION_ID: 'sess-child' };
    readAndAck(f, CHILD, { env: cenv, instanceNonce: 'h:' + process.ppid + ':' + STARTED });
    assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', f.PID], f.ctx({ env: { DEVSWARM_BUILDER_ID: UUID, CLAUDE_CODE_SESSION_ID: 'sess-before-resume' } }))),
      ['mail for the PRIMARY anchor'], 'the child\'s read leaves the Primary anchor mail unread');
  } finally { rm(f.home); rm(f.repo); }
});
