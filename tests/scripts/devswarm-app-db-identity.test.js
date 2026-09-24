'use strict';
// v0.108.0 — the DevSwarm app DB's session map (builder_terminals.ai_session_config
// -> builders.worktreePath) is the AUTHORITATIVE self-identification signal when
// it knows the caller's session; the v0.107.1 liveness rule stays the fallback.
//   (1) caller's session mapped to the anchor's worktree -> the Primary acks its
//       own builder partition even when its session is not provably alive
//   (2) caller's session mapped to ANOTHER worktree -> never acks the anchor,
//       even when the liveness fallback would have said "ours"
//   (3) register-primary: a caller the app names as this worktree's ACTIVE AI
//       terminal takes over from a live stale-session row; an inactive
//       (closed-tab) terminal mapping keeps the refusal
//   (4) no app DB -> byte-identical v0.107.1 behaviour (refusal stands)

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


const { COLS } = require('../helpers/app-db-fixture.js');
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

// appDb(dir, terminals) -> env override pointing at a fixture app DB whose
// builders own `terminals` [{ sid, wt, active }].
function appDbEnv(dir, terminals) {
  const file = path.join(dir, 'app-' + Math.random().toString(16).slice(2) + '.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE builders (' + COLS.builders + ')');
  db.exec('CREATE TABLE builder_terminals (' + COLS.builder_terminals + ')');
  terminals.forEach((t, i) => {
    db.prepare('INSERT INTO builders (id, worktreePath, builderType, isActive, isHidden) VALUES (?, ?, ?, 1, 0)').run('b' + i, t.wt, 'primary');
    db.prepare('INSERT INTO builder_terminals (id, builderId, terminalType, ai_session_config, isActive) VALUES (?, ?, ?, ?, ?)')
      .run('t' + i, 'b' + i, 'ai', JSON.stringify({ agent: 'claude', version: 1, sessionId: t.sid }), t.active === false ? 0 : 1);
  });
  db.close();
  return { ANTIHALL_DEVSWARM_APP_DB: file, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
}

test('(1) app DB maps the caller to the anchor worktree -> own builder partition acked without liveness proof', { skip }, () => {
  const f = fixture();
  try {
    // No liveSession(): the v0.107.1 fallback alone would NOT ack (see resumed-anchor test 2).
    Object.assign(f.env, appDbEnv(f.home, [{ sid: 'sess-after-resume', wt: f.repo }]));
    send(f, UUID, 'to the builder id');
    assert.deepEqual(readAndAck(f, f.PID), ['to the builder id']);
    assert.equal(count(f, UUID), 0, 'acked on the app-DB identity');
  } finally { rm(f.home); rm(f.repo); }
});

test('(2) app DB maps the caller to another worktree -> never acks the anchor', { skip }, () => {
  const f = fixture();
  try {
    liveSession(f.home, 'sess-after-resume', f.repo); // the fallback alone WOULD ack
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-other-wt-'));
    Object.assign(f.env, appDbEnv(f.home, [{ sid: 'sess-after-resume', wt: other }]));
    send(f, UUID, 'to the builder id');
    readAndAck(f, f.PID);
    assert.equal(count(f, UUID), 1, 'the app says this session is not the anchor\'s -> not acked');
    rm(other);
  } finally { rm(f.home); rm(f.repo); }
});

test('(3)(4) register-primary takeover: app-named active terminal wins; closed tab or no app DB keeps the refusal', { skip }, () => {
  const f = fixture();
  try {
    liveSession(f.home, 'sess-before-resume', f.repo); // the recorded session is positively alive
    const reg = (env) => cli.run(['register-primary'], { home: f.home, env, cwd: f.repo }).result;
    const base = { CLAUDE_CODE_SESSION_ID: 'sess-new' };
    const r0 = reg(base);
    assert.equal(r0.ok, false, 'no app DB -> v0.107.1 refusal');
    assert.equal(r0.reason, 'live-primary-conflict');
    const r1 = reg(Object.assign({}, base, appDbEnv(f.home, [{ sid: 'sess-new', wt: f.repo, active: false }])));
    assert.equal(r1.ok, false, 'a closed-tab terminal mapping is not authority');
    const r2 = reg(Object.assign({}, base, appDbEnv(f.home, [{ sid: 'sess-new', wt: f.repo, active: true }])));
    assert.equal(r2.ok, true, JSON.stringify(r2));
  } finally { rm(f.home); rm(f.repo); }
});
